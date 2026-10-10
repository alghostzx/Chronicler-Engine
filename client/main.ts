import { mount } from './dom';
import { initTheme } from './theme';
import { setAppShell } from './viewport';
import { renderOptions } from './views/options';
import { renderSession } from './views/session';
import { renderTitle, type TitleHandle, type TitleView } from './views/title';
import { renderVolume } from './views/volume';

const root = document.getElementById('app')!;
let cleanup: (() => void) | null = null;
/** Tela de título montada (as rotas #/, #/continuar e #/nova só trocam o quadro, sem recarregar). */
let title: TitleHandle | null = null;
/** Descarta navegações obsoletas (respostas assíncronas que chegam depois de uma nova rota). */
let navigation = 0;

/** Rotas da tela de título: `#/` (menu), `#/continuar` e `#/nova` (quadros sobre o menu). */
function titleView(hash: string): TitleView | null {
  if (hash === '' || hash === '#' || hash === '#/') return 'menu';
  if (hash === '#/continuar') return 'continuar';
  if (hash === '#/nova') return 'nova';
  return null;
}

async function route(): Promise<void> {
  const current = ++navigation;
  const view = titleView(location.hash);

  // Trocar de quadro dentro da tela de título não recria a tela.
  if (view && title) {
    title.show(view);
    return;
  }
  cleanup?.();
  cleanup = null;
  title?.dispose();
  title = null;

  // Sessão e leitor de volume são "app shell" (sem rolagem do documento); o resto rola normalmente.
  setAppShell(/^#\/s\/[^/]+(\/v\/\d+)?$/.test(location.hash));

  const volume = /^#\/s\/([^/]+)\/v\/(\d+)$/.exec(location.hash);
  if (volume) {
    const dispose = await renderVolume(root, decodeURIComponent(volume[1]!), Number(volume[2]));
    if (current !== navigation) dispose();
    else cleanup = dispose;
    return;
  }
  const match = /^#\/s\/([^/]+)$/.exec(location.hash);
  if (match) {
    const dispose = await renderSession(root, decodeURIComponent(match[1]!));
    if (current !== navigation) dispose();
    else cleanup = dispose;
    return;
  }
  if (location.hash === '#/opcoes') {
    await renderOptions(root);
    return;
  }
  const handle = await renderTitle(root, view ?? 'menu');
  if (current !== navigation) handle.dispose();
  else title = handle;
}

initTheme();
window.addEventListener('hashchange', () => void route());
route().catch((err) => {
  mount(root, Object.assign(document.createElement('p'), { className: 'p-8 text-hp-low', textContent: `Erro inesperado: ${(err as Error).message}` }));
});
