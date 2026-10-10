/**
 * Ajuste de viewport para celulares (telas da sessão e do leitor de volume).
 *
 * A tela é um "app shell" (`html.app-shell` + `.app-screen`): o cabeçalho fica no topo, a doca de
 * digitação embaixo e só a região das páginas rola. Para isso a altura da tela deve ser a da área
 * realmente visível, que muda com a barra de endereço do navegador e com o teclado virtual:
 *
 *  - Chrome/Android: a meta `viewport` pede `interactive-widget=resizes-content` e o CSS usa `100dvh`;
 *    o layout já se redimensiona sozinho.
 *  - iOS/Safari e navegadores que só encolhem a "janela visual" (e rolam o documento para mostrar o
 *    campo focado): `window.visualViewport` informa a altura útil, aplicada em `--app-height`, e o
 *    deslocamento de rolagem do documento é zerado para o cabeçalho não sair de vista.
 */

const SHELL_CLASS = 'app-shell';
const HEIGHT_VAR = '--app-height';

let attached = false;

function apply(): void {
  const root = document.documentElement;
  if (!root.classList.contains(SHELL_CLASS)) return;
  const vv = window.visualViewport;
  if (!vv) return;
  // Com zoom por pinça a janela visual é menor que a tela de propósito: não mexe na altura.
  if (Math.abs(vv.scale - 1) > 0.01) return;
  root.style.setProperty(HEIGHT_VAR, `${Math.round(vv.height)}px`);
  // O navegador pode ter rolado o documento (para mostrar o campo focado): volta ao topo.
  if (window.scrollY !== 0 || vv.offsetTop !== 0) window.scrollTo(0, 0);
}

function attach(): void {
  if (attached) return;
  attached = true;
  const vv = window.visualViewport;
  if (!vv) return;
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  window.addEventListener('orientationchange', apply);
}

/** Liga ou desliga o modo "app shell" na raiz `<html>` (chamado pelo roteador a cada rota). */
export function setAppShell(on: boolean): void {
  const root = document.documentElement;
  root.classList.toggle(SHELL_CLASS, on);
  if (on) {
    attach();
    apply();
  } else {
    root.style.removeProperty(HEIGHT_VAR);
  }
}
