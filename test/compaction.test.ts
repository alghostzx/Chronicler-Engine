import { beforeEach, describe, expect, it } from 'vitest';
import {
  appendChronicle,
  buildCompactionRefineRequest,
  COMPACTION_REFINE_SYSTEM_PROMPT,
  COMPACTION_SYSTEM_PROMPT,
  splitAtPage,
  splitForCompaction,
} from '../src/ai/compaction.js';
import { COMPACTION_IDLE_TIMEOUT_MS } from '../src/ai/gateway.js';
import { makeApp, withKey, type TestApp } from './helpers.js';

const blk = (order_index: number, size: number) => ({ order_index, generated_text: 'x'.repeat(size) });

describe('splitForCompaction', () => {
  it('divide 75/25 pelo peso, não pela contagem de páginas', () => {
    // pesos: 10,10,10,10,60 → total 100; prefixo ≤ 75: 10+10+10+10=40; +60=100 > 75 → corte em 4
    const s = splitForCompaction([blk(1, 10), blk(2, 10), blk(3, 10), blk(4, 10), blk(5, 60)])!;
    expect(s.past.map((b) => b.order_index)).toEqual([1, 2, 3, 4]);
    expect(s.keep.map((b) => b.order_index)).toEqual([5]);
  });

  it('com páginas uniformes aproxima 75% das páginas', () => {
    const pages = Array.from({ length: 8 }, (_, i) => blk(i + 1, 100));
    const s = splitForCompaction(pages)!;
    expect(s.past).toHaveLength(6);
    expect(s.keep).toHaveLength(2);
  });

  it('páginas antigas pesadas entram no passado mesmo sendo poucas', () => {
    // 70 + 10 + 10 + 10 = 100 → prefixo ≤ 75 é [70]
    const s = splitForCompaction([blk(1, 70), blk(2, 10), blk(3, 10), blk(4, 10)])!;
    expect(s.past.map((b) => b.order_index)).toEqual([1]);
    expect(s.keep).toHaveLength(3);
  });

  it('sempre deixa ao menos 1 página de cada lado', () => {
    const heavyFirst = splitForCompaction([blk(1, 1000), blk(2, 1)])!;
    expect(heavyFirst.past.map((b) => b.order_index)).toEqual([1]);
    expect(heavyFirst.keep.map((b) => b.order_index)).toEqual([2]);
    const light = splitForCompaction([blk(1, 1), blk(2, 1000)])!;
    expect(light.past).toHaveLength(1);
    expect(light.keep).toHaveLength(1);
  });

  it('ordena por order_index e retorna null com menos de 2 páginas', () => {
    expect(splitForCompaction([blk(1, 5)])).toBeNull();
    expect(splitForCompaction([])).toBeNull();
    const s = splitForCompaction([blk(3, 10), blk(1, 10), blk(2, 10), blk(4, 10)])!;
    expect(s.past.map((b) => b.order_index)).toEqual([1, 2, 3]);
  });
});

describe('splitAtPage', () => {
  it('corta exatamente na página limite escolhida (primeira, intermediária ou penúltima)', () => {
    const pages = [blk(4, 10), blk(5, 100), blk(6, 50), blk(7, 20)];
    const atFirst = splitAtPage(pages, 4)!;
    expect(atFirst.past.map((p) => p.order_index)).toEqual([4]);
    expect(atFirst.keep.map((p) => p.order_index)).toEqual([5, 6, 7]);

    const atMid = splitAtPage(pages, 5)!;
    expect(atMid.past.map((p) => p.order_index)).toEqual([4, 5]);
    expect(atMid.keep.map((p) => p.order_index)).toEqual([6, 7]);

    const atPenultimate = splitAtPage(pages, 6)!;
    expect(atPenultimate.past.map((p) => p.order_index)).toEqual([4, 5, 6]);
    expect(atPenultimate.keep.map((p) => p.order_index)).toEqual([7]);
  });

  it('retorna null se escolher a última página, página inexistente ou menos de 2 páginas', () => {
    const pages = [blk(1, 10), blk(2, 10), blk(3, 10)];
    expect(splitAtPage(pages, 3)).toBeNull();
    expect(splitAtPage(pages, 99)).toBeNull();
    expect(splitAtPage([blk(1, 10)], 1)).toBeNull();
    expect(splitAtPage([], 1)).toBeNull();
  });
});

describe('COMPACTION_SYSTEM_PROMPT', () => {
  it('orienta concisão guiada pelos fatos sem fração fixa nem teto de palavras conflitante', () => {
    expect(COMPACTION_SYSTEM_PROMPT).toContain('Regra 2');
    expect(COMPACTION_SYSTEM_PROMPT).not.toContain('2.500 palavras');
    expect(COMPACTION_SYSTEM_PROMPT).not.toContain('um oitavo');
  });

  it('COMPACTION_REFINE_SYSTEM_PROMPT instrui correção de erros factuais, auditoria de omissões e integração', () => {
    expect(COMPACTION_REFINE_SYSTEM_PROMPT).toContain('Auditor Editorial');
    expect(COMPACTION_REFINE_SYSTEM_PROMPT).toContain('sinopse preliminar');
    expect(COMPACTION_REFINE_SYSTEM_PROMPT).toContain('ERROS FACTUAIS');
    expect(COMPACTION_REFINE_SYSTEM_PROMPT).toContain('Identifique e incorpore fatos omitidos');
  });
});

describe('appendChronicle', () => {
  it('usa o cabeçalho "## Crônica — Volume N" e separa volumes', () => {
    const v1 = appendChronicle('Mundo base.\n', 1, '  Resumo um.  ');
    expect(v1).toBe('Mundo base.\n\n## Crônica — Volume 1\nResumo um.');
    const v2 = appendChronicle(v1, 2, 'Resumo dois.');
    expect(v2).toBe('Mundo base.\n\n## Crônica — Volume 1\nResumo um.\n\n## Crônica — Volume 2\nResumo dois.');
  });

  it('não deixa linhas em branco iniciais quando o contexto é vazio', () => {
    expect(appendChronicle('  ', 1, 'Resumo.')).toBe('## Crônica — Volume 1\nResumo.');
  });
});

describe('compactação (rotas)', () => {
  let t: TestApp;
  let sessionId: string;

  beforeEach(async () => {
    t = withKey(await makeApp());
    sessionId = t.repos.sessions.create({
      title: 'x',
      system_rules: 'REGRAS',
      world_context: 'Mundo base.',
      model: 'gemini-2.5-flash',
    }).id;
  });

  const seed = (n: number, size = 40) =>
    Array.from({ length: n }, (_, i) =>
      t.repos.pages.append(sessionId, {
        player_instruction: `META-${i + 1}`,
        generated_text: `Página${i + 1} `.padEnd(size, '.'),
      }),
    );

  const preview = (body?: Record<string, unknown>) =>
    t.app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/compact/preview`, ...(body ? { payload: body } : {}) });
  const refine = (body: Record<string, unknown>) =>
    t.app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/compact/refine`, payload: body });
  const commit = (body: Record<string, unknown>) =>
    t.app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/compact/commit`, payload: body });

  describe('preview', () => {
    it('gera a minuta com os 75% mais antigos e não grava nada', async () => {
      seed(8);
      t.gateway.queue('  Sinopse factual dos fatos.  ');
      const res = await preview();
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        summary_text: 'Sinopse factual dos fatos.',
        covered_page_start_index: 1,
        covered_page_end_index: 6,
        pages_to_archive: 6,
        pages_to_keep: 2,
        next_volume_number: 1,
        model: 'gemini-2.5-flash',
      });

      // Só o Corpus Passado vai ao Arquivista — sem os recentes e sem meta-instruções.
      const req = t.gateway.requests[0]!;
      expect(req.systemInstruction).toContain('SINOPSE FACTUAL DENSA');
      expect(req.userText).toContain('Página1');
      expect(req.userText).toContain('Página6');
      expect(req.userText).not.toContain('Página7');
      expect(req.userText).not.toContain('Página8');
      expect(req.userText).not.toContain('META-');
      expect(req.userText).toContain('Mundo base.');
      expect(req.responseJsonSchema).toBeUndefined();
      expect(req.idleTimeoutMs).toBe(COMPACTION_IDLE_TIMEOUT_MS);

      // Nenhum efeito colateral
      expect(t.repos.archives.list(sessionId)).toHaveLength(0);
      expect(t.repos.pages.listActive(sessionId)).toHaveLength(8);
      expect(t.repos.sessions.get(sessionId)!.world_context).toBe('Mundo base.');
    });

    it('aceita covered_page_end_index explícito e rejeita página limite inválida com 409', async () => {
      seed(6);
      t.gateway.queue('Sinopse das 2 primeiras páginas.');
      const res = await preview({ covered_page_end_index: 2 });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        summary_text: 'Sinopse das 2 primeiras páginas.',
        covered_page_start_index: 1,
        covered_page_end_index: 2,
        pages_to_archive: 2,
        pages_to_keep: 4,
        next_volume_number: 1,
      });
      const req = t.gateway.requests[0]!;
      expect(req.userText).toContain('Página1');
      expect(req.userText).toContain('Página2');
      expect(req.userText).not.toContain('Página3');

      // Última página ativa (6) ou página inexistente (99) → 409
      expect((await preview({ covered_page_end_index: 6 })).statusCode).toBe(409);
      expect((await preview({ covered_page_end_index: 99 })).statusCode).toBe(409);
    });

    it('409 com menos de 2 páginas; 409 com diálogo ativo; 404', async () => {
      seed(1);
      expect((await preview()).statusCode).toBe(409);
      seed(3);
      t.repos.dialogues.create(sessionId, 'Elena', 'p');
      expect((await preview()).statusCode).toBe(409);
      expect(
        (await t.app.inject({ method: 'POST', url: '/api/sessions/x/compact/preview' })).statusCode,
      ).toBe(404);
    });

    it('502 se a IA falhar ou devolver vazio, e libera a sessão', async () => {
      seed(4);
      t.gateway.queue('   ');
      expect((await preview()).statusCode).toBe(502);
      t.gateway.queue('Agora foi.');
      expect((await preview()).statusCode).toBe(200);
    });

    it('409 sem chave', async () => {
      const bare = await makeApp();
      const sid = bare.repos.sessions.create({ title: 'x', system_rules: 'r', world_context: '' }).id;
      bare.repos.pages.append(sid, { player_instruction: null, generated_text: 'a' });
      bare.repos.pages.append(sid, { player_instruction: null, generated_text: 'b' });
      const res = await bare.app.inject({ method: 'POST', url: `/api/sessions/${sid}/compact/preview` });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('missing_api_key');
    });
  });

  describe('refine', () => {
    it('audita o texto original contra a sinopse atual e devolve a versão enriquecida', async () => {
      seed(6);
      t.gateway.queue('Sinopse enriquecida após auditoria: inclui detalhes da espada.');
      const res = await refine({
        current_summary: 'Sinopse preliminar sem a espada.',
        covered_page_end_index: 3,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        summary_text: 'Sinopse enriquecida após auditoria: inclui detalhes da espada.',
        covered_page_start_index: 1,
        covered_page_end_index: 3,
        pages_to_archive: 3,
        pages_to_keep: 3,
        next_volume_number: 1,
      });

      const req = t.gateway.requests[0]!;
      expect(req.systemInstruction).toContain('Auditor Editorial');
      expect(req.userText).toContain('Página1');
      expect(req.userText).toContain('Página3');
      expect(req.userText).not.toContain('Página4');
      expect(req.userText).toContain('Sinopse preliminar sem a espada.');
      expect(req.idleTimeoutMs).toBe(COMPACTION_IDLE_TIMEOUT_MS);
    });

    it('rejeita sinopse vazia (400), página limite inválida (409) e diálogo ativo (409)', async () => {
      seed(4);
      expect((await refine({ current_summary: '   ', covered_page_end_index: 2 })).statusCode).toBe(400);
      expect((await refine({ current_summary: 'ok', covered_page_end_index: 4 })).statusCode).toBe(409);
      expect((await refine({ current_summary: 'ok', covered_page_end_index: 99 })).statusCode).toBe(409);

      t.repos.dialogues.create(sessionId, 'NPC', 'p');
      expect((await refine({ current_summary: 'ok', covered_page_end_index: 2 })).statusCode).toBe(409);
    });
  });

  describe('commit', () => {
    it('arquiva o passado, grava o volume e anexa a crônica ao world_context', async () => {
      seed(8);
      const res = await commit({
        summary_text: '  Sinopse revisada pelo autor.  ',
        covered_page_start_index: 1,
        covered_page_end_index: 6,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.archived_pages).toBe(6);
      expect(body.archive).toMatchObject({
        volume_number: 1,
        summary_text: 'Sinopse revisada pelo autor.',
        covered_page_start_index: 1,
        covered_page_end_index: 6,
      });
      expect(body.session.world_context).toBe('Mundo base.\n\n## Crônica — Volume 1\nSinopse revisada pelo autor.');

      expect(t.repos.pages.listActive(sessionId).map((b) => b.order_index)).toEqual([7, 8]);
      expect(t.repos.pages.listAll(sessionId)).toHaveLength(8);
    });

    it('o payload seguinte usa a crônica e não as páginas arquivadas (HP recupera espaço)', async () => {
      seed(8);
      await commit({ summary_text: 'Resumo curto.', covered_page_start_index: 1, covered_page_end_index: 6 });
      const count = await t.app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/token-count` });
      expect(count.statusCode).toBe(200);
      const measured = t.gateway.countRequests.at(-1)!;
      expect(measured.userText).toContain('## Crônica — Volume 1\nResumo curto.');
      expect(measured.userText).toContain('Página7');
      expect(measured.userText).not.toContain('Página3');
    });

    it('segunda compactação cria o Volume 2 sem reutilizar índices', async () => {
      seed(8);
      await commit({ summary_text: 'Resumo um.', covered_page_start_index: 1, covered_page_end_index: 6 });
      seed(6); // índices 9..14
      expect(t.repos.pages.listActive(sessionId).map((b) => b.order_index)).toEqual([7, 8, 9, 10, 11, 12, 13, 14]);

      t.gateway.queue('Resumo dois.');
      const pv = (await preview()).json();
      expect(pv).toMatchObject({ covered_page_start_index: 7, next_volume_number: 2 });
      const res = await commit({
        summary_text: pv.summary_text,
        covered_page_start_index: pv.covered_page_start_index,
        covered_page_end_index: pv.covered_page_end_index,
      });
      expect(res.json().archive.volume_number).toBe(2);
      expect(res.json().session.world_context).toBe(
        'Mundo base.\n\n## Crônica — Volume 1\nResumo um.\n\n## Crônica — Volume 2\nResumo dois.',
      );
    });

    it('rejeita faixas que não são prefixo das páginas ativas, sem alterar nada', async () => {
      seed(8);
      const bad = [
        { covered_page_start_index: 2, covered_page_end_index: 6 }, // não começa no primeiro ativo
        { covered_page_start_index: 1, covered_page_end_index: 8 }, // consumiria a última página
        { covered_page_start_index: 1, covered_page_end_index: 99 },
        { covered_page_start_index: 4, covered_page_end_index: 2 },
      ];
      for (const range of bad) {
        const res = await commit({ summary_text: 'x', ...range });
        expect(res.statusCode, JSON.stringify(range)).toBe(409);
      }
      expect(t.repos.archives.list(sessionId)).toHaveLength(0);
      expect(t.repos.pages.listActive(sessionId)).toHaveLength(8);
      expect(t.repos.sessions.get(sessionId)!.world_context).toBe('Mundo base.');
    });

    it('rejeita sinopse vazia e corpo inválido; 409 com diálogo ativo', async () => {
      seed(4);
      const range = { covered_page_start_index: 1, covered_page_end_index: 3 };
      expect((await commit({ summary_text: '   ', ...range })).statusCode).toBe(400);
      expect((await commit({ summary_text: 'x' })).statusCode).toBe(400);
      t.repos.dialogues.create(sessionId, 'Elena', 'p');
      expect((await commit({ summary_text: 'x', ...range })).statusCode).toBe(409);
    });

    it('é atômico: falha no último passo desfaz volume e arquivamento', async () => {
      seed(4);
      // A falha ocorre DEPOIS de criar o volume e arquivar as páginas, no update do world_context.
      t.repos.sessions.update = () => {
        throw new Error('falha simulada');
      };
      const res = await commit({ summary_text: 'x', covered_page_start_index: 1, covered_page_end_index: 3 });
      expect(res.statusCode).toBe(500);
      expect(t.repos.pages.listActive(sessionId)).toHaveLength(4);
      expect(t.repos.archives.list(sessionId)).toHaveLength(0);
      expect(t.repos.sessions.get(sessionId)!.world_context).toBe('Mundo base.');
    });

    it('descarta os trechos WAV em cache de páginas arquivadas ao consolidar volume', async () => {
      seed(4);
      const activePages = t.repos.pages.listActive(sessionId);
      const p1 = activePages[0]!;
      const p4 = activePages[3]!;

      // Simula áudio e chunks salvos na página 1 (que será arquivada) e página 4 (que continuará ativa)
      const fakeChunk = {
        chunk_index: 0,
        chunk_sha256: 'h1',
        voice: 'Gacrux',
        model: 'gemini-3.8-flash-tts',
        style: '',
        duration_ms: 100,
        audio: Buffer.from('RIFF...fake chunk'),
      };
      const fakeAudio = {
        text_sha256: 'h1',
        voice: 'Gacrux',
        model: 'gemini-3.8-flash-tts',
        style: '',
        duration_ms: 100,
        audio: Buffer.from('ID3...fake mp3'),
      };
      t.repos.audio.save(p1.id, fakeAudio, [fakeChunk]);
      t.repos.audio.save(p4.id, fakeAudio, [fakeChunk]);

      expect(t.repos.audio.getChunks(p1.id)).toHaveLength(1);
      expect(t.repos.audio.getChunks(p4.id)).toHaveLength(1);

      // Consolida páginas 1..3 em um volume
      const res = await commit({ summary_text: 'Sinopse.', covered_page_start_index: 1, covered_page_end_index: 3 });
      expect(res.statusCode).toBe(200);

      // Na página 1 arquivada: os chunks de cache foram liberados, mas o MP3 consolidado continua intacto para leitura
      expect(t.repos.audio.getChunks(p1.id)).toHaveLength(0);
      expect(t.repos.audio.meta(p1.id)).toBeDefined();

      // Na página 4 mantida ativa: chunks continuam para futuro reuso
      expect(t.repos.audio.getChunks(p4.id)).toHaveLength(1);
    });
  });
});
