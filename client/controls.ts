import { THEMES, type ThemeId } from './api';
import { h } from './dom';
import { icon, type IconName } from './icons';
import { MODE_PREFS, isModePref, savedMode, setModePref, type ModePref } from './theme';

/** Posição do tooltip em relação ao botão (evita cortar nas bordas da tela). */
export type TipAlign = 'start' | 'center' | 'end';

const tipClass = (align: TipAlign): string => `tip${align === 'center' ? '' : ` tip-${align}`}`;

/**
 * Botão quadrado só com ícone. O texto vira `aria-label` (leitores de tela) e tooltip visual
 * (`data-tip`, exibido ao passar o mouse ou receber foco do teclado).
 */
export function iconButton(opts: {
  icon: IconName;
  label: string;
  tip?: string;
  align?: TipAlign;
  onClick?: () => void;
  href?: string;
}): HTMLButtonElement | HTMLAnchorElement {
  const attrs = {
    class: `btn btn-icon ${tipClass(opts.align ?? 'center')}`,
    'aria-label': opts.label,
    'data-tip': opts.tip ?? opts.label,
  };
  if (opts.href !== undefined) return h('a', { ...attrs, href: opts.href }, icon(opts.icon));
  return h('button', { ...attrs, type: 'button', onClick: opts.onClick }, icon(opts.icon));
}

export interface MenuOption<T extends string> {
  id: T;
  label: string;
  icon?: IconName;
}

export interface MenuControl<T extends string> {
  el: HTMLElement;
  button: HTMLButtonElement;
  setCurrent(id: T): void;
}

/**
 * Botão de ícone que abre um pequeno menu de opções exclusivas (radio). Fecha com Esc, clique fora,
 * escolha de uma opção ou saída do foco; setas ↑/↓ navegam entre as opções.
 */
export function createMenuControl<T extends string>(opts: {
  label: string;
  icon: (current: T) => IconName;
  tip: (current: T) => string;
  options: MenuOption<T>[];
  current: T;
  onSelect: (id: T) => void;
  align?: TipAlign;
}): MenuControl<T> {
  let current = opts.current;
  const align = opts.align ?? 'end';

  const button = h('button', {
    type: 'button',
    class: `btn btn-icon ${tipClass(align)}`,
    'aria-label': opts.label,
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
  });
  const menu = h('div', {
    role: 'menu',
    'aria-label': opts.label,
    class: `menu hidden ${align === 'start' ? 'left-0' : 'right-0'}`,
  });
  const el = h('div', { class: 'relative inline-flex' }, button, menu);

  const items = (): HTMLButtonElement[] => Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
  const isOpen = (): boolean => !menu.classList.contains('hidden');

  function paint(): void {
    button.replaceChildren(icon(opts.icon(current)));
    button.setAttribute('data-tip', opts.tip(current));
    menu.replaceChildren(
      ...opts.options.map((o) =>
        h(
          'button',
          {
            type: 'button',
            role: 'menuitemradio',
            'aria-checked': String(o.id === current),
            class: 'menu-item',
            onClick: () => {
              close(true);
              if (o.id !== current) {
                setCurrent(o.id);
                opts.onSelect(o.id);
              }
            },
          },
          o.icon ? icon(o.icon, 16) : null,
          h('span', { class: 'flex-1 text-left' }, o.label),
          o.id === current ? icon('check', 16) : null,
        ),
      ),
    );
  }

  function setCurrent(id: T): void {
    current = id;
    paint();
  }

  const onOutside = (e: Event): void => {
    if (!el.isConnected || !el.contains(e.target as Node)) close(false);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (!el.isConnected) return close(false);
    if (e.key === 'Escape') {
      e.stopPropagation();
      close(true);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const list = items();
      if (list.length === 0) return;
      const at = list.indexOf(document.activeElement as HTMLButtonElement);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      list[(at + step + list.length) % list.length]?.focus();
    }
  };

  function open(): void {
    menu.classList.remove('hidden');
    button.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', onOutside);
    document.addEventListener('keydown', onKey, true);
    (items().find((i) => i.getAttribute('aria-checked') === 'true') ?? items()[0])?.focus();
  }

  function close(refocus: boolean): void {
    menu.classList.add('hidden');
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onOutside);
    document.removeEventListener('keydown', onKey, true);
    if (refocus) button.focus();
  }

  button.addEventListener('click', () => (isOpen() ? close(true) : open()));
  el.addEventListener('focusout', (e) => {
    const next = (e as FocusEvent).relatedTarget as Node | null;
    if (isOpen() && next && !el.contains(next)) close(false);
  });

  paint();
  return { el, button, setCurrent };
}

const MODE_ICON: Record<ModePref, IconName> = { auto: 'monitor', light: 'sun', dark: 'moon' };
const MODE_OPTION_ICON = MODE_ICON;

/** Controle de modo claro/escuro (automático, claro, escuro) reutilizado na tela inicial e na sessão. */
export function createModeControl(align: TipAlign = 'end'): HTMLElement {
  const label = (id: ModePref): string => MODE_PREFS.find((m) => m.id === id)?.label ?? id;
  const ctl = createMenuControl<ModePref>({
    label: 'Modo claro ou escuro',
    icon: (cur) => MODE_ICON[cur],
    tip: (cur) => `Modo claro ou escuro: ${label(cur)}`,
    options: MODE_PREFS.map((m) => ({ id: m.id, label: m.label, icon: MODE_OPTION_ICON[m.id] })),
    current: savedMode(),
    onSelect: (id) => {
      if (isModePref(id)) setModePref(id);
    },
    align,
  });
  return ctl.el;
}

/** Controle de tema visual (Medieval, Cyberpunk…) da sessão. */
export function createThemeControl(current: ThemeId, onSelect: (theme: ThemeId) => void, align: TipAlign = 'end'): MenuControl<ThemeId> {
  const label = (id: ThemeId): string => THEMES.find((t) => t.id === id)?.label ?? id;
  return createMenuControl<ThemeId>({
    label: 'Tema visual',
    icon: () => 'palette',
    tip: (cur) => `Tema visual: ${label(cur)}`,
    options: THEMES.map((t) => ({ id: t.id, label: t.label })),
    current,
    onSelect,
    align,
  });
}

export { createFullscreenButton, toggleFullscreen, isFullscreen } from './fullscreen';
