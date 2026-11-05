import { api, ApiError, type Archive, type Page, type SessionDetail } from '../api';
import { audioPlayer } from '../audioPlayer';
import { setQuietReadyToasts } from '../audioUi';
import { ContinuousPlayback, type EndInfo, type StatusPage } from '../continuousPlayback';
import { askGenerate } from '../continuousUi';
import { createModeControl, fullscreenButton, iconButton } from '../controls';
import { h, mount, paragraphs, toast } from '../dom';
import { icon } from '../icons';
import { pageCard } from '../pageCard';
import { createPlayerBar } from '../playerBar';
import { applyTheme } from '../theme';
import { openVolumeExport } from './volumeExport';

/**
 * Leitor de volume (rota `#/s/<id>/v/<n>` ou `#/s/<id>/v/<n>?p=<pageIndex>`): as páginas que a compactação
 * consumiu, em somente leitura. Elas já não fazem parte do contexto da IA, mas o jogador pode relê-las,
 * ouvi-las (inclusive em reprodução contínua) e exportá-las.
 */
export async function renderVolume(
  root: HTMLElement,
  sessionId: string,
  volumeNumber: number,
  targetPageIndex?: number,
): Promise<() => void> {
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

  let disposed = false;
  const title = detail.session.title;
  applyTheme(detail.session.active_theme);
  document.title = `Volume ${archive.volume_number} — ${title} — Chronicler Engine`;

  const neighbour = (n: number, label: string) =>
    detail.archives.some((a) => a.volume_number === n) ? h('a', { href: `#/s/${sessionId}/v/${n}`, class: 'btn' }, label) : null;

  const pageCount = pages.length;
  const volumeScroll = h('main', { class: 'min-w-0 flex-1 overflow-y-auto', id: 'volume-scroll' });
  const volumeArticle = h('article', { class: 'mx-auto max-w-3xl space-y-6 px-3 py-6 font-reading text-lg text-ink sm:px-5 sm:py-8' });
  volumeScroll.appendChild(volumeArticle);

  const toStatusPages = (list: Page[]): StatusPage[] =>
    list.map((p) => ({ page_id: p.id, order_index: p.order_index, kind: p.kind, audio: p.audio ?? null }));

  const fetchStatus = async (): Promise<StatusPage[]> => {
    const res = await api<{ pages: Page[] }>('GET', `/api/archives/${archive!.id}/pages`);
    pages = res.pages;
    return toStatusPages(pages);
  };

  function syncAudio(statusPages: StatusPage[]): void {
    const byId = new Map(statusPages.map((p) => [p.page_id, p.audio]));
    for (const p of pages) if (byId.has(p.id)) p.audio = byId.get(p.id) ?? null;
  }

  function continuousEnded(info: EndInfo): void {
    if (disposed) return;
    if (info.kind === 'finished') toast('Reprodução contínua concluída.', 'success');
    else if (info.kind === 'blocked') {
      if (info.reason === 'error') toast(`Parei na Página ${info.page}: a geração do áudio falhou${info.message ? ` (${info.message})` : ''}.`, 'error');
      else toast(`Parei na Página ${info.page}: ela não tem áudio.`, 'info');
    } else if (info.kind === 'failed') toast(`Reprodução contínua interrompida na Página ${info.page}: o áudio não pôde ser reproduzido.`, 'error');
  }

  const continuous = new ContinuousPlayback(audioPlayer, {
    fetchStatus,
    track: (p) => ({
      pageId: p.page_id,
      version: p.audio?.created_at ?? '',
      title: `Página ${p.order_index}`,
      artist: title,
      durationMs: p.audio?.duration_ms,
    }),
    onPageChange: (id) => {
      if (disposed) return;
      renderArticle();
      const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
      volumeScroll.querySelector(`[data-page-id="${id}"]`)?.scrollIntoView?.({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
    },
    onStatus: (statusPages) => syncAudio(statusPages),
    onEnd: (info) => {
      setQuietReadyToasts(false);
      if (info.kind === 'finished' || info.kind === 'blocked' || info.kind === 'failed') audioPlayer.stop();
      continuousEnded(info);
    },
  });

  const bar = createPlayerBar({
    continuous,
    title: () => title,
    onStopContinuous: () => {
      continuous.stop();
      audioPlayer.stop();
    },
  });

  async function playFromHere(b: Page): Promise<void> {
    let statusPages: StatusPage[];
    try {
      statusPages = await fetchStatus();
    } catch (err) {
      toast((err as Error).message, 'error');
      return;
    }
    syncAudio(statusPages);
    const range = statusPages.filter((p) => p.order_index >= b.order_index);
    const missing = range.filter((p) => !p.audio || p.audio.status === 'error');
    const generating = range.filter((p) => p.audio?.status === 'generating').length;
    let mode: 'all' | 'ready-prefix' = 'all';
    if (missing.length > 0) {
      const choice = await askGenerate({ missing: missing.map((p) => p.order_index), generating });
      if (!choice || disposed) return;
      if (choice === 'ready') mode = 'ready-prefix';
      else {
        try {
          const res = await api<{ pages: StatusPage[] }>('POST', `/api/archives/${archive!.id}/audio/batch`, { from_page_id: b.id });
          setQuietReadyToasts(true);
          statusPages = res.pages;
        } catch (err) {
          const e = err as ApiError;
          toast(e.code === 'missing_api_key' ? 'Configure a chave da API em “Opções”, no menu inicial, para gerar o áudio.' : e.message, 'error');
          return;
        }
        syncAudio(statusPages);
        renderArticle();
      }
    }
    if (disposed) return;
    if (!continuous.start({ pages: statusPages, fromPageId: b.id, mode }).ok) {
      setQuietReadyToasts(false);
      toast(`A Página ${b.order_index} ainda não tem áudio: não há o que reproduzir.`, 'info');
    }
  }

  function renderArticle(): void {
    mount(
      volumeArticle,
      h(
        'section',
        { class: 'card font-sans text-sm leading-6', 'aria-label': 'Sinopse do volume' },
        h('h2', { class: 'mb-2 font-display text-xs uppercase tracking-widest text-muted' }, `Volume ${archive!.volume_number} — páginas ${archive!.covered_page_start_index} a ${archive!.covered_page_end_index} · sinopse`),
        ...paragraphs(archive!.summary_text).map((p) => h('p', { class: 'mb-2 last:mb-0' }, p)),
        h('p', { class: 'mt-3 text-xs text-muted' }, `Somente leitura. Estas ${pageCount} páginas já foram resumidas na crônica e não fazem mais parte do contexto da IA.`),
        pages.length > 0
          ? h(
              'div',
              { class: 'mt-3 flex items-center gap-2' },
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn',
                  'aria-label': 'Ouvir volume em sequência',
                  onClick: () => void playFromHere(pages[0]!),
                },
                icon('playFrom', 16),
                h('span', null, 'Ouvir volume'),
              ),
            )
          : null,
      ),
      ...pages.map((p) =>
        pageCard({
          page: p,
          readonly: true,
          sessionTitle: title,
          dropCap: p.order_index === 1,
          laterCount: pages.filter((x) => x.order_index > p.order_index).length,
          onPlayFromHere: () => void playFromHere(p),
        }),
      ),
      h(
        'nav',
        { class: 'flex flex-wrap items-center justify-between gap-2 pb-4', 'aria-label': 'Navegação entre volumes' },
        neighbour(volumeNumber - 1, '← Volume anterior') ?? h('span', null),
        back('Voltar ao Tome'),
        neighbour(volumeNumber + 1, 'Próximo volume →') ?? h('span', null),
      ),
    );
  }

  renderArticle();
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
      volumeScroll,
      bar.el,
    ),
  );

  if (targetPageIndex !== undefined) {
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    root.querySelector<HTMLElement>(`section.page-card[data-page-index="${targetPageIndex}"]`)?.scrollIntoView?.({
      block: 'start',
      behavior: reduce ? 'auto' : 'smooth',
    });
  }

  return () => {
    disposed = true;
    continuous.dispose();
    bar.dispose();
    setQuietReadyToasts(false);
    audioPlayer.stop();
    document.title = 'Chronicler Engine';
  };
}
