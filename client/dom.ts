/** Utilitários mínimos de DOM (sem framework): criação de elementos, toasts e modais. */

import { icon } from './icons';

type Child = Node | string | number | null | undefined | false | Child[];

export type Attrs = {
  class?: string;
  [key: string]: unknown;
};

/**
 * Cria um elemento. Atributos `onXxx` viram listeners; `value`/`checked`/`disabled`/`selected`
 * são propriedades; o resto são atributos. Filhos de texto usam `textContent` (sem XSS).
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') el.className = String(value);
      else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'selected') {
        (el as unknown as Record<string, unknown>)[key] = value;
      } else if (value === true) el.setAttribute(key, '');
      else el.setAttribute(key, String(value));
    }
  }
  append(el, children);
  return el;
}

function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(parent, c);
    else if (c instanceof Node) parent.appendChild(c);
    else parent.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function mount(el: Element, ...children: Child[]): void {
  clear(el);
  append(el, children);
}

// --- Toasts ----------------------------------------------------------------------------------
export function toast(message: string, kind: 'info' | 'error' | 'success' = 'info'): void {
  const host = document.getElementById('toasts');
  if (!host) return;
  const color =
    kind === 'error' ? 'border-hp-low text-hp-low' : kind === 'success' ? 'border-hp-ok text-hp-ok' : 'border-accent text-ink';
  const el = h('div', { class: `pointer-events-auto rounded border bg-panel px-4 py-2 text-sm shadow-lg ${color}`, role: 'status' }, message);
  host.appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 8000 : 4000);
}

// --- Modal -----------------------------------------------------------------------------------
export interface ModalHandle {
  close(): void;
  body: HTMLElement;
}

/** Modais abertos (o último é o do topo): Esc fecha só o do topo, p.ex. uma confirmação sobre um quadro. */
const modalStack: Array<() => void> = [];

/**
 * Abre um modal acessível (Esc fecha, clique no fundo fecha). Com `closeButton` mostra um botão de
 * ícone “Fechar” no canto (fica por último na ordem do foco, para o primeiro campo receber o foco).
 */
export function openModal(
  title: string,
  content: Child,
  opts: { wide?: boolean; closeButton?: boolean; onClose?: () => void } = {},
): ModalHandle {
  const previouslyFocused = document.activeElement as HTMLElement | null;
  const body = h('div', { class: 'mt-3' }, content);
  const closeBtn = opts.closeButton
    ? h(
        'button',
        { type: 'button', class: 'btn btn-icon tip tip-end absolute right-3 top-3', 'aria-label': 'Fechar', 'data-tip': 'Fechar', onClick: () => close() },
        icon('close'),
      )
    : null;
  const dialog = h(
    'div',
    {
      class: `card relative max-h-[90vh] w-full overflow-y-auto shadow-2xl ${opts.wide ? 'max-w-3xl' : 'max-w-lg'}`,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': title,
    },
    h('h2', { class: `font-display text-lg text-strong${closeBtn ? ' pr-10' : ''}` }, title),
    body,
    closeBtn,
  );
  const backdrop = h('div', { class: 'fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm' }, dialog);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    const at = modalStack.indexOf(close);
    if (at >= 0) modalStack.splice(at, 1);
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    previouslyFocused?.focus?.();
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && modalStack[modalStack.length - 1] === close) close();
  };
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  modalStack.push(close);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(backdrop);
  (dialog.querySelector('textarea, input, select, button, a[href]') as HTMLElement | null)?.focus();
  return { close, body };
}

/** Confirmação com botões pt-BR. Resolve `true` se o usuário confirmar. */
export function confirmModal(
  title: string,
  message: Child,
  opts: { confirmLabel?: string; danger?: boolean } = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v: boolean) => {
      if (settled) return;
      settled = true;
      modal.close();
      resolve(v);
    };
    const modal = openModal(
      title,
      h(
        'div',
        null,
        h('div', { class: 'text-sm leading-6 text-ink' }, message),
        h(
          'div',
          { class: 'mt-4 flex justify-end gap-2' },
          h('button', { class: 'btn', type: 'button', onClick: () => settle(false) }, 'Cancelar'),
          h(
            'button',
            { class: `btn btn-primary ${opts.danger ? 'btn-danger' : ''}`, type: 'button', onClick: () => settle(true) },
            opts.confirmLabel ?? 'Confirmar',
          ),
        ),
      ),
      { onClose: () => settle(false) },
    );
  });
}

// --- Texto -----------------------------------------------------------------------------------
/** Divide a prosa em parágrafos (linhas em branco separam; linhas simples também). */
export function paragraphs(text: string): string[] {
  return text
    .split(/\n{2,}|\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

export function formatNumber(n: number): string {
  return n.toLocaleString('pt-BR');
}

/** "1 página" / "N páginas" (N com separador de milhar pt-BR). */
export function countPages(n: number): string {
  return `${formatNumber(n)} ${n === 1 ? 'página' : 'páginas'}`;
}
