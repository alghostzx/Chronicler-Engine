// Teste ponta a ponta REAL da narração por voz (gasta alguns centavos de tokens de TTS/texto).
// O servidor sobe com SQLite em memória e um narrador simulado, mas a síntese usa a API real do Gemini
// (chave em GEMINIKEY.txt — nunca é impressa). Gera o áudio de uma página pelo endpoint do app, confere o
// MP3 servido (cabeçalho, duração, Range) e TRANSCREVE o resultado com um modelo de texto para verificar
// que o português foi lido fielmente (não dá para "ouvir" aqui).
//
// Uso:  npx tsx scripts/live-tts-e2e.ts            (modelo e voz padrão)
//       TTS_MODEL=gemini-3.8-flash-lite-tts npx tsx scripts/live-tts-e2e.ts
import fs from 'node:fs';
import { GoogleGenAI } from '@google/genai';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/connection.js';
import { createRepositories } from '../src/db/index.js';
import { GeminiGatewayImpl, type GeminiGateway } from '../src/ai/gateway.js';
import { buildApp } from '../src/server.js';
import { mockGateway, narratorJson } from '../test/helpers.js';

const key = fs.readFileSync('GEMINIKEY.txt', 'utf8').trim();
const TRANSCRIBER = process.env.TRANSCRIBER ?? 'gemini-3.8-flash';

const mock = mockGateway();
const real = new GeminiGatewayImpl(key);
// Narrador simulado; síntese real.
const gateway = new Proxy(mock, {
  get: (target, prop) => (prop === 'synthesize' ? real.synthesize.bind(real) : (target as never)[prop]),
}) as unknown as GeminiGateway;

const repos = createRepositories(openDatabase(':memory:'));
repos.settings.set('gemini_api_key', key);
const app = await buildApp(loadConfig({ PUBLIC_DIR: process.cwd() + '/public', HOST: '127.0.0.1', PORT: '0' }), { repos, gatewayFactory: () => gateway, logger: false });

const TEXT =
  'A neblina subia do porto como um sudário, engolindo os mastros um a um. Varn não acolhia ninguém; apenas tolerava.\n\nVocê empurrou a porta do Corvo Cego e o calor rançoso de sebo e hidromel lhe bateu no rosto.';
const sessionId = (await app.inject({ method: 'POST', url: '/api/sessions', payload: { title: 'E2E TTS', active_theme: 'medieval', world_context: 'Reino de Valdoria.', token_limit: 100_000 } })).json().session.id as string;
mock.queue(narratorJson(TEXT, { activate: false }));
const turn = await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/narrative/next`, payload: { player_instruction: 'Chego a Varn.' } });
if (!turn.body.includes('event: page')) throw new Error(`Turno falhou: ${turn.body.slice(0, 200)}`);
const pageId = (await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` })).json().pages[0].id as string;

if (process.env.TTS_MODEL) {
  const r = await app.inject({ method: 'PUT', url: '/api/settings/tts', payload: { model: process.env.TTS_MODEL } });
  if (r.statusCode !== 200) throw new Error(`Configuração recusada: ${r.body}`);
}
const settings = (await app.inject({ method: 'GET', url: '/api/settings/tts' })).json();
console.log(`Modelo: ${settings.model} | voz: ${settings.voice}`);

async function generateAndWait(label: string): Promise<void> {
  const t0 = Date.now();
  const start = await app.inject({ method: 'POST', url: `/api/narrative/pages/${pageId}/audio` });
  if (start.statusCode !== 202) throw new Error(`${label}: início falhou (${start.statusCode}): ${start.body}`);
  for (;;) {
    const st = (await app.inject({ method: 'GET', url: `/api/narrative/pages/${pageId}/audio/status` })).json().audio;
    if (st?.status === 'ready') {
      console.log(`${label}: pronto em ${((Date.now() - t0) / 1000).toFixed(1)} s — ${st.bytes} bytes, ${(st.duration_ms / 1000).toFixed(1)} s`);
      return;
    }
    if (st?.status === 'error') throw new Error(`${label}: erro: ${st.error}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

await generateAndWait('geração');
const mp3 = await app.inject({ method: 'GET', url: `/api/narrative/pages/${pageId}/audio` });
const buf = mp3.rawPayload;
console.log(`GET áudio: ${mp3.statusCode} ${mp3.headers['content-type']} ${buf.length} bytes; início ${buf.subarray(0, 3).toString('latin1') === 'ID3' ? 'ID3' : buf.subarray(0, 2).toString('hex')}`);
const range = await app.inject({ method: 'GET', url: `/api/narrative/pages/${pageId}/audio`, headers: { range: 'bytes=0-9' } });
console.log(`Range: ${range.statusCode} ${range.headers['content-range']}`);
fs.writeFileSync('/tmp/chronicler-e2e.mp3', buf);

const ai = new GoogleGenAI({ apiKey: key });
const tr = await ai.models.generateContent({
  model: TRANSCRIBER,
  contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/mpeg', data: buf.toString('base64') } }, { text: 'Transcreva exatamente o que é falado, sem comentários. Depois, em uma linha começando com "VOZ:", descreva a voz e o sotaque.' }] }],
});
console.log(`Transcrição:\n${tr.text}`);

// Re-gerar substitui o áudio anterior (um único registro).
await generateAndWait('re-geração');
console.log(`Áudios guardados: ${repos.audio.usage().count}`);
await app.close();
fs.rmSync('/tmp/chronicler-e2e.mp3', { force: true });
