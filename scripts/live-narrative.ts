// Verificação manual ponta a ponta contra a API real (usa GEMINIKEY.txt; não imprime a chave).
// Uso: npx tsx scripts/live-narrative.ts [modelo]
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/connection.js';
import { createRepositories } from '../src/db/index.js';
import { buildApp } from '../src/server.js';

const key = fs.readFileSync('GEMINIKEY.txt', 'utf8').trim();
const repos = createRepositories(openDatabase(':memory:'));
repos.settings.set('gemini_api_key', key);
const app = await buildApp(loadConfig({ PUBLIC_DIR: '/inexistente' }), { repos, logger: false });

const model = process.argv[2];
const created = await app.inject({
  method: 'POST',
  url: '/api/sessions',
  payload: {
    title: 'Teste real',
    world_context: 'Reino medieval de Aldor, tom sombrio. A taverna O Corvo Cego fica no porto de Varn.',
    ...(model ? { model } : {}),
  },
});
const sessionId = created.json().session.id;

async function turn(instruction: string) {
  const t0 = Date.now();
  const res = await app.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/narrative/next`,
    payload: { player_instruction: instruction },
  });
  if (res.headers['content-type']?.toString().includes('json')) {
    console.log('ERRO HTTP', res.statusCode, res.body);
    return;
  }
  const frames = res.body.split('\n\n').filter((f) => f.startsWith('event:'));
  const names = frames.map((f) => f.split('\n')[0]!.slice(7));
  const chunks = names.filter((n) => n === 'chunk').length;
  console.log(`\n>>> "${instruction}"  (${Date.now() - t0} ms, ${chunks} chunks, eventos finais: ${names.slice(-3).join(',')})`);
  for (const f of frames) {
    const [e, d] = f.split('\n');
    const data = JSON.parse(d!.slice(5));
    if (e === 'event: start') console.log('modelo:', data.model);
    if (e === 'event: error') console.log('ERRO:', data.message);
    if (e === 'event: block') console.log('\nTEXTO:\n' + data.block.generated_text);
    if (e === 'event: dialogue_trigger') console.log('\nDIÁLOGO →', data.npc_name);
  }
}

await turn('Entro no Corvo Cego, me sento no balcão e peço uma caneca de hidromel.');
await turn('Assim que vejo a taverneira Elena, inicio um diálogo direto com ela.');

const blocks = repos.blocks.listActive(sessionId);
console.log(`\nBlocos salvos: ${blocks.length}; diálogo ativo:`, repos.dialogues.getActive(sessionId)?.npc_name ?? 'nenhum');
await app.close();
