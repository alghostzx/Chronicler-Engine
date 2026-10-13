import { THEMES, type ThemeId } from './api';
import { h, toast } from './dom';
import { icon, type IconName } from './icons';
import { MODE_PREFS, isModePref, savedMode, setModePref, type ModePref } from './theme';

/** Posição do tooltip em relação ao botão (evita cortar nas bordas da tela). */
export type TipAlign = 'start' | 'center' | 'end';

const tipClass = (align: TipAlign, up = false): string => `tip${align === 'center' ? '' : ` tip-${align}`}${up ? ' tip-up' : ''}`;

/**
 * Botão quadrado só com ícone. O texto vira `aria-label` (leitores de tela) e tooltip visual
 * (`data-tip`, exibido ao passar o mouse ou receber foco do teclado).
 */
export function iconButton(opts: {
  icon: IconName;
  label: string;
  tip?: string;
  align?: TipAlign;
  /** Tooltip acima do botão (útil em rodapés de cartões). */
  up?: boolean;
  disabled?: boolean;
  /** Classe extra (ex.: `page-action`). */
  extraClass?: string;
  onClick?: () => void;
  href?: string;
}): HTMLButtonElement | HTMLAnchorElement {
  const attrs = {
    class: `btn btn-icon ${tipClass(opts.align ?? 'center', opts.up)}${opts.extraClass ? ` ${opts.extraClass}` : ''}`,
    'aria-label': opts.label,
    'data-tip': opts.tip ?? opts.label,
  };
  if (opts.href !== undefined) return h('a', { ...attrs, href: opts.href }, icon(opts.icon));
  return h('button', { ...attrs, type: 'button', disabled: opts.disabled, onClick: opts.onClick }, icon(opts.icon));
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

export interface ActionMenuItem {
  label: string;
  icon?: IconName;
  /** Link de download: vira `<a download>` em vez de botão. */
  href?: string;
  danger?: boolean;
  onSelect?: () => void;
}

export interface ActionMenu {
  el: HTMLElement;
  button: HTMLButtonElement;
  setItems(items: ActionMenuItem[]): void;
  /** Esconde/mostra o botão inteiro (ex.: sem áudio pronto não há o que escolher). */
  setHidden(hidden: boolean): void;
}

/**
 * Botão de ícone (reticências) que abre um pequeno menu de ações (`role=menu`). Fecha com Esc, clique
 * fora, escolha de um item ou saída do foco; setas ↑/↓ navegam. `up` abre o menu para cima (rodapés).
 */
export function createActionMenu(opts: { label: string; icon?: IconName; items: ActionMenuItem[]; align?: TipAlign; up?: boolean }): ActionMenu {
  const align = opts.align ?? 'start';
  const button = h('button', {
    type: 'button',
    class: `btn btn-icon page-action-menu ${tipClass(align, opts.up)}`,
    'aria-label': opts.label,
    'data-tip': opts.label,
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
  });
  button.append(icon(opts.icon ?? 'more'));
  const menu = h('div', {
    role: 'menu',
    'aria-label': opts.label,
    class: `menu hidden ${opts.up ? 'menu-up' : ''} ${align === 'end' ? 'right-0' : 'left-0'}`,
  });
  const el = h('div', { class: 'relative inline-flex' }, button, menu);

  const entries = (): HTMLElement[] => Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  const isOpen = (): boolean => !menu.classList.contains('hidden');

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
      const list = entries();
      if (list.length === 0) return;
      const at = list.indexOf(document.activeElement as HTMLElement);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      list[(at + step + list.length) % list.length]?.focus();
    }
  };

  function open(): void {
    menu.classList.remove('hidden');
    button.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', onOutside);
    document.addEventListener('keydown', onKey, true);
    entries()[0]?.focus();
  }

  function close(refocus: boolean): void {
    menu.classList.add('hidden');
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onOutside);
    document.removeEventListener('keydown', onKey, true);
    if (refocus) button.focus();
  }

  function setItems(items: ActionMenuItem[]): void {
    menu.replaceChildren(
      ...items.map((it) => {
        const content = [it.icon ? icon(it.icon, 16) : null, h('span', { class: 'flex-1 text-left' }, it.label)];
        const cls = `menu-item${it.danger ? ' is-danger' : ''}`;
        if (it.href !== undefined) {
          return h('a', { role: 'menuitem', class: cls, href: it.href, download: '', onClick: () => close(false) }, ...content);
        }
        return h(
          'button',
          {
            type: 'button',
            role: 'menuitem',
            class: cls,
            onClick: () => {
              close(true);
              it.onSelect?.();
            },
          },
          ...content,
        );
      }),
    );
  }

  button.addEventListener('click', () => (isOpen() ? close(true) : open()));
  el.addEventListener('focusout', (e) => {
    const next = (e as FocusEvent).relatedTarget as Node | null;
    if (isOpen() && next && !el.contains(next)) close(false);
  });

  setItems(opts.items);
  return {
    el,
    button,
    setItems,
    setHidden(hidden) {
      if (hidden && isOpen()) close(false);
      el.classList.toggle('hidden', hidden);
    },
  };
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

/** O navegador permite pedir tela cheia (Fullscreen API)? Não existe, por exemplo, no iPhone. */
export function canFullscreen(): boolean {
  return !!document.fullscreenEnabled && typeof document.documentElement.requestFullscreen === 'function';
}

/**
 * Botão de ícone que entra/sai do modo de tela cheia (esconde a barra do navegador). Retorna `null`
 * onde a API não existe; o ícone, o rótulo e a dica acompanham o estado atual.
 */
export function fullscreenButton(): HTMLButtonElement | null {
  if (!canFullscreen()) return null;
  const button = h('button', { type: 'button', class: `btn btn-icon ${tipClass('end')}` });

  const paint = (): void => {
    const on = !!document.fullscreenElement;
    const label = on ? 'Sair da tela cheia' : 'Tela cheia';
    button.replaceChildren(icon(on ? 'fullscreenExit' : 'fullscreen'));
    button.setAttribute('aria-label', label);
    button.setAttribute('data-tip', on ? 'Sair da tela cheia e voltar a mostrar a barra do navegador' : 'Usar a tela inteira (esconde a barra do navegador)');
    button.setAttribute('aria-pressed', String(on));
  };
  const onChange = (): void => {
    // O botão sai do DOM ao trocar de tela: solta o ouvinte global.
    if (!button.isConnected) return document.removeEventListener('fullscreenchange', onChange);
    paint();
  };

  button.addEventListener('click', () => {
    const action = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    action.catch(() => toast('Não foi possível alternar a tela cheia neste navegador.', 'error'));
  });
  document.addEventListener('fullscreenchange', onChange);
  paint();
  return button;
}
