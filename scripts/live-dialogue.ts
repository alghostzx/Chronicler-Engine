// Verificação manual ponta a ponta do Modo Diálogo contra a API real (usa GEMINIKEY.txt).
// Uso: npx tsx scripts/live-dialogue.ts [modelo]
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/connection.js';
import { createRepositories } from '../src/db/index.js';
import { checkDialogueFidelity } from '../src/ai/dialogueProse.js';
import { buildApp } from '../src/server.js';

const repos = createRepositories(openDatabase(':memory:'));
repos.settings.set('gemini_api_key', fs.readFileSync('GEMINIKEY.txt', 'utf8').trim());
const app = await buildApp(loadConfig({ PUBLIC_DIR: '/inexistente' }), { repos });

const model = process.argv[2];
const sessionId = (
  await app.inject({
    method: 'POST',
    url: '/api/sessions',
    payload: {
      title: 'Diálogo real',
      world_context: 'Reino medieval de Aldor, tom sombrio. A taverna O Corvo Cego fica no porto de Varn. Elena é a taverneira.',
      ...(model ? { model } : {}),
    },
  })
).json().session.id;

const sse = (body: string) =>
  body
    .split('\n\n')
    .filter((f) => f.startsWith('event:'))
    .map((f) => {
      const [e, d] = f.split('\n');
      return { event: e!.slice(7), data: JSON.parse(d!.slice(5)) };
    });

const turn = await app.inject({
  method: 'POST',
  url: `/api/sessions/${sessionId}/narrative/next`,
  payload: { player_instruction: 'Entro no Corvo Cego e, assim que encontro Elena atrás do balcão, iniciamos um diálogo direto.' },
});
const events = sse(turn.body);
console.log('Eventos do turno:', events.map((e) => e.event).join(','));
const trigger = events.find((e) => e.event === 'dialogue_trigger');
if (!trigger) throw new Error('O Narrador não ativou o diálogo');
console.log('Diálogo com:', trigger.data.npc_name);
console.log('\nPROMPT DINÂMICO DO NPC (servidor):\n' + repos.dialogues.get(trigger.data.dialogue_id)!.dynamic_system_prompt);

const did = trigger.data.dialogue_id;
for (const line of ['Procuro um navio que parta para o norte esta noite. Sabe de algum?', 'Posso pagar bem. Quem eu procuro?']) {
  const res = (await app.inject({ method: 'POST', url: `/api/dialogue/${did}/message`, payload: { message: line } })).json();
  console.log(`\nJOGADOR: ${line}\nNPC: ${res.npc_message?.content ?? JSON.stringify(res)}  [quer encerrar: ${res.npc_wants_to_end}]`);
}

const t0 = Date.now();
const concl = sse((await app.inject({ method: 'POST', url: `/api/dialogue/${did}/conclude`, payload: {} })).body);
console.log('\nEventos do encerramento:', concl.map((e) => e.event).filter((e) => e !== 'chunk').join(','), `(${Math.round((Date.now() - t0) / 1000)} s)`);
const final = concl.find((e) => e.event === 'page');
if (!final) throw new Error(`Encerrar falhou: ${JSON.stringify(concl.find((e) => e.event === 'error')?.data)}`);
const page = final.data.page;
const stored = repos.pages.get(page.id)!;
console.log('\nTRANSCRIÇÃO CRUA (player_instruction):\n' + stored.player_instruction);
console.log('\nPÁGINA DO DIÁLOGO (' + final.data.narration + '):\n' + page.generated_text);
console.log('\nTipo:', page.kind, '| NPC:', page.npc_name, '| crua:', page.raw_dialogue, '| rótulo do jogador:', repos.dialogues.get(did)!.player_name ?? '(padrão)');
console.log('Fidelidade das falas:', JSON.stringify(checkDialogueFidelity(stored.player_instruction ?? '', page.generated_text)));
console.log('Páginas:', repos.pages.listActive(sessionId).length, '| diálogo ativo:', repos.dialogues.getActive(sessionId)?.npc_name ?? 'nenhum');

// Reprocessamento: uma página crua (como as de antes) vira prosa sem tocar nas seguintes.
const raw = repos.pages.append(sessionId, {
  kind: 'dialogue',
  npc_name: 'Elena',
  raw_dialogue: true,
  generated_text: '**Aldric:** Quanto custa a passagem?\n\n**Elena:** Mais do que você carrega na bolsa. Beba, e esqueça o que ouviu.',
});
const after = repos.pages.append(sessionId, { player_instruction: 'depois', generated_text: 'Página seguinte (deve ficar intacta).' });
const t1 = Date.now();
const re = sse((await app.inject({ method: 'POST', url: `/api/narrative/pages/${raw.id}/narrate-dialogue` })).body);
console.log('\nEventos do reprocessamento:', re.map((e) => e.event).filter((e) => e !== 'chunk').join(','), `(${Math.round((Date.now() - t1) / 1000)} s)`);
console.log(re.find((e) => e.event === 'page')?.data.page.generated_text ?? JSON.stringify(re.find((e) => e.event === 'error')?.data));
console.log('Página seguinte intacta:', repos.pages.get(after.id)!.generated_text === 'Página seguinte (deve ficar intacta).');
await app.close();
