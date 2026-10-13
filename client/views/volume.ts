import { api, type Archive, type Page, type SessionDetail } from '../api';
import { audioPlayer } from '../audioPlayer';
import { createModeControl, fullscreenButton, iconButton } from '../controls';
import { h, mount, paragraphs } from '../dom';
import { pageCard } from '../pageCard';
import { createPlayerBar } from '../playerBar';
import { applyTheme } from '../theme';
import { openVolumeExport } from './volumeExport';

/**
 * Leitor de volume (rota `#/s/<id>/v/<n>`): as páginas que a compactação consumiu, em somente
 * leitura. Elas já não fazem parte do contexto da IA, mas o jogador pode relê-las e exportá-las.
 */
export async function renderVolume(root: HTMLElement, sessionId: string, volumeNumber: number): Promise<() => void> {
  mount(root, h('p', { class: 'p-8 text-center text-muted' }, 'Abrindo o volume…'));

  const back = (text = 'Voltar ao Tome') => h('a', { href: `#/s/${sessionId}`, class: 'btn mt-4' }, text);
  const fail = (message: string) =>
    mount(root, h('div', { class: 'p-8 text-center' }, h('p', { class: 'text-hp-low' }, message), back()));

  let detail: SessionDetail;
  let archive: Archive | undefined;
  let pages: Page[];
  try {
    detail = await api<SessionDetail>('GET', `/api/sessions/${sessionId}`);
    archive = detail.archives.find((a) => a.volume_number === volumeNumber);
    if (!archive) {
      fail(`O Volume ${volumeNumber} não existe nesta crônica.`);
      return () => {};
    }
    pages = (await api<{ pages: Page[] }>('GET', `/api/archives/${archive.id}/pages`)).pages;
  } catch (err) {
    fail((err as Error).message);
    return () => {};
  }

  const title = detail.session.title;
  applyTheme(detail.session.active_theme);
  document.title = `Volume ${archive.volume_number} — ${title} — Chronicler Engine`;

  const neighbour = (n: number, label: string) =>
    detail.archives.some((a) => a.volume_number === n) ? h('a', { href: `#/s/${sessionId}/v/${n}`, class: 'btn' }, label) : null;

  const pageCount = pages.length;
  // Player das páginas do volume: barra fixa no rodapé da tela (uma página por vez, sem modo contínuo).
  const bar = createPlayerBar({ title: () => title });
  mount(
    root,
    h(
      'div',
      { class: 'app-screen' },
      h(
        'header',
        { class: 'flex shrink-0 items-center gap-1.5 border-b border-line bg-panel px-3 py-2 sm:gap-2' },
        iconButton({ icon: 'back', label: 'Voltar ao Tome', tip: 'Voltar ao Tome da crônica', align: 'start', href: `#/s/${sessionId}` }),
        h('h1', { class: 'min-w-0 flex-1 truncate font-display text-lg text-strong' }, `${title} — Volume ${archive.volume_number}`),
        createModeControl(),
        fullscreenButton(),
        iconButton({ icon: 'download', label: 'Salvar volume em Markdown', tip: `Salvar o Volume ${archive.volume_number} como arquivo Markdown (.md)`, align: 'end', onClick: () => openVolumeExport(archive!) }),
      ),
      h(
        'main',
        { class: 'min-w-0 flex-1 overflow-y-auto', id: 'volume-scroll' },
        h(
          'article',
          { class: 'mx-auto max-w-3xl space-y-6 px-3 py-6 font-reading text-lg text-ink sm:px-5 sm:py-8' },
          h(
            'section',
            { class: 'card font-sans text-sm leading-6', 'aria-label': 'Sinopse do volume' },
            h('h2', { class: 'mb-2 font-display text-xs uppercase tracking-widest text-muted' }, `Volume ${archive.volume_number} — páginas ${archive.covered_page_start_index} a ${archive.covered_page_end_index} · sinopse`),
            ...paragraphs(archive.summary_text).map((p) => h('p', { class: 'mb-2 last:mb-0' }, p)),
            h('p', { class: 'mt-3 text-xs text-muted' }, `Somente leitura. Estas ${pageCount} páginas já foram resumidas na crônica e não fazem mais parte do contexto da IA.`),
          ),
          ...pages.map((p) => pageCard({ page: p, readonly: true, sessionTitle: title, dropCap: p.order_index === 1 })),
          h('nav', { class: 'flex flex-wrap items-center justify-between gap-2 pb-4', 'aria-label': 'Navegação entre volumes' }, neighbour(volumeNumber - 1, '← Volume anterior') ?? h('span', null), back('Voltar ao Tome'), neighbour(volumeNumber + 1, 'Próximo volume →') ?? h('span', null)),
        ),
      ),
      bar.el,
    ),
  );

  return () => {
    bar.dispose();
    audioPlayer.stop();
    document.title = 'Chronicler Engine';
  };
}
