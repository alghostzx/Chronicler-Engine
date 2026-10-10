import { THEMES, type ThemeId } from './api';

const THEME_KEY = 'chronicler.theme';
const MODE_KEY = 'chronicler.mode';
const ALL_THEMES = THEMES.map((t) => `theme-${t.id}`);

/** Preferência de modo: segue o sistema (padrão) ou força claro/escuro. */
export type ModePref = 'auto' | 'light' | 'dark';
export type Mode = 'light' | 'dark';

export const MODE_PREFS: { id: ModePref; label: string }[] = [
  { id: 'auto', label: 'Automático (sistema)' },
  { id: 'light', label: 'Claro' },
  { id: 'dark', label: 'Escuro' },
];

let currentTheme: ThemeId = 'medieval';
let currentPref: ModePref = 'auto';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* armazenamento indisponível */
  }
}

export function isTheme(value: unknown): value is ThemeId {
  return THEMES.some((t) => t.id === value);
}

export function isModePref(value: unknown): value is ModePref {
  return MODE_PREFS.some((m) => m.id === value);
}

export function savedTheme(): ThemeId {
  const v = read(THEME_KEY);
  return isTheme(v) ? v : 'medieval';
}

export function savedMode(): ModePref {
  const v = read(MODE_KEY);
  return isModePref(v) ? v : 'auto';
}

/** Resolve a preferência para o modo efetivo (consultando o sistema quando for "auto"). */
export function resolveMode(pref: ModePref): Mode {
  if (pref !== 'auto') return pref;
  const dark = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
  return dark ? 'dark' : 'light';
}

/**
 * Escopo visual da tela inicial e de Opções: paleta Srcery escura fixa (`theme-srcery`), sem tocar no
 * tema/modo salvos (valem nas crônicas). Sair da tela inicial (`applyTheme`) desfaz o escopo.
 */
let titleScope = false;

function paint(): void {
  const root = document.documentElement;
  root.classList.remove(...ALL_THEMES, 'theme-srcery', 'mode-light', 'mode-dark');
  if (titleScope) root.classList.add('theme-srcery', 'mode-dark');
  else root.classList.add(`theme-${currentTheme}`, `mode-${resolveMode(currentPref)}`);
  syncThemeColor();
}

/** Atualiza `<meta name="theme-color">` (barra de status/título do app) com a cor do cabeçalho do tema. */
function syncThemeColor(): void {
  const color = getComputedStyle(document.documentElement).getPropertyValue('--bg-panel').trim();
  if (!color) return;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.content = color;
}

/** Aplica o tema (classe na raiz <html>) mantendo o modo claro/escuro atual. */
export function applyTheme(theme: ThemeId): void {
  titleScope = false;
  currentTheme = theme;
  write(THEME_KEY, theme);
  paint();
}

/** Liga a paleta Srcery (tela inicial e Opções). */
export function applyTitleScreen(): void {
  titleScope = true;
  paint();
}

export function setModePref(pref: ModePref): void {
  currentPref = pref;
  write(MODE_KEY, pref);
  paint();
}

/** Carrega as preferências salvas e acompanha mudanças do tema do sistema (modo "auto"). */
export function initTheme(): void {
  currentTheme = savedTheme();
  currentPref = savedMode();
  paint();
  if (typeof window.matchMedia === 'function') {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (currentPref === 'auto') paint();
    });
  }
}
