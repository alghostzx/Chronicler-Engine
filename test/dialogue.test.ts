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
  t.repos.blocks.append(sessionId, { player_instruction: 'META-ANTERIOR', generated_text: 'Prosa anterior.' });
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

  it('não altera os blocos da história (checklist §10 nº 5)', async () => {
    t.gateway.queue(npcJson('a'), npcJson('b'), npcJson('c'));
    await say('1');
    await say('2');
    await say('3');
    const blocks = t.repos.blocks.listAll(sessionId);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.generated_text).toBe('Prosa anterior.');
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
    t.repos.dialogues.conclude(dialogueId);
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

describe('POST /dialogue/:id/conclude (costura)', () => {
  const converse = async () => {
    t.gateway.queue(npcJson('Quem pergunta?'), npcJson('Hmpf. Entre.'));
    await say('Procuro um mapa.');
    await say('Pago bem.');
  };

  it('envia ao Narrador a transcrição literal e grava UM novo bloco, concluindo o diálogo', async () => {
    await converse();
    t.gateway.queue(narratorJson('Elena estreitou os olhos e, por fim, abriu a porta dos fundos.'));

    const res = await conclude();
    const events = parseSse(res.body);
    expect(events.map((e) => e.event)).toContain('chunk');
    expect(events.slice(-2).map((e) => e.event)).toEqual(['block', 'done']);

    const req = t.gateway.requests.at(-1)!;
    expect(req.systemInstruction).toBe('REGRAS DO NARRADOR');
    expect(req.userText).toContain('Prosa anterior.');
    expect(req.userText).toContain('A cena de diálogo entre o protagonista e Elena Vance se encerrou');
    expect(req.userText).toContain('Protagonista: Procuro um mapa.\nElena Vance: Quem pergunta?\nProtagonista: Pago bem.\nElena Vance: Hmpf. Entre.');
    expect(req.userText).not.toContain('META-ANTERIOR');
    expect(req.userText).not.toContain('SEGREDO-DO-NPC'); // o segredo do NPC não vai para o Narrador
    expect(req.responseJsonSchema).toBeDefined();

    const blocks = t.repos.blocks.listActive(sessionId);
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toMatchObject({
      order_index: 2,
      generated_text: 'Elena estreitou os olhos e, por fim, abriu a porta dos fundos.',
      model_identifier: 'gemini-2.5-flash',
    });
    expect(blocks[1]!.player_instruction).toContain('[Diálogo com Elena Vance]');
    expect(t.repos.dialogues.get(dialogueId)!.status).toBe('concluded');
    expect(t.repos.dialogues.getActive(sessionId)).toBeUndefined();
  });

  it('só então a narração normal volta a funcionar', async () => {
    await converse();
    const blocked = await t.app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/narrative/next`,
      payload: { player_instruction: 'Sigo adiante.' },
    });
    expect(blocked.statusCode).toBe(409);

    t.gateway.queue(narratorJson('Costura.'), narratorJson('Depois do diálogo.'));
    await conclude();
    const ok = await t.app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/narrative/next`,
      payload: { player_instruction: 'Sigo adiante.' },
    });
    expect(parseSse(ok.body).at(-1)!.event).toBe('done');
    // o corpus do próximo turno já contém a costura, mas não a transcrição bruta
    const next = t.gateway.requests.at(-1)!;
    expect(next.userText).toContain('Costura.');
    expect(next.userText).not.toContain('Protagonista: Procuro um mapa.');
  });

  it('falha da costura não grava bloco e mantém o diálogo ativo', async () => {
    await converse();
    t.gateway.queue('lixo');
    const events = parseSse((await conclude()).body);
    expect(events.at(-1)!.event).toBe('error');
    expect(t.repos.blocks.listAll(sessionId)).toHaveLength(1);
    expect(t.repos.dialogues.getActive(sessionId)!.id).toBe(dialogueId);
    // nova tentativa funciona
    t.gateway.queue(narratorJson('Agora foi.'));
    expect(parseSse((await conclude()).body).at(-1)!.event).toBe('done');
  });

  it('o Narrador pode encadear um novo diálogo ao costurar', async () => {
    await converse();
    t.gateway.queue(
      narratorJson('Um homem encapuzado se aproxima.', {
        activate: true,
        npc_name: 'Encapuzado',
        dynamic_system_prompt: 'Você é um estranho.',
      }),
    );
    const events = parseSse((await conclude()).body);
    expect(events.at(-2)!.event).toBe('dialogue_trigger');
    expect(t.repos.dialogues.getActive(sessionId)!.npc_name).toBe('Encapuzado');
    expect(t.repos.dialogues.get(dialogueId)!.status).toBe('concluded');
  });

  it('409 sem falas (sugere cancelar), 404 e 409 se já encerrado', async () => {
    expect((await conclude()).statusCode).toBe(409);
    expect((await conclude('nao-existe')).statusCode).toBe(404);
    t.repos.dialogues.conclude(dialogueId);
    expect((await conclude()).statusCode).toBe(409);
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
    t.repos.dialogues.conclude(dialogueId);
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
    expect(t.repos.blocks.listAll(sessionId)).toHaveLength(1);
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
