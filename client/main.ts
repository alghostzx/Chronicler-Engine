import { mount } from './dom';
import { initTheme } from './theme';
import { setAppShell } from './viewport';
import { renderHome } from './views/home';
import { renderSession } from './views/session';
import { renderVolume } from './views/volume';

const root = document.getElementById('app')!;
let cleanup: (() => void) | null = null;
/** Descarta navegações obsoletas (respostas assíncronas que chegam depois de uma nova rota). */
let navigation = 0;

async function route(): Promise<void> {
  const current = ++navigation;
  cleanup?.();
  cleanup = null;

  // Sessão e leitor de volume são "app shell" (sem rolagem do documento); a biblioteca rola normalmente.
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
  document.title = 'Chronicler Engine';
  await renderHome(root);
}

initTheme();
window.addEventListener('hashchange', () => void route());
route().catch((err) => {
  mount(root, Object.assign(document.createElement('p'), { className: 'p-8 text-hp-low', textContent: `Erro inesperado: ${(err as Error).message}` }));
});
