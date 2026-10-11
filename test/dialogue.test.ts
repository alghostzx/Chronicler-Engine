import { beforeEach, describe, expect, it } from 'vitest';
import { makeApp, mockGateway, narratorJson, npcJson, parseSse, withKey, type TestApp } from './helpers.js';

let t: TestApp;
let sessionId: string;
let dialogueId: string;

const NPC_PROMPT = 'Você é Elena Vance, taverneira desconfiada. SEGREDO-DO-NPC: ela esconde um mapa.';

beforeEach(async () => {
  t = withKey(await makeApp());
  sessionId = t.repos.sessions.create({
    title: 'Teste',
    system_rules: 'REGRAS DO NARRADOR',
    world_context: 'Reino de Aldor',
    model: 'gemini-2.5-flash',
  }).id;
  t.repos.pages.append(sessionId, { player_instruction: 'META-ANTERIOR', generated_text: 'Prosa anterior.' });
  dialogueId = t.repos.dialogues.create(sessionId, 'Elena Vance', NPC_PROMPT).id;
});

const say = (message: string, id = dialogueId) =>
  t.app.inject({ method: 'POST', url: `/api/dialogue/${id}/message`, payload: { message } });
const conclude = (id = dialogueId) => t.app.inject({ method: 'POST', url: `/api/dialogue/${id}/conclude` });

describe('POST /dialogue/:id/message', () => {
  it('responde como o NPC, com histórico isolado, e persiste as duas falas', async () => {
    t.gateway.queue(npcJson('Quem pergunta?'), npcJson('Talvez eu saiba de algo.'));

    const first = (await say('Procuro um mapa.')).json();
    expect(first.player_message.content).toBe('Procuro um mapa.');
    expect(first.npc_message).toMatchObject({ sender: 'npc', content: 'Quem pergunta?' });
    expect(first.npc_wants_to_end).toBe(false);

    await say('Sou um viajante.');
    const second = t.gateway.requests[1]!;
    expect(second.history).toEqual([
      { role: 'user', text: 'Procuro um mapa.' },
      { role: 'model', text: 'Quem pergunta?' },
    ]);
    expect(second.userText).toBe('Sou um viajante.');
    expect(t.repos.dialogues.listMessages(dialogueId).map((m) => m.sender)).toEqual([
      'player',
      'npc',
      'player',
      'npc',
    ]);
  });

  it('usa o prompt dinâmico como persona e NÃO envia corpus nem meta-instruções do jogador', async () => {
    t.gateway.queue(npcJson('Hum.'));
    await say('Olá.');
    const req = t.gateway.requests[0]!;
    expect(req.systemInstruction).toContain('Elena Vance');
    expect(req.systemInstruction).toContain('primeira pessoa');
    expect(req.model).toBe('gemini-2.5-flash');
    const everything = JSON.stringify(req);
    expect(everything).not.toContain('Prosa anterior.');
    expect(everything).not.toContain('META-ANTERIOR');
    expect(everything).not.toContain('Reino de Aldor');
    expect(req.responseJsonSchema).toBeDefined();
  });

  it('não altera as páginas da história (checklist §10 nº 5)', async () => {
    t.gateway.queue(npcJson('a'), npcJson('b'), npcJson('c'));
    await say('1');
    await say('2');
    await say('3');
    const pages = t.repos.pages.listAll(sessionId);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.generated_text).toBe('Prosa anterior.');
  });

  it('sinaliza npc_wants_to_end sem encerrar sozinho', async () => {
    t.gateway.queue(npcJson('Adeus, forasteiro.', true));
    const res = (await say('Tenho que ir.')).json();
    expect(res.npc_wants_to_end).toBe(true);
    expect(t.repos.dialogues.get(dialogueId)!.status).toBe('active');
  });

  it('falha da IA não grava nada (nem a fala do jogador)', async () => {
    t.gateway.queue('json quebrado');
    const res = await say('Olá?');
    expect(res.statusCode).toBe(502);
    expect(t.repos.dialogues.listMessages(dialogueId)).toHaveLength(0);
    // pode tentar de novo
    t.gateway.queue(npcJson('Agora sim.'));
    expect((await say('Olá?')).statusCode).toBe(200);
  });

  it('valida: 404, 400 (vazio) e 409 (diálogo encerrado)', async () => {
    expect((await say('oi', 'nao-existe')).statusCode).toBe(404);
    expect((await say('')).statusCode).toBe(400);
    t.repos.dialogues.conclude(dialogueId, t.repos.pages.listAll(sessionId)[0]!.id);
    expect((await say('oi')).statusCode).toBe(409);
  });

  it('409 sem chave configurada', async () => {
    const bare = await makeApp();
    const sid = bare.repos.sessions.create({ title: 'x', system_rules: 'r', world_context: '' }).id;
    const did = bare.repos.dialogues.create(sid, 'N', 'p').id;
    const res = await bare.app.inject({ method: 'POST', url: `/api/dialogue/${did}/message`, payload: { message: 'oi' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('missing_api_key');
  });
});

const TRANSCRIPT =
  '**Protagonista:** Procuro um mapa.\n\n**Elena Vance:** Quem pergunta?\n\n**Protagonista:** Pago bem.\n\n**Elena Vance:** Hmpf. Entre.';

describe('POST /dialogue/:id/conclude (o diálogo vira página)', () => {
  const converse = async (id = dialogueId) => {
    t.gateway.queue(npcJson('Quem pergunta?'), npcJson('Hmpf. Entre.'));
    await say('Procuro um mapa.', id);
    await say('Pago bem.', id);
  };

  it('grava a transcrição como UMA página de diálogo, sem chamar o Narrador', async () => {
    await converse();
    const before = t.gateway.requests.length;

    const res = await conclude();
    expect(res.statusCode).toBe(200);
    expect(t.gateway.requests).toHaveLength(before); // nenhuma chamada de IA ao encerrar
    const body = res.json();
    expect(body.discarded).toBe(0);
    expect(body.page).toMatchObject({ kind: 'dialogue', npc_name: 'Elena Vance', order_index: 2, generated_text: TRANSCRIPT });
    expect(res.body).not.toContain('SEGREDO-DO-NPC');

    const pages = t.repos.pages.listActive(sessionId);
    expect(pages).toHaveLength(2);
    expect(pages[1]).toMatchObject({ kind: 'dialogue', npc_name: 'Elena Vance', player_instruction: null, model_identifier: null });
    expect(pages[0]).toMatchObject({ kind: 'narrative', npc_name: null });

    const d = t.repos.dialogues.get(dialogueId)!;
    expect(d).toMatchObject({ status: 'concluded', page_id: pages[1]!.id, redo_page_id: null });
    expect(t.repos.dialogues.listMessages(dialogueId)).toHaveLength(0); // a página é a fonte da verdade
    expect(t.repos.dialogues.getActive(sessionId)).toBeUndefined();
  });

  it('rotula o jogador com o nome dado pelo Narrador (e “Protagonista” sem ele)', async () => {
    t.repos.dialogues.delete(dialogueId);
    const named = t.repos.dialogues.create(sessionId, 'Elena Vance', NPC_PROMPT, { playerName: 'Kira' });
    await converse(named.id);
    const res = await conclude(named.id);
    expect(res.json().page.generated_text).toBe(TRANSCRIPT.replaceAll('Protagonista', 'Kira'));
  });

  it('o prompt do NPC recebe o nome do jogador', async () => {
    t.repos.dialogues.delete(dialogueId);
    const named = t.repos.dialogues.create(sessionId, 'Elena Vance', NPC_PROMPT, { playerName: 'Kira' });
    t.gateway.queue(npcJson('Hum.'));
    await say('Olá.', named.id);
    expect(t.gateway.requests[0]!.systemInstruction).toContain('"Kira"');
  });

  it('a narração normal só volta depois, e o corpus já traz a conversa como foi gravada', async () => {
    await converse();
    const blocked = await t.app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/narrative/next`,
      payload: { player_instruction: 'Sigo adiante.' },
    });
    expect(blocked.statusCode).toBe(409);

    await conclude();
    t.gateway.queue(narratorJson('Depois do diálogo.'));
    const ok = await t.app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/narrative/next`,
      payload: { player_instruction: 'Sigo adiante.' },
    });
    expect(parseSse(ok.body).at(-1)!.event).toBe('done');
    const next = t.gateway.requests.at(-1)!;
    expect(next.userText).toContain(TRANSCRIPT);
    expect(next.userText).not.toContain('SEGREDO-DO-NPC');
  });

  it('409 sem falas (sugere cancelar), 404 e 409 se já encerrado', async () => {
    expect((await conclude()).statusCode).toBe(409);
    expect((await conclude('nao-existe')).statusCode).toBe(404);
    await converse();
    expect((await conclude()).statusCode).toBe(200);
    expect((await conclude()).statusCode).toBe(409);
  });

  describe('a página de diálogo', () => {
    let pageId: string;
    beforeEach(async () => {
      await converse();
      pageId = (await conclude()).json().page.id;
    });

    it('edita o texto sem descartar as páginas seguintes', async () => {
      t.repos.pages.append(sessionId, { player_instruction: 'depois', generated_text: 'Página seguinte.' });
      const res = await t.app.inject({ method: 'PUT', url: `/api/narrative/pages/${pageId}`, payload: { generated_text: '**Kira:** Editado.' } });
      expect(res.statusCode).toBe(200);
      expect(res.json().page).toMatchObject({ kind: 'dialogue', generated_text: '**Kira:** Editado.' });
      expect(t.repos.pages.listActive(sessionId)).toHaveLength(3);
    });

    it('não tem prompt: re-gerar é recusado (409) e nada muda', async () => {
      const res = await t.app.inject({
        method: 'POST',
        url: `/api/narrative/pages/${pageId}/regenerate`,
        payload: { player_instruction: 'x', confirm_truncate: true },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toContain('Refazer diálogo');
      expect(t.repos.pages.get(pageId)!.generated_text).toBe(TRANSCRIPT);
    });

    it('some junto com a página (ramificar) — o diálogo concluído não sobra no banco', async () => {
      const first = t.repos.pages.listActive(sessionId)[0]!;
      const res = await t.app.inject({ method: 'POST', url: `/api/narrative/pages/${first.id}/branch`, payload: { confirm_truncate: true } });
      expect(res.statusCode).toBe(200);
      expect(t.repos.pages.get(pageId)).toBeUndefined();
      expect(t.repos.dialogues.get(dialogueId)).toBeUndefined();
    });

    it('some junto com a crônica (excluir sessão)', async () => {
      await t.app.inject({ method: 'DELETE', url: `/api/sessions/${sessionId}` });
      expect(t.repos.dialogues.get(dialogueId)).toBeUndefined();
    });
  });
});

describe('POST /narrative/pages/:id/redo-dialogue (refazer, não destrutivo)', () => {
  let pageId: string;
  const redo = (body: object = {}, id = pageId) => t.app.inject({ method: 'POST', url: `/api/narrative/pages/${id}/redo-dialogue`, payload: body });

  beforeEach(async () => {
    t.repos.dialogues.delete(dialogueId);
    const d = t.repos.dialogues.create(sessionId, 'Elena Vance', NPC_PROMPT, { playerName: 'Kira' });
    t.gateway.queue(npcJson('Quem pergunta?'));
    await say('Procuro um mapa.', d.id);
    dialogueId = d.id;
    pageId = (await conclude(d.id)).json().page.id;
  });

  it('abre um diálogo ativo com a mesma persona, sem tocar na página', async () => {
    const res = await redo();
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.dialogue).toMatchObject({ npc_name: 'Elena Vance', player_name: 'Kira', status: 'active', redo_page_id: pageId });
    expect(body.messages).toEqual([]);
    expect(res.body).not.toContain('SEGREDO-DO-NPC');

    const active = t.repos.dialogues.getActive(sessionId)!;
    expect(active.dynamic_system_prompt).toBe(NPC_PROMPT); // a persona é a mesma
    expect(t.repos.pages.get(pageId)!.generated_text).toContain('Procuro um mapa.');
    expect(t.repos.dialogues.get(dialogueId)!.page_id).toBe(pageId); // o diálogo antigo continua ligado
    // com um diálogo ativo, narrar/re-gerar/ramificar/refazer de novo ficam bloqueados
    expect((await redo()).statusCode).toBe(409);
    const detail = (await t.app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` })).json();
    expect(detail.active_dialogue.redo_page_id).toBe(pageId);
  });

  it('pede confirmação quando há páginas seguintes e não cria nada sem ela', async () => {
    t.repos.pages.append(sessionId, { player_instruction: 'depois', generated_text: 'Página seguinte.' });
    const res = await redo();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'truncation_required', pages_to_discard: 1 });
    expect(t.repos.dialogues.getActive(sessionId)).toBeUndefined();
    expect((await redo({ confirm_truncate: true })).statusCode).toBe(201);
    expect(t.repos.pages.listActive(sessionId)).toHaveLength(3); // nada foi descartado ainda
  });

  it('só vale para páginas de diálogo', async () => {
    const narrative = t.repos.pages.listActive(sessionId)[0]!;
    expect((await redo({}, narrative.id)).statusCode).toBe(409);
    expect((await redo({}, 'nao-existe')).statusCode).toBe(404);
  });

  it('descartar o novo diálogo mantém tudo como estava', async () => {
    t.repos.pages.append(sessionId, { player_instruction: 'depois', generated_text: 'Página seguinte.' });
    const opened = (await redo({ confirm_truncate: true })).json();
    t.gateway.queue(npcJson('Outra resposta.'));
    await say('Fala descartada.', opened.dialogue.id);
    const res = await t.app.inject({ method: 'POST', url: `/api/dialogue/${opened.dialogue.id}/cancel` });
    expect(res.statusCode).toBe(204);
    expect(t.repos.dialogues.getActive(sessionId)).toBeUndefined();
    expect(t.repos.pages.listActive(sessionId).map((p) => p.generated_text)).toEqual(['Prosa anterior.', '**Kira:** Procuro um mapa.\n\n**Elena Vance:** Quem pergunta?', 'Página seguinte.']);
    expect(t.repos.dialogues.get(dialogueId)!.page_id).toBe(pageId);
  });

  it('encerrar o novo diálogo substitui a página (mesmo número), descarta as seguintes e troca o diálogo da página', async () => {
    t.repos.pages.append(sessionId, { player_instruction: 'depois', generated_text: 'Página seguinte.' });
    const opened = (await redo({ confirm_truncate: true })).json();
    t.gateway.queue(npcJson('Fale logo.'));
    await say('Outra abordagem.', opened.dialogue.id);

    const res = await conclude(opened.dialogue.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ discarded: 1, page: { id: pageId, order_index: 2, kind: 'dialogue' } });
    expect(res.json().page.generated_text).toBe('**Kira:** Outra abordagem.\n\n**Elena Vance:** Fale logo.');

    expect(t.repos.pages.listActive(sessionId)).toHaveLength(2);
    expect(t.repos.dialogues.get(dialogueId)).toBeUndefined(); // o antigo foi substituído
    expect(t.repos.dialogues.getByPage(pageId)!.id).toBe(opened.dialogue.id);
    expect(t.repos.dialogues.getActive(sessionId)).toBeUndefined();
    // e dá para refazer de novo, com a mesma persona
    expect((await redo({})).statusCode).toBe(201);
  });
});

describe('player_name no gatilho do Narrador', () => {
  it('é gravado no diálogo criado pelo Narrador (limpo de marcações) e opcional', async () => {
    t.repos.dialogues.delete(dialogueId);
    t.gateway.queue(
      narratorJson('Alguém se aproxima.', {
        activate: true,
        npc_name: 'Encapuzado',
        player_name: '**Kira**:\n',
        dynamic_system_prompt: 'Você é um estranho.',
      }),
    );
    const res = await t.app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/narrative/next`, payload: { player_instruction: 'Avanço.' } });
    expect(parseSse(res.body).map((e) => e.event)).toContain('dialogue_trigger');
    expect(t.repos.dialogues.getActive(sessionId)).toMatchObject({ npc_name: 'Encapuzado', player_name: 'Kira' });
  });
});

describe('cancelamento e reconexão', () => {
  it('GET /sessions/:id/dialogue/active devolve o diálogo e as falas, sem o prompt secreto', async () => {
    t.repos.dialogues.addMessage(dialogueId, 'player', 'oi');
    t.repos.dialogues.addMessage(dialogueId, 'npc', 'olá');
    const res = await t.app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/dialogue/active` });
    const body = res.json();
    expect(body.dialogue).toMatchObject({ id: dialogueId, npc_name: 'Elena Vance', status: 'active' });
    expect(body.messages.map((m: { content: string }) => m.content)).toEqual(['oi', 'olá']);
    expect(res.body).not.toContain('SEGREDO-DO-NPC');

    const detail = await t.app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });
    expect(detail.json().active_dialogue.id).toBe(dialogueId);
    expect(detail.body).not.toContain('SEGREDO-DO-NPC');
  });

  it('sem diálogo ativo devolve null; sessão inexistente 404', async () => {
    t.repos.dialogues.conclude(dialogueId, t.repos.pages.listAll(sessionId)[0]!.id);
    const res = await t.app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/dialogue/active` });
    expect(res.json()).toEqual({ dialogue: null, messages: [] });
    expect((await t.app.inject({ method: 'GET', url: '/api/sessions/x/dialogue/active' })).statusCode).toBe(404);
  });

  it('cancelar descarta o diálogo sem tocar na história e libera a narração', async () => {
    t.repos.dialogues.addMessage(dialogueId, 'player', 'oi');
    const res = await t.app.inject({ method: 'POST', url: `/api/dialogue/${dialogueId}/cancel` });
    expect(res.statusCode).toBe(204);
    expect(t.repos.dialogues.get(dialogueId)).toBeUndefined();
    expect(t.repos.dialogues.listMessages(dialogueId)).toHaveLength(0);
    expect(t.repos.pages.listAll(sessionId)).toHaveLength(1);
    expect(t.repos.dialogues.getActive(sessionId)).toBeUndefined();
  });
});

describe('concorrência', () => {
  it('rejeita duas mensagens simultâneas no mesmo diálogo', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = withKey(await makeApp());
    const sid = slow.repos.sessions.create({ title: 'x', system_rules: 'r', world_context: '' }).id;
    const did = slow.repos.dialogues.create(sid, 'N', 'p').id;
    const original = slow.gateway.streamGenerate.bind(slow.gateway);
    slow.gateway.streamGenerate = async function* (req) {
      await gate;
      yield* original(req);
    };
    slow.gateway.queue(npcJson('ok'));

    const first = slow.app.inject({ method: 'POST', url: `/api/dialogue/${did}/message`, payload: { message: 'a' } });
    await new Promise((r) => setTimeout(r, 20));
    const second = await slow.app.inject({ method: 'POST', url: `/api/dialogue/${did}/message`, payload: { message: 'b' } });
    expect(second.statusCode).toBe(409);
    release();
    expect((await first).statusCode).toBe(200);
  });
});

// garante que o helper mockGateway com falha mid-stream também degrada bem no diálogo
describe('erros de API no diálogo', () => {
  it('erro no meio do stream → 502 e nada gravado', async () => {
    const failing = withKey(await makeApp(mockGateway({ failWith: new Error('conexão caiu') })));
    const sid = failing.repos.sessions.create({ title: 'x', system_rules: 'r', world_context: '' }).id;
    const did = failing.repos.dialogues.create(sid, 'N', 'p').id;
    failing.gateway.queue(npcJson('uma resposta razoavelmente longa'));
    const res = await failing.app.inject({
      method: 'POST',
      url: `/api/dialogue/${did}/message`,
      payload: { message: 'oi' },
    });
    expect(res.statusCode).toBe(502);
    expect(failing.repos.dialogues.listMessages(did)).toHaveLength(0);
  });
});
