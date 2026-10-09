// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { filenameFromDisposition } from '../client/download';
import { createModeControl } from '../client/controls';
import { applyTheme, initTheme, resolveMode, savedMode, setModePref } from '../client/theme';

function stubSystemDark(dark: boolean) {
  const listeners: Array<() => void> = [];
  vi.stubGlobal(
    'matchMedia',
    (query: string) => ({
      matches: dark && query.includes('dark'),
      media: query,
      addEventListener: (_: string, fn: () => void) => listeners.push(fn),
      removeEventListener: () => {},
    }),
  );
  window.matchMedia = globalThis.matchMedia;
  return {
    flip(next: boolean) {
      dark = next;
      listeners.forEach((fn) => fn());
    },
  };
}

const cls = () => document.documentElement.classList;

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = '';
  vi.unstubAllGlobals();
});

describe('temas claro/escuro', () => {
  it('modo automático segue o sistema e reage a mudanças dele', () => {
    const sys = stubSystemDark(true);
    initTheme();
    expect(cls().contains('mode-dark')).toBe(true);
    expect(cls().contains('theme-medieval')).toBe(true);
    sys.flip(false);
    expect(cls().contains('mode-light')).toBe(true);
    expect(cls().contains('mode-dark')).toBe(false);
    expect(resolveMode('dark')).toBe('dark');
  });

  it('modo forçado ignora o sistema, persiste e preserva o tema ao trocar', () => {
    stubSystemDark(true);
    initTheme();
    setModePref('light');
    expect(cls().contains('mode-light')).toBe(true);
    expect(cls().contains('mode-dark')).toBe(false);
    expect(savedMode()).toBe('light');

    applyTheme('cyberpunk');
    expect(cls().contains('theme-cyberpunk')).toBe(true);
    expect(cls().contains('mode-light')).toBe(true);
    expect(cls().contains('theme-medieval')).toBe(false);

    setModePref('dark');
    expect(cls().contains('theme-cyberpunk')).toBe(true);
    expect(cls().contains('mode-dark')).toBe(true);
  });

  it('recarrega a preferência salva e ignora valores inválidos', () => {
    localStorage.setItem('chronicler.mode', 'dark');
    localStorage.setItem('chronicler.theme', 'contemporaneo');
    initTheme();
    expect(cls().contains('theme-contemporaneo')).toBe(true);
    expect(cls().contains('mode-dark')).toBe(true);

    localStorage.setItem('chronicler.mode', 'roxo');
    localStorage.setItem('chronicler.theme', 'inexistente');
    initTheme();
    expect(savedMode()).toBe('auto');
    expect(cls().contains('theme-medieval')).toBe(true);
  });

  it('o seletor de modo reflete e altera a preferência', () => {
    setModePref('dark');
    const el = createModeControl();
    document.body.appendChild(el);
    const btn = el.querySelector('button')!;
    expect(btn.getAttribute('data-tip')).toBe('Modo claro ou escuro: Escuro');
    btn.click();
    const light = Array.from(el.querySelectorAll<HTMLElement>('[role="menuitemradio"]')).find((i) => i.textContent === 'Claro')!;
    expect(light.getAttribute('aria-checked')).toBe('false');
    light.click();
    expect(savedMode()).toBe('light');
    expect(cls().contains('mode-light')).toBe(true);
    expect(btn.getAttribute('data-tip')).toBe('Modo claro ou escuro: Claro');
    el.remove();
  });
});

describe('nome do arquivo exportado', () => {
  it('prefere filename* UTF-8, depois filename simples, depois o padrão', () => {
    expect(filenameFromDisposition(`attachment; filename="a.md"; filename*=UTF-8''Cr%C3%B4nica.md`, 'x.md')).toBe('Crônica.md');
    expect(filenameFromDisposition('attachment; filename="a-b.md"', 'x.md')).toBe('a-b.md');
    expect(filenameFromDisposition(null, 'x.md')).toBe('x.md');
    expect(filenameFromDisposition("attachment; filename*=UTF-8''%E0%A4%A", 'x.md')).toBe('x.md');
  });
});
