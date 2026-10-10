// Verificação visual dos cartões de página nos 8 temas (4 temas × claro/escuro) em um Chromium
// headless, em desktop (1280 px) e celular (390 px). Não usa a API real: sobe o app com SQLite em
// memória e um Gemini simulado. Uso:
//   npm run build:client && npm run check:paginas
// Falha (exit 1) se alguma verificação não passar; gera capturas em docs/screenshots/paginas/.
// Requer um navegador do Playwright (`npx playwright-core install chromium-headless-shell`) ou
// `CHROME_PATH=/caminho/do/chrome`.
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/connection.js';
import { createRepositories } from '../src/db/index.js';
import { buildApp } from '../src/server.js';
import { FAKE_KEY, mockGateway, narratorJson } from '../test/helpers.js';
import { findChrome } from './chrome.js';

const OUT = 'docs/screenshots/paginas';
fs.mkdirSync(OUT, { recursive: true });

const THEMES = ['medieval', 'cyberpunk', 'pos-apocaliptico', 'contemporaneo'] as const;
const MODES = ['light', 'dark'] as const;
const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 1000, mobile: false },
  { name: 'celular', width: 390, height: 844, mobile: true },
] as const;

// --- Dados de exemplo ---------------------------------------------------------------------------
const gateway = mockGateway({ chunkSize: 4000 });
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

const STORY = [
  ['Chego a Varn ao anoitecer.', 'A neblina subia do porto como um sudário, engolindo os mastros um a um. Varn não acolhia ninguém; apenas tolerava.\n\nVocê empurrou a porta do Corvo Cego e o calor rançoso de sebo e hidromel lhe bateu no rosto.'],
  ['Peço hidromel.', 'A caneca deslizou pelo balcão e parou rente aos seus dedos. Ao ouvir o nome do rei, o murmúrio das mesas vizinhas se apagou, como se alguém tivesse soprado uma vela.\n\n“Quem pergunta pelos mortos costuma se juntar a eles”, murmurou a taverneira.'],
  ['Abro o pergaminho.', 'O papel cheirava a mofo e a medo. Havia apenas um endereço: https://exemplo.invalido/um/caminho/muito/longo/que/nao/quebra/linha/por/natureza/e/precisa/de/overflow-wrap.\n\nVocê o releu três vezes antes de guardá-lo.'],
  ['Saio da taverna.', 'A rua estava vazia, e o vento trazia o sal do porto até a língua. Em algum lugar, um sino bateu uma hora que ninguém quis contar.\n\nVocê apertou o manto e seguiu para o cais.'],
  ['Sigo o homem de capuz.', 'O homem de capuz virou a esquina sem pressa, como quem sabe que é seguido e não se importa. Você contou os passos, depois desistiu de contar.\n\nO cais se abriu à frente, negro e molhado, com um único barco aceso.'],
] as const;

async function newSession(title: string, withVolume: boolean): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/api/sessions', payload: { title, active_theme: 'medieval', world_context: 'Reino de Valdoria.', token_limit: 100_000 } });
  const id = r.json().session.id as string;
  for (const [instruction, text] of STORY) {
    gateway.queue(narratorJson(text, { activate: false }));
    const t = await app.inject({ method: 'POST', url: `/api/sessions/${id}/narrative/next`, payload: { player_instruction: instruction } });
    if (!t.body.includes('event: page')) throw new Error(`Turno falhou: ${t.body.slice(0, 300)}`);
  }
  if (withVolume) {
    gateway.queue('Sinopse: o viajante chega a Varn, ganha um pergaminho enigmático e começa a ser seguido.');
    const pv = (await app.inject({ method: 'POST', url: `/api/sessions/${id}/compact/preview` })).json();
    const commit = await app.inject({
      method: 'POST',
      url: `/api/sessions/${id}/compact/commit`,
      payload: { summary_text: pv.summary_text, covered_page_start_index: pv.covered_page_start_index, covered_page_end_index: pv.covered_page_end_index },
    });
    if (commit.statusCode !== 200) throw new Error(`Compactação falhou: ${commit.body}`);
  }
  return id;
}
const tomeId = await newSession('A Queda de Valdoria', false);
const volumeId = await newSession('Crônica dos Volumes', true);

// --- Verificações no DOM renderizado ----------------------------------------------------------
interface Report {
  problems: string[];
}

/** Executado dentro do navegador: mede cartões, ações, contraste e overflow. */
function inspect(kind: 'tome' | 'volume'): { problems: string[]; cards: number } {
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
  const effectiveOpacity = (el: Element) => {
    let o = 1;
    for (let n: Element | null = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
    return o;
  };

  const root = document.documentElement;
  const mainBg = parse(getComputedStyle(document.body).backgroundColor);
  if (root.scrollWidth > root.clientWidth) problems.push(`rolagem horizontal da página: ${root.scrollWidth - root.clientWidth}px`);
  const scroller = document.getElementById(kind === 'tome' ? 'tome-scroll' : 'volume-scroll');
  if (scroller && scroller.scrollWidth > scroller.clientWidth) problems.push(`rolagem horizontal na área de leitura: ${scroller.scrollWidth - scroller.clientWidth}px`);

  const cards = Array.from(document.querySelectorAll<HTMLElement>('.page-card[data-page-id]'));
  if (cards.length === 0) problems.push('nenhum cartão de página renderizado');
  let prev: DOMRect | null = null;
  let prevIndex = 0;
  for (const card of cards) {
    const idx = Number(card.dataset.pageIndex);
    const label = `Página ${idx}`;
    const rect = card.getBoundingClientRect();
    if (card.querySelector('.page-card-title')?.textContent !== label) problems.push(`${label}: título diferente do índice absoluto`);
    if (idx <= prevIndex) problems.push(`${label}: numeração fora de ordem`);
    prevIndex = idx;
    if (prev && rect.top < prev.bottom + 8) problems.push(`${label}: sobreposta/colada à página anterior (gap ${Math.round(rect.top - prev.bottom)}px)`);
    prev = rect;
    if (rect.left < 0 || rect.right > root.clientWidth + 0.5) problems.push(`${label}: cartão fora da largura da tela`);

    const cs = getComputedStyle(card);
    const sheet = parse(cs.backgroundColor);
    const border = parse(cs.borderTopColor);
    if (ratio(border, mainBg) < 1.3) problems.push(`${label}: borda da folha quase invisível contra o fundo (${ratio(border, mainBg).toFixed(2)}:1)`);
    if (cs.boxShadow === 'none') problems.push(`${label}: sem sombra`);

    const checkText = (el: Element | null, name: string, min: number) => {
      if (!el) return;
      const c = parse(getComputedStyle(el).color);
      const r = ratio(blend(c, sheet), sheet);
      if (r < min) problems.push(`${label}: contraste de ${name} ${r.toFixed(2)}:1 (< ${min})`);
    };
    checkText(card.querySelector('.page-card-title'), 'título', 4.5);
    checkText(card.querySelector('.page-card-body p, .page-card-body'), 'texto', 4.5);

    const actions = Array.from(card.querySelectorAll<HTMLButtonElement>('.page-card-actions button.page-action'));
    if (kind === 'volume') {
      if (card.querySelector('.page-card-actions')) problems.push(`${label}: leitor deve ser somente leitura`);
    } else if (actions.length !== 3) {
      problems.push(`${label}: esperava 3 ações, achou ${actions.length}`);
    }
    for (const b of actions) {
      const name = b.getAttribute('aria-label') ?? '?';
      const r = b.getBoundingClientRect();
      const disabled = b.disabled;
      if (r.width < 32 || r.height < 32) problems.push(`${label}/${name}: alvo pequeno (${Math.round(r.width)}×${Math.round(r.height)})`);
      if (r.left < rect.left - 0.5 || r.right > rect.right + 0.5 || r.top < rect.top || r.bottom > rect.bottom) problems.push(`${label}/${name}: fora do cartão`);
      if (getComputedStyle(b).visibility !== 'visible' || getComputedStyle(b).display === 'none') problems.push(`${label}/${name}: invisível`);
      const op = effectiveOpacity(b);
      if (!disabled && op < 0.99) problems.push(`${label}/${name}: opacidade ${op.toFixed(2)} (deveria estar sempre visível)`);
      if (disabled && op < 0.45) problems.push(`${label}/${name}: desabilitado apagado demais (${op.toFixed(2)})`);
      if (b.querySelectorAll('svg').length !== 1) problems.push(`${label}/${name}: deve ter exatamente um ícone`);
      if (b.textContent?.trim()) problems.push(`${label}/${name}: tem texto visível`);
      const c = parse(getComputedStyle(b).color);
      const bg = parse(getComputedStyle(b).backgroundColor);
      const under = bg[3]! > 0.9 ? bg : blend(bg, sheet);
      const cr = ratio(blend(c, under), under);
      if (cr < 3) problems.push(`${label}/${name}: contraste do ícone ${cr.toFixed(2)}:1 (< 3)`);
    }
    if (kind === 'tome' && actions.length === 3) {
      const rects = actions.map((a) => a.getBoundingClientRect());
      if (new Set(rects.map((r) => Math.round(r.top))).size !== 1) problems.push(`${label}: ícones quebraram em mais de uma linha`);
      const glyphs = actions.map((a) => a.querySelector('svg')!.innerHTML);
      if (new Set(glyphs).size !== 3) problems.push(`${label}: ícones repetidos`);
    }
  }
  return { problems, cards: cards.length };
}

// --- Execução -------------------------------------------------------------------------------------
const exe = findChrome();
if (!exe) throw new Error('Chromium não encontrado. Defina CHROME_PATH ou instale um navegador do Playwright.');
const browser: Browser = await chromium.launch({ executablePath: exe });
const failures: string[] = [];
let checked = 0;

async function open(page: Page, hash: string, ready: string): Promise<void> {
  await page.goto(`${base}/${hash}`);
  await page.reload(); // aplica a preferência de modo gravada e o tema já salvo na sessão
  await page.waitForSelector(ready, { timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

for (const theme of THEMES) {
  await app.inject({ method: 'PUT', url: `/api/sessions/${tomeId}/context`, payload: { active_theme: theme } });
  await app.inject({ method: 'PUT', url: `/api/sessions/${volumeId}/context`, payload: { active_theme: theme } });
  for (const mode of MODES) {
    for (const vp of VIEWPORTS) {
      const tag = `${theme}-${mode}-${vp.name}`;
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: vp.mobile ? 2 : 1,
        isMobile: vp.mobile,
        hasTouch: vp.mobile,
        locale: 'pt-BR',
        colorScheme: mode,
      });
      const page = await ctx.newPage();
      // O tsx (esbuild) injeta `__name` nas funções serializadas para o navegador.
      await page.addInitScript('window.__name = (fn) => fn;');
      await page.addInitScript((m) => localStorage.setItem('chronicler.mode', m), mode);
      const report: Report = { problems: [] };
      const mark = (what: string, ps: string[]) => ps.forEach((p) => report.problems.push(`[${what}] ${p}`));

      // 1) Tome
      await open(page, `#/s/${tomeId}`, '.page-card[data-page-id]');
      const classes = await page.evaluate(() => document.documentElement.className);
      if (!classes.includes(`theme-${theme}`) || !classes.includes(`mode-${mode}`)) report.problems.push(`classes do <html> inesperadas: ${classes}`);
      const tome = await page.evaluate(inspect, 'tome');
      mark('tome', tome.problems);
      if (tome.cards !== 5) report.problems.push(`[tome] esperava 5 cartões, achou ${tome.cards}`);
      await page.evaluate(() => (document.getElementById('tome-scroll')!.scrollTop = 0));
      await page.screenshot({ path: path.join(OUT, `${theme}-${mode}${vp.mobile ? '-celular' : ''}.png`) });

      // Ações clicáveis (verifica visibilidade, estabilidade e que nada cobre o botão) + tooltip
      const first = page.locator('.page-card[data-page-id]').first();
      for (const label of ['Editar texto da página', 'Editar prompt e re-gerar', 'Ramificar a partir desta página']) {
        try {
          await first.getByRole('button', { name: label }).click({ trial: true, timeout: 3000 });
        } catch (e) {
          report.problems.push(`[tome] ação não clicável: ${label} (${(e as Error).message.split('\n')[0]})`);
        }
      }
      if (!vp.mobile) {
        await first.getByRole('button', { name: 'Editar prompt e re-gerar' }).hover();
        await page.waitForTimeout(500);
        const tip = await first.getByRole('button', { name: 'Editar prompt e re-gerar' }).evaluate((b) => {
          const s = getComputedStyle(b, '::after');
          return { opacity: s.opacity, visibility: s.visibility, text: s.content };
        });
        if (tip.opacity !== '1' || tip.visibility !== 'visible') report.problems.push(`[tome] tooltip não aparece no hover (${JSON.stringify(tip)})`);
        await page.mouse.move(5, 5);
      }
      const lastBranch = page.locator('.page-card[data-page-id]').last().getByRole('button', { name: 'Ramificar a partir desta página' });
      if (!(await lastBranch.isDisabled())) report.problems.push('[tome] Ramificar deveria estar desabilitado na última página');

      // Edição dentro do cartão
      await first.getByRole('button', { name: 'Editar texto da página' }).click();
      const editing = page.locator('.page-card.is-editing');
      await editing.waitFor({ timeout: 3000 });
      const box = await editing.evaluate((c) => {
        const r = c.getBoundingClientRect();
        const t = c.querySelector('textarea')!.getBoundingClientRect();
        return { inside: t.left >= r.left && t.right <= r.right && t.bottom <= r.bottom, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      });
      if (!box.inside) report.problems.push('[edição] textarea vazou do cartão');
      if (box.overflow > 0) report.problems.push(`[edição] rolagem horizontal ${box.overflow}px`);
      await page.getByRole('button', { name: 'Cancelar' }).click();

      // 2) Sessão com volume: aviso no Tome + leitor
      await open(page, `#/s/${volumeId}`, '.page-card[data-page-id]');
      const notice = await page.locator('nav[aria-label^="Páginas anteriores"] a').first().textContent();
      if (!notice?.includes('Volume 1')) report.problems.push('[tome com volume] aviso de volumes ausente');
      const afterVolume = await page.evaluate(inspect, 'tome');
      mark('tome com volume', afterVolume.problems);
      const numbers = await page.locator('.page-card-title').allTextContents();
      if (numbers[0] === 'Página 1') report.problems.push('[tome com volume] numeração deveria continuar absoluta (não recomeçar em 1)');

      await open(page, `#/s/${volumeId}/v/1`, '.page-card[data-page-id]');
      const reader = await page.evaluate(inspect, 'volume');
      mark('leitor', reader.problems);
      if (reader.cards < 2) report.problems.push(`[leitor] páginas do volume ausentes (${reader.cards})`);
      const titles = await page.locator('.page-card-title').allTextContents();
      if (titles[0] !== 'Página 1') report.problems.push(`[leitor] primeira página deveria ser “Página 1”, veio ${titles[0]}`);
      if ((theme === 'medieval' && mode === 'light') || (theme === 'cyberpunk' && mode === 'dark')) {
        await page.screenshot({ path: path.join(OUT, `volume-${theme}-${mode}${vp.mobile ? '-celular' : ''}.png`) });
      }

      // Gaveta → Crônica: volume com "Ler as N páginas" e ícone de exportar (uma captura de referência).
      if (theme === 'cyberpunk' && mode === 'dark' && !vp.mobile) {
        await open(page, `#/s/${volumeId}`, '.page-card[data-page-id]');
        await page.getByRole('button', { name: 'Contexto da sessão' }).click();
        await page.getByRole('tab', { name: 'Crônica' }).click();
        const read = page.getByRole('link', { name: /^Ler as 3 páginas$/ });
        await read.waitFor({ timeout: 3000 });
        await page.getByRole('button', { name: 'Salvar Volume 1 em Markdown' }).waitFor({ timeout: 3000 });
        await page.mouse.move(5, 5);
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(OUT, 'volumes-gaveta.png') });
      }

      checked++;
      if (report.problems.length) {
        failures.push(...report.problems.map((p) => `${tag}: ${p}`));
        console.log(`✗ ${tag}`);
        for (const p of report.problems) console.log(`    ${p}`);
      } else {
        console.log(`✓ ${tag}`);
      }
      await ctx.close();
    }
  }
}

await browser.close();
await app.close();
console.log(`\n${checked} combinações verificadas (4 temas × claro/escuro × desktop/celular); ${failures.length} problema(s).`);
process.exit(failures.length ? 1 : 0);
