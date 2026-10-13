// Verificação visual da narração por voz (ícone "Ouvir", progresso, menu de opções, barra do player,
// configurações) nos 8 temas
// (4 temas × claro/escuro), em desktop (1280 px) e celular (390 px). Não usa a API real: sobe o app com
// SQLite em memória e um Gemini simulado cuja síntese demora um pouco (para ver o estado "gerando").
//
// Uso:  npm run build:client && npm run check:audio
//       BROWSER=firefox npm run check:audio       (Firefox do Playwright)
//       ONLY=medieval-light-desktop npm run check:audio   (só as combinações listadas, separadas por vírgula)
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

const ONLY = process.env.ONLY?.split(',').map((t) => t.trim());
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
/** Executado dentro do navegador: mede o painel de áudio de um cartão (só aparece gerando ou com erro). */
function inspectAudio(opts: { expect: 'generating' | 'idle' }): string[] {
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
  // O player não mora mais no cartão: nenhuma página pode ter controles de posição/velocidade.
  if (document.querySelector('.page-card .audio-seek, .page-card .audio-rate, .page-card .audio-player')) problems.push('o cartão da página ainda tem controles de player');

  const card = document.querySelector<HTMLElement>('.page-card[data-page-id]:has(.audio-panel:not(.hidden))');
  if (opts.expect === 'idle') {
    if (card) problems.push('painel de áudio visível sem geração em andamento');
    return problems;
  }
  if (!card) return [...problems, 'painel de áudio não apareceu'];
  const panel = card.querySelector<HTMLElement>('.audio-panel')!;
  const cr = card.getBoundingClientRect();
  const pr = panel.getBoundingClientRect();
  if (pr.left < cr.left - 0.5 || pr.right > cr.right + 0.5) problems.push(`painel vaza do cartão (${Math.round(pr.left - cr.left)}…${Math.round(pr.right - cr.right)})`);
  if (panel.scrollWidth > panel.clientWidth + 1) problems.push(`conteúdo do painel mais largo que ele (${panel.scrollWidth} > ${panel.clientWidth})`);
  const sheet = parse(getComputedStyle(card).backgroundColor);
  const t = panel.querySelector('.audio-status-text');
  if (t) {
    const r = ratio(blend(parse(getComputedStyle(t).color), sheet), sheet);
    if (r < 4.5) problems.push(`contraste do texto de status ${r.toFixed(2)}:1 (< 4.5)`);
  }
  for (const b of Array.from(panel.querySelectorAll<HTMLElement>('button'))) {
    const name = b.getAttribute('aria-label') ?? b.textContent?.trim() ?? '?';
    const r = b.getBoundingClientRect();
    if (r.width < 32 || r.height < 32) problems.push(`${name}: alvo pequeno (${Math.round(r.width)}×${Math.round(r.height)})`);
    if (r.left < pr.left - 0.5 || r.right > pr.right + 0.5) problems.push(`${name}: fora do painel`);
    if (!b.hasAttribute('aria-label')) problems.push(`${b.className}: botão sem aria-label`);
    if (b.querySelectorAll('svg').length !== 1) problems.push(`${name}: deve ter exatamente um ícone`);
    if (b.textContent?.trim()) problems.push(`${name}: tem texto visível`);
  }
  if (!panel.querySelector('.audio-progress, .audio-spin')) problems.push('estado “gerando” sem indicador de progresso');
  return problems;
}

/** Executado dentro do navegador: mede a barra do player (uma página, ou reprodução contínua). */
function inspectBar(opts: { mode: 'single' | 'continuous'; title: string }): string[] {
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
  const bar = document.querySelector<HTMLElement>('[data-player-bar]:not(.hidden)');
  if (!bar) return ['a barra do player não está visível'];
  const r = bar.getBoundingClientRect();
  const root = document.documentElement;
  if (r.left < -0.5 || r.right > window.innerWidth + 0.5) problems.push(`barra fora da tela (${Math.round(r.left)}…${Math.round(r.right)} de ${window.innerWidth})`);
  if (bar.scrollWidth > bar.clientWidth + 1) problems.push(`conteúdo da barra mais largo que ela (${bar.scrollWidth} > ${bar.clientWidth})`);
  if (root.scrollWidth > root.clientWidth) problems.push('rolagem horizontal da página com a barra');
  if (root.scrollHeight > root.clientHeight + 1) problems.push(`a página inteira passou a rolar com a barra (${root.scrollHeight} > ${root.clientHeight})`);
  if (r.bottom > window.innerHeight + 0.5) problems.push('barra cortada embaixo da tela');
  if (r.height > window.innerHeight * 0.3) problems.push(`barra alta demais (${Math.round(r.height)}px de ${window.innerHeight}px)`);
  const dock = document.querySelector<HTMLElement>('main > footer');
  if (dock) {
    const d = dock.getBoundingClientRect();
    if (r.bottom > d.top + 1) problems.push('barra sobreposta à Doca');
    if (d.bottom > window.innerHeight + 1 || d.bottom < window.innerHeight - 2) problems.push('a Doca saiu do fim da tela');
  } else if (r.bottom < window.innerHeight - 2) problems.push('no leitor de volumes a barra deveria ficar no fim da tela');
  if (bar.getAttribute('data-mode') !== opts.mode) problems.push(`modo da barra “${bar.getAttribute('data-mode')}” (esperado ${opts.mode})`);

  const heading = bar.querySelector('.player-bar-title')?.textContent ?? '';
  const wantTitle = opts.mode === 'continuous' ? `«${opts.title}»` : `Tocando a Página`;
  if (opts.mode === 'continuous' ? heading !== wantTitle : !heading.startsWith(wantTitle)) problems.push(`título da barra inesperado: ${heading}`);
  if (opts.mode === 'continuous' && /Reproduzindo|modo contínuo/.test(heading)) problems.push('o título do modo contínuo deveria usar só o ícone, sem as palavras “Reproduzindo”/“modo contínuo”');
  if (opts.mode === 'continuous' && !(bar.getAttribute('aria-label') ?? '').includes('em modo contínuo')) problems.push('a região da barra deveria ter o nome completo para leitores de tela');
  if (opts.mode === 'single' && !heading.endsWith(`de «${opts.title}»`)) problems.push(`título da barra sem a crônica: ${heading}`);

  const bg = parse(getComputedStyle(bar).backgroundColor);
  for (const sel of ['.player-bar-title', '.player-bar-detail', '.audio-time', '.audio-rate']) {
    const el = bar.querySelector(sel);
    if (!el) {
      problems.push(`falta ${sel} na barra`);
      continue;
    }
    const c = ratio(blend(parse(getComputedStyle(el).color), bg), bg);
    const min = sel === '.audio-rate' ? 3 : 4.5;
    if (c < min) problems.push(`contraste de ${sel} ${c.toFixed(2)}:1 (< ${min})`);
  }

  const visible = Array.from(bar.querySelectorAll<HTMLElement>('button, a')).filter((b) => b.getClientRects().length > 0);
  const names = visible.map((b) => b.getAttribute('aria-label') ?? '');
  const has = (n: string) => names.includes(n);
  if (!has('Tocar') && !has('Pausar')) problems.push('falta Tocar/Pausar na barra');
  if (opts.mode === 'continuous') {
    for (const n of ['Página anterior', 'Próxima página', 'Interromper a reprodução contínua']) if (!has(n)) problems.push(`falta o botão “${n}”`);
    if (has('Fechar o player')) problems.push('“Fechar o player” não existe no modo contínuo');
  } else {
    if (!has('Fechar o player')) problems.push('falta o botão “Fechar o player”');
    for (const n of ['Página anterior', 'Próxima página', 'Interromper a reprodução contínua']) if (has(n)) problems.push(`“${n}” não existe fora do modo contínuo`);
  }
  for (const b of visible) {
    const name = b.getAttribute('aria-label') ?? b.textContent?.trim() ?? '?';
    const br = b.getBoundingClientRect();
    if (br.width < 32 || br.height < 32) problems.push(`${name}: alvo pequeno (${Math.round(br.width)}×${Math.round(br.height)})`);
    if (br.left < r.left - 0.5 || br.right > r.right + 0.5) problems.push(`${name}: fora da barra`);
    if (!b.hasAttribute('aria-label')) problems.push(`${b.className}: botão sem aria-label`);
    if (b.classList.contains('audio-rate')) continue; // mostra "1×" em vez de ícone
    if (b.querySelectorAll('svg').length !== 1) problems.push(`${name}: deve ter exatamente um ícone`);
    if (b.classList.contains('player-bar-stop')) {
      if (!b.textContent?.includes('Interromper')) problems.push('Interromper deve ter texto e um ícone');
      continue;
    }
    if (b.textContent?.trim()) problems.push(`${name}: tem texto visível`);
    const col = parse(getComputedStyle(b).color);
    const bbg = parse(getComputedStyle(b).backgroundColor);
    const under = bbg[3]! > 0.9 ? bbg : blend(bbg, bg);
    const rr = ratio(blend(col, under), under);
    if (rr < 3) problems.push(`${name}: contraste do ícone ${rr.toFixed(2)}:1 (< 3)`);
  }
  const rects = visible.map((b) => b.getBoundingClientRect());
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]!;
      const b = rects[j]!;
      if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) problems.push(`controles sobrepostos: ${names[i]} × ${names[j]}`);
    }
  const seek = bar.querySelector<HTMLElement>('.audio-seek');
  if (seek) {
    const sr = seek.getBoundingClientRect();
    if (sr.width < 80) problems.push(`posição do áudio estreita demais (${Math.round(sr.width)}px)`);
    if (sr.right > r.right + 0.5 || sr.left < r.left - 0.5) problems.push('posição do áudio fora da barra');
  } else problems.push('barra sem controle de posição');
  return problems;
}

/** Executado dentro do navegador: mede o menu "Opções do áudio" aberto no rodapé de um cartão. */
function inspectMenu(): string[] {
  const problems: string[] = [];
  const menu = document.querySelector<HTMLElement>('.page-card .menu:not(.hidden)');
  if (!menu) return ['o menu de opções do áudio não abriu'];
  const r = menu.getBoundingClientRect();
  if (r.left < -0.5 || r.right > window.innerWidth + 0.5 || r.top < -0.5) problems.push(`menu fora da tela (${Math.round(r.left)}…${Math.round(r.right)}, topo ${Math.round(r.top)})`);
  const btn = menu.parentElement!.querySelector<HTMLElement>('.page-action-menu')!;
  if (r.bottom > btn.getBoundingClientRect().top + 1) problems.push('o menu deveria abrir para cima do botão');
  const names = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')).map((i) => i.textContent?.trim());
  for (const want of ['Baixar o áudio (.mp3)', 'Gerar o áudio de novo', 'Apagar o áudio']) if (!names.includes(want)) problems.push(`falta o item “${want}” (tem: ${names.join(', ')})`);
  for (const item of Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'))) {
    const ir = item.getBoundingClientRect();
    if (ir.height < 32) problems.push(`${item.textContent}: item baixo demais (${Math.round(ir.height)}px)`);
    if (ir.right > r.right + 0.5 || ir.left < r.left - 0.5) problems.push(`${item.textContent}: item fora do menu`);
    if (item.querySelectorAll('svg').length !== 1) problems.push(`${item.textContent}: deve ter um ícone`);
  }
  if (menu.scrollWidth > menu.clientWidth + 1) problems.push('conteúdo do menu mais largo que ele');
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
      if (ONLY && !ONLY.includes(tag)) continue;
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
      const shot = async (name: string) => {
        // Sem avisos (toasts) nem tooltips de foco nas capturas que vão para a documentação.
        await page.evaluate(() => {
          document.getElementById('toasts')?.replaceChildren();
          (document.activeElement as HTMLElement | null)?.blur?.();
        });
        await page.screenshot({ path: path.join(OUT, `${theme}-${mode}-${vp.name}-${name}.png`) });
      };

      const TITLE = 'A Queda de Valdoria';
      const bar = page.locator('[data-player-bar]');
      // Só dá para pular no tempo com a faixa carregada (esperando a geração, a posição fica desabilitada).
      const seekNearEnd = async () => {
        await page.waitForSelector('[data-player-bar] input.audio-seek:not([disabled])', { timeout: SYNTH_DELAY_MS * 4 + 5000 });
        await page.waitForFunction(() => Number(document.querySelector<HTMLInputElement>('[data-player-bar] input.audio-seek')?.max) > 1, null, { timeout: 5000 });
        await bar.locator('input.audio-seek').evaluate((el) => {
          const input = el as HTMLInputElement;
          input.value = String(Math.max(0, Number(input.max) - 0.6));
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        });
      };

      // 1) Tome: gerar o áudio de uma página (o cartão só mostra o status da geração)
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
      await card.locator('.page-action-menu').waitFor({ state: 'visible', timeout: SYNTH_DELAY_MS * 4 + 5000 });
      await page.waitForTimeout(250);
      mark('pronto (só o menu no cartão)', await page.evaluate(inspectAudio, { expect: 'idle' }));
      if ((await bar.locator(':scope:not(.hidden)').count()) !== 0) problems.push('[pronto] a barra do player não deveria abrir sozinha ao terminar de gerar');

      // O áudio gerado é servido como MP3.
      const served = await page.evaluate(async () => {
        const id = document.querySelectorAll('.page-card[data-page-id]')[1]!.getAttribute('data-page-id');
        const r = await fetch(`/api/narrative/pages/${id}/audio`, { headers: { Range: 'bytes=0-3' } });
        return { status: r.status, type: r.headers.get('content-type'), len: (await r.arrayBuffer()).byteLength };
      });
      if (served.status !== 206 || served.type !== 'audio/mpeg' || served.len !== 4) problems.push(`[mp3] resposta inesperada: ${JSON.stringify(served)}`);

      // Tooltips (somente desktop; no toque não existe hover)
      if (!vp.mobile) {
        for (const [where, name] of [[card, 'Opções do áudio'], [bar, 'Fechar o player']] as const) {
          if (where === bar) {
            await listen.click(); // abre a barra (o botão de fechar só existe com ela visível)
            await bar.locator(':scope:not(.hidden)').waitFor({ timeout: 3000 });
          }
          const btn = where.getByRole('button', { name });
          await btn.hover();
          await page.waitForTimeout(500);
          const tip = await btn.evaluate((b) => {
            const s = getComputedStyle(b, '::after');
            return { opacity: s.opacity, visibility: s.visibility };
          });
          if (tip.opacity !== '1' || tip.visibility !== 'visible') problems.push(`[tooltip] “${name}” não aparece no hover (${JSON.stringify(tip)})`);
        }
        await page.mouse.move(5, 5);
        await bar.getByRole('button', { name: 'Fechar o player' }).click();
        await page.waitForTimeout(200);
      }

      // Reprodução: o clique em Ouvir toca e abre a barra (Firefox sem codec MP3 → aviso)
      await listen.click();
      await bar.locator(':scope:not(.hidden)').waitFor({ timeout: 3000 }).catch(() => problems.push('[player] a barra não apareceu ao ouvir a página'));
      await page.waitForTimeout(800);
      mark('barra/uma página', await page.evaluate(inspectBar, { mode: 'single', title: TITLE }));
      const playing = await card.locator('.page-action-listen.is-playing').count();
      if (!playing) {
        if (BROWSER === 'firefox') console.log(`    (aviso) ${tag}: Firefox headless não iniciou a reprodução do MP3`);
        else problems.push('[reprodução] o botão Ouvir não entrou em “tocando” depois de Ouvir');
      } else {
        await page.waitForTimeout(300);
        await card.scrollIntoViewIfNeeded();
        if (theme === 'medieval' || theme === 'cyberpunk' || vp.mobile) await shot('player');
        await bar.getByRole('button', { name: 'Pausar' }).click();
        await page.waitForTimeout(200);
        if (!/Pausado/.test((await bar.textContent()) ?? '')) problems.push('[player] a barra não mostrou “Pausado” depois de Pausar');
        if (await card.locator('.page-action-listen.is-playing').count()) problems.push('[player] o botão Ouvir continuou “tocando” depois de Pausar');
        if (theme === 'medieval' && mode === 'light') await shot('tocando');
      }

      // Menu "Opções do áudio" no rodapé do cartão: baixar, gerar de novo, apagar
      await card.getByRole('button', { name: 'Opções do áudio' }).click();
      await page.waitForTimeout(150);
      mark('menu de opções', await page.evaluate(inspectMenu));
      if ((theme === 'medieval' && mode === 'dark') || (theme === 'cyberpunk' && vp.mobile)) await shot('menu');
      await card.getByRole('menuitem', { name: 'Apagar o áudio' }).click();
      const confirm = page.getByRole('button', { name: /^(Apagar|Confirmar|Sim)/ }).last();
      await confirm.click({ timeout: 3000 }).catch(() => problems.push('[apagar] confirmação não apareceu'));
      await page.waitForTimeout(400);
      mark('após apagar', await page.evaluate(inspectAudio, { expect: 'idle' }));
      if ((await card.locator('.page-action-menu:visible').count()) !== 0) problems.push('[apagar] o menu de opções deveria sumir sem áudio');
      if ((await bar.locator(':scope:not(.hidden)').count()) !== 0) problems.push('[apagar] a barra deveria sumir ao apagar o áudio da página que tocava');

      // 1b) Reprodução contínua: gera as faltantes (modal), toca em sequência e encerra sozinha
      {
        const cards = page.locator('.page-card[data-page-id]');
        const total = await cards.count();
        const c3 = cards.nth(total - 2); // as duas últimas páginas: 2 de 2
        await c3.scrollIntoViewIfNeeded();
        await c3.getByRole('button', { name: 'Reproduzir a partir daqui' }).click();
        await page.getByRole('button', { name: 'Gerar e reproduzir' }).click({ timeout: 3000 }).catch(() => problems.push('[contínuo] modal de geração não apareceu'));
        try {
          await page.waitForSelector('[data-player-bar]:not(.hidden)[data-mode="continuous"]', { timeout: SYNTH_DELAY_MS * 4 + 5000 });
          await page.waitForSelector('[data-player-bar] input.audio-seek:not([disabled])', { timeout: SYNTH_DELAY_MS * 4 + 5000 }); // tocando
          await page.waitForTimeout(300);
          mark('contínuo/barra', await page.evaluate(inspectBar, { mode: 'continuous', title: TITLE }));
          if ((await page.locator('.page-card .audio-seek, .page-card .audio-player').count()) !== 0) problems.push('[contínuo] as páginas não devem ter player');
          if ((theme === 'medieval' && mode === 'light') || (theme === 'cyberpunk' && mode === 'dark')) await shot('continuo');
          // Próxima / anterior da barra
          const next = bar.getByRole('button', { name: 'Próxima página' });
          await next.click();
          await page.waitForFunction(() => /2 de 2/.test(document.querySelector('[data-player-bar]')?.textContent ?? ''), null, { timeout: SYNTH_DELAY_MS * 4 + 8000 });
          if (!(await next.isDisabled())) problems.push('[contínuo] “Próxima página” deveria estar desabilitada na última página');
          await bar.getByRole('button', { name: 'Página anterior' }).click();
          await page.waitForFunction(() => /1 de 2/.test(document.querySelector('[data-player-bar]')?.textContent ?? ''), null, { timeout: 5000 });
          // Encadeia sozinho até o fim
          await seekNearEnd();
          await page.waitForFunction(() => /2 de 2/.test(document.querySelector('[data-player-bar]')?.textContent ?? ''), null, { timeout: SYNTH_DELAY_MS * 4 + 8000 });
          await seekNearEnd();
          await page.waitForSelector('[data-player-bar].hidden', { state: 'attached', timeout: 8000 });
          if (!(await page.getByText('Reprodução contínua concluída.').count())) problems.push('[contínuo] faltou o aviso de conclusão');
        } catch (e) {
          if (BROWSER === 'firefox') console.log(`    (aviso) ${tag}: Firefox headless não encadeou o MP3 (${(e as Error).message.split('\n')[0]})`);
          else problems.push(`[contínuo] fluxo não concluiu: ${(e as Error).message.split('\n')[0]} (barra: ${((await bar.textContent().catch(() => '')) ?? '').slice(0, 160)})`);
        }
        await page.getByRole('button', { name: 'Interromper a reprodução contínua' }).click({ timeout: 500 }).catch(() => {});
      }

      // 2) Leitor de volume: Ouvir em página já coletada em crônica; a barra fica fixa no rodapé
      await open(page, `#/s/${sessionId}/v/1`, '.page-card[data-page-id]');
      const vcard = page.locator('.page-card[data-page-id]').first();
      await vcard.getByRole('button', { name: 'Ouvir esta página' }).click();
      await vcard.locator('.audio-panel:not(.hidden)').waitFor({ timeout: 5000 });
      await vcard.locator('.page-action-menu').waitFor({ state: 'visible', timeout: SYNTH_DELAY_MS * 4 + 5000 });
      await vcard.getByRole('button', { name: 'Ouvir esta página' }).click();
      await bar.locator(':scope:not(.hidden)').waitFor({ timeout: 3000 }).catch(() => problems.push('[volume] a barra não apareceu'));
      await page.waitForTimeout(500);
      mark('volume/barra', await page.evaluate(inspectBar, { mode: 'single', title: TITLE }));
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

      // 4) Página Opções: cartão “Narração por voz”
      await open(page, '#/opcoes', 'section, .card');
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
