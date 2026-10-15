import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SynthesisError } from '../src/ai/gateway.js';
import { openDatabase } from '../src/db/connection.js';
import { createRepositories } from '../src/db/index.js';
import { sha256 } from '../src/tts/service.js';
import { fakeWav, makeApp, mockGateway, narratorJson, npcJson, parseSse, withKey, type TestApp } from './helpers.js';

let t: TestApp;
let sessionId: string;

const TEXT = 'A neblina subia do porto.\n\nVarn não acolhia ninguém.';

async function setup(gateway = mockGateway(), audio: Parameters<typeof makeApp>[1] = {}) {
  t = withKey(await makeApp(gateway, audio));
  sessionId = t.repos.sessions.create({ title: 'Crônica de Teste', system_rules: 'R', world_context: 'W' }).id;
}
beforeEach(() => setup());
afterEach(() => t.app.close());

const addPage = (text = TEXT) => t.repos.pages.append(sessionId, { player_instruction: 'vou', generated_text: text });
const generate = (pageId: string) => t.app.inject({ method: 'POST', url: `/api/narrative/pages/${pageId}/audio` });
const status = async (pageId: string) =>
  (await t.app.inject({ method: 'GET', url: `/api/narrative/pages/${pageId}/audio/status` })).json().audio;
const getAudio = (pageId: string, headers: Record<string, string> = {}, query = '') =>
  t.app.inject({ method: 'GET', url: `/api/narrative/pages/${pageId}/audio${query}`, headers });

/** Espera o job da página sair de "generating". */
async function settle(pageId: string) {
  for (let i = 0; i < 400; i++) {
    const a = await status(pageId);
    if (!a || a.status !== 'generating') return a;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('a geração de áudio não terminou');
}
const audioRows = () => t.repos.audio.usage().count;

describe('geração e leitura do áudio', () => {
  it('gera em segundo plano (202 imediato), guarda MP3 no SQLite e o serve', async () => {
    const page = addPage();
    const res = await generate(page.id);
    expect(res.statusCode).toBe(202);
    expect(res.json().audio.status).toBe('generating');

    const done = await settle(page.id);
    expect(done).toMatchObject({ status: 'ready', voice: 'Gacrux', model: 'gemini-3.8-flash-tts' });
    expect(done.duration_ms).toBeGreaterThan(0);

    const meta = t.repos.audio.meta(page.id)!;
    expect(meta.mime).toBe('audio/mpeg');
    expect(meta.bytes).toBe(done.bytes);

    const file = await getAudio(page.id);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('audio/mpeg');
    expect(file.headers['accept-ranges']).toBe('bytes');
    expect(file.rawPayload.length).toBe(meta.bytes);
    expect(file.rawPayload[0]).toBe(0xff); // quadro MP3
  });

  it('usa voz, modelo e estilo configurados; o texto vai limpo e o estilo não vai dentro do texto', async () => {
    await t.app.inject({
      method: 'PUT',
      url: '/api/settings/tts',
      payload: { voice: 'Algenib', model: 'gemini-3.8-flash-lite-tts', style: 'bem devagar' },
    });
    const page = addPage('Ele disse *baixinho*.\n\n---\n\nFim.');
    await generate(page.id);
    await settle(page.id);
    const req = t.gateway.synthRequests[0]!;
    expect(req).toMatchObject({ voice: 'Algenib', model: 'gemini-3.8-flash-lite-tts', style: 'bem devagar' });
    expect(req.text).toBe('Ele disse baixinho.\n\nFim.');
    expect(req.text).not.toContain('bem devagar');
  });

  it('é cache: ler várias vezes não chama a API de novo', async () => {
    const page = addPage();
    await generate(page.id);
    await settle(page.id);
    expect(t.gateway.synthRequests).toHaveLength(1);
    for (let i = 0; i < 3; i++) await getAudio(page.id);
    await status(page.id);
    expect(t.gateway.synthRequests).toHaveLength(1);
  });

  it('serve Range (206) e rejeita intervalo inválido (416)', async () => {
    const page = addPage();
    await generate(page.id);
    await settle(page.id);
    const size = t.repos.audio.meta(page.id)!.bytes;
    const part = await getAudio(page.id, { range: 'bytes=10-19' });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 10-19/${size}`);
    expect(part.rawPayload.length).toBe(10);
    const tail = await getAudio(page.id, { range: 'bytes=-5' });
    expect(tail.rawPayload.length).toBe(5);
    expect((await getAudio(page.id, { range: `bytes=${size + 10}-` })).statusCode).toBe(416);
  });

  it('?download=1 devolve como anexo .mp3', async () => {
    const page = addPage();
    await generate(page.id);
    await settle(page.id);
    const res = await getAudio(page.id, {}, '?download=true');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="[^"]+\.mp3"/);
    expect(res.headers['content-disposition']).toContain('P%C3%A1gina%201.mp3');
  });

  it('página longa vira vários trechos em paralelo, preservando ordem e progresso', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await setup(
      mockGateway({
        synthesize: async (req) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 10));
          inFlight--;
          return fakeWav(req.text);
        },
      }),
      { audio: { chunkChars: 60 } },
    );
    const text = Array.from({ length: 6 }, (_, i) => `Parágrafo número ${i + 1} da história.`).join('\n\n');
    const page = addPage(text);
    await generate(page.id);
    await settle(page.id);
    const sent = t.gateway.synthRequests.map((r) => r.text);
    expect(sent.length).toBeGreaterThan(2);
    expect(sent.every((s) => s.length <= 60)).toBe(true);
    expect(sent.join('\n\n')).toBe(text);
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
    // duração = soma dos trechos + silêncios (250 ms) entre eles
    const spoken = sent.reduce((n, s) => n + s.length * 10, 0);
    expect(t.repos.audio.meta(page.id)!.duration_ms).toBeGreaterThanOrEqual(spoken + (sent.length - 1) * 250 - 5);
  });

  it('gera o áudio também de páginas arquivadas (consumidas por volumes)', async () => {
    const page = addPage();
    addPage('Outra.');
    t.repos.pages.archiveRange(sessionId, 1, 1);
    await generate(page.id);
    expect((await settle(page.id)).status).toBe('ready');
    expect((await getAudio(page.id)).statusCode).toBe(200);
  });

  it('sem chave → 409 missing_api_key; página inexistente → 404; sem texto → 409', async () => {
    const page = addPage();
    t.repos.settings.delete('gemini_api_key');
    const res = await generate(page.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('missing_api_key');
    withKey(t);
    expect((await generate('nao-existe')).statusCode).toBe(404);
    const blank = addPage('***\n---');
    expect((await generate(blank.id)).statusCode).toBe(409);
    expect((await getAudio(page.id)).statusCode).toBe(404);
  });

  it('páginas e a sessão expõem o estado do áudio (audio: null | ready)', async () => {
    const a = addPage();
    const b = addPage('Outra página.');
    await generate(a.id);
    await settle(a.id);
    const detail = (await t.app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` })).json();
    expect(detail.pages.find((p: any) => p.id === a.id).audio.status).toBe('ready');
    expect(detail.pages.find((p: any) => p.id === b.id).audio).toBeNull();
    expect(JSON.stringify(detail)).not.toContain('"audio":{"type"'); // sem bytes na listagem
  });
});

describe('falhas, tentativas e cancelamento', () => {
  it('tenta de novo em falha transitória e acaba com sucesso', async () => {
    let calls = 0;
    await setup(
      mockGateway({
        synthesize: async (req) => {
          if (++calls < 3) throw new SynthesisError('limite', true);
          return fakeWav(req.text);
        },
      }),
    );
    const page = addPage();
    await generate(page.id);
    expect((await settle(page.id)).status).toBe('ready');
    expect(calls).toBe(3);
  });

  it('falha não transitória aparece como erro em pt-BR, sem tentar de novo, sem guardar áudio', async () => {
    let calls = 0;
    await setup(
      mockGateway({
        synthesize: async () => {
          calls++;
          throw new SynthesisError('O texto foi bloqueado.');
        },
      }),
    );
    const page = addPage();
    await generate(page.id);
    expect(await settle(page.id)).toEqual({ status: 'error', error: 'O texto foi bloqueado.' });
    expect(calls).toBe(1);
    expect(audioRows()).toBe(0);
    // tentar de novo é permitido
    await generate(page.id);
    await settle(page.id);
    expect(calls).toBe(2);
  });

  it('desiste após esgotar as tentativas em falha transitória', async () => {
    let calls = 0;
    await setup(
      mockGateway({
        synthesize: async () => {
          calls++;
          throw new SynthesisError('cota', true);
        },
      }),
    );
    const page = addPage();
    await generate(page.id);
    expect((await settle(page.id)).status).toBe('error');
    expect(calls).toBe(3); // 1 + 2 tentativas
  });

  it('se gerar de novo falhar, o áudio antigo continua (com o erro anotado)', async () => {
    let fail = false;
    await setup(
      mockGateway({
        synthesize: async (req) => {
          if (fail) throw new SynthesisError('cota esgotada');
          return fakeWav(req.text);
        },
      }),
    );
    const page = addPage();
    await generate(page.id);
    await settle(page.id);
    fail = true;
    await generate(page.id);
    const a = await settle(page.id);
    expect(a).toMatchObject({ status: 'ready', error: 'cota esgotada' });
    expect((await getAudio(page.id)).statusCode).toBe(200);
  });

  it('se um dos trechos paralelos falha, cancela os demais e registra erro', async () => {
    await setup(
      mockGateway({
        synthesize: async (req) => {
          if (req.text.includes('Falha')) throw new SynthesisError('Erro no trecho');
          await new Promise((r) => setTimeout(r, 60));
          return fakeWav(req.text);
        },
      }),
      { audio: { chunkChars: 60 } },
    );
    const text = 'Primeiro trecho ok.\n\nFalha neste trecho.\n\nTerceiro trecho ok.';
    const page = addPage(text);
    await generate(page.id);
    const res = await settle(page.id);
    expect(res.status).toBe('error');
    expect(res.error).toBe('Erro no trecho');
    expect(audioRows()).toBe(0);
  });

  it('cancelar interrompe o job e nada é gravado', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await setup(mockGateway({ synthesize: async (req) => (await gate, fakeWav(req.text)) }));
    const page = addPage();
    await generate(page.id);
    expect((await status(page.id)).status).toBe('generating');
    const res = await t.app.inject({ method: 'POST', url: `/api/narrative/pages/${page.id}/audio/cancel` });
    expect(res.json().audio).toBeNull();
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(audioRows()).toBe(0);
    expect(await status(page.id)).toBeNull();
  });

  it('respeita o máximo de jobs simultâneos: o excedente espera na fila', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await setup(mockGateway({ synthesize: async (req) => (await gate, fakeWav(req.text)) }), {
      audio: { maxConcurrent: 1 },
    });
    const a = addPage('Primeira.');
    const b = addPage('Segunda.');
    await generate(a.id);
    await generate(b.id);
    expect((await status(a.id)).queued).toBe(false);
    expect((await status(b.id)).queued).toBe(true);
    release();
    expect((await settle(a.id)).status).toBe('ready');
    expect((await settle(b.id)).status).toBe('ready');
  });
});

describe('descarte do áudio', () => {
  async function narrated(text = TEXT) {
    const page = addPage(text);
    await generate(page.id);
    await settle(page.id);
    expect(t.repos.audio.meta(page.id)).toBeDefined();
    return page;
  }

  it('editar o texto da página apaga o áudio', async () => {
    const page = await narrated();
    const res = await t.app.inject({
      method: 'PUT',
      url: `/api/narrative/pages/${page.id}`,
      payload: { generated_text: 'Texto novo.' },
    });
    expect(res.json().page.audio).toBeNull();
    expect(t.repos.audio.meta(page.id)).toBeUndefined();
    expect((await getAudio(page.id)).statusCode).toBe(404);
  });

  it('re-gerar a página (Editar prompt) apaga o áudio e o das páginas descartadas', async () => {
    const p1 = await narrated('Um.');
    const p2 = await narrated('Dois.');
    expect(audioRows()).toBe(2);
    t.gateway.queue(narratorJson('Um novo.'));
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/narrative/pages/${p1.id}/regenerate`,
      payload: { player_instruction: 'outra coisa', confirm_truncate: true },
    });
    expect(res.statusCode).toBe(200);
    expect(audioRows()).toBe(0);
    expect(t.repos.pages.get(p2.id)).toBeUndefined();
  });

  it('ramificar apaga o áudio das páginas descartadas e preserva o da página mantida', async () => {
    const p1 = await narrated('Um.');
    const p2 = await narrated('Dois.');
    const p3 = await narrated('Três.');
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/narrative/pages/${p1.id}/branch`,
      payload: { confirm_truncate: true },
    });
    expect(res.json().discarded).toBe(2);
    expect(t.repos.audio.meta(p1.id)).toBeDefined();
    expect(t.repos.audio.meta(p2.id)).toBeUndefined();
    expect(t.repos.audio.meta(p3.id)).toBeUndefined();
    expect(audioRows()).toBe(1);
  });

  it('excluir a sessão apaga todos os áudios', async () => {
    await narrated('Um.');
    await narrated('Dois.');
    expect((await t.app.inject({ method: 'DELETE', url: `/api/sessions/${sessionId}` })).statusCode).toBe(204);
    expect(audioRows()).toBe(0);
  });

  it('DELETE do áudio apaga só aquele; DELETE /api/audio apaga todos (páginas intactas)', async () => {
    const p1 = await narrated('Um.');
    await narrated('Dois.');
    const one = await t.app.inject({ method: 'DELETE', url: `/api/narrative/pages/${p1.id}/audio` });
    expect(one.json().audio).toBeNull();
    expect(audioRows()).toBe(1);
    const all = await t.app.inject({ method: 'DELETE', url: '/api/audio' });
    expect(all.json()).toMatchObject({ deleted: 1, usage: { count: 0, bytes: 0 } });
    expect(t.repos.pages.listAll(sessionId)).toHaveLength(2);
  });

  it('cinto de segurança: texto alterado por fora do fluxo invalida o áudio na leitura', async () => {
    const page = await narrated();
    t.repos.db.prepare('UPDATE narrative_pages SET generated_text = ? WHERE id = ?').run('Mudou por fora.', page.id);
    expect((await getAudio(page.id)).statusCode).toBe(404);
    expect(t.repos.audio.meta(page.id)).toBeUndefined(); // e foi apagado
  });

  it('cinto de segurança também vale na listagem da sessão', async () => {
    const page = await narrated();
    t.repos.db.prepare('UPDATE narrative_pages SET generated_text = ? WHERE id = ?').run('Mudou.', page.id);
    const detail = (await t.app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` })).json();
    expect(detail.pages[0].audio).toBeNull();
    expect(audioRows()).toBe(0);
  });

  it('corrida: página editada durante a geração → resultado descartado, nada é gravado', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await setup(mockGateway({ synthesize: async (req) => (await gate, fakeWav(req.text)) }));
    const page = addPage();
    await generate(page.id);
    // edição direta enquanto o job espera a API
    await t.app.inject({ method: 'PUT', url: `/api/narrative/pages/${page.id}`, payload: { generated_text: 'Editada.' } });
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(audioRows()).toBe(0);
    expect(await status(page.id)).toBeNull();
  });

  it('corrida: o resultado de um job obsoleto não grava nem se o job não foi cancelado (hash diferente)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await setup(mockGateway({ synthesize: async (req) => (await gate, fakeWav(req.text)) }));
    const page = addPage();
    await generate(page.id);
    // muda o texto "por fora", sem cancelar o job
    t.repos.db.prepare('UPDATE narrative_pages SET generated_text = ? WHERE id = ?').run('Outro.', page.id);
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(audioRows()).toBe(0);
  });
});

describe('geração automática', () => {
  const next = () =>
    t.app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/narrative/next`,
      payload: { player_instruction: 'avanço' },
    });
  const pageOf = (res: Awaited<ReturnType<typeof next>>) =>
    res.body
      .split('\n\n')
      .find((f) => f.startsWith('event: page'))!
      .split('\n')[1]!
      .slice(5);

  it('vem desligada: nenhuma síntese ao criar páginas', async () => {
    t.gateway.queue(narratorJson('Nova página.'));
    const res = await next();
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(t.gateway.synthRequests).toHaveLength(0);
    expect(JSON.parse(pageOf(res)).page.audio).toBeNull();
    expect((await t.app.inject({ method: 'GET', url: '/api/settings/tts' })).json().auto_default).toBe(false);
  });

  it('ligada globalmente: gera o áudio da página nova em segundo plano; o evento já traz "generating"', async () => {
    await t.app.inject({ method: 'PUT', url: '/api/settings/tts', payload: { auto_default: true } });
    t.gateway.queue(narratorJson('Nova página.'));
    const res = await next();
    const page = JSON.parse(pageOf(res)).page;
    expect(page.audio.status).toBe('generating');
    expect((await settle(page.id)).status).toBe('ready');
    expect(t.gateway.synthRequests.map((r) => r.text)).toEqual(['Nova página.']);
  });

  it('a configuração da sessão vence o padrão global (nos dois sentidos)', async () => {
    await t.app.inject({ method: 'PUT', url: '/api/settings/tts', payload: { auto_default: true } });
    await t.app.inject({ method: 'PUT', url: `/api/sessions/${sessionId}/context`, payload: { tts_auto: false } });
    t.gateway.queue(narratorJson('Sem áudio.'));
    await next();
    await new Promise((r) => setTimeout(r, 30));
    expect(t.gateway.synthRequests).toHaveLength(0);

    await t.app.inject({ method: 'PUT', url: '/api/settings/tts', payload: { auto_default: false } });
    const upd = await t.app.inject({ method: 'PUT', url: `/api/sessions/${sessionId}/context`, payload: { tts_auto: true } });
    expect(upd.json().session.tts_auto).toBe(true);
    t.gateway.queue(narratorJson('Com áudio.'));
    const res = await next();
    await settle(JSON.parse(pageOf(res)).page.id);
    expect(t.gateway.synthRequests.map((r) => r.text)).toEqual(['Com áudio.']);

    // null volta a herdar
    const inherit = await t.app.inject({ method: 'PUT', url: `/api/sessions/${sessionId}/context`, payload: { tts_auto: null } });
    expect(inherit.json().session.tts_auto).toBeNull();
  });

  it('falha de áudio (sem chave de voz etc.) nunca derruba o turno narrativo', async () => {
    await setup(
      mockGateway({
        synthesize: async () => {
          throw new SynthesisError('quebrou');
        },
      }),
    );
    await t.app.inject({ method: 'PUT', url: '/api/settings/tts', payload: { auto_default: true } });
    t.gateway.queue(narratorJson('Texto.'));
    const res = await next();
    expect(res.body).toContain('event: done');
    expect(res.body).not.toContain('event: error');
    expect(t.repos.pages.listActive(sessionId)).toHaveLength(1);
  });

  // Conversa e encerra um diálogo (o Narrador escreve a página em prosa); devolve a página.
  async function dialoguePage(): Promise<{ id: string; generated_text: string }> {
    t.repos.pages.append(sessionId, { player_instruction: 'x', generated_text: 'Prosa anterior.' });
    const dialogue = t.repos.dialogues.create(sessionId, 'Elena', 'Você é Elena.');
    t.gateway.queue(npcJson('Quem pergunta?'), npcJson('Hum.'));
    await t.app.inject({ method: 'POST', url: `/api/dialogue/${dialogue.id}/message`, payload: { message: 'Oi' } });
    await t.app.inject({ method: 'POST', url: `/api/dialogue/${dialogue.id}/message`, payload: { message: 'Tchau' } });
    await new Promise((r) => setTimeout(r, 30));
    expect(t.gateway.synthRequests).toHaveLength(0); // as falas soltas do diálogo nunca são narradas
    t.gateway.queue(narratorJson('Elena o encarou.\n\n— Oi.\n\nEla ergueu uma sobrancelha.\n\n— Quem pergunta?\n\n— Tchau.\n\n— Hum.'));
    const res = await t.app.inject({ method: 'POST', url: `/api/dialogue/${dialogue.id}/conclude` });
    expect(res.statusCode).toBe(200);
    return parseSse(res.body).find((e) => e.event === 'page')!.data.page;
  }

  it('com a narração automática desligada (padrão), a página de diálogo não é narrada', async () => {
    const page = await dialoguePage();
    await new Promise((r) => setTimeout(r, 30));
    expect(t.gateway.synthRequests).toHaveLength(0);
    expect(audioRows()).toBe(0);
    expect(page).toMatchObject({ audio: null });
  });

  it('com a opção única ligada, as falas soltas seguem sem áudio, mas a página de diálogo é narrada ao ser criada (texto sem marcações)', async () => {
    await t.app.inject({ method: 'PUT', url: '/api/settings/tts', payload: { auto_default: true } });
    const page = await dialoguePage(); // o auxiliar confere que as falas soltas nunca geram áudio
    expect((await settle(page.id)).status).toBe('ready');
    expect(t.gateway.synthRequests).toHaveLength(1);
    expect(t.gateway.synthRequests[0]!.text).toContain('Elena');
    expect(t.gateway.synthRequests[0]!.text).not.toContain('**');
  });

  it('a opção da sessão manda mais que a global, também para a página de diálogo', async () => {
    await t.app.inject({ method: 'PUT', url: '/api/settings/tts', payload: { auto_default: true } });
    t.repos.sessions.update(sessionId, { tts_auto: false });
    await dialoguePage();
    await new Promise((r) => setTimeout(r, 30));
    expect(t.gateway.synthRequests).toHaveLength(0);

    t.repos.sessions.update(sessionId, { tts_auto: true });
    await t.app.inject({ method: 'PUT', url: '/api/settings/tts', payload: { auto_default: false } });
    const page = await dialoguePage();
    expect((await settle(page.id)).status).toBe('ready');
    expect(t.gateway.synthRequests).toHaveLength(1);
  });

  it('páginas de diálogo também podem ser narradas sob demanda', async () => {
    const page = await dialoguePage();
    const res = await t.app.inject({ method: 'POST', url: `/api/narrative/pages/${page.id}/audio` });
    expect(res.statusCode).toBe(202);
    expect((await settle(page.id)).status).toBe('ready');
  });
});

describe('reprodução contínua: estado e geração em lote', () => {
  const batch = (from: string, sid = sessionId) =>
    t.app.inject({ method: 'POST', url: `/api/sessions/${sid}/audio/batch`, payload: { from_page_id: from } });
  const sessionAudioStatus = async (sid = sessionId) =>
    (await t.app.inject({ method: 'GET', url: `/api/sessions/${sid}/audio` })).json().pages as { page_id: string; order_index: number; kind: string; audio: any }[];
  const settleAll = async (ids: string[]) => {
    for (const id of ids) await settle(id);
  };

  it('GET /sessions/:id/audio lista as páginas ativas em ordem, com o estado do áudio de cada uma', async () => {
    const [p1, p2, p3] = [addPage('Um.'), addPage('Dois.'), addPage('Três.')];
    await generate(p2.id);
    await settle(p2.id);
    const pages = await sessionAudioStatus();
    expect(pages.map((p) => [p.page_id, p.order_index, p.kind])).toEqual([
      [p1.id, 1, 'narrative'],
      [p2.id, 2, 'narrative'],
      [p3.id, 3, 'narrative'],
    ]);
    expect(pages.map((p) => p.audio?.status ?? null)).toEqual([null, 'ready', null]);
    expect(JSON.stringify(pages)).not.toContain('"audio":{"type"'); // sem bytes
    expect((await t.app.inject({ method: 'GET', url: '/api/sessions/nao-existe/audio' })).statusCode).toBe(404);
  });

  it('batch agenda, EM ORDEM, só as páginas da escolhida em diante que não têm áudio nem geração', async () => {
    const [p1, p2, p3, p4] = [addPage('Um.'), addPage('Dois.'), addPage('Três.'), addPage('Quatro.')];
    await generate(p2.id);
    await settle(p2.id);
    const before = t.gateway.synthRequests.length;

    const res = await batch(p2.id);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.started).toEqual([p3.id, p4.id]); // a 1 é anterior; a 2 já está pronta
    expect(body.pages.find((p: any) => p.page_id === p1.id).audio).toBeNull();
    expect(body.pages.find((p: any) => p.page_id === p3.id).audio.status).toBe('generating');

    await settleAll([p3.id, p4.id]);
    const texts = t.gateway.synthRequests.slice(before).map((r) => r.text);
    expect(texts[0]).toContain('Três');
    expect(texts[1]).toContain('Quatro');
    expect((await sessionAudioStatus()).map((p) => p.audio?.status ?? null)).toEqual([null, 'ready', 'ready', 'ready']);
  });

  it('é idempotente (não duplica jobs) e retenta as páginas que falharam', async () => {
    let fail = true;
    await setup(
      mockGateway({
        synthesize: async (req) => {
          await new Promise((r) => setTimeout(r, 15));
          if (fail && req.text.includes('Quebra')) throw new SynthesisError('cota esgotada');
          return fakeWav(req.text);
        },
      }),
    );
    const [a, b] = [addPage('Boa.'), addPage('Quebra.')];
    const first = (await batch(a.id)).json();
    expect(first.started).toEqual([a.id, b.id]);
    expect((await batch(a.id)).json().started).toEqual([]); // ambas ainda gerando
    await settle(a.id);
    expect((await settle(b.id)).status).toBe('error');

    fail = false;
    expect((await batch(a.id)).json().started).toEqual([b.id]); // a pronta fica; a com erro tenta de novo
    expect((await settle(b.id)).status).toBe('ready');
    expect(t.gateway.synthRequests.filter((r) => r.text.includes('Boa')).length).toBe(1);
  });

  it('sem chave → 409 antes de agendar; sessão ou página fora do Tome → 404', async () => {
    const bare = await makeApp();
    const sid = bare.repos.sessions.create({ title: 'x', system_rules: 'r', world_context: '' }).id;
    const page = bare.repos.pages.append(sid, { player_instruction: 'a', generated_text: 'Texto.' });
    const res = await bare.app.inject({ method: 'POST', url: `/api/sessions/${sid}/audio/batch`, payload: { from_page_id: page.id } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('missing_api_key');

    const mine = addPage('Minha.');
    expect((await batch(mine.id, 'nao-existe')).statusCode).toBe(404);
    const other = t.repos.sessions.create({ title: 'Outra', system_rules: 'r', world_context: '' }).id;
    expect((await batch(mine.id, other)).statusCode).toBe(404); // a página não é desta sessão
    expect((await batch('nao-existe')).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/audio/batch`, payload: {} })).statusCode).toBe(400);
  });

  it('cancel interrompe só as gerações informadas e desta sessão', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await setup(mockGateway({ synthesize: async (req) => (await gate, fakeWav(req.text)) }), { audio: { maxConcurrent: 1 } });
    const [a, b, c] = [addPage('Um.'), addPage('Dois.'), addPage('Três.')];
    await batch(a.id);
    const foreignSession = t.repos.sessions.create({ title: 'Outra', system_rules: 'r', world_context: '' }).id;
    const foreign = t.repos.pages.append(foreignSession, { player_instruction: 'x', generated_text: 'Alheia.' });
    await generate(foreign.id);

    const res = await t.app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/audio/cancel`,
      payload: { page_ids: [b.id, c.id, foreign.id, 'nao-existe'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().cancelled).toEqual([b.id, c.id]);
    expect((await status(a.id)).status).toBe('generating'); // não pedida: continua
    expect(await status(b.id)).toBeNull();
    expect((await status(foreign.id)).status).toBe('generating'); // de outra sessão: intocada
    release();
    expect((await settle(a.id)).status).toBe('ready');
  });
});

describe('configurações de voz', () => {
  it('GET traz padrões, modelos, vozes e uso; PUT valida e persiste', async () => {
    const get = (await t.app.inject({ method: 'GET', url: '/api/settings/tts' })).json();
    expect(get).toMatchObject({
      auto_default: false,
      model: 'gemini-3.8-flash-tts',
      voice: 'Gacrux',
      usage: { count: 0, bytes: 0 },
    });
    expect(get.style).toContain('velho narrador');
    expect(get.voices.map((v: any) => v.id)).toContain('Gacrux');
    expect(get.voices).toHaveLength(30);
    expect(get.models.map((m: any) => m.id)).toContain('gemini-3.8-flash-tts');

    const put = await t.app.inject({ method: 'PUT', url: '/api/settings/tts', payload: { voice: 'Charon', auto_default: true } });
    expect(put.json()).toMatchObject({ voice: 'Charon', auto_default: true, model: 'gemini-3.8-flash-tts' });
    expect((await t.app.inject({ method: 'GET', url: '/api/settings/tts' })).json().voice).toBe('Charon');

    for (const bad of [{}, { voice: 'com espaço' }, { style: 'x'.repeat(301) }, { extra: 1 }, { auto_default: 'sim' }, { auto_dialogue_default: true }]) {
      expect((await t.app.inject({ method: 'PUT', url: '/api/settings/tts', payload: bad as never })).statusCode).toBe(400);
    }
  });

  it('amostra de voz devolve MP3 e não grava nada', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/settings/tts/sample',
      payload: { voice: 'Charon', style: 'rápido' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(res.rawPayload[0]).toBe(0xff);
    expect(t.gateway.synthRequests[0]).toMatchObject({ voice: 'Charon', style: 'rápido' });
    expect(audioRows()).toBe(0);
  });

  it('uso de armazenamento soma os áudios guardados', async () => {
    const page = addPage();
    await generate(page.id);
    await settle(page.id);
    const usage = (await t.app.inject({ method: 'GET', url: '/api/settings/tts' })).json().usage;
    expect(usage.count).toBe(1);
    expect(usage.bytes).toBe(t.repos.audio.meta(page.id)!.bytes);
  });
});

describe('armazenamento', () => {
  it('banco novo usa auto_vacuum incremental; apagar áudios devolve espaço ao arquivo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicler-av-'));
    try {
      const db = openDatabase(path.join(dir, 'x.db'));
      expect(db.pragma('auto_vacuum', { simple: true })).toBe(2);
      const repos = createRepositories(db);
      const s = repos.sessions.create({ title: 'T', system_rules: 'r', world_context: '' });
      const p = repos.pages.append(s.id, { player_instruction: null, generated_text: 'x' });
      const blob = Buffer.alloc(3 * 1024 * 1024, 7);
      repos.audio.put(p.id, { text_sha256: 'h', voice: 'v', model: 'm', style: '', duration_ms: 1, audio: blob });
      db.pragma('wal_checkpoint(TRUNCATE)');
      const big = fs.statSync(path.join(dir, 'x.db')).size;
      expect(big).toBeGreaterThan(3 * 1024 * 1024);
      repos.audio.delete(p.id);
      db.pragma('wal_checkpoint(TRUNCATE)');
      expect(fs.statSync(path.join(dir, 'x.db')).size).toBeLessThan(big / 4);
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('o BLOB é removido por CASCADE ao apagar a página', () => {
    const p = addPage();
    t.repos.audio.put(p.id, { text_sha256: 'h', voice: 'v', model: 'm', style: '', duration_ms: 1, audio: Buffer.from('abc') });
    t.repos.db.prepare('DELETE FROM narrative_pages WHERE id = ?').run(p.id);
    expect(audioRows()).toBe(0);
  });
});

describe('limite de chamadas por minuto e uma página por vez', () => {
  const WINDOW = 300;
  /** Cada parágrafo (≈ 40 caracteres) vira um trecho próprio com `chunkChars: 60`. */
  const paras = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `${tag}: parágrafo número ${i + 1} da história.`).join('\n\n');
  /** Gateway que registra o instante de início (e de fim) de cada chamada. */
  function recording(ms = 10) {
    const calls: { text: string; start: number; end: number }[] = [];
    const gateway = mockGateway({
      synthesize: async (req) => {
        const call = { text: req.text, start: Date.now(), end: 0 };
        calls.push(call);
        await new Promise((r) => setTimeout(r, ms));
        call.end = Date.now();
        return fakeWav(req.text);
      },
    });
    return { calls, gateway };
  }
  const limited = (rpm: number, window = WINDOW) => ({ audio: { chunkChars: 60, maxRequestsPerMinute: rpm, rateWindowMs: window, rateMarginMs: 0 } });

  it('por padrão só uma página roda por vez: a segunda espera na fila e começa quando a primeira termina', async () => {
    const { calls, gateway } = recording(20);
    await setup(gateway, limited(10_000));
    const a = addPage(paras('A', 3));
    const b = addPage(paras('B', 3));
    await generate(a.id);
    await generate(b.id);
    expect((await status(b.id)).queued).toBe(true);
    await settle(a.id);
    await settle(b.id);
    const lastA = Math.max(...calls.filter((c) => c.text.startsWith('A')).map((c) => c.end));
    const firstB = Math.min(...calls.filter((c) => c.text.startsWith('B')).map((c) => c.start));
    expect(firstB).toBeGreaterThanOrEqual(lastA);
  });

  it('páginas de 7 e de 5 trechos (limite 10): nenhuma janela de 1 minuto passa de 10 chamadas; o excedente espera o cooldown', async () => {
    const { calls, gateway } = recording();
    await setup(gateway, limited(10));
    const a = addPage(paras('A', 7));
    const b = addPage(paras('B', 5));
    await generate(a.id);
    await generate(b.id);
    expect((await settle(a.id)).status).toBe('ready');
    expect((await settle(b.id)).status).toBe('ready');
    expect(calls).toHaveLength(12);
    for (let i = 10; i < calls.length; i++) expect(calls[i]!.start - calls[i - 10]!.start).toBeGreaterThanOrEqual(WINDOW - 8);
    // o excedente (11ª e 12ª chamadas) esperou; as 10 primeiras saíram sem esperar
    expect(calls[9]!.start - calls[0]!.start).toBeLessThan(WINDOW / 2);
    expect(calls[10]!.start - calls[0]!.start).toBeGreaterThanOrEqual(WINDOW - 8);
  });

  it('páginas de 5 e de 4 trechos (limite 10): não há cooldown', async () => {
    const { calls, gateway } = recording();
    await setup(gateway, limited(10, 1500));
    const a = addPage(paras('A', 5));
    const b = addPage(paras('B', 4));
    await generate(a.id);
    await generate(b.id);
    await settle(a.id);
    await settle(b.id);
    expect(calls).toHaveLength(9);
    expect(calls[8]!.start - calls[0]!.start).toBeLessThan(700);
  });

  it('uma página com mais trechos que o limite termina, em ondas', async () => {
    const { calls, gateway } = recording();
    await setup(gateway, limited(10));
    const page = addPage(paras('A', 12));
    await generate(page.id);
    const done = await settle(page.id);
    expect(done.status).toBe('ready');
    expect(calls).toHaveLength(12);
    expect(calls[10]!.start - calls[0]!.start).toBeGreaterThanOrEqual(WINDOW - 8);
    // a ordem do áudio final é a do texto (checada pela duração: soma dos trechos + silêncios)
    const spoken = calls.reduce((n, c) => n + c.text.length * 10, 0);
    expect(t.repos.audio.meta(page.id)!.duration_ms).toBeGreaterThanOrEqual(spoken + 11 * 250 - 5);
  });

  it('expõe throttled/wait_ms enquanto espera o limite, e nada de throttled antes ou depois', async () => {
    const { gateway } = recording();
    await setup(gateway, limited(2, 600));
    const page = addPage(paras('A', 4));
    await generate(page.id);
    let seen: { throttled?: boolean; wait_ms?: number } | undefined;
    for (let i = 0; i < 200 && !seen; i++) {
      const s = await status(page.id);
      if (s?.throttled) seen = s;
      else await new Promise((r) => setTimeout(r, 5));
    }
    expect(seen?.throttled).toBe(true);
    expect(seen?.wait_ms).toBeGreaterThan(0);
    expect(seen?.wait_ms).toBeLessThanOrEqual(600);
    const done = await settle(page.id);
    expect(done.status).toBe('ready');
    expect(done.throttled).toBeUndefined();
  });

  it('cancelar durante a espera do limite interrompe o job, não faz mais chamadas e não deixa o fechamento esperando', async () => {
    const { calls, gateway } = recording();
    await setup(gateway, limited(1, 60_000));
    const page = addPage(paras('A', 3));
    await generate(page.id);
    for (let i = 0; i < 200 && !(await status(page.id))?.throttled; i++) await new Promise((r) => setTimeout(r, 5));
    expect((await status(page.id)).throttled).toBe(true);
    const res = await t.app.inject({ method: 'POST', url: `/api/narrative/pages/${page.id}/audio/cancel` });
    expect(res.statusCode).toBe(200);
    expect(await status(page.id)).toBeNull();
    await new Promise((r) => setTimeout(r, 40));
    expect(calls).toHaveLength(1);
    expect(audioRows()).toBe(0);
  });

  it('retentativas também contam no limite por minuto', async () => {
    let failedOnce = false;
    const calls: number[] = [];
    const gateway = mockGateway({
      synthesize: async (req) => {
        calls.push(Date.now());
        if (!failedOnce) {
          failedOnce = true;
          throw new SynthesisError('Limite atingido', true);
        }
        return fakeWav(req.text);
      },
    });
    await setup(gateway, limited(2));
    const a = addPage('Primeira.');
    const b = addPage('Segunda.');
    await generate(a.id);
    await generate(b.id);
    expect((await settle(a.id)).status).toBe('ready');
    expect((await settle(b.id)).status).toBe('ready');
    expect(calls).toHaveLength(3); // 1 falha + 1 retentativa + 1 da segunda página
    expect(calls[2]! - calls[0]!).toBeGreaterThanOrEqual(WINDOW - 8);
  });
});

describe('reaproveitamento incremental de trechos (cache por chunk)', () => {
  it('edição pontual de página reutiliza os trechos inalterados e só chama a API para o trecho novo', async () => {
    const calledTexts: string[] = [];
    await setup(
      mockGateway({
        synthesize: async (req) => {
          calledTexts.push(req.text);
          return fakeWav(req.text);
        },
      }),
      { audio: { chunkChars: 30 } },
    );

    const p1 = 'Primeiro parágrafo longo.';
    const p2 = 'Segundo parágrafo longo.';
    const p3 = 'Terceiro parágrafo longo.';
    const initialText = `${p1}\n\n${p2}\n\n${p3}`;

    const page = addPage(initialText);
    await generate(page.id);
    const firstAudio = await settle(page.id);
    expect(firstAudio.status).toBe('ready');
    expect(calledTexts).toEqual([p1, p2, p3]);

    // Chunks foram persistidos na tabela page_audio_chunks
    const initialChunks = t.repos.audio.getChunks(page.id);
    expect(initialChunks).toHaveLength(3);
    expect(initialChunks[0]!.chunk_sha256).toBe(sha256(p1));
    expect(initialChunks[1]!.chunk_sha256).toBe(sha256(p2));
    expect(initialChunks[2]!.chunk_sha256).toBe(sha256(p3));

    // Edita o 2º parágrafo mantendo o 1º e o 3º inalterados
    const p2Novo = 'Segundo parágrafo MODIFICADO.';
    const updatedText = `${p1}\n\n${p2Novo}\n\n${p3}`;
    const editRes = await t.app.inject({
      method: 'PUT',
      url: `/api/narrative/pages/${page.id}`,
      payload: { generated_text: updatedText },
    });
    expect(editRes.statusCode).toBe(200);
    // MP3 consolidado foi invalidado
    expect(t.repos.audio.meta(page.id)).toBeUndefined();
    // Mas os chunks continuam guardados para reaproveitamento
    expect(t.repos.audio.getChunks(page.id)).toHaveLength(3);

    // Gera o áudio novamente para a página editada
    calledTexts.length = 0;
    await generate(page.id);
    const secondAudio = await settle(page.id);
    expect(secondAudio.status).toBe('ready');

    // Apenas o trecho novo foi sintetizado na API do Gemini!
    expect(calledTexts).toEqual([p2Novo]);

    // O áudio final foi regerado e os chunks atualizados
    expect(t.repos.audio.meta(page.id)).toBeDefined();
    const updatedChunks = t.repos.audio.getChunks(page.id);
    expect(updatedChunks).toHaveLength(3);
    expect(updatedChunks[0]!.chunk_sha256).toBe(sha256(p1));
    expect(updatedChunks[1]!.chunk_sha256).toBe(sha256(p2Novo));
    expect(updatedChunks[2]!.chunk_sha256).toBe(sha256(p3));
  });

  it('alteração de voz nas configurações ignora o cache da voz antiga', async () => {
    const calledVoices: string[] = [];
    await setup(
      mockGateway({
        synthesize: async (req) => {
          calledVoices.push(req.voice);
          return fakeWav(req.text);
        },
      }),
      { audio: { chunkChars: 30 } },
    );

    const p1 = 'Primeiro trecho curto.';
    const p2 = 'Segundo trecho curto.';
    const page = addPage(`${p1}\n\n${p2}`);
    await generate(page.id);
    await settle(page.id);
    expect(calledVoices).toEqual(['Gacrux', 'Gacrux']);

    // Troca a voz para Aoede na rota correta de configurações
    const setRes = await t.app.inject({
      method: 'PUT',
      url: '/api/settings/tts',
      payload: { voice: 'Aoede' },
    });
    expect(setRes.statusCode).toBe(200);

    // Edita o texto levemente
    await t.app.inject({
      method: 'PUT',
      url: `/api/narrative/pages/${page.id}`,
      payload: { generated_text: `${p1}\n\nSegundo trecho mudou.` },
    });

    calledVoices.length = 0;
    await generate(page.id);
    await settle(page.id);

    // Ambos os trechos são sintetizados com a nova voz (não mistura vozes)
    expect(calledVoices).toEqual(['Aoede', 'Aoede']);
  });

  it('DELETE do áudio apaga tanto o consolidado quanto os trechos em page_audio_chunks', async () => {
    await setup(mockGateway({ synthesize: async (req) => fakeWav(req.text) }), {
      audio: { chunkChars: 30 },
    });
    const p1 = 'Primeiro trecho curto.';
    const p2 = 'Segundo trecho curto.';
    const page = addPage(`${p1}\n\n${p2}`);
    await generate(page.id);
    await settle(page.id);
    expect(t.repos.audio.getChunks(page.id)).toHaveLength(2);

    const res = await t.app.inject({ method: 'DELETE', url: `/api/narrative/pages/${page.id}/audio` });
    expect(res.statusCode).toBe(200);
    expect(t.repos.audio.meta(page.id)).toBeUndefined();
    expect(t.repos.audio.getChunks(page.id)).toHaveLength(0);
  });
});
