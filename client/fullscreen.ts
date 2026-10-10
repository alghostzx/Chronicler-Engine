import { type TipAlign } from './controls';
import { h, toast } from './dom';
import { icon } from './icons';

type VendorDocument = Document & {
  webkitFullscreenElement?: Element | null;
  mozFullScreenElement?: Element | null;
  msFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
  mozCancelFullScreen?: () => Promise<void> | void;
  msExitFullscreen?: () => Promise<void> | void;
  webkitFullscreenEnabled?: boolean;
  mozFullScreenEnabled?: boolean;
  msFullscreenEnabled?: boolean;
};

type VendorElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
  mozRequestFullScreen?: () => Promise<void> | void;
  msRequestFullscreen?: () => Promise<void> | void;
};

let pseudoActive = false;
const listeners = new Set<(active: boolean) => void>();

function notify(): void {
  const current = isFullscreen();
  for (const fn of listeners) {
    try {
      fn(current);
    } catch {
      // Evita que falha em um ouvinte bloqueie os demais
    }
  }
}

/** Verifica se o navegador está atualmente em modo tela cheia (nativo ou pseudo). */
export function isFullscreen(): boolean {
  if (pseudoActive) return true;
  if (typeof document === 'undefined') return false;
  const doc = document as VendorDocument;
  return !!(
    doc.fullscreenElement ||
    doc.webkitFullscreenElement ||
    doc.mozFullScreenElement ||
    doc.msFullscreenElement
  );
}

/** Indica se a API nativa de tela cheia está disponível no navegador/dispositivo. */
export function isNativeFullscreenSupported(): boolean {
  if (typeof document === 'undefined') return false;
  const doc = document as VendorDocument;
  const docEl = document.documentElement as VendorElement;
  return !!(
    doc.fullscreenEnabled ||
    doc.webkitFullscreenEnabled ||
    doc.mozFullScreenEnabled ||
    doc.msFullscreenEnabled ||
    docEl.requestFullscreen ||
    docEl.webkitRequestFullscreen ||
    docEl.mozRequestFullScreen ||
    docEl.msRequestFullscreen
  );
}

/**
 * Ativa o modo tela cheia. Usa a API nativa (com prefixos de fornecedor para navegadores móveis)
 * e aplica modo pseudo-tela cheia se a API não estiver disponível (ex.: Safari no iPhone).
 */
export async function enterFullscreen(target: HTMLElement = document.documentElement): Promise<boolean> {
  const el = target as VendorElement;

  try {
    if (typeof el.requestFullscreen === 'function') {
      await el.requestFullscreen();
      return true;
    }
    if (typeof el.webkitRequestFullscreen === 'function') {
      await el.webkitRequestFullscreen();
      return true;
    }
    if (typeof el.mozRequestFullScreen === 'function') {
      await el.mozRequestFullScreen();
      return true;
    }
    if (typeof el.msRequestFullscreen === 'function') {
      await el.msRequestFullscreen();
      return true;
    }
  } catch {
    // Falha ou permissão negada na API nativa: cai para o modo pseudo
  }

  // Fallback: modo pseudo tela cheia (garante funcionamento no Safari iOS)
  setPseudoFullscreen(true);
  if (typeof navigator !== 'undefined' && /iPhone|iPod/i.test(navigator.userAgent)) {
    toast('Tela cheia ativada. No Safari do iPhone, adicione à Tela de Início para ocultar todas as barras.', 'info');
  }
  return true;
}

/** Sai do modo tela cheia (nativo ou pseudo). */
export async function exitFullscreen(): Promise<boolean> {
  if (pseudoActive) {
    setPseudoFullscreen(false);
    return true;
  }

  if (typeof document === 'undefined') return false;
  const doc = document as VendorDocument;

  try {
    if (typeof doc.exitFullscreen === 'function') {
      await doc.exitFullscreen();
      return true;
    }
    if (typeof doc.webkitExitFullscreen === 'function') {
      await doc.webkitExitFullscreen();
      return true;
    }
    if (typeof doc.mozCancelFullScreen === 'function') {
      await doc.mozCancelFullScreen();
      return true;
    }
    if (typeof doc.msExitFullscreen === 'function') {
      await doc.msExitFullscreen();
      return true;
    }
  } catch {
    // Ignora erro ao sair
  }

  return false;
}

/** Alterna entre tela cheia e modo normal. */
export async function toggleFullscreen(target?: HTMLElement): Promise<boolean> {
  if (isFullscreen()) {
    await exitFullscreen();
    return false;
  }
  await enterFullscreen(target);
  return true;
}

function setPseudoFullscreen(active: boolean): void {
  if (pseudoActive === active) return;
  pseudoActive = active;
  if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('pseudo-fullscreen', active);
    if (active) {
      try {
        window.scrollTo(0, 1);
      } catch {}
    }
  }
  notify();
}

/** Registra um ouvinte para alterações no estado de tela cheia. Retorna função de desinscrição. */
export function onFullscreenChange(callback: (active: boolean) => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

// Configura ouvintes globais de eventos de tela cheia
if (typeof document !== 'undefined') {
  const events = ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'];
  for (const ev of events) {
    document.addEventListener(ev, () => notify());
  }

  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape' && pseudoActive) {
      setPseudoFullscreen(false);
    }
  });
}

const tipClass = (align: TipAlign): string => `tip${align === 'center' ? '' : ` tip-${align}`}`;

/**
 * Cria o botão de tela cheia com alternância visual de ícone (maximizar / minimizar),
 * suporte acessível (`aria-label`) e tooltip (`data-tip`).
 */
export function createFullscreenButton(align: TipAlign = 'end'): HTMLButtonElement {
  let active = isFullscreen();

  const getLabel = (fs: boolean) => (fs ? 'Sair da tela cheia' : 'Tela cheia');
  const getTip = (fs: boolean) => (fs ? 'Sair da tela cheia' : 'Entrar em tela cheia');

  const btn = h(
    'button',
    {
      type: 'button',
      class: `btn btn-icon ${tipClass(align)}`,
      'aria-label': getLabel(active),
      'data-tip': getTip(active),
      onClick: () => {
        void toggleFullscreen();
      },
    },
    icon(active ? 'minimize' : 'maximize'),
  );

  const unsubscribe = onFullscreenChange((fs) => {
    if (!btn.isConnected) {
      unsubscribe();
      return;
    }
    active = fs;
    btn.setAttribute('aria-label', getLabel(active));
    btn.setAttribute('data-tip', getTip(active));
    btn.replaceChildren(icon(active ? 'minimize' : 'maximize'));
  });

  return btn;
}
