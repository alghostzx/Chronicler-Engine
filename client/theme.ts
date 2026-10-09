import { THEMES, type ThemeId } from './api';

const STORAGE_KEY = 'chronicler.theme';
const ALL = THEMES.map((t) => `theme-${t.id}`);

export function isTheme(value: unknown): value is ThemeId {
  return THEMES.some((t) => t.id === value);
}

/** Aplica a classe de tema na raiz (<html>) — o CSS troca cores e fontes via variáveis. */
export function applyTheme(theme: ThemeId): void {
  const root = document.documentElement;
  root.classList.remove(...ALL);
  root.classList.add(`theme-${theme}`);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* armazenamento indisponível */
  }
}

export function savedTheme(): ThemeId {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (isTheme(v)) return v;
  } catch {
    /* ignora */
  }
  return 'medieval';
}
