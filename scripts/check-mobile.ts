// Verificação do layout mobile (app shell) nos 8 temas (4 temas × claro/escuro) em um navegador
// headless emulando um celular Android de 390 px de largura, em três alturas:
//   844 px  tela cheia/app instalado      760 px  com a barra do navegador visível
//   480 px  com o teclado virtual aberto (campo de digitação focado)
// Confere, na sessão e no leitor de volume: cabeçalho no topo e doca de digitação embaixo, sem rolagem
// do documento, só a área das páginas rolando, campo visível ao focar, sem rolagem horizontal, botões do
// cabeçalho sem sobreposição; e, no Chromium, o manifesto (instalabilidade, via CDP) e o `theme-color`.
// Gera folhas de contato em docs/screenshots/mobile/. Falha (exit 1) se alguma verificação não passar.
//
// Uso:  npm run build:client && npm run check:mobile
//       BROWSER=firefox npm run check:mobile      (Firefox do Playwright: `npx playwright-core install firefox`)
// Requer um navegador do Playwright ou `CHROME_PATH=/caminho/do/chrome`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, firefox, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/connection.js';
import { createRepositories } from '../src/db/index.js';
import { buildApp } from '../src/server.js';
import { FAKE_KEY, mockGateway, narratorJson } from '../test/helpers.js';
import { findChrome } from './chrome.js';

const BROWSER = process.env.BROWSER === 'firefox' ? 'firefox' : 'chromium';
const OUT = BROWSER === 'firefox' ? 'docs/screenshots/mobile-firefox' : 'docs/screenshots/mobile';
fs.mkdirSync(OUT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicler-mobile-'));

const THEMES = ['medieval', 'cyberpunk', 'pos-apocaliptico', 'contemporaneo'] as const;
const MODES = ['light', 'dark'] as const;
const WIDTH = 390;
const HEIGHTS = [
  { name: 'tela', height: 844 },
  { name: 'barra', height: 760 },
  { name: 'teclado', height: 480 },
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
  ['Abro o pergaminho.', 'O papel cheirava a mofo e a medo. Havia apenas um endereço, e ele não levava a lugar algum que você conhecesse.\n\nVocê o releu três vezes antes de guardá-lo.'],
  ['Saio da taverna.', 'A rua estava vazia, e o vento trazia o sal do porto até a língua. Em algum lugar, um sino bateu uma hora que ninguém quis contar.\n\nVocê apertou o manto e seguiu para o cais.'],
  ['Sigo o homem de capuz.', 'O homem de capuz virou a esquina sem pressa, como quem sabe que é seguido e não se importa. Você contou os passos, depois desistiu de contar.\n\nO cais se abriu à frente, negro e molhado, com um único barco aceso.'],
] as const;

const created = await app.inject({ method: 'POST', url: '/api/sessions', payload: { title: 'A Queda de Valdoria', active_theme: 'medieval', world_context: 'Reino de Valdoria.', token_limit: 100_000 } });
const sessionId = created.json().session.id as string;
for (const [instruction, text] of STORY) {
  gateway.queue(narratorJson(text, { activate: false }));
  const t = await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/narrative/next`, payload: { player_instruction: instruction } });
  if (!t.body.includes('event: page')) throw new Error(`Turno falhou: ${t.body.slice(0, 300)}`);
}
gateway.queue('Sinopse: o viajante chega a Varn, ganha um pergaminho enigmático e começa a ser seguido.');
const pv = (await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/compact/preview` })).json();
const commit = await app.inject({
  method: 'POST',
  url: `/api/sessions/${sessionId}/compact/commit`,
  payload: { summary_text: pv.summary_text, covered_page_start_index: pv.covered_page_start_index, covered_page_end_index: pv.covered_page_end_index },
});
if (commit.statusCode !== 200) throw new Error(`Compactação falhou: ${commit.body}`);
// Mais páginas depois do volume, para o Tome ter o que rolar.
for (const [instruction, text] of STORY) {
  gateway.queue(narratorJson(text, { activate: false }));
  await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/narrative/next`, payload: { player_instruction: instruction } });
}

// --- Verificações dentro do navegador ---------------------------------------------------------
type Kind = 'sessao' | 'volume';
interface Geometry {
  problems: string[];
  header: { top: number; bottom: number } | null;
  dock: { top: number; bottom: number } | null;
  scroller: { top: number; bottom: number; client: number; scroll: number } | null;
  inner: number;
}

/** Mede o layout e devolve os problemas encontrados (executado no navegador). */
function measure(kind: Kind): Geometry {
  const problems: string[] = [];
  const root = document.documentElement;
  const inner = window.innerHeight;
  const box = (el: Element | null): { top: number; bottom: number } | null => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top * 10) / 10, bottom: Math.round(r.bottom * 10) / 10 };
  };
  const header = box(document.querySelector('header'));
  const dock = kind === 'sessao' ? box(document.querySelector('main > footer')) : null;
  const scrollEl = document.getElementById(kind === 'sessao' ? 'tome-scroll' : 'volume-scroll');
  const sr = scrollEl?.getBoundingClientRect();
  const scroller = scrollEl && sr ? { top: Math.round(sr.top), bottom: Math.round(sr.bottom), client: scrollEl.clientHeight, scroll: scrollEl.scrollHeight } : null;

  if (!root.classList.contains('app-shell')) problems.push('html sem a classe app-shell');
  if (!header) problems.push('sem cabeçalho');
  else if (Math.abs(header.top) > 1) problems.push(`cabeçalho fora do topo (top=${header.top})`);
  if (kind === 'sessao') {
    if (!dock) problems.push('sem doca de digitação');
    else if (Math.abs(dock.bottom - inner) > 1) problems.push(`doca não está colada ao fim da tela (bottom=${dock.bottom}, altura=${inner})`);
  } else if (scroller && Math.abs(scroller.bottom - inner) > 1) {
    problems.push(`área de leitura não chega ao fim da tela (bottom=${scroller.bottom}, altura=${inner})`);
  }
  if (!scroller) problems.push('sem área rolável');
  else {
    if (scroller.client < 100) problems.push(`área das páginas minúscula (${scroller.client}px)`);
    if (scroller.scroll <= scroller.client) problems.push('a área das páginas não rola (conteúdo coube inteiro?)');
    if (header && Math.abs(scroller.top - header.bottom) > 1) problems.push('área das páginas não encosta no cabeçalho');
    if (dock && Math.abs(scroller.bottom - dock.top) > 1) problems.push('área das páginas não encosta na doca');
  }
  if (root.scrollHeight > root.clientHeight + 1) problems.push(`o documento rola (${root.scrollHeight} > ${root.clientHeight})`);
  if (root.scrollWidth > root.clientWidth) problems.push(`rolagem horizontal: ${root.scrollWidth - root.clientWidth}px`);
  if (scrollEl && scrollEl.scrollWidth > scrollEl.clientWidth) problems.push('rolagem horizontal na área das páginas');

  // Botões do cabeçalho: dentro da tela, sem sobreposição, com espaço para o título.
  const hdr = document.querySelector('header');
  if (hdr) {
    const items = Array.from(hdr.querySelectorAll<HTMLElement>(':scope > a, :scope > button, :scope > div'));
    const rects = items.map((el) => el.getBoundingClientRect());
    rects.forEach((r, i) => {
      if (r.left < -0.5 || r.right > root.clientWidth + 0.5) problems.push(`cabeçalho: item ${i} fora da largura da tela`);
      for (let j = i + 1; j < rects.length; j++) {
        const o = rects[j]!;
        if (r.width > 0 && o.width > 0 && r.left < o.right - 0.5 && o.left < r.right - 0.5 && r.top < o.bottom - 0.5 && o.top < r.bottom - 0.5) problems.push(`cabeçalho: itens ${i} e ${j} sobrepostos`);
      }
    });
    const title = hdr.querySelector('h1');
    if (title && title.getBoundingClientRect().width < 60) problems.push(`título espremido (${Math.round(title.getBoundingClientRect().width)}px)`);
    const fs = hdr.querySelector('[aria-label="Tela cheia"], [aria-label="Sair da tela cheia"]');
    if (!fs) problems.push('botão de tela cheia ausente');
  }
  return { problems, header, dock, scroller, inner };
}

const results: string[] = [];
let failures = 0;
function report(label: string, problems: string[]): void {
  if (problems.length === 0) return void results.push(`  ok   ${label}`);
  failures += problems.length;
  results.push(`  FAIL ${label}`);
  for (const p of problems) results.push(`         - ${p}`);
}

/** Cria um contexto "celular" (toque, 390 px). Firefox não oferece `isMobile`. */
async function newContext(browser: Browser, height: number): Promise<BrowserContext> {
  return browser.newContext({
    viewport: { width: WIDTH, height },
    deviceScaleFactor: 1,
    hasTouch: true,
    ...(BROWSER === 'chromium' ? { isMobile: true } : {}),
    locale: 'pt-BR',
  });
}

async function openRoute(page: Page, kind: Kind, theme: string, mode: string): Promise<void> {
  await page.addInitScript(`window.__name = (fn) => fn; localStorage.setItem('chronicler.theme','${theme}'); localStorage.setItem('chronicler.mode','${mode}');`);
  const hash = kind === 'sessao' ? `#/s/${sessionId}` : `#/s/${sessionId}/v/1`;
  await page.goto(`${base}/${hash}`, { waitUntil: 'networkidle' });
  await page.waitForSelector(kind === 'sessao' ? '#tome-scroll .page-card' : '#volume-scroll .page-card');
  if (kind === 'sessao') await page.waitForSelector('footer textarea');
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

const executablePath = BROWSER === 'chromium' ? findChrome() : undefined;
if (BROWSER === 'chromium' && !executablePath) {
  console.error('Chromium não encontrado: defina CHROME_PATH ou instale um navegador do Playwright.');
  process.exit(1);
}
const browser = await (BROWSER === 'chromium' ? chromium : firefox).launch(executablePath ? { executablePath } : {});
console.log(`Navegador: ${BROWSER} ${browser.version()}`);

/** Capturas individuais (em TMP) para compor as folhas de contato. */
const shots: Record<string, string[]> = {};
const sheetKey = (name: string): string => name;

try {
  for (const hv of HEIGHTS) {
    for (const kind of ['sessao', 'volume'] as const) {
      for (const theme of THEMES) {
        for (const mode of MODES) {
          const label = `${kind} · ${theme}/${mode} · ${WIDTH}×${hv.height} (${hv.name})`;
          const ctx = await newContext(browser, hv.height);
          const page = await ctx.newPage();
          try {
            // O tema visual é da sessão (active_theme) e prevalece sobre o salvo no navegador.
            const put = await app.inject({ method: 'PUT', url: `/api/sessions/${sessionId}/context`, payload: { active_theme: theme } });
            if (put.statusCode !== 200) throw new Error(`Não foi possível trocar o tema: ${put.body}`);
            await openRoute(page, kind, theme, mode);
            const applied = await page.evaluate(() => document.documentElement.className);
            if (!applied.includes(`theme-${theme}`) || !applied.includes(`mode-${mode}`)) throw new Error(`Tema não aplicado: esperava ${theme}/${mode}, html.class="${applied}"`);
            const problems: string[] = [];

            if (kind === 'sessao' && hv.name === 'teclado') {
              // Teclado aberto = altura reduzida + campo focado.
              await page.focus('footer textarea');
              await page.keyboard.type('Examino a porta com cuidado.');
              const ta = await page.evaluate(() => {
                const el = document.querySelector('footer textarea')!;
                const r = el.getBoundingClientRect();
                return { top: r.top, bottom: r.bottom, inner: window.innerHeight };
              });
              if (ta.top < 0 || ta.bottom > ta.inner + 0.5) problems.push(`campo de digitação fora da área visível (${Math.round(ta.top)}–${Math.round(ta.bottom)} de ${ta.inner})`);
            }

            if (kind === 'sessao') {
              // Com pouca altura a doca esconde HP/Compactar; com espaço de sobra eles aparecem.
              const metaShown = await page.evaluate(() => getComputedStyle(document.querySelector('.dock-meta')!).display !== 'none');
              if (hv.height <= 520 && metaShown) problems.push('HP/Compactar deveriam ficar ocultos com altura tão curta');
              if (hv.height > 520 && !metaShown) problems.push('HP/Compactar deveriam aparecer com altura suficiente');
            }

            const before = await page.evaluate(measure, kind);
            problems.push(...before.problems);

            // Tentativa de rolar o documento e a área das páginas: cabeçalho e doca não saem do lugar.
            await page.evaluate(() => window.scrollTo(0, 300));
            const scrollerId = kind === 'sessao' ? 'tome-scroll' : 'volume-scroll';
            await page.evaluate((id) => {
              const el = document.getElementById(id)!;
              el.scrollTop = el.scrollHeight;
            }, scrollerId);
            const after = await page.evaluate(measure, kind);
            problems.push(...after.problems.filter((p) => !before.problems.includes(p)).map((p) => `após rolar: ${p}`));
            const scrolled = await page.evaluate((id) => ({ doc: window.scrollY, area: document.getElementById(id)!.scrollTop }), scrollerId);
            if (scrolled.doc !== 0) problems.push(`o documento rolou ${scrolled.doc}px`);
            if (scrolled.area <= 0) problems.push('a área das páginas não rolou');
            await page.evaluate((id) => {
              document.getElementById(id)!.scrollTop = 0;
            }, scrollerId);

            // theme-color acompanha o painel do tema (Chromium aplica a meta; vale também no Firefox).
            const colors = await page.evaluate(() => ({
              meta: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? '',
              panel: getComputedStyle(document.documentElement).getPropertyValue('--bg-panel').trim(),
            }));
            if (colors.meta !== colors.panel) problems.push(`theme-color (${colors.meta}) diferente do painel do tema (${colors.panel})`);

            report(label, problems);

            const wantShot = (kind === 'sessao' && (hv.name === 'barra' || hv.name === 'teclado')) || (kind === 'volume' && hv.name === 'teclado');
            if (wantShot) {
              const key = sheetKey(`${kind}-${hv.name}`);
              const file = path.join(TMP, `${key}-${theme}-${mode}.png`);
              await page.screenshot({ path: file });
              (shots[key] ??= []).push(file);
            }
          } finally {
            await ctx.close();
          }
        }
      }
    }
  }

  // --- Instalabilidade (somente Chromium/CDP) --------------------------------
  if (BROWSER === 'chromium') {
    const ctx = await newContext(browser, 844);
    const page = await ctx.newPage();
    await page.addInitScript('window.__name = (fn) => fn;');
    await page.goto(`${base}/`, { waitUntil: 'networkidle' });
    const cdp = await ctx.newCDPSession(page);
    const inst = (await cdp.send('Page.getInstallabilityErrors')) as { installabilityErrors: { errorId: string; errorArguments: unknown[] }[] };
    const manifest = (await cdp.send('Page.getAppManifest')) as { url?: string; errors: { message: string }[]; data?: string };
    const problems: string[] = [];
    for (const e of inst.installabilityErrors) problems.push(`instalabilidade: ${e.errorId} ${JSON.stringify(e.errorArguments)}`);
    for (const e of manifest.errors) problems.push(`manifesto: ${e.message}`);
    if (!manifest.url) problems.push('o navegador não encontrou o manifesto');
    report('instalabilidade (Chromium/CDP): sem erros e manifesto válido', problems);

    // A tela inicial rola normalmente (sem app shell), inclusive ao voltar da sessão sem recarregar.
    const homeProblems: string[] = [];
    const shellOn = async (): Promise<boolean> => page.evaluate(() => document.documentElement.classList.contains('app-shell'));
    if (await shellOn()) homeProblems.push('tela inicial com app-shell ligado');
    await page.evaluate((id) => (location.hash = `#/s/${id}`), sessionId);
    await page.waitForSelector('footer textarea');
    if (!(await shellOn())) homeProblems.push('sessão sem app-shell');
    await page.evaluate(() => (location.hash = '#/'));
    await page.waitForFunction(() => !document.querySelector('footer textarea'));
    if (await shellOn()) homeProblems.push('app-shell continuou ligado ao voltar para a tela inicial');
    const overflow = await page.evaluate(() => getComputedStyle(document.documentElement).overflowY + '/' + getComputedStyle(document.body).overflowY);
    if (overflow.includes('hidden')) homeProblems.push(`tela inicial sem rolagem (overflow ${overflow})`);
    report('tela inicial: rolagem normal, app shell só na sessão e no leitor', homeProblems);

    await ctx.close();
  }
} finally {
  await browser.close();
}

// --- Folhas de contato: 4 temas por linha (claro em cima, escuro embaixo) ----------------------------
const sheetBrowser = await (BROWSER === 'chromium' ? chromium : firefox).launch(executablePath ? { executablePath } : {});
try {
  for (const [key, files] of Object.entries(shots)) {
    const cells = files
      .map((f) => {
        const label = path.basename(f, '.png').replace(`${key}-`, '');
        return `<figure><img src="data:image/png;base64,${fs.readFileSync(f).toString('base64')}"><figcaption>${label}</figcaption></figure>`;
      })
      .join('');
    const html = `<!doctype html><body style="margin:0;background:#888;font:12px sans-serif"><div style="display:grid;grid-template-columns:repeat(4,${WIDTH}px);gap:8px;padding:8px;width:max-content">${cells}</div><style>figure{margin:0}img{display:block;border:1px solid #000}figcaption{color:#fff;padding:2px 0}</style></body>`;
    const page = await sheetBrowser.newPage({ viewport: { width: 4 * WIDTH + 40, height: 900 } });
    await page.setContent(html);
    await page.screenshot({ path: path.join(OUT, `${key}.png`), fullPage: true });
    await page.close();
  }
} finally {
  await sheetBrowser.close();
}

await app.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(results.join('\n'));
console.log(failures === 0 ? `\nTudo certo. Folhas de contato em ${OUT}/` : `\n${failures} problema(s) encontrado(s).`);
process.exit(failures === 0 ? 0 : 1);
