// Verificação manual da compactação contra a API real (usa GEMINIKEY.txt).
// Uso: npx tsx scripts/live-compaction.ts [modelo]
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/connection.js';
import { createRepositories } from '../src/db/index.js';
import { buildApp } from '../src/server.js';

const repos = createRepositories(openDatabase(':memory:'));
repos.settings.set('gemini_api_key', fs.readFileSync('GEMINIKEY.txt', 'utf8').trim());
const app = await buildApp(loadConfig({ PUBLIC_DIR: '/inexistente' }), { repos });
const model = process.argv[2];

const session = repos.sessions.create({
  title: 'Compactação real',
  system_rules: 'Você é o Narrador.',
  world_context: 'Reino medieval de Aldor, tom sombrio. Porto de Varn.',
  token_limit: 3000,
  model: model ?? null,
});

const prose = [
  'Kael desembarcou no porto de Varn sob chuva fina, carregando apenas uma espada herdada do pai e uma carta lacrada com o selo do duque Aldric. No cais, o contrabandista Torvo ofereceu-lhe passagem para as ilhas do norte por dez moedas de prata; Kael recusou e seguiu para a taverna O Corvo Cego. ' + 'A chuva engrossava e as docas cheiravam a sal e alcatrão. '.repeat(6),
  'Na taverna, a taverneira Elena avisou que a carta de Kael era conhecida: homens do duque haviam procurado por ele na véspera. Kael pagou duas moedas por um quarto e dormiu com a espada na mão. Durante a noite, um desconhecido arrombou a porta e fugiu ao ser surpreendido, deixando cair um broche de corvo negro. ' + 'O vento uivava nas vigas podres da hospedaria. '.repeat(6),
  'Pela manhã, Kael seguiu o rastro do broche até um armazém abandonado e lá enfrentou três capangas de Torvo. Matou dois e feriu o terceiro, que confessou que Torvo trabalhava para o conselheiro Maren, rival do duque. Kael perdeu a carta do duque no combate, queimada por uma lamparina derrubada. ' + 'O armazém ardeu até restarem apenas vigas escuras. '.repeat(6),
  'Kael voltou ao Corvo Cego ferido no braço esquerdo. Elena tratou do ferimento em troca de uma promessa: que ele levasse seu irmão Piet, marinheiro, em segurança até a fortaleza de Aldric. Kael aceitou. ' + 'A lareira estalava e a taverna estava vazia pela primeira vez em semanas. '.repeat(6),
  'Os dois partiram ao anoitecer numa carroça emprestada. Na estrada da floresta de Dornmoor, Piet revelou que Maren planejava envenenar o duque no festival da colheita, dali a nove dias. Kael jurou chegar a tempo. ' + 'As árvores fechavam o céu sobre eles como dedos tortos. '.repeat(6),
  'Uma ponte caída os obrigou a acampar. À noite, lobos cercaram a carroça; Kael afugentou-os com fogo, mas o cavalo fugiu e a carroça ficou. Seguiram a pé, com o festival a oito dias de distância. ' + 'A fogueira morria devagar, e Piet murmurava orações na escuridão. '.repeat(6),
];
for (const [i, text] of prose.entries()) {
  repos.pages.append(session.id, { player_instruction: `META-SECRETA-${i}`, generated_text: text });
}

const hp = async () => (await app.inject({ method: 'GET', url: `/api/sessions/${session.id}/token-count` })).json();
const before = await hp();
console.log('HP antes:', before);

const pv = (await app.inject({ method: 'POST', url: `/api/sessions/${session.id}/compact/preview` })).json();
console.log('\nMINUTA:', { ...pv, summary_text: undefined });
console.log('\nSINOPSE GERADA:\n' + pv.summary_text);

const commit = await app.inject({
  method: 'POST',
  url: `/api/sessions/${session.id}/compact/commit`,
  payload: {
    summary_text: pv.summary_text,
    covered_page_start_index: pv.covered_page_start_index,
    covered_page_end_index: pv.covered_page_end_index,
  },
});
console.log('\ncommit:', commit.statusCode, 'arquivados:', commit.json().archived_pages);
console.log('\nworld_context agora:\n' + repos.sessions.get(session.id)!.world_context);
const after = await hp();
console.log('\nHP depois:', after);
console.log(after.tokens_used < before.tokens_used ? 'OK: HP recuperado' : 'ATENÇÃO: HP não recuperou');
await app.close();
