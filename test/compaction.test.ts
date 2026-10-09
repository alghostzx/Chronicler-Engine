import { beforeEach, describe, expect, it } from 'vitest';
import { appendChronicle, splitForCompaction } from '../src/ai/compaction.js';
import { makeApp, withKey, type TestApp } from './helpers.js';

const blk = (order_index: number, size: number) => ({ order_index, generated_text: 'x'.repeat(size) });

describe('splitForCompaction', () => {
  it('divide 75/25 pelo peso, não pela contagem de blocos', () => {
    // pesos: 10,10,10,10,60 → total 100; prefixo ≤ 75: 10+10+10+10=40; +60=100 > 75 → corte em 4
    const s = splitForCompaction([blk(1, 10), blk(2, 10), blk(3, 10), blk(4, 10), blk(5, 60)])!;
    expect(s.past.map((b) => b.order_index)).toEqual([1, 2, 3, 4]);
    expect(s.keep.map((b) => b.order_index)).toEqual([5]);
  });

  it('com blocos uniformes aproxima 75% dos blocos', () => {
    const blocks = Array.from({ length: 8 }, (_, i) => blk(i + 1, 100));
    const s = splitForCompaction(blocks)!;
    expect(s.past).toHaveLength(6);
    expect(s.keep).toHaveLength(2);
  });

  it('blocos antigos pesados entram no passado mesmo sendo poucos', () => {
    // 70 + 10 + 10 + 10 = 100 → prefixo ≤ 75 é [70]
    const s = splitForCompaction([blk(1, 70), blk(2, 10), blk(3, 10), blk(4, 10)])!;
    expect(s.past.map((b) => b.order_index)).toEqual([1]);
    expect(s.keep).toHaveLength(3);
  });

  it('sempre deixa ao menos 1 bloco de cada lado', () => {
    const heavyFirst = splitForCompaction([blk(1, 1000), blk(2, 1)])!;
    expect(heavyFirst.past.map((b) => b.order_index)).toEqual([1]);
    expect(heavyFirst.keep.map((b) => b.order_index)).toEqual([2]);
    const light = splitForCompaction([blk(1, 1), blk(2, 1000)])!;
    expect(light.past).toHaveLength(1);
    expect(light.keep).toHaveLength(1);
  });

  it('ordena por order_index e retorna null com menos de 2 blocos', () => {
    expect(splitForCompaction([blk(1, 5)])).toBeNull();
    expect(splitForCompaction([])).toBeNull();
    const s = splitForCompaction([blk(3, 10), blk(1, 10), blk(2, 10), blk(4, 10)])!;
    expect(s.past.map((b) => b.order_index)).toEqual([1, 2, 3]);
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
      t.repos.blocks.append(sessionId, {
        player_instruction: `META-${i + 1}`,
        generated_text: `Bloco${i + 1} `.padEnd(size, '.'),
      }),
    );

  const preview = () => t.app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/compact/preview` });
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
        covered_block_start_index: 1,
        covered_block_end_index: 6,
        blocks_to_archive: 6,
        blocks_to_keep: 2,
        next_volume_number: 1,
        model: 'gemini-2.5-flash',
      });

      // Só o Corpus Passado vai ao Arquivista — sem os recentes e sem meta-instruções.
      const req = t.gateway.requests[0]!;
      expect(req.systemInstruction).toContain('SINOPSE FACTUAL DENSA');
      expect(req.userText).toContain('Bloco1');
      expect(req.userText).toContain('Bloco6');
      expect(req.userText).not.toContain('Bloco7');
      expect(req.userText).not.toContain('Bloco8');
      expect(req.userText).not.toContain('META-');
      expect(req.userText).toContain('Mundo base.');
      expect(req.responseJsonSchema).toBeUndefined();

      // Nenhum efeito colateral
      expect(t.repos.archives.list(sessionId)).toHaveLength(0);
      expect(t.repos.blocks.listActive(sessionId)).toHaveLength(8);
      expect(t.repos.sessions.get(sessionId)!.world_context).toBe('Mundo base.');
    });

    it('409 com menos de 2 blocos; 409 com diálogo ativo; 404', async () => {
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
      bare.repos.blocks.append(sid, { player_instruction: null, generated_text: 'a' });
      bare.repos.blocks.append(sid, { player_instruction: null, generated_text: 'b' });
      const res = await bare.app.inject({ method: 'POST', url: `/api/sessions/${sid}/compact/preview` });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('missing_api_key');
    });
  });

  describe('commit', () => {
    it('arquiva o passado, grava o volume e anexa a crônica ao world_context', async () => {
      seed(8);
      const res = await commit({
        summary_text: '  Sinopse revisada pelo autor.  ',
        covered_block_start_index: 1,
        covered_block_end_index: 6,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.archived_blocks).toBe(6);
      expect(body.archive).toMatchObject({
        volume_number: 1,
        summary_text: 'Sinopse revisada pelo autor.',
        covered_block_start_index: 1,
        covered_block_end_index: 6,
      });
      expect(body.session.world_context).toBe('Mundo base.\n\n## Crônica — Volume 1\nSinopse revisada pelo autor.');

      expect(t.repos.blocks.listActive(sessionId).map((b) => b.order_index)).toEqual([7, 8]);
      expect(t.repos.blocks.listAll(sessionId)).toHaveLength(8);
    });

    it('o payload seguinte usa a crônica e não os blocos arquivados (HP recupera espaço)', async () => {
      seed(8);
      await commit({ summary_text: 'Resumo curto.', covered_block_start_index: 1, covered_block_end_index: 6 });
      const count = await t.app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/token-count` });
      expect(count.statusCode).toBe(200);
      const measured = t.gateway.countRequests.at(-1)!;
      expect(measured.userText).toContain('## Crônica — Volume 1\nResumo curto.');
      expect(measured.userText).toContain('Bloco7');
      expect(measured.userText).not.toContain('Bloco3');
    });

    it('segunda compactação cria o Volume 2 sem reutilizar índices', async () => {
      seed(8);
      await commit({ summary_text: 'Resumo um.', covered_block_start_index: 1, covered_block_end_index: 6 });
      seed(6); // índices 9..14
      expect(t.repos.blocks.listActive(sessionId).map((b) => b.order_index)).toEqual([7, 8, 9, 10, 11, 12, 13, 14]);

      t.gateway.queue('Resumo dois.');
      const pv = (await preview()).json();
      expect(pv).toMatchObject({ covered_block_start_index: 7, next_volume_number: 2 });
      const res = await commit({
        summary_text: pv.summary_text,
        covered_block_start_index: pv.covered_block_start_index,
        covered_block_end_index: pv.covered_block_end_index,
      });
      expect(res.json().archive.volume_number).toBe(2);
      expect(res.json().session.world_context).toBe(
        'Mundo base.\n\n## Crônica — Volume 1\nResumo um.\n\n## Crônica — Volume 2\nResumo dois.',
      );
    });

    it('rejeita faixas que não são prefixo dos blocos ativos, sem alterar nada', async () => {
      seed(8);
      const bad = [
        { covered_block_start_index: 2, covered_block_end_index: 6 }, // não começa no primeiro ativo
        { covered_block_start_index: 1, covered_block_end_index: 8 }, // consumiria o último bloco
        { covered_block_start_index: 1, covered_block_end_index: 99 },
        { covered_block_start_index: 4, covered_block_end_index: 2 },
      ];
      for (const range of bad) {
        const res = await commit({ summary_text: 'x', ...range });
        expect(res.statusCode, JSON.stringify(range)).toBe(409);
      }
      expect(t.repos.archives.list(sessionId)).toHaveLength(0);
      expect(t.repos.blocks.listActive(sessionId)).toHaveLength(8);
      expect(t.repos.sessions.get(sessionId)!.world_context).toBe('Mundo base.');
    });

    it('rejeita sinopse vazia e corpo inválido; 409 com diálogo ativo', async () => {
      seed(4);
      const range = { covered_block_start_index: 1, covered_block_end_index: 3 };
      expect((await commit({ summary_text: '   ', ...range })).statusCode).toBe(400);
      expect((await commit({ summary_text: 'x' })).statusCode).toBe(400);
      t.repos.dialogues.create(sessionId, 'Elena', 'p');
      expect((await commit({ summary_text: 'x', ...range })).statusCode).toBe(409);
    });

    it('é atômico: falha no último passo desfaz volume e arquivamento', async () => {
      seed(4);
      // A falha ocorre DEPOIS de criar o volume e arquivar os blocos, no update do world_context.
      t.repos.sessions.update = () => {
        throw new Error('falha simulada');
      };
      const res = await commit({ summary_text: 'x', covered_block_start_index: 1, covered_block_end_index: 3 });
      expect(res.statusCode).toBe(500);
      expect(t.repos.blocks.listActive(sessionId)).toHaveLength(4);
      expect(t.repos.archives.list(sessionId)).toHaveLength(0);
      expect(t.repos.sessions.get(sessionId)!.world_context).toBe('Mundo base.');
    });
  });
});
