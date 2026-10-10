// Gera as capturas de tela do README (docs/screenshots/*.png) com um Chromium headless.
// Não usa a API real: sobe o app com SQLite em memória e um Gemini simulado, populado com
// uma história de exemplo. Uso:
//   npm run build:client && npx tsx scripts/screenshots.ts
// Requer um navegador do Playwright (`npx playwright-core install chromium-headless-shell`) ou
// `CHROME_PATH=/caminho/do/chrome`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/connection.js';
import { createRepositories } from '../src/db/index.js';
import { buildApp } from '../src/server.js';
import { FAKE_KEY, SAMPLE_MODELS, mockGateway, narratorJson, npcJson } from '../test/helpers.js';

const OUT = 'docs/screenshots';
fs.mkdirSync(OUT, { recursive: true });

function findChrome(): string | undefined {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = path.join(os.homedir(), '.cache', 'ms-playwright');
  if (!fs.existsSync(root)) return undefined;
  for (const dir of fs.readdirSync(root).sort().reverse()) {
    if (!dir.startsWith('chromium')) continue;
    for (const sub of ['chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-linux/chrome', 'chrome-linux64/chrome']) {
      const p = path.join(root, dir, sub);
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}

// --- Dados de exemplo --------------------------------------------------------------------------
const gateway = mockGateway({
  chunkSize: 4000,
  listModels: async () => [{ id: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash' }, ...SAMPLE_MODELS],
});
const repos = createRepositories(openDatabase(':memory:'));
repos.settings.set('gemini_api_key', FAKE_KEY);
const app = await buildApp(loadConfig({ PUBLIC_DIR: path.resolve('public'), HOST: '127.0.0.1', PORT: '0' }), {
  repos,
  gatewayFactory: () => gateway,
  logger: false,
});
await app.listen({ port: 0, host: '127.0.0.1' });
const addr = app.server.address();
const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

async function createSession(title: string, theme: string, world: string, limit: number): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/api/sessions', payload: { title, active_theme: theme, world_context: world, token_limit: limit } });
  return r.json().session.id as string;
}
async function turn(id: string, instruction: string, text: string, trigger?: { npc: string; prompt: string }): Promise<void> {
  gateway.queue(
    narratorJson(text, trigger ? { activate: true, npc_name: trigger.npc, dynamic_system_prompt: trigger.prompt } : { activate: false }),
  );
  const r = await app.inject({ method: 'POST', url: `/api/sessions/${id}/narrative/next`, payload: { player_instruction: instruction } });
  if (!r.body.includes('event: page')) throw new Error(`Turno falhou: ${r.body.slice(0, 300)}`);
}

const medieval = await createSession(
  'A Queda de Valdoria',
  'medieval',
  'Reino de Valdoria, tom sombrio e melancólico. O rei Aldric morreu sem herdeiros e o porto de Varn vive de contrabando. A taverna O Corvo Cego é ponto de encontro de espiões.',
  2400,
);
await turn(
  medieval,
  'Chego a Varn ao anoitecer e procuro a taverna O Corvo Cego.',
  'A neblina subia do porto como um sudário, engolindo os mastros um a um. Varn não acolhia ninguém; apenas tolerava. Você empurrou a porta do Corvo Cego e o calor rançoso de sebo e hidromel lhe bateu no rosto.\n\nNo balcão, uma mulher de cabelos grisalhos enxugava uma caneca sem tirar os olhos de você. “Forasteiro”, disse, e a palavra pesou mais do que uma moeda.',
);
await turn(
  medieval,
  'Peço hidromel e pergunto sobre o rei Aldric.',
  'A caneca deslizou pelo balcão e parou rente aos seus dedos. Ao ouvir o nome do rei, o murmúrio das mesas vizinhas se apagou, como se alguém tivesse soprado uma vela.\n\n“Quem pergunta pelos mortos costuma se juntar a eles”, murmurou Elena, a taverneira. Ainda assim, deslizou um pedaço de pergaminho dobrado sob o pano que usava para limpar o balcão.',
  { npc: 'Elena', prompt: 'Você é Elena, taverneira do Corvo Cego: desconfiada, econômica nas palavras, leal aos contrabandistas de Varn. Só revela segredos a quem prova coragem.' },
);
gateway.queue(
  npcJson('Leia depressa e queime depois. O Rei não morreu de febre, forasteiro... e quem o matou ainda janta no castelo.'),
);
const active = await app.inject({ method: 'GET', url: `/api/sessions/${medieval}/dialogue/active` });
const dialogueId = active.json().dialogue.id as string;
const dlg = await app.inject({
  method: 'POST',
  url: `/api/dialogue/${dialogueId}/message`,
  payload: { message: 'Não vim causar problemas. O que diz esse pergaminho?' },
});
if (dlg.statusCode !== 200) throw new Error(`Diálogo falhou: ${dlg.body.slice(0, 300)}`);

const cyber = await createSession(
  'Neon Requiem',
  'cyberpunk',
  'Neo-Tóquio, 2147. Corporações dominam os céus; o submundo vive nos andares baixos. Você é Kira, decker freelancer com um implante neural instável.',
  20_000,
);
await turn(
  cyber,
  'Conecto o deck ao terminal da Arasaka na viela.',
  'A chuva ácida chiava nos letreiros quando o seu deck estalou contra a porta do terminal. Por um instante, só havia estática — depois, a rede se abriu como uma flor de vidro, cheia de gelos negros pulsando em magenta.\n\nUma voz sem rosto sussurrou no seu implante: “Kira, você está atrasada”.',
);

const modern = await createSession(
  'Cartas de Outono',
  'contemporaneo',
  'São Paulo, hoje. Marina é arquiteta, acabou de herdar o apartamento da avó e encontra uma caixa de cartas nunca enviadas.',
  50_000,
);
await turn(
  modern,
  'Abro a caixa de cartas na sala vazia.',
  'A sala ainda cheirava a café requentado e naftalina. Marina sentou-se no chão, entre caixas de papelão, e levantou a tampa de lata. Dezenas de envelopes, todos selados, nenhum carimbado.\n\nO primeiro trazia o seu nome, escrito com a letra inclinada da avó.',
);

// --- Capturas ----------------------------------------------------------------------------------
const exe = findChrome();
if (!exe) throw new Error('Chromium não encontrado. Defina CHROME_PATH ou instale um navegador do Playwright.');
const browser: Browser = await chromium.launch({ executablePath: exe });

async function shoot(
  file: string,
  opts: { hash: string; mode: 'light' | 'dark'; mobile?: boolean; ready: string; act?: (p: Page) => Promise<void>; fullPage?: boolean },
): Promise<void> {
  const ctx = await browser.newContext({
    viewport: opts.mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
    deviceScaleFactor: opts.mobile ? 2 : 1,
    isMobile: opts.mobile ?? false,
    hasTouch: opts.mobile ?? false,
    locale: 'pt-BR',
    colorScheme: opts.mode,
  });
  const page = await ctx.newPage();
  await page.addInitScript((m) => localStorage.setItem('chronicler.mode', m), opts.mode);
  await page.goto(`${base}/${opts.hash}`);
  await page.waitForSelector(opts.ready, { timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const t = document.getElementById('tome-scroll');
    if (t) t.scrollTop = t.scrollHeight;
  });
  if (opts.act) await opts.act(page);
  await page.screenshot({ path: path.join(OUT, file), fullPage: opts.fullPage ?? false });
  if (opts.mobile) {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    console.log(`${file}: rolagem horizontal = ${overflow}px`);
  }
  await ctx.close();
  console.log('ok', file);
}

await shoot('01-biblioteca.png', { hash: '#/', mode: 'dark', ready: 'input[aria-label="Título da crônica"]' });
await shoot('02-tome-medieval.png', { hash: `#/s/${medieval}`, mode: 'dark', ready: 'section[data-page-id]' });
await shoot('03-tome-cyberpunk.png', { hash: `#/s/${cyber}`, mode: 'dark', ready: 'section[data-page-id]' });
await shoot('04-contexto-contemporaneo.png', {
  hash: `#/s/${modern}`,
  mode: 'light',
  ready: 'section[data-page-id]',
  act: async (p) => {
    await p.click('[aria-label="Contexto da sessão"]');
    await p.mouse.move(600, 400); // tira o mouse de cima do botão (sem tooltip na captura)
    await p.waitForTimeout(500);
  },
});
await shoot('05-tema-menu.png', {
  hash: `#/s/${modern}`,
  mode: 'light',
  ready: 'section[data-page-id]',
  act: async (p) => {
    await p.click('[aria-label="Tema visual"]');
    await p.waitForTimeout(200);
  },
});
await shoot('06-tooltip.png', {
  hash: `#/s/${cyber}`,
  mode: 'dark',
  ready: 'section[data-page-id]',
  act: async (p) => {
    await p.hover('[aria-label="Salvar em Markdown"]');
    await p.waitForTimeout(600);
  },
});
await shoot('07-celular-biblioteca.png', { hash: '#/', mode: 'dark', mobile: true, ready: 'input[aria-label="Título da crônica"]', fullPage: true });
await shoot('08-celular-tome.png', { hash: `#/s/${medieval}`, mode: 'light', mobile: true, ready: 'section[data-page-id]' });

await browser.close();
await app.close();
