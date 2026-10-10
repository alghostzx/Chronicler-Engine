// Verificação visual e funcional da tela inicial (logo Srcery, menu, quadros sobrepostos e Opções) em
// larguras de 320 a 1920 px, num navegador headless. Não usa a API real: sobe o app com SQLite em
// memória e um Gemini simulado.
//
// Uso:  npm run build:client && npm run check:inicio
//       BROWSER=firefox npm run check:inicio       (Firefox do Playwright)
// Falha (exit 1) se alguma verificação não passar; gera capturas em docs/screenshots/inicio/
// (Firefox: docs/screenshots/inicio-firefox/, ignorado pelo git).
import fs from 'node:fs';
import path from 'node:path';
import { chromium, firefox, type Browser, type Page } from 'playwright-core';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/connection.js';
import { createRepositories } from '../src/db/index.js';
import { buildApp } from '../src/server.js';
import { FAKE_KEY, mockGateway } from '../test/helpers.js';
import { findChrome } from './chrome.js';

const BROWSER = process.env.BROWSER === 'firefox' ? 'firefox' : 'chromium';
const OUT = BROWSER === 'firefox' ? 'docs/screenshots/inicio-firefox' : 'docs/screenshots/inicio';
fs.mkdirSync(OUT, { recursive: true });

const SIZES = [
  { name: '320', width: 320, height: 640 },
  { name: '390', width: 390, height: 844 },
  { name: '768', width: 768, height: 1024 },
  { name: '1280', width: 1280, height: 800 },
  { name: '1920', width: 1920, height: 1080 },
] as const;

const gateway = mockGateway({ chunkSize: 4000 });
const repos = createRepositories(openDatabase(':memory:'));
const app = await buildApp(loadConfig({ PUBLIC_DIR: path.resolve('public'), HOST: '127.0.0.1', PORT: '0' }), { repos, gatewayFactory: () => gateway, logger: false });
await app.listen({ port: 0, host: '127.0.0.1' });
const addr = app.server.address();
const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

async function createSession(title: string): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/api/sessions', payload: { title, active_theme: 'cyberpunk', world_context: 'Mundo.', token_limit: 100_000 } });
  return r.json().session.id as string;
}

/** Executado no navegador: métricas e contrastes da tela de título. */
function inspectTitle(opts: { width: number; expectDisabledContinue: boolean }): string[] {
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
  const root = document.documentElement;
  const bg = parse(getComputedStyle(document.body).backgroundColor);
  if (!root.className.includes('theme-srcery')) problems.push(`html sem theme-srcery (${root.className})`);
  if (root.scrollWidth > root.clientWidth) problems.push(`rolagem horizontal: ${root.scrollWidth - root.clientWidth}px`);

  const img = document.querySelector<HTMLImageElement>('.title-logo');
  if (!img) return [...problems, 'logo ausente'];
  if (!img.complete || img.naturalWidth === 0) problems.push('logo não carregou');
  const stacked = opts.width < 768;
  if (!img.currentSrc.endsWith(stacked ? '/logo-stacked.svg' : '/logo.svg')) problems.push(`variante do logo errada para ${opts.width}px: ${img.currentSrc}`);
  const rect = img.getBoundingClientRect();
  const rem = parseFloat(getComputedStyle(root).fontSize);
  const maxH = (stacked ? 11 : 9) * rem;
  if (rect.height > maxH + 0.5) problems.push(`logo alto demais: ${Math.round(rect.height)}px (máx. ${maxH})`);
  if (rect.left < -0.5 || rect.right > root.clientWidth + 0.5) problems.push('logo fora da largura da tela');
  // Com a altura limitada o SVG fica centralizado ("contain"); a largura útil precisa ocupar quase toda a faixa.
  const ar = img.naturalWidth / img.naturalHeight;
  const shown = Math.min(rect.width, rect.height * ar);
  const minShown = Math.min(rect.width, stacked ? 200 : 600);
  if (shown < minShown) problems.push(`logo pequeno demais: ${Math.round(shown)}px de largura útil`);

  const tag = document.querySelector('.title-tagline');
  if (!tag || tag.textContent !== 'Escreva a sua crônica com um Narrador de IA.') problems.push('legenda ausente ou diferente');
  else if (ratio(parse(getComputedStyle(tag).color), bg) < 4.5) problems.push('contraste da legenda < 4.5');

  const items = Array.from(document.querySelectorAll<HTMLElement>('.title-menu-item'));
  const names = items.map((i) => i.textContent);
  if (names.join('|') !== 'Continuar|Nova Crônica|Opções') problems.push(`itens do menu inesperados: ${names.join('|')}`);
  let prevBottom = -1;
  for (const it of items) {
    const r = it.getBoundingClientRect();
    if (r.height < 44) problems.push(`${it.textContent}: alvo baixo (${Math.round(r.height)}px)`);
    if (r.left < 0 || r.right > root.clientWidth) problems.push(`${it.textContent}: fora da tela`);
    if (r.top < prevBottom - 0.5) problems.push(`${it.textContent}: sobreposto`);
    prevBottom = r.bottom;
    const disabled = it.getAttribute('aria-disabled') === 'true';
    const c = parse(getComputedStyle(it).color);
    const min = disabled ? 3 : 4.5;
    const eff = Number(getComputedStyle(it).opacity);
    const blended = [0, 1, 2].map((i) => Math.round(c[i]! * eff + bg[i]! * (1 - eff)));
    if (ratio(blended, bg) < min) problems.push(`${it.textContent}: contraste ${ratio(blended, bg).toFixed(2)}:1 (< ${min})`);
  }
  if ((items[0]!.getAttribute('aria-disabled') === 'true') !== opts.expectDisabledContinue) problems.push(`Continuar ${opts.expectDisabledContinue ? 'deveria' : 'não deveria'} estar desabilitado`);
  return problems;
}

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
  await page.evaluate(async () => {
    const img = document.querySelector<HTMLImageElement>('.title-logo');
    if (img) await img.decode().catch(() => undefined);
  });
  await page.waitForTimeout(250);
}

async function runState(label: 'vazio' | 'completo'): Promise<void> {
  for (const size of SIZES) {
    const tag = `${label}-${size.name}`;
    const mobile = size.width <= 768;
    const ctx = await browser.newContext({
      viewport: { width: size.width, height: size.height },
      deviceScaleFactor: mobile ? 2 : 1,
      ...(mobile && BROWSER === 'chromium' ? { isMobile: true } : {}),
      hasTouch: mobile,
      locale: 'pt-BR',
      colorScheme: 'light', // o fundo da tela inicial é fixo: mesmo com o sistema claro, fica escuro
    });
    const page = await ctx.newPage();
    await page.addInitScript('window.__name = (fn) => fn;');
    const problems: string[] = [];
    const shot = (name: string) => page.screenshot({ path: path.join(OUT, `${tag}-${name}.png`) });
    const empty = label === 'vazio';

    // 1) Menu
    await open(page, '#/', '.title-menu-item');
    problems.push(...(await page.evaluate(inspectTitle, { width: size.width, expectDisabledContinue: empty })).map((p) => `[menu] ${p}`));
    const noticeVisible = await page.locator('.title-notice').isVisible();
    const pulsing = await page.locator('.title-menu-item.is-pulsing').count();
    if (empty && (!noticeVisible || pulsing !== 1)) problems.push('[menu] sem chave: aviso e pulso em Opções esperados');
    if (!empty && (noticeVisible || pulsing !== 0)) problems.push('[menu] com chave: aviso/pulso não deveriam aparecer');
    const fits = await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1);
    if (!fits && size.height >= 800) problems.push('[menu] a tela de título deveria caber sem rolagem');
    await shot('menu');

    // Foco inicial: com mouse, o primeiro item habilitado já vem focado (como num menu de jogo)
    const initialFocus = await page.evaluate(() => document.activeElement?.textContent ?? '');
    const wantInitial = mobile ? null : empty ? 'Nova Crônica' : 'Continuar';
    if (wantInitial && initialFocus !== wantInitial) problems.push(`[teclado] foco inicial deveria estar em “${wantInitial}” (foi: ${initialFocus})`);
    // Teclado: sem foco, ↓ foca o primeiro item e ↑ volta ao último
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('ArrowDown');
    const first = await page.evaluate(() => document.activeElement?.textContent);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    const wrapped = await page.evaluate(() => document.activeElement?.textContent);
    if (first !== 'Continuar' || wrapped !== 'Opções') problems.push(`[teclado] navegação por setas falhou (${first} / ${wrapped})`);

    if (empty) {
      // Continuar desabilitado: só avisa
      await page.getByRole('button', { name: 'Continuar' }).click({ force: true });
      if (!(await page.evaluate(() => location.hash === '#/' || location.hash === ''))) problems.push('[continuar] não deveria navegar sem crônicas');
      await page.locator('#toasts [role="status"]').first().waitFor({ timeout: 2000 }).catch(() => problems.push('[continuar] sem aviso de “nenhuma crônica”'));
    } else {
      // 2) Continuar: quadro sobreposto
      await page.getByRole('button', { name: 'Continuar' }).click();
      const dialog = page.getByRole('dialog', { name: 'Continuar' });
      await dialog.waitFor({ timeout: 3000 });
      if (!(await page.evaluate(() => location.hash === '#/continuar'))) problems.push('[continuar] rota #/continuar não aplicada');
      const rows = await dialog.locator('a[href^="#/s/"]').count();
      if (rows !== 2) problems.push(`[continuar] esperava 2 crônicas, achou ${rows}`);
      const geo = await page.evaluate(() => {
        const d = document.querySelector('[role="dialog"]')!.getBoundingClientRect();
        const backdrop = document.querySelector('[role="dialog"]')!.parentElement!;
        const b = backdrop.getBoundingClientRect();
        return {
          inside: d.left >= 0 && d.right <= window.innerWidth && d.top >= 0 && d.bottom <= window.innerHeight,
          covers: b.width >= window.innerWidth - 1 && b.height >= window.innerHeight - 1,
          dim: getComputedStyle(backdrop).backgroundColor,
          menuBehind: !!document.querySelector('.title-menu'),
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
      if (!geo.inside) problems.push('[continuar] quadro fora da tela');
      if (!geo.covers) problems.push('[continuar] fundo escurecido não cobre a tela');
      if (!geo.menuBehind) problems.push('[continuar] o menu deveria continuar por trás');
      if (geo.overflow > 0) problems.push(`[continuar] rolagem horizontal ${geo.overflow}px`);
      await shot('continuar');
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached', timeout: 3000 }).catch(() => problems.push('[continuar] Esc não fechou o quadro'));
      if (!(await page.evaluate(() => location.hash === '#/' || location.hash === ''))) problems.push(`[continuar] Esc deveria voltar a #/ (hash: ${await page.evaluate(() => location.hash)})`);
      const refocus = await page.evaluate(() => document.activeElement?.textContent);
      if (refocus !== 'Continuar') problems.push(`[continuar] foco deveria voltar ao botão (foi: ${refocus})`);

      // botão "voltar" do navegador fecha o quadro
      await page.getByRole('button', { name: 'Continuar' }).click();
      await dialog.waitFor({ timeout: 3000 });
      await page.goBack();
      await dialog.waitFor({ state: 'detached', timeout: 3000 }).catch(() => problems.push('[continuar] “voltar” do navegador não fechou o quadro'));
      // botão Fechar (SVG)
      await page.getByRole('button', { name: 'Continuar' }).click();
      await dialog.waitFor({ timeout: 3000 });
      const closeBox = await dialog.getByRole('button', { name: 'Fechar' }).boundingBox();
      if (!closeBox || closeBox.width < 32 || closeBox.height < 32) problems.push('[continuar] botão Fechar pequeno demais');
      await dialog.getByRole('button', { name: 'Fechar' }).click();
      await dialog.waitFor({ state: 'detached', timeout: 3000 }).catch(() => problems.push('[continuar] Fechar não fechou o quadro'));
    }

    // 3) Nova Crônica
    await page.getByRole('button', { name: 'Nova Crônica' }).click();
    const nova = page.getByRole('dialog', { name: 'Nova crônica' });
    await nova.waitFor({ timeout: 3000 });
    const focusedTitle = await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.getAttribute('aria-label'));
    if (focusedTitle !== 'Título da crônica') problems.push(`[nova] foco inicial deveria estar no título (foi: ${focusedTitle})`);
    const novaGeo = await page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]')!;
      const r = dlg.getBoundingClientRect();
      return { inside: r.left >= 0 && r.right <= window.innerWidth, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, scrollable: dlg.scrollHeight > dlg.clientHeight };
    });
    if (!novaGeo.inside) problems.push('[nova] quadro fora da largura da tela');
    if (novaGeo.overflow > 0) problems.push(`[nova] rolagem horizontal ${novaGeo.overflow}px`);
    await shot('nova');
    if (!empty) {
      await nova.getByLabel('Título da crônica').fill('A Torre de Ônix');
      await nova.getByRole('button', { name: 'Iniciar nova crônica' }).click();
      await page.waitForSelector('.page-card, #tome-scroll, .app-screen', { timeout: 8000 });
      const cls = await page.evaluate(() => document.documentElement.className);
      if (cls.includes('theme-srcery') || !cls.includes('theme-medieval')) problems.push(`[nova] a sessão deveria usar o tema escolhido, não Srcery (${cls})`);
      await page.getByRole('link', { name: 'Voltar ao menu inicial' }).click();
      await page.waitForSelector('.title-menu-item', { timeout: 8000 });
      const back = await page.evaluate(() => document.documentElement.className);
      if (!back.includes('theme-srcery')) problems.push(`[nova] ao voltar ao menu o fundo Srcery deveria voltar (${back})`);
      const rows = await page.evaluate(() => 0);
      void rows;
      // limpa a crônica criada para manter o estado do próximo ciclo
      const created = (await app.inject({ method: 'GET', url: '/api/sessions' })).json().sessions.find((s: { title: string }) => s.title === 'A Torre de Ônix');
      if (created) await app.inject({ method: 'DELETE', url: `/api/sessions/${created.id}` });
    } else {
      await page.keyboard.press('Escape');
    }

    // 4) Opções
    await open(page, '#/', '.title-menu-item');
    await page.getByRole('link', { name: 'Opções' }).click();
    await page.waitForSelector('text=Conexão com o Gemini', { timeout: 5000 });
    await page.getByLabel('Narração por voz').first().waitFor({ timeout: 5000 });
    const opt = await page.evaluate(() => {
      const back = document.querySelector<HTMLElement>('a[aria-label="Voltar ao menu inicial"]');
      const r = back?.getBoundingClientRect();
      return { hash: location.hash, srcery: document.documentElement.className.includes('theme-srcery'), overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, back: r ? { w: r.width, h: r.height } : null, h1: document.querySelector('h1')?.textContent };
    });
    if (opt.hash !== '#/opcoes' || !opt.srcery) problems.push(`[opções] rota/tema inesperados (${JSON.stringify(opt)})`);
    if (opt.overflow > 0) problems.push(`[opções] rolagem horizontal ${opt.overflow}px`);
    if (!opt.back || opt.back.w < 32 || opt.back.h < 32) problems.push('[opções] botão Voltar ausente ou pequeno');
    if (opt.h1 !== 'Opções') problems.push(`[opções] título inesperado: ${opt.h1}`);
    await shot('opcoes');
    await page.getByRole('link', { name: 'Voltar ao menu inicial' }).click();
    await page.waitForSelector('.title-menu-item', { timeout: 5000 });

    checked++;
    if (problems.length) {
      failures.push(...problems.map((p) => `${tag}: ${p}`));
      console.log(`✗ ${tag}`);
      for (const p of problems) console.log(`    ${p}`);
    } else console.log(`✓ ${tag}`);
    await ctx.close();
  }
}

// Estado 1: servidor novo (sem chave e sem crônicas). Estado 2: chave configurada e duas crônicas.
await runState('vazio');
repos.settings.set('gemini_api_key', FAKE_KEY);
await createSession('A Queda de Valdoria');
await createSession('Crônica dos Volumes');
await runState('completo');

await browser.close();
await app.close();
console.log(`\n${checked} cenários verificados (2 estados × 5 larguras) em ${BROWSER}; ${failures.length} problema(s).`);
process.exit(failures.length ? 1 : 0);
