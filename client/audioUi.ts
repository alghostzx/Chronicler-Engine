import { api, ApiError, type AudioInfo, type Page } from './api';
import { audioPlayer, audioUrl, type TrackMeta } from './audioPlayer';
import { createActionMenu, iconButton, type ActionMenu } from './controls';
import { confirmModal, h, toast } from './dom';
import { icon } from './icons';

/**
 * Controles de narração de UMA página: o botão "Ouvir" do rodapé do cartão, o menu de opções do
 * áudio (baixar, gerar de novo, apagar) e o painel que aparece sobre o rodapé (só gerando ou erro).
 * O player em si (tocar/pausar, posição, velocidade) vive na barra fixa de client/playerBar.ts; o
 * áudio, em client/audioPlayer.ts. `page.audio` é mantido atualizado (mutação) para que
 * reconstruções do Tome não percam o estado.
 */

export const AUDIO_LABELS = {
  listen: 'Ouvir esta página',
  play: 'Tocar',
  pause: 'Pausar',
  options: 'Opções do áudio',
  regenerate: 'Gerar o áudio de novo',
  remove: 'Apagar o áudio',
  download: 'Baixar o áudio (.mp3)',
  cancel: 'Cancelar a geração do áudio',
  retry: 'Tentar gerar o áudio de novo',
} as const;

/** Durante a geração em lote da reprodução contínua, o aviso "ficou pronta" de cada página seria só ruído. */
let quietReady = false;
export function setQuietReadyToasts(quiet: boolean): void {
  quietReady = quiet;
}

let pollMs = 1500;
/** Intervalo de consulta do progresso (testes usam valores curtos). */
export function setAudioPollInterval(ms: number): void {
  pollMs = ms;
}

// --- Acompanhamento do progresso (uma consulta por página, compartilhada) ---------------------
type Listener = (info: AudioInfo | null) => boolean; // devolve false quando o controle saiu da tela
const watchers = new Map<string, { timer: ReturnType<typeof setTimeout> | undefined; listeners: Set<Listener> }>();

function watch(pageId: string, listener: Listener): void {
  let w = watchers.get(pageId);
  if (w) {
    w.listeners.add(listener);
    return;
  }
  w = { timer: undefined, listeners: new Set([listener]) };
  watchers.set(pageId, w);
  const entry = w;
  const tick = async (): Promise<void> => {
    let info: AudioInfo | null | undefined;
    try {
      info = (await api<{ audio: AudioInfo | null }>('GET', `/api/narrative/pages/${pageId}/audio/status`)).audio;
    } catch (err) {
      // Página sumiu: encerra. Falha de rede é transitória: tenta de novo no próximo ciclo.
      if (err instanceof ApiError && err.status === 404) info = null;
    }
    if (info !== undefined) {
      for (const l of [...entry.listeners]) if (!l(info)) entry.listeners.delete(l);
    }
    const stillGenerating = info === undefined || info?.status === 'generating';
    if (entry.listeners.size === 0 || !stillGenerating) {
      watchers.delete(pageId);
      return;
    }
    entry.timer = setTimeout(() => void tick(), pollMs);
  };
  entry.timer = setTimeout(() => void tick(), pollMs);
}

const sizeLabel = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

export interface AudioControls {
  /** Botão "Ouvir" do rodapé do cartão. */
  button: HTMLButtonElement;
  /** Menu "Opções do áudio" (baixar, gerar de novo, apagar); oculto enquanto não há áudio pronto. */
  menu: ActionMenu;
  /** Painel (gerando / erro) que fica acima do rodapé; vazio e oculto quando não há o que mostrar. */
  panel: HTMLElement;
}

export function audioControls(page: Page, opts: { sessionTitle: string }): AudioControls {
  const meta = (): TrackMeta => ({
    pageId: page.id,
    version: page.audio?.created_at ?? '',
    title: `Página ${page.order_index}`,
    artist: opts.sessionTitle,
    durationMs: page.audio?.duration_ms,
  });
  const playingThis = (): boolean => audioPlayer.state.pageId === page.id && audioPlayer.state.playing;

  const button = iconButton({
    icon: 'volume',
    label: AUDIO_LABELS.listen,
    align: 'start',
    up: true,
    extraClass: 'page-action page-action-listen',
    onClick: () => void onListen(),
  }) as HTMLButtonElement;
  const menu = createActionMenu({ label: AUDIO_LABELS.options, items: [], align: 'start', up: true });
  const panel = h('div', { class: 'audio-panel hidden', 'data-audio-panel': page.id });

  // Se a página perdeu o áudio (editada, apagada, regenerada) enquanto ele tocava, para.
  if (!page.audio && audioPlayer.state.pageId === page.id) audioPlayer.stop();
  if (page.audio?.status === 'generating') startWatching();
  // Repinta o botão quando o player (barra) toca/pausa esta página; solta o ouvinte quando o cartão sai da tela.
  let attached = false;
  const unsubscribe = audioPlayer.subscribe(() => {
    if (button.isConnected) {
      attached = true;
      paintButton();
    } else if (attached) unsubscribe();
  });

  // --- Ações ---------------------------------------------------------------------------------
  async function generate(): Promise<void> {
    try {
      const r = await api<{ audio: AudioInfo }>('POST', `/api/narrative/pages/${page.id}/audio`);
      if (playingThis()) audioPlayer.pause();
      page.audio = r.audio;
      paint();
      startWatching();
    } catch (err) {
      const e = err as ApiError;
      toast(e.code === 'missing_api_key' ? 'Configure a chave da API em “Opções”, no menu inicial, para gerar o áudio.' : e.message, 'error');
    }
  }

  async function onListen(): Promise<void> {
    const a = page.audio;
    if (!a || a.status === 'error') return generate();
    if (a.status === 'generating') return;
    if (playingThis()) audioPlayer.pause();
    else await audioPlayer.play(meta());
  }

  async function regenerate(): Promise<void> {
    const ok = await confirmModal(
      'Gerar o áudio de novo',
      'Uma nova narração será gerada e, quando ficar pronta, substituirá a atual (que é descartada). Isso consome tokens de voz da API do Gemini.',
      { confirmLabel: 'Gerar de novo' },
    );
    if (ok) await generate();
  }

  async function remove(): Promise<void> {
    const ok = await confirmModal('Apagar o áudio', 'Apagar a narração desta página? O texto não é alterado; para ouvir de novo será preciso gerar o áudio outra vez.', {
      danger: true,
      confirmLabel: 'Apagar',
    });
    if (!ok) return;
    try {
      await api('DELETE', `/api/narrative/pages/${page.id}/audio`);
      if (audioPlayer.state.pageId === page.id) audioPlayer.stop();
      page.audio = null;
      paint();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  async function cancel(): Promise<void> {
    try {
      const r = await api<{ audio: AudioInfo | null }>('POST', `/api/narrative/pages/${page.id}/audio/cancel`);
      page.audio = r.audio;
      paint();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  function startWatching(): void {
    let wasGenerating = true;
    watch(page.id, (info) => {
      if (!button.isConnected && !panel.isConnected) return false;
      const done = wasGenerating && info?.status !== 'generating';
      page.audio = info;
      paint();
      if (done) {
        wasGenerating = false;
        if (info?.status === 'ready') {
          if (!quietReady) toast(`A narração da Página ${page.order_index} ficou pronta.`, 'success');
        } else if (info?.status === 'error') toast(info.error ?? 'Não foi possível gerar o áudio.', 'error');
      }
      return true;
    });
  }

  // --- Desenho -------------------------------------------------------------------------------
  function paintButton(): void {
    const a = page.audio;
    button.disabled = a?.status === 'generating';
    button.classList.toggle('is-busy', a?.status === 'generating');
    button.classList.toggle('is-playing', playingThis());
    button.removeAttribute('aria-pressed');
    button.removeAttribute('aria-busy');
    let tip: string;
    if (!a) tip = 'Gerar a narração em áudio desta página (usa tokens de voz do Gemini)';
    else if (a.status === 'generating') {
      tip = 'Gerando a narração…';
      button.setAttribute('aria-busy', 'true');
    } else if (a.status === 'error') tip = `A narração falhou: ${a.error ?? 'erro desconhecido'}. Clique para tentar de novo.`;
    else {
      button.setAttribute('aria-pressed', String(playingThis()));
      tip = playingThis() ? 'Pausar esta página' : 'Ouvir esta página';
    }
    button.setAttribute('data-tip', tip);
  }

  function paint(): void {
    paintButton();
    const a = page.audio;
    if (a?.status === 'generating') {
      const total = a.total ?? 0;
      const progress = total > 1 ? ` ${a.done ?? 0}/${total}` : '';
      const label = a.queued
        ? 'Na fila para gerar a narração…'
        : a.throttled
          ? `Aguardando o limite da API${a.wait_ms ? ` (cerca de ${Math.max(1, Math.round(a.wait_ms / 1000))} s)` : ''}…${progress}`
          : `Gerando a narração…${progress}`;
      const pct = total > 0 ? Math.round(((a.done ?? 0) / total) * 100) : 0;
      show(
        h(
          'div',
          { class: 'audio-status', role: 'status' },
          spinner(),
          h('span', { class: 'audio-status-text' }, label),
          h('div', { class: 'audio-progress', 'aria-hidden': 'true' }, h('div', { class: 'audio-progress-bar', style: `width:${pct}%` })),
          iconButton({ icon: 'close', label: AUDIO_LABELS.cancel, align: 'end', up: true, onClick: () => void cancel() }),
        ),
      );
    } else if (a?.status === 'error') {
      show(
        h(
          'div',
          { class: 'audio-status audio-error', role: 'alert' },
          h('span', { class: 'audio-status-text' }, `Não foi possível gerar a narração: ${a.error ?? 'erro desconhecido'}`),
          iconButton({ icon: 'refresh', label: AUDIO_LABELS.retry, align: 'end', up: true, onClick: () => void generate() }),
        ),
      );
    } else if (a?.status === 'ready' && a.error) {
      show(h('p', { class: 'audio-note', role: 'status' }, `A última tentativa de gerar de novo falhou: ${a.error}. Esta é a narração anterior.`));
    } else {
      show(null);
    }
    paintMenu();
  }

  function paintMenu(): void {
    const a = page.audio;
    menu.setHidden(a?.status !== 'ready');
    if (a?.status !== 'ready') return;
    menu.button.setAttribute('data-tip', `${AUDIO_LABELS.options} (${sizeLabel(a.bytes ?? 0)})`);
    menu.setItems([
      { label: AUDIO_LABELS.download, icon: 'download', href: audioUrl(page.id, undefined, true) },
      { label: AUDIO_LABELS.regenerate, icon: 'refresh', onSelect: () => void regenerate() },
      { label: AUDIO_LABELS.remove, icon: 'trash', danger: true, onSelect: () => void remove() },
    ]);
  }

  function show(content: HTMLElement | null): void {
    panel.replaceChildren(...(content ? [content] : []));
    panel.classList.toggle('hidden', !content);
  }

  function spinner(): SVGSVGElement {
    const s = icon('loader', 16);
    s.classList.add('audio-spin');
    return s;
  }

  paint();
  return { button, menu, panel };
}
