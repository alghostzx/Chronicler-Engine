// Verificação visual da narração por voz (ícone "Ouvir", progresso, player, configurações) nos 8 temas
// (4 temas × claro/escuro), em desktop (1280 px) e celular (390 px). Não usa a API real: sobe o app com
// SQLite em memória e um Gemini simulado cuja síntese demora um pouco (para ver o estado "gerando").
//
// Uso:  npm run build:client && npm run check:audio
//       BROWSER=firefox npm run check:audio       (Firefox do Playwright)
// Falha (exit 1) se alguma verificação não passar; gera capturas em docs/screenshots/audio/
// (Firefox: docs/screenshots/audio-firefox/, ignorado pelo git).
import fs from 'node:fs';
import path from 'node:path';
import { chromium, firefox, type Browser, type Page } from 'playwright-core';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/connection.js';
import { createRepositories } from '../src/db/index.js';
import { buildApp } from '../src/server.js';
import { FAKE_KEY, fakeWav, mockGateway, narratorJson } from '../test/helpers.js';
import { findChrome } from './chrome.js';

const BROWSER = process.env.BROWSER === 'firefox' ? 'firefox' : 'chromium';
const OUT = BROWSER === 'firefox' ? 'docs/screenshots/audio-firefox' : 'docs/screenshots/audio';
fs.mkdirSync(OUT, { recursive: true });

const THEMES = ['medieval', 'cyberpunk', 'pos-apocaliptico', 'contemporaneo'] as const;
const MODES = ['light', 'dark'] as const;
const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 1000, mobile: false },
  { name: 'celular', width: 390, height: 844, mobile: true },
] as const;

// --- Dados de exemplo ---------------------------------------------------------------------------
const SYNTH_DELAY_MS = 1200;
const gateway = mockGateway({
  chunkSize: 4000,
  synthesize: async (req) => {
    await new Promise((r) => setTimeout(r, SYNTH_DELAY_MS));
    return fakeWav(req.text.repeat(8));
  },
});
const repos = createRepositories(openDatabase(':memory:'));
repos.settings.set('gemini_api_key', FAKE_KEY);
const app = await buildApp(loadConfig({ PUBLIC_DIR: path.resolve('public'), HOST: '127.0.0.1', PORT: '0' }), {
  repos,
  gatewayFactory: () => gateway,
  logger: false,
  audio: { retryDelaysMs: [0, 0] },
});
await app.listen({ port: 0, host: '127.0.0.1' });
const addr = app.server.address();
const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

const STORY = [
  ['Chego a Varn ao anoitecer.', 'A neblina subia do porto como um sudário, engolindo os mastros um a um. Varn não acolhia ninguém; apenas tolerava.\n\nVocê empurrou a porta do Corvo Cego e o calor rançoso de sebo e hidromel lhe bateu no rosto.'],
  ['Peço hidromel.', 'A caneca deslizou pelo balcão e parou rente aos seus dedos. Ao ouvir o nome do rei, o murmúrio das mesas vizinhas se apagou, como se alguém tivesse soprado uma vela.\n\n“Quem pergunta pelos mortos costuma se juntar a eles”, murmurou a taverneira.'],
  ['Abro o pergaminho.', 'O papel cheirava a mofo e a medo. Havia apenas um endereço, e ele não levava a lugar algum que você conhecesse.\n\nVocê o releu três vezes antes de guardá-lo.'],
  ['Saio da taverna.', 'A rua estava vazia, e o vento trazia o sal do porto até a língua. Em algum lugar, um sino bateu uma hora que ninguém quis contar.\n\nVocê apertou o manto e seguiu para o cais.'],
  ['Sigo o homem de capuz.', 'O homem de capuz virou a esquina sem pressa, como quem sabe que é seguido e não se importa. Você contou os passos, depois desistiu de contar.\n\nO cais se abriu à frente, negro e molhado, com um único barco aceso.'],
] as const;

const created = await app.inject({ method: 'POST', url: '/api/sessions', payload: { title: 'A Queda de Valdoria', active_theme: 'medieval', world_context: 'Reino de Valdoria.', token_limit: 100_000 } });
const sessionId = created.json().session.id as string;
async function story(): Promise<void> {
  for (const [instruction, text] of STORY) {
    gateway.queue(narratorJson(text, { activate: false }));
    const t = await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/narrative/next`, payload: { player_instruction: instruction } });
    if (!t.body.includes('event: page')) throw new Error(`Turno falhou: ${t.body.slice(0, 300)}`);
  }
}
await story();
gateway.queue('Sinopse: o viajante chega a Varn, ganha um pergaminho enigmático e começa a ser seguido.');
const pv = (await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/compact/preview` })).json();
const commit = await app.inject({
  method: 'POST',
  url: `/api/sessions/${sessionId}/compact/commit`,
  payload: { summary_text: pv.summary_text, covered_page_start_index: pv.covered_page_start_index, covered_page_end_index: pv.covered_page_end_index },
});
if (commit.statusCode !== 200) throw new Error(`Compactação falhou: ${commit.body}`);
await story();

// --- Verificações dentro do navegador ---------------------------------------------------------
/** Executado dentro do navegador: mede o painel de áudio de um cartão. */
function inspectAudio(opts: { expect: 'generating' | 'player' | 'idle' }): string[] {
  const problems: string[] = [];
  const parse = (c: string): [number, number, number, number] => {
    const m = /rgba?\(([^)]+)\)/.exec(c);
    if (!m) return [0, 0, 0, 0];
    const p = m[1]!.split(/[ ,/]+/).filter(Boolean).map(Number);
    return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 1];
  };
  const lum = ([r, g, b]: number[]) => {
    const f = (v: number) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
  };
  const ratio = (a: number[], b: number[]) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x! + 0.05) / (y! + 0.05);
  };
  const blend = (fg: number[], bg: number[]) => {
    const a = fg[3] ?? 1;
    return [0, 1, 2].map((i) => Math.round(fg[i]! * a + bg[i]! * (1 - a)));
  };
  const root = document.documentElement;
  if (root.scrollWidth > root.clientWidth) problems.push(`rolagem horizontal da página: ${root.scrollWidth - root.clientWidth}px`);

  const card = document.querySelector<HTMLElement>('.page-card[data-page-id]:has(.audio-panel:not(.hidden))');
  if (opts.expect === 'idle') {
    if (document.querySelector('.audio-panel:not(.hidden)')) problems.push('painel de áudio visível sem áudio aberto');
    return problems;
  }
  if (!card) return [...problems, 'painel de áudio não apareceu'];
  const panel = card.querySelector<HTMLElement>('.audio-panel')!;
  const cr = card.getBoundingClientRect();
  const pr = panel.getBoundingClientRect();
  if (pr.left < cr.left - 0.5 || pr.right > cr.right + 0.5) problems.push(`painel vaza do cartão (${Math.round(pr.left - cr.left)}…${Math.round(pr.right - cr.right)})`);
  if (panel.scrollWidth > panel.clientWidth + 1) problems.push(`conteúdo do painel mais largo que ele (${panel.scrollWidth} > ${panel.clientWidth})`);
  const sheet = parse(getComputedStyle(card).backgroundColor);

  const text = (sel: string, min: number) => {
    const el = panel.querySelector(sel);
    if (!el) return;
    const c = parse(getComputedStyle(el).color);
    const r = ratio(blend(c, sheet), sheet);
    if (r < min) problems.push(`contraste de ${sel} ${r.toFixed(2)}:1 (< ${min})`);
  };
  text('.audio-time', 4.5);
  text('.audio-status-text', 4.5);
  text('.audio-rate', 3);

  const buttons = Array.from(panel.querySelectorAll<HTMLElement>('button, a.page-action, a.icon-btn, a[role="button"], a[download]'));
  const rects: DOMRect[] = [];
  for (const b of buttons) {
    const name = b.getAttribute('aria-label') ?? b.textContent?.trim() ?? '?';
    const r = b.getBoundingClientRect();
    rects.push(r);
    if (r.width < 32 || r.height < 32) problems.push(`${name}: alvo pequeno (${Math.round(r.width)}×${Math.round(r.height)})`);
    if (r.left < pr.left - 0.5 || r.right > pr.right + 0.5) problems.push(`${name}: fora do painel`);
    if (!b.hasAttribute('aria-label')) problems.push(`${b.className}: botão sem aria-label`);
    if (b.classList.contains('audio-rate')) continue; // mostra texto "1×" em vez de ícone
    if (b.querySelectorAll('svg').length !== 1) problems.push(`${name}: deve ter exatamente um ícone`);
    if (b.textContent?.trim()) problems.push(`${name}: tem texto visível`);
    const c = parse(getComputedStyle(b).color);
    const bg = parse(getComputedStyle(b).backgroundColor);
    const under = bg[3]! > 0.9 ? bg : blend(bg, sheet);
    const rr = ratio(blend(c, under), under);
    if (rr < 3) problems.push(`${name}: contraste do ícone ${rr.toFixed(2)}:1 (< 3)`);
  }
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]!;
      const b = rects[j]!;
      if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) problems.push(`controles sobrepostos: ${buttons[i]!.getAttribute('aria-label')} × ${buttons[j]!.getAttribute('aria-label')}`);
    }
  if (opts.expect === 'player') {
    for (const sel of ['.audio-seek', '.audio-time', '.audio-rate']) {
      const el = panel.querySelector<HTMLElement>(sel);
      if (!el) problems.push(`player sem ${sel}`);
      else {
        const r = el.getBoundingClientRect();
        if (r.width < 24) problems.push(`${sel} estreito demais (${Math.round(r.width)}px)`);
        if (r.right > pr.right + 0.5) problems.push(`${sel} fora do painel`);
      }
    }
    const names = buttons.map((b) => b.getAttribute('aria-label') ?? '');
    for (const wanted of ['Tocar', 'Gerar o áudio de novo', 'Apagar o áudio', 'Baixar o áudio (.mp3)']) if (!names.includes(wanted)) problems.push(`falta o botão “${wanted}”`);
  } else if (!panel.querySelector('.audio-progress, .audio-spin')) problems.push('estado “gerando” sem indicador de progresso');
  return problems;
}

// --- Execução -------------------------------------------------------------------------------------
const exe = BROWSER === 'chromium' ? findChrome() : undefined;
if (BROWSER === 'chromium' && !exe) throw new Error('Chromium não encontrado. Defina CHROME_PATH ou instale um navegador do Playwright.');
const browser: Browser = await (BROWSER === 'chromium' ? chromium : firefox).launch(exe ? { executablePath: exe } : {});
console.log(`Navegador: ${BROWSER} ${browser.version()}`);
const failures: string[] = [];
let checked = 0;

async function open(page: Page, hash: string, ready: string): Promise<void> {
  await page.goto(`${base}/${hash}`);
  await page.reload();
  await page.waitForSelector(ready, { timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

for (const theme of THEMES) {
  await app.inject({ method: 'PUT', url: `/api/sessions/${sessionId}/context`, payload: { active_theme: theme } });
  for (const mode of MODES) {
    for (const vp of VIEWPORTS) {
      const tag = `${theme}-${mode}-${vp.name}`;
      await app.inject({ method: 'DELETE', url: '/api/audio' });
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: vp.mobile ? 2 : 1,
        ...(vp.mobile && BROWSER === 'chromium' ? { isMobile: true } : {}),
        hasTouch: vp.mobile,
        locale: 'pt-BR',
        colorScheme: mode,
      });
      const page = await ctx.newPage();
      await page.addInitScript('window.__name = (fn) => fn;');
      await page.addInitScript((m) => localStorage.setItem('chronicler.mode', m), mode);
      const problems: string[] = [];
      const mark = (what: string, ps: string[]) => ps.forEach((p) => problems.push(`[${what}] ${p}`));
      const shot = (name: string) => page.screenshot({ path: path.join(OUT, `${theme}-${mode}-${vp.name}-${name}.png`) });

      // 1) Tome: gerar o áudio de uma página
      await open(page, `#/s/${sessionId}`, '.page-card[data-page-id]');
      const card = page.locator('.page-card[data-page-id]').nth(1);
      await card.scrollIntoViewIfNeeded();
      const listen = card.getByRole('button', { name: 'Ouvir esta página' });
      await listen.click();
      await card.locator('.audio-panel:not(.hidden)').waitFor({ timeout: 5000 });
      await page.waitForTimeout(250);
      mark('gerando', await page.evaluate(inspectAudio, { expect: 'generating' }));
      await card.scrollIntoViewIfNeeded();
      if (theme === 'medieval' || theme === 'cyberpunk') await shot('gerando');
      await card.locator('.audio-player').waitFor({ timeout: SYNTH_DELAY_MS * 4 + 5000 });
      await page.waitForTimeout(250);
      mark('player', await page.evaluate(inspectAudio, { expect: 'player' }));
      await card.scrollIntoViewIfNeeded();
      if (theme === 'medieval' || theme === 'cyberpunk' || vp.mobile) await shot('player');

      // O ícone "Ouvir" fica visível e sem texto; o áudio gerado é servido como MP3.
      const served = await page.evaluate(async () => {
        const id = document.querySelectorAll('.page-card[data-page-id]')[1]!.getAttribute('data-page-id');
        const r = await fetch(`/api/narrative/pages/${id}/audio`, { headers: { Range: 'bytes=0-3' } });
        return { status: r.status, type: r.headers.get('content-type'), len: (await r.arrayBuffer()).byteLength };
      });
      if (served.status !== 206 || served.type !== 'audio/mpeg' || served.len !== 4) problems.push(`[mp3] resposta inesperada: ${JSON.stringify(served)}`);

      // Tooltips (somente desktop; no toque não existe hover)
      if (!vp.mobile) {
        for (const name of ['Gerar o áudio de novo', 'Apagar o áudio']) {
          const btn = card.getByRole('button', { name });
          await btn.hover();
          await page.waitForTimeout(500);
          const tip = await btn.evaluate((b) => {
            const s = getComputedStyle(b, '::after');
            return { opacity: s.opacity, visibility: s.visibility };
          });
          if (tip.opacity !== '1' || tip.visibility !== 'visible') problems.push(`[tooltip] “${name}” não aparece no hover (${JSON.stringify(tip)})`);
        }
        await page.mouse.move(5, 5);
      }

      // Reprodução: o clique em Tocar deve ativar o estado “tocando” (Firefox sem codec MP3 → aviso)
      await card.getByRole('button', { name: 'Tocar' }).click();
      await page.waitForTimeout(800);
      const playing = await card.locator('.page-action-listen.is-playing').count();
      if (!playing) {
        if (BROWSER === 'firefox') console.log(`    (aviso) ${tag}: Firefox headless não iniciou a reprodução do MP3`);
        else problems.push('[reprodução] o botão Ouvir não entrou em “tocando” depois de Tocar');
      } else {
        if (theme === 'medieval' && mode === 'light') await shot('tocando');
        await card.getByRole('button', { name: 'Pausar' }).click();
      }

      // Apagar o áudio devolve o cartão ao estado inicial (confirmação inclusa)
      await card.getByRole('button', { name: 'Apagar o áudio' }).click();
      const confirm = page.getByRole('button', { name: /^(Apagar|Confirmar|Sim)/ }).last();
      await confirm.click({ timeout: 3000 }).catch(() => problems.push('[apagar] confirmação não apareceu'));
      await page.waitForTimeout(400);
      mark('após apagar', await page.evaluate(inspectAudio, { expect: 'idle' }));

      // 2) Leitor de volume: Ouvir em página já coletada em crônica
      await open(page, `#/s/${sessionId}/v/1`, '.page-card[data-page-id]');
      const vcard = page.locator('.page-card[data-page-id]').first();
      await vcard.getByRole('button', { name: 'Ouvir esta página' }).click();
      await vcard.locator('.audio-panel:not(.hidden)').waitFor({ timeout: 5000 });
      await vcard.locator('.audio-player').waitFor({ timeout: SYNTH_DELAY_MS * 4 + 5000 });
      await page.waitForTimeout(250);
      mark('volume', await page.evaluate(inspectAudio, { expect: 'player' }));
      if (theme === 'cyberpunk' && mode === 'dark') await shot('volume');

      // 3) Gaveta → aba Voz (padrão por sessão)
      await open(page, `#/s/${sessionId}`, '.page-card[data-page-id]');
      await page.getByRole('button', { name: 'Contexto da sessão' }).click();
      await page.getByRole('tab', { name: 'Voz' }).click();
      const select = page.getByLabel('Narração automática desta sessão');
      await select.waitFor({ timeout: 3000 });
      const overflowDrawer = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflowDrawer > 0) problems.push(`[gaveta/voz] rolagem horizontal ${overflowDrawer}px`);
      if (theme === 'medieval' && mode === 'dark') await shot('gaveta-voz');

      // 4) Tela inicial: cartão “Narração por voz”
      await open(page, '#/', 'section, .card');
      const tts = page.getByLabel('Narração por voz').first();
      await tts.waitFor({ timeout: 5000 });
      await tts.scrollIntoViewIfNeeded();
      const homeOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (homeOverflow > 0) problems.push(`[configurações de voz] rolagem horizontal ${homeOverflow}px`);
      const box = await tts.boundingBox();
      if (!box || box.x < -0.5 || box.x + box.width > vp.width + 0.5) problems.push('[configurações de voz] cartão fora da tela');
      for (const name of ['Ouvir amostra', 'Salvar voz', 'Restaurar padrão', 'Apagar todos os áudios']) {
        if ((await tts.getByRole('button', { name: new RegExp(name) }).count()) === 0) problems.push(`[configurações de voz] falta o botão “${name}”`);
      }
      if ((theme === 'medieval' && mode === 'light') || (theme === 'pos-apocaliptico' && mode === 'dark')) await shot('config-voz');

      checked++;
      if (problems.length) {
        failures.push(...problems.map((p) => `${tag}: ${p}`));
        console.log(`✗ ${tag}`);
        for (const p of problems) console.log(`    ${p}`);
      } else {
        console.log(`✓ ${tag}`);
      }
      await ctx.close();
    }
  }
}

await browser.close();
await app.close();
console.log(`\n${checked} combinações verificadas (4 temas × claro/escuro × desktop/celular) em ${BROWSER}; ${failures.length} problema(s).`);
process.exit(failures.length ? 1 : 0);
