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

/** Prosa que o Narrador devolveria: as quatro falas intactas (uma partida ao meio) + preenchimento. */
const PROSE =
  'Elena Vance ergueu os olhos do balcão.\n\n— Procuro um mapa, — disse o viajante.\n\nA taverneira estreitou o olhar.\n\n— Quem pergunta? — rebateu ela.\n\nO viajante deixou uma bolsa sobre a madeira.\n\n— Pago bem.\n\nElena pesou a bolsa na mão.\n\n— Hmpf. Entre.';
/** Prosa reprovada: omite a fala “Pago bem.” */
const BAD_PROSE = 'Elena ergueu os olhos.\n\n— Procuro um mapa.\n\n— Quem pergunta?\n\n— Hmpf. Entre.';

const concludePage = (res: { body: string }) => parseSse(res.body).find((e) => e.event === 'page')?.data;

describe('POST /dialogue/:id/conclude (o Narrador escreve o diálogo como página)', () => {
  const converse = async (id = dialogueId) => {
    t.gateway.queue(npcJson('Quem pergunta?'), npcJson('Hmpf. Entre.'));
    await say('Procuro um mapa.', id);
    await say('Pago bem.', id);
  };

  it('grava UMA página de prosa com as falas literais; a transcrição crua fica em player_instruction', async () => {
    await converse();
    const before = t.gateway.requests.length;
    t.gateway.queue(narratorJson(PROSE));

    const res = await conclude();
    expect(res.statusCode).toBe(200);
    const events = parseSse(res.body);
    expect(events.map((e) => e.event)).toEqual(expect.arrayContaining(['start', 'chunk', 'page', 'done']));
    expect(events.map((e) => e.event)).not.toContain('retry');
    const body = concludePage(res);
    expect(body).toMatchObject({ discarded: 0, narration: 'narrated' });
    expect(body.page).toMatchObject({
      kind: 'dialogue',
      npc_name: 'Elena Vance',
      order_index: 2,
      raw_dialogue: false,
      generated_text: PROSE,
    });
    expect(res.body).not.toContain('SEGREDO-DO-NPC');

    // o Narrador viu a história até aqui, o mundo e a transcrição literal — nunca o segredo do NPC
    expect(t.gateway.requests).toHaveLength(before + 1);
    const req = t.gateway.requests.at(-1)!;
    expect(req.systemInstruction).toBe('REGRAS DO NARRADOR');
    expect(req.userText).toContain('Reino de Aldor');
    expect(req.userText).toContain('Prosa anterior.');
    expect(req.userText).toContain(TRANSCRIPT);
    expect(req.userText).not.toContain('SEGREDO-DO-NPC');

    const pages = t.repos.pages.listActive(sessionId);
    expect(pages).toHaveLength(2);
    expect(pages[1]).toMatchObject({ kind: 'dialogue', player_instruction: TRANSCRIPT, raw_dialogue: false });
    expect(pages[1]!.model_identifier).toBeTruthy();
    expect(pages[0]).toMatchObject({ kind: 'narrative', npc_name: null, raw_dialogue: false });

    const d = t.repos.dialogues.get(dialogueId)!;
    expect(d).toMatchObject({ status: 'concluded', page_id: pages[1]!.id, redo_page_id: null });
    expect(t.repos.dialogues.listMessages(dialogueId)).toHaveLength(0); // a página é a fonte da verdade
    expect(t.repos.dialogues.getActive(sessionId)).toBeUndefined();
  });

  it('rotula o jogador com o nome dado pelo Narrador na transcrição (e “Protagonista” sem ele)', async () => {
    t.repos.dialogues.delete(dialogueId);
    const named = t.repos.dialogues.create(sessionId, 'Elena Vance', NPC_PROMPT, { playerName: 'Kira' });
    await converse(named.id);
    t.gateway.queue(narratorJson(PROSE));
    const res = await conclude(named.id);
    const kira = TRANSCRIPT.replaceAll('Protagonista', 'Kira');
    expect(t.gateway.requests.at(-1)!.userText).toContain(kira);
    expect(concludePage(res).page.generated_text).toBe(PROSE);
    expect(t.repos.pages.get(concludePage(res).page.id)!.player_instruction).toBe(kira);
  });

  it('o prompt do NPC recebe o nome do jogador', async () => {
    t.repos.dialogues.delete(dialogueId);
    const named = t.repos.dialogues.create(sessionId, 'Elena Vance', NPC_PROMPT, { playerName: 'Kira' });
    t.gateway.queue(npcJson('Hum.'));
    await say('Olá.', named.id);
    expect(t.gateway.requests[0]!.systemInstruction).toContain('"Kira"');
  });

  it('prosa que altera as falas é recusada e o Narrador tenta de novo (evento retry + aviso na 2ª tentativa)', async () => {
    await converse();
    const before = t.gateway.requests.length;
    t.gateway.queue(narratorJson(BAD_PROSE), narratorJson(PROSE));

    const res = await conclude();
    const events = parseSse(res.body);
    expect(events.filter((e) => e.event === 'retry').map((e) => e.data)).toEqual([{ attempt: 2, of: 3 }]);
    expect(t.gateway.requests).toHaveLength(before + 2);
    expect(t.gateway.requests.at(-2)!.userText).not.toContain('ATENÇÃO');
    expect(t.gateway.requests.at(-1)!.userText).toContain('ATENÇÃO');
    expect(concludePage(res)).toMatchObject({ narration: 'narrated', page: { generated_text: PROSE, raw_dialogue: false } });
  });

  it('JSON inválido também conta como tentativa perdida', async () => {
    await converse();
    t.gateway.queue('isto não é JSON', narratorJson(PROSE));
    const res = await conclude();
    expect(concludePage(res)).toMatchObject({ narration: 'narrated' });
    expect(parseSse(res.body).map((e) => e.event)).toContain('retry');
  });

  it('após 3 tentativas reprovadas grava a transcrição crua (fallback) e marca a página como crua', async () => {
    await converse();
    const before = t.gateway.requests.length;
    t.gateway.queue(narratorJson(BAD_PROSE), narratorJson(BAD_PROSE), narratorJson(BAD_PROSE));

    const res = await conclude();
    expect(res.statusCode).toBe(200);
    expect(t.gateway.requests).toHaveLength(before + 3);
    const events = parseSse(res.body);
    expect(events.filter((e) => e.event === 'retry')).toHaveLength(2);
    expect(events.map((e) => e.event)).not.toContain('error');
    const body = concludePage(res);
    expect(body.narration).toBe('fallback');
    expect(body.page).toMatchObject({ kind: 'dialogue', raw_dialogue: true, generated_text: TRANSCRIPT, model_identifier: null });

    const page = t.repos.pages.listActive(sessionId)[1]!;
    expect(page).toMatchObject({ raw_dialogue: true, generated_text: TRANSCRIPT, player_instruction: TRANSCRIPT });
    expect(t.repos.dialogues.get(dialogueId)).toMatchObject({ status: 'concluded', page_id: page.id });
    expect(t.repos.dialogues.getActive(sessionId)).toBeUndefined();
  });

  it('o gatilho de diálogo na resposta do Narrador é ignorado nesta página', async () => {
    await converse();
    t.gateway.queue(narratorJson(PROSE, { activate: true, npc_name: 'Intruso', dynamic_system_prompt: 'x' }));
    const res = await conclude();
    expect(parseSse(res.body).map((e) => e.event)).not.toContain('dialogue_trigger');
    expect(t.repos.dialogues.getActive(sessionId)).toBeUndefined();
  });

  it('falha de API: nada é gravado, o diálogo continua ativo e dá para encerrar de novo', async () => {
    await converse();
    // sem resposta enfileirada → o gateway falha
    const res = await conclude();
    expect(parseSse(res.body).map((e) => e.event)).toContain('error');
    expect(t.repos.pages.listActive(sessionId)).toHaveLength(1);
    expect(t.repos.dialogues.getActive(sessionId)).toMatchObject({ id: dialogueId, status: 'active' });
    expect(t.repos.dialogues.listMessages(dialogueId)).toHaveLength(4);

    t.gateway.queue(narratorJson(PROSE));
    expect(concludePage(await conclude())).toMatchObject({ narration: 'narrated' });
  });

  it('a narração normal só volta depois, e o corpus já traz a página em prosa', async () => {
    await converse();
    const blocked = await t.app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/narrative/next`,
      payload: { player_instruction: 'Sigo adiante.' },
    });
    expect(blocked.statusCode).toBe(409);

    t.gateway.queue(narratorJson(PROSE));
    await conclude();
    t.gateway.queue(narratorJson('Depois do diálogo.'));
    const ok = await t.app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/narrative/next`,
      payload: { player_instruction: 'Sigo adiante.' },
    });
    expect(parseSse(ok.body).at(-1)!.event).toBe('done');
    const next = t.gateway.requests.at(-1)!;
    expect(next.userText).toContain(PROSE);
    expect(next.userText).not.toContain('SEGREDO-DO-NPC');
  });

  it('409 sem falas (sugere cancelar), 404 e 409 se já encerrado', async () => {
    expect((await conclude()).statusCode).toBe(409);
    expect((await conclude('nao-existe')).statusCode).toBe(404);
    await converse();
    t.gateway.queue(narratorJson(PROSE));
    expect((await conclude()).statusCode).toBe(200);
    expect((await conclude()).statusCode).toBe(409);
  });

  describe('a página de diálogo', () => {
    let pageId: string;
    beforeEach(async () => {
      await converse();
      t.gateway.queue(narratorJson(PROSE));
      pageId = concludePage(await conclude()).page.id;
    });

    it('edita o texto sem descartar as páginas seguintes', async () => {
      t.repos.pages.append(sessionId, { player_instruction: 'depois', generated_text: 'Página seguinte.' });
      const res = await t.app.inject({ method: 'PUT', url: `/api/narrative/pages/${pageId}`, payload: { generated_text: '— Editado.' } });
      expect(res.statusCode).toBe(200);
      expect(res.json().page).toMatchObject({ kind: 'dialogue', generated_text: '— Editado.' });
      expect(t.repos.pages.listActive(sessionId)).toHaveLength(3);
    });

    it('re-gerar é recusado (409, sugere Refazer diálogo) e nada muda', async () => {
      const res = await t.app.inject({
        method: 'POST',
        url: `/api/narrative/pages/${pageId}/regenerate`,
        payload: { player_instruction: 'x', confirm_truncate: true },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toContain('Refazer diálogo');
      expect(t.repos.pages.get(pageId)!.generated_text).toBe(PROSE);
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
  const FIRST_PROSE = 'Elena estreitou os olhos.\n\n— Procuro um mapa.\n\n— Quem pergunta?';
  const SECOND_PROSE = 'O viajante se inclinou.\n\n— Outra abordagem.\n\nElena cerrou o punho.\n\n— Fale logo.';

  beforeEach(async () => {
    t.repos.dialogues.delete(dialogueId);
    const d = t.repos.dialogues.create(sessionId, 'Elena Vance', NPC_PROMPT, { playerName: 'Kira' });
    t.gateway.queue(npcJson('Quem pergunta?'));
    await say('Procuro um mapa.', d.id);
    dialogueId = d.id;
    t.gateway.queue(narratorJson(FIRST_PROSE));
    pageId = concludePage(await conclude(d.id)).page.id;
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
    expect(t.repos.pages.get(pageId)!.generated_text).toBe(FIRST_PROSE);
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
    expect(t.repos.pages.listActive(sessionId).map((p) => p.generated_text)).toEqual(['Prosa anterior.', FIRST_PROSE, 'Página seguinte.']);
    expect(t.repos.dialogues.get(dialogueId)!.page_id).toBe(pageId);
  });

  it('encerrar o novo diálogo substitui a página (mesmo número), descarta as seguintes e troca o diálogo da página', async () => {
    t.repos.pages.append(sessionId, { player_instruction: 'depois', generated_text: 'Página seguinte.' });
    const opened = (await redo({ confirm_truncate: true })).json();
    t.gateway.queue(npcJson('Fale logo.'));
    await say('Outra abordagem.', opened.dialogue.id);

    t.gateway.queue(narratorJson(SECOND_PROSE));
    const res = await conclude(opened.dialogue.id);
    expect(res.statusCode).toBe(200);
    expect(concludePage(res)).toMatchObject({ discarded: 1, narration: 'narrated', page: { id: pageId, order_index: 2, kind: 'dialogue' } });
    expect(concludePage(res).page.generated_text).toBe(SECOND_PROSE);
    expect(t.repos.pages.get(pageId)!.player_instruction).toBe('**Kira:** Outra abordagem.\n\n**Elena Vance:** Fale logo.');

    // o contexto da narração é a história ANTES da página refeita (nem a página antiga, nem as seguintes)
    const req = t.gateway.requests.at(-1)!;
    expect(req.userText).toContain('Prosa anterior.');
    expect(req.userText).not.toContain('Elena estreitou os olhos.');
    expect(req.userText).not.toContain('Página seguinte.');

    expect(t.repos.pages.listActive(sessionId)).toHaveLength(2);
    expect(t.repos.dialogues.get(dialogueId)).toBeUndefined(); // o antigo foi substituído
    expect(t.repos.dialogues.getByPage(pageId)!.id).toBe(opened.dialogue.id);
    expect(t.repos.dialogues.getActive(sessionId)).toBeUndefined();
    // e dá para refazer de novo, com a mesma persona
    expect((await redo({})).statusCode).toBe(201);
  });

  it('se a narração do novo diálogo falhar, nada é substituído e o diálogo continua ativo', async () => {
    t.repos.pages.append(sessionId, { player_instruction: 'depois', generated_text: 'Página seguinte.' });
    const opened = (await redo({ confirm_truncate: true })).json();
    t.gateway.queue(npcJson('Fale logo.'));
    await say('Outra abordagem.', opened.dialogue.id);

    const res = await conclude(opened.dialogue.id); // sem resposta do Narrador
    expect(parseSse(res.body).map((e) => e.event)).toContain('error');
    expect(t.repos.pages.listActive(sessionId).map((p) => p.generated_text)).toEqual(['Prosa anterior.', FIRST_PROSE, 'Página seguinte.']);
    expect(t.repos.dialogues.getActive(sessionId)!.id).toBe(opened.dialogue.id);
  });
});

describe('POST /narrative/pages/:id/narrate-dialogue (reprocessar transcrição crua)', () => {
  let rawId: string;
  const narrate = (id = rawId) => t.app.inject({ method: 'POST', url: `/api/narrative/pages/${id}/narrate-dialogue` });
  const RAW = '**Kira:** Procuro um mapa.\n\n**Elena Vance:** Quem pergunta?';
  const NARRATED = 'Elena ergueu os olhos.\n\n— Procuro um mapa, — disse Kira.\n\nElena sorriu de lado.\n\n— Quem pergunta?';

  beforeEach(() => {
    t.repos.dialogues.delete(dialogueId);
    rawId = t.repos.pages.append(sessionId, {
      kind: 'dialogue',
      npc_name: 'Elena Vance',
      raw_dialogue: true,
      player_instruction: null,
      generated_text: RAW,
    }).id;
    t.repos.pages.append(sessionId, { player_instruction: 'depois', generated_text: 'Página seguinte.' });
  });

  it('troca só o texto da página crua por prosa, guardando a transcrição; as páginas seguintes ficam intactas', async () => {
    t.gateway.queue(narratorJson(NARRATED));
    const res = await narrate();
    expect(res.statusCode).toBe(200);
    const body = concludePage(res);
    expect(body).toMatchObject({ discarded: 0, narration: 'narrated', page: { id: rawId, raw_dialogue: false, generated_text: NARRATED } });

    const page = t.repos.pages.get(rawId)!;
    expect(page).toMatchObject({ kind: 'dialogue', raw_dialogue: false, player_instruction: RAW, generated_text: NARRATED });
    expect(page.model_identifier).toBeTruthy();
    expect(t.repos.pages.listActive(sessionId).map((p) => p.generated_text)).toEqual(['Prosa anterior.', NARRATED, 'Página seguinte.']);

    // contexto: a história até a página; as seguintes não entram
    const req = t.gateway.requests.at(-1)!;
    expect(req.userText).toContain('Prosa anterior.');
    expect(req.userText).toContain(RAW);
    expect(req.userText).not.toContain('Página seguinte.');
  });

  it('tenta até 3 vezes; se todas falharem, a página continua crua e nada é alterado', async () => {
    const bad = narratorJson('Elena ergueu os olhos.\n\n— Procuro um mapa.');
    t.gateway.queue(bad, bad, bad);
    const res = await narrate();
    expect(res.statusCode).toBe(200);
    const events = parseSse(res.body).map((e) => e.event);
    expect(events).toContain('error');
    expect(events).not.toContain('page');
    expect(t.gateway.requests).toHaveLength(3);
    expect(t.repos.pages.get(rawId)).toMatchObject({ raw_dialogue: true, generated_text: RAW, player_instruction: null });
    // a trava foi liberada: dá para tentar de novo
    t.gateway.queue(narratorJson(NARRATED));
    expect(concludePage(await narrate())).toMatchObject({ narration: 'narrated' });
  });

  it('recusa páginas narrativas, diálogos já narrados e inexistentes', async () => {
    t.gateway.queue(narratorJson(NARRATED));
    await narrate();
    expect((await narrate()).statusCode).toBe(409); // já narrada
    const narrative = t.repos.pages.listActive(sessionId)[0]!;
    expect((await narrate(narrative.id)).statusCode).toBe(409);
    expect((await narrate('nao-existe')).statusCode).toBe(404);
    expect(t.gateway.requests).toHaveLength(1);
  });

  it('409 com diálogo ativo', async () => {
    t.repos.dialogues.create(sessionId, 'Elena Vance', NPC_PROMPT);
    expect((await narrate()).statusCode).toBe(409);
  });

  it('apaga o áudio antigo (lia a transcrição crua)', async () => {
    t.repos.audio.put(rawId, {
      text_sha256: 'x',
      voice: 'Gacrux',
      model: 'gemini-3.8-flash-tts',
      style: '',
      duration_ms: 1000,
      audio: Buffer.from([1, 2, 3]),
    });
    expect(t.repos.audio.meta(rawId)).toBeDefined();
    t.gateway.queue(narratorJson(NARRATED));
    await narrate();
    expect(t.repos.audio.meta(rawId)).toBeUndefined();
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
