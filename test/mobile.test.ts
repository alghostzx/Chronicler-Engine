// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/connection.js';
import { createRepositories } from '../src/db/index.js';
import { buildApp } from '../src/server.js';
import { canFullscreen, fullscreenButton } from '../client/controls';
import { applyTheme, setModePref } from '../client/theme';
import { mockGateway } from './helpers.js';

const PUBLIC = join(process.cwd(), 'public');
const INDEX = readFileSync(join(PUBLIC, 'index.html'), 'utf8');

/** Lê as dimensões do cabeçalho IHDR de um PNG. */
function pngSize(file: string): { width: number; height: number } {
  const b = readFileSync(file);
  expect(b.subarray(1, 4).toString('ascii')).toBe('PNG');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

describe('viewport e metas para celular', () => {
  const meta = (name: string): string | null => new RegExp(`<meta name="${name}" content="([^"]*)"`).exec(INDEX)?.[1] ?? null;

  it('a meta viewport redimensiona o conteúdo com o teclado e cobre a tela inteira', () => {
    const vp = meta('viewport') ?? '';
    expect(vp).toContain('width=device-width');
    expect(vp).toContain('viewport-fit=cover');
    expect(vp).toContain('interactive-widget=resizes-content');
    expect(vp).not.toContain('user-scalable=no');
    expect(vp).not.toContain('maximum-scale');
  });

  it('declara o manifesto, a cor da barra de status e os metadados de app (Android e iOS)', () => {
    expect(INDEX).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(meta('theme-color')).toMatch(/^#[0-9a-f]{6}$/i);
    expect(meta('mobile-web-app-capable')).toBe('yes');
    expect(meta('apple-mobile-web-app-capable')).toBe('yes');
    expect(meta('apple-mobile-web-app-title')).toBeTruthy();
    expect(meta('apple-mobile-web-app-status-bar-style')).toBe('default');
  });

  it('as telas da sessão e do leitor usam o app shell em vez de h-screen (100vh)', () => {
    for (const file of ['session.ts', 'volume.ts']) {
      const src = readFileSync(join(process.cwd(), 'client', 'views', file), 'utf8');
      expect(src, file).toContain("class: 'app-screen'");
      expect(src, file).not.toContain('h-screen');
    }
    const css = readFileSync(join(process.cwd(), 'client', 'styles.css'), 'utf8');
    expect(css).toContain('100dvh');
    expect(css).toContain('env(safe-area-inset-bottom)');
    expect(css).toMatch(/html\.app-shell[\s\S]*overflow:\s*hidden/);
  });
});

describe('manifesto web (instalável como PWA)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeEach(async () => {
    const gateway = mockGateway();
    app = await buildApp(loadConfig({ PUBLIC_DIR: PUBLIC }), { repos: createRepositories(openDatabase(':memory:')), gatewayFactory: () => gateway });
  });
  afterEach(() => app.close());

  it('é servido com o tipo MIME de manifesto e tem os campos exigidos', async () => {
    const res = await app.inject({ method: 'GET', url: '/manifest.webmanifest' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/manifest+json');
    const m = res.json();
    expect(m.name).toBe('Chronicler Engine');
    expect(m.short_name).toBeTruthy();
    expect(m.short_name.length).toBeLessThanOrEqual(12);
    expect(m.lang).toBe('pt-BR');
    expect(m.display).toBe('standalone'); // sem barra do navegador, mas com a barra de status
    expect(m.start_url).toBe('/');
    expect(m.scope).toBe('/');
    expect(m.background_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(m.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('declara ícones 192, 512 e maskable que existem, são PNG e têm o tamanho declarado', async () => {
    const m = (await app.inject({ method: 'GET', url: '/manifest.webmanifest' })).json() as { icons: { src: string; sizes: string; type: string; purpose?: string }[] };
    const png = m.icons.filter((i) => i.type === 'image/png');
    expect(png.some((i) => i.sizes === '192x192' && i.purpose === 'any')).toBe(true);
    expect(png.some((i) => i.sizes === '512x512' && i.purpose === 'any')).toBe(true);
    expect(png.some((i) => i.sizes === '512x512' && i.purpose === 'maskable')).toBe(true);
    for (const icon of m.icons) {
      const res = await app.inject({ method: 'GET', url: icon.src });
      expect(res.statusCode, icon.src).toBe(200);
      if (icon.type === 'image/png') {
        const [w, h] = icon.sizes.split('x').map(Number);
        expect(pngSize(join(PUBLIC, icon.src)), icon.src).toEqual({ width: w, height: h });
      }
    }
  });
});

describe('client/viewport.ts (altura útil com a janela visual)', () => {
  const root = document.documentElement;
  type Listener = () => void;
  let listeners: Record<string, Listener[]>;
  let vv: { height: number; scale: number; offsetTop: number; addEventListener: (t: string, fn: Listener) => void };
  let scrollTo: ReturnType<typeof vi.fn>;
  let setAppShell: (on: boolean) => void;

  beforeEach(async () => {
    listeners = {};
    vv = { height: 600, scale: 1, offsetTop: 0, addEventListener: (t, fn) => (listeners[t] ??= []).push(fn) };
    vi.stubGlobal('visualViewport', vv);
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });
    scrollTo = vi.fn();
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
    root.className = '';
    root.style.removeProperty('--app-height');
    vi.resetModules();
    ({ setAppShell } = await import('../client/viewport'));
  });
  afterEach(() => vi.unstubAllGlobals());

  const fire = (type: string): void => listeners[type]?.forEach((fn) => fn());

  it('liga o app shell, aplica a altura visível e acompanha o teclado abrindo e fechando', () => {
    setAppShell(true);
    expect(root.classList.contains('app-shell')).toBe(true);
    expect(root.style.getPropertyValue('--app-height')).toBe('600px');
    vv.height = 310; // teclado aberto
    fire('resize');
    expect(root.style.getPropertyValue('--app-height')).toBe('310px');
    vv.height = 600;
    fire('resize');
    expect(root.style.getPropertyValue('--app-height')).toBe('600px');
  });

  it('devolve o documento ao topo quando o navegador o desloca (iOS ao focar o campo)', () => {
    setAppShell(true);
    vv.offsetTop = 120;
    fire('scroll');
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('não mexe na altura durante o zoom por pinça', () => {
    setAppShell(true);
    vv.scale = 2;
    vv.height = 300;
    fire('resize');
    expect(root.style.getPropertyValue('--app-height')).toBe('600px');
  });

  it('desliga o app shell e limpa a altura fora das telas de leitura/sessão; ignora eventos depois disso', () => {
    setAppShell(true);
    setAppShell(false);
    expect(root.classList.contains('app-shell')).toBe(false);
    expect(root.style.getPropertyValue('--app-height')).toBe('');
    vv.height = 200;
    fire('resize');
    expect(root.style.getPropertyValue('--app-height')).toBe('');
  });
});

describe('botão de tela cheia', () => {
  let fullscreenElement: Element | null;
  let request: ReturnType<typeof vi.fn>;
  let exit: ReturnType<typeof vi.fn>;

  function stubFullscreen(supported: boolean): void {
    fullscreenElement = null;
    request = vi.fn(() => Promise.resolve());
    exit = vi.fn(() => Promise.resolve());
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: supported });
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreenElement });
    document.documentElement.requestFullscreen = request as unknown as typeof document.documentElement.requestFullscreen;
    document.exitFullscreen = exit as unknown as typeof document.exitFullscreen;
  }

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('não aparece onde a Fullscreen API não existe (ex.: iPhone)', () => {
    stubFullscreen(false);
    expect(canFullscreen()).toBe(false);
    expect(fullscreenButton()).toBeNull();
  });

  it('é um botão só de ícone, com rótulo e dica em português, e alterna entrar/sair', () => {
    stubFullscreen(true);
    const btn = fullscreenButton()!;
    document.body.appendChild(btn);
    expect(btn.getAttribute('aria-label')).toBe('Tela cheia');
    expect(btn.getAttribute('data-tip')).toBeTruthy();
    expect(btn.querySelectorAll('svg')).toHaveLength(1);
    expect(btn.textContent?.trim()).toBe('');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    const enterIcon = btn.querySelector('svg')!.innerHTML;

    btn.click();
    expect(request).toHaveBeenCalledTimes(1);

    fullscreenElement = document.documentElement; // o navegador entrou em tela cheia
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(btn.getAttribute('aria-label')).toBe('Sair da tela cheia');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.querySelector('svg')!.innerHTML).not.toBe(enterIcon);

    btn.click();
    expect(exit).toHaveBeenCalledTimes(1);

    fullscreenElement = null;
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(btn.getAttribute('aria-label')).toBe('Tela cheia');
  });

  it('mostra um aviso se o navegador recusar a tela cheia', async () => {
    stubFullscreen(true);
    document.body.innerHTML = '<div id="toasts"></div>';
    request.mockImplementation(() => Promise.reject(new Error('negado')));
    const btn = fullscreenButton()!;
    document.body.appendChild(btn);
    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.getElementById('toasts')!.textContent).toContain('tela cheia');
  });
});

describe('theme-color dinâmico', () => {
  beforeEach(() => {
    document.head.innerHTML = '<meta name="theme-color" content="#ebe0c4" />';
    localStorage.clear();
  });
  afterEach(() => vi.restoreAllMocks());

  it('acompanha a cor do painel do tema/modo aplicado', () => {
    const panel: Record<string, string> = { 'theme-cyberpunk': '#161b22', 'theme-medieval': '#ebe0c4' };
    vi.spyOn(window, 'getComputedStyle').mockImplementation(
      () =>
        ({
          getPropertyValue: (name: string) => (name === '--bg-panel' ? (Object.entries(panel).find(([cls]) => document.documentElement.classList.contains(cls))?.[1] ?? '') : ''),
        }) as unknown as CSSStyleDeclaration,
    );
    setModePref('dark');
    applyTheme('cyberpunk');
    expect(document.querySelector('meta[name="theme-color"]')!.getAttribute('content')).toBe('#161b22');
    applyTheme('medieval');
    expect(document.querySelector('meta[name="theme-color"]')!.getAttribute('content')).toBe('#ebe0c4');
  });

  it('cria a meta se ela não existir', () => {
    document.head.innerHTML = '';
    vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({ getPropertyValue: () => '#123456' }) as unknown as CSSStyleDeclaration);
    applyTheme('medieval');
    expect(document.querySelector('meta[name="theme-color"]')!.getAttribute('content')).toBe('#123456');
  });
});
