// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFullscreenButton,
  enterFullscreen,
  exitFullscreen,
  isFullscreen,
  isNativeFullscreenSupported,
  onFullscreenChange,
  toggleFullscreen,
} from '../client/fullscreen';

describe('client/fullscreen', () => {
  beforeEach(async () => {
    // Garante que o estado seja limpo entre testes
    window.scrollTo = vi.fn();
    await exitFullscreen();
    document.documentElement.className = '';
  });

  it('inicia fora de tela cheia', () => {
    expect(isFullscreen()).toBe(false);
  });

  it('ativa e desativa o modo pseudo-tela cheia quando a API nativa não existe (jsdom/iOS Safari)', async () => {
    const unsub = onFullscreenChange(() => {});
    try {
      expect(isFullscreen()).toBe(false);
      expect(document.documentElement.classList.contains('pseudo-fullscreen')).toBe(false);

      const entered = await enterFullscreen();
      expect(entered).toBe(true);
      expect(isFullscreen()).toBe(true);
      expect(document.documentElement.classList.contains('pseudo-fullscreen')).toBe(true);

      const exited = await exitFullscreen();
      expect(exited).toBe(true);
      expect(isFullscreen()).toBe(false);
      expect(document.documentElement.classList.contains('pseudo-fullscreen')).toBe(false);
    } finally {
      unsub();
    }
  });

  it('toggleFullscreen alterna entre ativo e inativo', async () => {
    expect(isFullscreen()).toBe(false);
    await toggleFullscreen();
    expect(isFullscreen()).toBe(true);
    await toggleFullscreen();
    expect(isFullscreen()).toBe(false);
  });

  it('notifica ouvintes quando o estado de tela cheia muda', async () => {
    const states: boolean[] = [];
    const unsubscribe = onFullscreenChange((active) => {
      states.push(active);
    });

    await enterFullscreen();
    await exitFullscreen();
    unsubscribe();

    await enterFullscreen(); // não deve mais registrar após unsubscribe
    expect(states).toEqual([true, false]);
  });

  it('usa a API nativa requestFullscreen quando disponível', async () => {
    let nativeCalled = false;
    let nativeExited = false;

    const originalRequest = document.documentElement.requestFullscreen;
    const originalExit = document.exitFullscreen;

    (document.documentElement as unknown as { requestFullscreen: () => Promise<void> }).requestFullscreen = async () => {
      nativeCalled = true;
      Object.defineProperty(document, 'fullscreenElement', {
        configurable: true,
        get: () => document.documentElement,
      });
      document.dispatchEvent(new Event('fullscreenchange'));
    };

    (document as unknown as { exitFullscreen: () => Promise<void> }).exitFullscreen = async () => {
      nativeExited = true;
      Object.defineProperty(document, 'fullscreenElement', {
        configurable: true,
        get: () => null,
      });
      document.dispatchEvent(new Event('fullscreenchange'));
    };

    try {
      expect(isNativeFullscreenSupported()).toBe(true);
      await enterFullscreen();
      expect(nativeCalled).toBe(true);
      expect(isFullscreen()).toBe(true);

      await exitFullscreen();
      expect(nativeExited).toBe(true);
      expect(isFullscreen()).toBe(false);
    } finally {
      document.documentElement.requestFullscreen = originalRequest;
      document.exitFullscreen = originalExit;
      Object.defineProperty(document, 'fullscreenElement', {
        configurable: true,
        get: () => null,
      });
    }
  });

  it('createFullscreenButton renderiza botão com ícone, acessibilidade e responde ao clique', async () => {
    const btn = createFullscreenButton('end');
    document.body.appendChild(btn);

    expect(btn.getAttribute('aria-label')).toBe('Tela cheia');
    expect(btn.getAttribute('data-tip')).toBe('Entrar em tela cheia');
    expect(btn.querySelector('svg')).not.toBeNull();

    // Clica para entrar em tela cheia
    btn.click();
    await new Promise((r) => setTimeout(r, 10));

    expect(btn.getAttribute('aria-label')).toBe('Sair da tela cheia');
    expect(btn.getAttribute('data-tip')).toBe('Sair da tela cheia');
    expect(isFullscreen()).toBe(true);

    // Clica para sair
    btn.click();
    await new Promise((r) => setTimeout(r, 10));

    expect(btn.getAttribute('aria-label')).toBe('Tela cheia');
    expect(btn.getAttribute('data-tip')).toBe('Entrar em tela cheia');
    expect(isFullscreen()).toBe(false);

    btn.remove();
  });

  it('tecla Escape cancela o modo pseudo-tela cheia e atualiza o botão', async () => {
    const btn = createFullscreenButton();
    document.body.appendChild(btn);

    btn.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(isFullscreen()).toBe(true);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await new Promise((r) => setTimeout(r, 10));

    expect(isFullscreen()).toBe(false);
    expect(btn.getAttribute('aria-label')).toBe('Tela cheia');

    btn.remove();
  });
});
