import { beforeEach, describe, expect, it } from 'vitest';
import { NARRATOR_RESPONSE_SCHEMA } from '../src/ai/narratorSchema.js';
import { makeApp, mockGateway, narratorJson, parseSse, withKey, type TestApp } from './helpers.js';

let t: TestApp;
let sessionId: string;

beforeEach(async () => {
  t = withKey(await makeApp());
  sessionId = t.repos.sessions.create({
    title: 'Teste',
    system_rules: 'REGRAS DO NARRADOR',
    world_context: 'Reino de Aldor',
    model: 'gemini-2.5-flash',
  }).id;
});

const next = (instruction: string) =>
  t.app.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/narrative/next`,
    payload: { player_instruction: instruction },
  });

describe('POST /narrative/next', () => {
  it('faz streaming de chunks, persiste a página e emite page/done no fechamento', async () => {
    t.gateway.queue(narratorJson('Ele entrou na taverna e pediu uma bebida.'));
    const res = await next('Entro na taverna.');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');

    const events = parseSse(res.body);
    const names = events.map((e) => e.event);
    expect(names[0]).toBe('start');
    expect(names.slice(-2)).toEqual(['page', 'done']);
    expect(names.filter((n) => n === 'chunk').length).toBeGreaterThan(1);

    const streamed = events
      .filter((e) => e.event === 'chunk')
      .map((e) => e.data.text)
      .join('');
    expect(streamed).toBe('Ele entrou na taverna e pediu uma bebida.');
    // chunks vêm antes da página
    expect(names.indexOf('page')).toBeGreaterThan(names.lastIndexOf('chunk'));

    const stored = t.repos.pages.listActive(sessionId);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      order_index: 1,
      player_instruction: 'Entro na taverna.',
      generated_text: 'Ele entrou na taverna e pediu uma bebida.',
      model_identifier: 'gemini-2.5-flash',
    });
    expect(events.find((e) => e.event === 'page')!.data.page.id).toBe(stored[0]!.id);
  });

  it('força o responseSchema e envia regras como system instruction (invariante 2 em docs/decisoes.md)', async () => {
    t.gateway.queue(narratorJson('Texto.'));
    await next('Ação.');
    const req = t.gateway.requests[0]!;
    expect(req.responseJsonSchema).toEqual(NARRATOR_RESPONSE_SCHEMA);
    expect(req.systemInstruction).toBe('REGRAS DO NARRADOR');
    expect(req.model).toBe('gemini-2.5-flash');
    expect(req.userText).toContain('Reino de Aldor');
  });

  it('não reenvia instruções passadas do jogador, apenas a prosa (invariante 1 em docs/decisoes.md)', async () => {
    t.gateway.queue(narratorJson('Prosa um.'), narratorJson('Prosa dois.'));
    await next('PRIMEIRA-INSTRUCAO-META');
    await next('SEGUNDA-INSTRUCAO');

    const second = t.gateway.requests[1]!;
    expect(second.userText).toContain('Prosa um.');
    expect(second.userText).toContain('SEGUNDA-INSTRUCAO');
    expect(second.userText).not.toContain('PRIMEIRA-INSTRUCAO-META');
    expect(t.repos.pages.listActive(sessionId).map((b) => b.order_index)).toEqual([1, 2]);
  });

  it('ativa o Modo Diálogo quando o Narrador pede e informa o diálogo ao cliente', async () => {
    t.gateway.queue(
      narratorJson('Elena se vira para você.', {
        activate: true,
        npc_name: 'Elena Vance',
        dynamic_system_prompt: 'Você é Elena Vance, desconfiada.',
      }),
    );
    const events = parseSse((await next('Falo com Elena.')).body);
    const trigger = events.find((e) => e.event === 'dialogue_trigger')!;
    expect(trigger.data.npc_name).toBe('Elena Vance');
    // page precede dialogue_trigger; ambos só no fechamento
    expect(events.map((e) => e.event).slice(-3)).toEqual(['page', 'dialogue_trigger', 'done']);

    const active = t.repos.dialogues.getActive(sessionId)!;
    expect(active.id).toBe(trigger.data.dialogue_id);
    expect(active.dynamic_system_prompt).toBe('Você é Elena Vance, desconfiada.');
    // O prompt do NPC não vaza para o cliente neste evento
    expect(JSON.stringify(trigger.data)).not.toContain('desconfiada');
  });

  it('ignora gatilho incompleto (activate sem npc_name/prompt)', async () => {
    t.gateway.queue(narratorJson('Texto.', { activate: true, npc_name: 'Sem prompt' }));
    const events = parseSse((await next('Ação.')).body);
    expect(events.some((e) => e.event === 'dialogue_trigger')).toBe(false);
    expect(t.repos.dialogues.getActive(sessionId)).toBeUndefined();
  });

  it('recusa narrar enquanto há diálogo ativo', async () => {
    t.repos.dialogues.create(sessionId, 'Elena', 'prompt');
    const res = await next('Ação.');
    expect(res.statusCode).toBe(409);
    expect(t.gateway.requests).toHaveLength(0);
  });

  it('retorna 409 com code missing_api_key sem chave, antes de abrir o SSE', async () => {
    const bare = await makeApp();
    const sid = bare.repos.sessions.create({ title: 'x', system_rules: 'r', world_context: '' }).id;
    const res = await bare.app.inject({
      method: 'POST',
      url: `/api/sessions/${sid}/narrative/next`,
      payload: { player_instruction: 'Ação.' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('missing_api_key');
  });

  it('não persiste nada e emite error quando o JSON final é inválido', async () => {
    t.gateway.queue('{"narrative_text":"cortado no meio');
    const events = parseSse((await next('Ação.')).body);
    expect(events.at(-1)!.event).toBe('error');
    expect(events.some((e) => e.event === 'page')).toBe(false);
    expect(t.repos.pages.listAll(sessionId)).toHaveLength(0);
  });

  it('não persiste nada quando a API falha no meio do stream', async () => {
    const failing = withKey(await makeApp(mockGateway({ failWith: new Error('conexão caiu') })));
    const sid = failing.repos.sessions.create({ title: 'x', system_rules: 'r', world_context: '' }).id;
    failing.gateway.queue(narratorJson('Um texto longo o bastante.'));
    const res = await failing.app.inject({
      method: 'POST',
      url: `/api/sessions/${sid}/narrative/next`,
      payload: { player_instruction: 'Ação.' },
    });
    const events = parseSse(res.body);
    expect(events.at(-1)).toMatchObject({ event: 'error' });
    expect(events.at(-1)!.data.message).toContain('conexão caiu');
    expect(failing.repos.pages.listAll(sid)).toHaveLength(0);
  });

  it('valida o corpo e a existência da sessão', async () => {
    expect(
      (await t.app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/narrative/next`, payload: {} })).statusCode,
    ).toBe(400);
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: '/api/sessions/nao-existe/narrative/next',
          payload: { player_instruction: 'x' },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('libera a sessão após falha, permitindo nova tentativa', async () => {
    t.gateway.queue('lixo', narratorJson('Agora foi.'));
    await next('Ação.');
    const events = parseSse((await next('Ação.')).body);
    expect(events.at(-1)!.event).toBe('done');
    expect(t.repos.pages.listActive(sessionId)).toHaveLength(1);
  });
});

describe('PUT /narrative/pages/:id (edição direta)', () => {
  it('altera só o texto e preserva as páginas posteriores', async () => {
    const a = t.repos.pages.append(sessionId, { player_instruction: 'i1', generated_text: 'um' });
    t.repos.pages.append(sessionId, { player_instruction: 'i2', generated_text: 'dois' });
    const res = await t.app.inject({
      method: 'PUT',
      url: `/api/narrative/pages/${a.id}`,
      payload: { generated_text: 'um editado' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().page.generated_text).toBe('um editado');
    expect(t.repos.pages.listActive(sessionId).map((b) => b.generated_text)).toEqual(['um editado', 'dois']);
    // a instrução original permanece intacta
    expect(t.repos.pages.get(a.id)!.player_instruction).toBe('i1');
  });

  it('404 para página inexistente, 409 para arquivada, 400 para texto vazio', async () => {
    expect(
      (await t.app.inject({ method: 'PUT', url: '/api/narrative/pages/x', payload: { generated_text: 'a' } })).statusCode,
    ).toBe(404);
    const a = t.repos.pages.append(sessionId, { player_instruction: null, generated_text: 'um' });
    expect(
      (await t.app.inject({ method: 'PUT', url: `/api/narrative/pages/${a.id}`, payload: { generated_text: '' } }))
        .statusCode,
    ).toBe(400);
    t.repos.pages.archiveRange(sessionId, 1, 1);
    expect(
      (await t.app.inject({ method: 'PUT', url: `/api/narrative/pages/${a.id}`, payload: { generated_text: 'x' } }))
        .statusCode,
    ).toBe(409);
  });
});

describe('POST /narrative/pages/:id/regenerate', () => {
  const seed = () =>
    [1, 2, 3].map((n) =>
      t.repos.pages.append(sessionId, { player_instruction: `instr${n}`, generated_text: `texto${n}` }),
    );

  const regen = (id: string, body: Record<string, unknown>) =>
    t.app.inject({ method: 'POST', url: `/api/narrative/pages/${id}/regenerate`, payload: body });

  it('última página: substitui o texto sem truncar nem exigir confirmação', async () => {
    const [, , c] = seed();
    t.gateway.queue(narratorJson('novo texto 3'));
    const events = parseSse((await regen(c!.id, { player_instruction: 'nova instr3' })).body);
    expect(events.at(-1)!.event).toBe('done');
    expect(events.find((e) => e.event === 'page')!.data.discarded).toBe(0);

    const pages = t.repos.pages.listActive(sessionId);
    expect(pages.map((b) => b.generated_text)).toEqual(['texto1', 'texto2', 'novo texto 3']);
    expect(pages[2]).toMatchObject({ id: c!.id, player_instruction: 'nova instr3' });
    // corpus = páginas anteriores, sem o texto antigo da própria página nem instruções
    const sent = t.gateway.requests[0]!.userText;
    expect(sent).toContain('texto1');
    expect(sent).toContain('texto2');
    expect(sent).not.toContain('texto3');
    for (const old of ['instr1', 'instr2', 'instr3 ']) expect(sent).not.toContain(old);
    expect(sent).toContain('nova instr3');
  });

  it('página intermediária sem confirmação: 409 truncation_required e nada muda (invariante 3 em docs/decisoes.md)', async () => {
    const [, b] = seed();
    const res = await regen(b!.id, { player_instruction: 'nova' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'truncation_required', pages_to_discard: 1 });
    expect(t.gateway.requests).toHaveLength(0);
    expect(t.repos.pages.listAll(sessionId)).toHaveLength(3);
  });

  it('página intermediária com confirmação: descarta as posteriores e vira a última', async () => {
    const [a, b] = seed();
    t.gateway.queue(narratorJson('novo texto 2'));
    const events = parseSse((await regen(b!.id, { player_instruction: 'nova', confirm_truncate: true })).body);
    expect(events.find((e) => e.event === 'page')!.data.discarded).toBe(1);

    const pages = t.repos.pages.listAll(sessionId);
    expect(pages.map((x) => x.generated_text)).toEqual(['texto1', 'novo texto 2']);
    expect(pages.at(-1)!.id).toBe(b!.id);
    expect(pages[0]!.id).toBe(a!.id);
    // corpus enviado contém só a página 1
    const sent = t.gateway.requests[0]!.userText;
    expect(sent).toContain('texto1');
    expect(sent).not.toContain('texto2');
    expect(sent).not.toContain('texto3');
  });

  it('falha de geração NÃO apaga nada, mesmo com confirmação (transação pós-geração)', async () => {
    const [, b] = seed();
    t.gateway.queue('json quebrado');
    const events = parseSse((await regen(b!.id, { player_instruction: 'nova', confirm_truncate: true })).body);
    expect(events.at(-1)!.event).toBe('error');
    expect(t.repos.pages.listAll(sessionId).map((x) => x.generated_text)).toEqual(['texto1', 'texto2', 'texto3']);
    expect(t.repos.pages.get(b!.id)!.player_instruction).toBe('instr2');
  });

  it('404 / 409 (arquivado) / 409 (diálogo ativo)', async () => {
    expect((await regen('x', { player_instruction: 'a' })).statusCode).toBe(404);
    const [a, , c] = seed();
    t.repos.pages.archiveRange(sessionId, 1, 1);
    expect((await regen(a!.id, { player_instruction: 'a' })).statusCode).toBe(409);
    t.repos.dialogues.create(sessionId, 'Elena', 'p');
    expect((await regen(c!.id, { player_instruction: 'a' })).statusCode).toBe(409);
  });
});

describe('POST /narrative/pages/:id/branch (ramificar a partir daqui)', () => {
  const seed = () =>
    [1, 2, 3].map((n) => t.repos.pages.append(sessionId, { player_instruction: `i${n}`, generated_text: `texto${n}` }));
  const branch = (id: string, body: Record<string, unknown> = {}) =>
    t.app.inject({ method: 'POST', url: `/api/narrative/pages/${id}/branch`, payload: body });

  it('sem confirmação: 409 truncation_required e nada muda', async () => {
    const [a] = seed();
    const res = await branch(a!.id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'truncation_required', pages_to_discard: 2 });
    expect(t.repos.pages.listAll(sessionId)).toHaveLength(3);
  });

  it('com confirmação: descarta as posteriores sem chamar a IA e mantém a página K intacta', async () => {
    const [, b] = seed();
    const res = await branch(b!.id, { confirm_truncate: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ discarded: 1, last_page_id: b!.id });
    expect(t.gateway.requests).toHaveLength(0);
    expect(t.repos.pages.listAll(sessionId).map((x) => x.generated_text)).toEqual(['texto1', 'texto2']);
    expect(t.repos.pages.get(b!.id)!.player_instruction).toBe('i2');
  });

  it('na última página não há o que descartar (200, sem confirmação)', async () => {
    const [, , c] = seed();
    const res = await branch(c!.id);
    expect(res.statusCode).toBe(200);
    expect(res.json().discarded).toBe(0);
  });

  it('404 / 409 (arquivado) / 409 (diálogo ativo)', async () => {
    expect((await branch('x')).statusCode).toBe(404);
    const [a, , c] = seed();
    t.repos.pages.archiveRange(sessionId, 1, 1);
    expect((await branch(a!.id, { confirm_truncate: true })).statusCode).toBe(409);
    t.repos.dialogues.create(sessionId, 'Elena', 'p');
    expect((await branch(c!.id)).statusCode).toBe(409);
  });
});
