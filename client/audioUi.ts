import { api, ApiError, type AudioInfo, type Page } from './api';
import { audioPlayer, audioUrl, formatClock, RATES, type TrackMeta } from './audioPlayer';
import { iconButton } from './controls';
import { confirmModal, h, toast } from './dom';
import { icon } from './icons';

/**
 * Controles de narração de UMA página: o botão "Ouvir" do rodapé do cartão e o painel que aparece
 * sobre o rodapé (gerando, erro, ou player). O áudio em si vive em client/audioPlayer.ts; aqui só
 * há estado de interface. `page.audio` é mantido atualizado (mutação) para que reconstruções do
 * Tome não percam o estado.
 */

export const AUDIO_LABELS = {
  listen: 'Ouvir esta página',
  play: 'Tocar',
  pause: 'Pausar',
  regenerate: 'Gerar o áudio de novo',
  remove: 'Apagar o áudio',
  download: 'Baixar o áudio (.mp3)',
  cancel: 'Cancelar a geração do áudio',
  retry: 'Tentar gerar o áudio de novo',
} as const;

/** Páginas cujo player está aberto (sobrevive às reconstruções do Tome). */
const openPanels = new Set<string>();

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
  /** Painel (gerando / erro / player) que fica acima do rodapé; vazio e oculto quando não há o que mostrar. */
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
  const panel = h('div', { class: 'audio-panel hidden', 'data-audio-panel': page.id });

  // Se a página perdeu o áudio (editada, apagada, regenerada) enquanto ele tocava, para.
  if (!page.audio && audioPlayer.state.pageId === page.id) audioPlayer.stop();
  if (page.audio?.status === 'generating') startWatching();

  // --- Ações ---------------------------------------------------------------------------------
  async function generate(): Promise<void> {
    try {
      const r = await api<{ audio: AudioInfo }>('POST', `/api/narrative/pages/${page.id}/audio`);
      if (playingThis()) audioPlayer.pause();
      page.audio = r.audio;
      openPanels.add(page.id);
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
    if (openPanels.has(page.id)) {
      openPanels.delete(page.id);
      if (playingThis()) audioPlayer.pause();
      paint();
    } else {
      openPanels.add(page.id);
      paint();
      await audioPlayer.play(meta());
    }
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
      openPanels.delete(page.id);
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
        if (info?.status === 'ready') toast(`A narração da Página ${page.order_index} ficou pronta.`, 'success');
        else if (info?.status === 'error') toast(info.error ?? 'Não foi possível gerar o áudio.', 'error');
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
    button.removeAttribute('aria-expanded');
    button.removeAttribute('aria-busy');
    let tip: string;
    if (!a) tip = 'Gerar a narração em áudio desta página (usa tokens de voz do Gemini)';
    else if (a.status === 'generating') {
      tip = 'Gerando a narração…';
      button.setAttribute('aria-busy', 'true');
    } else if (a.status === 'error') tip = `A narração falhou: ${a.error ?? 'erro desconhecido'}. Clique para tentar de novo.`;
    else {
      const open = openPanels.has(page.id);
      button.setAttribute('aria-expanded', String(open));
      tip = open ? 'Fechar o player e pausar' : 'Ouvir esta página';
    }
    button.setAttribute('data-tip', tip);
  }

  function paint(): void {
    paintButton();
    const a = page.audio;
    if (a?.status === 'generating') {
      const total = a.total ?? 0;
      const label = a.queued ? 'Na fila para gerar a narração…' : total > 1 ? `Gerando a narração… ${a.done ?? 0}/${total}` : 'Gerando a narração…';
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
    } else if (a?.status === 'ready' && openPanels.has(page.id)) {
      show(player(a));
    } else {
      show(null);
    }
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

  function player(a: AudioInfo): HTMLElement {
    const playBtn = iconButton({ icon: 'play', label: AUDIO_LABELS.play, align: 'start', up: true, onClick: () => void (playingThis() ? audioPlayer.pause() : audioPlayer.play(meta())) }) as HTMLButtonElement;
    const seek = h('input', { type: 'range', class: 'audio-seek', min: '0', max: String((a.duration_ms ?? 0) / 1000 || 1), step: '0.1', value: '0', 'aria-label': 'Posição do áudio' });
    const time = h('span', { class: 'audio-time', 'aria-hidden': 'true' }, '0:00');
    const rateBtn = h('button', { type: 'button', class: 'btn audio-rate tip tip-up', 'data-tip': 'Velocidade de reprodução' });
    let dragging = false;

    const sync = (): boolean => {
      if (!panel.isConnected || !panel.contains(playBtn)) return false;
      const s = audioPlayer.state;
      const mine = s.pageId === page.id;
      const duration = mine && s.duration > 0 ? s.duration : (a.duration_ms ?? 0) / 1000;
      const current = mine ? s.time : 0;
      const playing = mine && s.playing;
      seek.max = String(duration || 1);
      if (!dragging) seek.value = String(current);
      seek.setAttribute('aria-valuetext', `${formatClock(current)} de ${formatClock(duration)}`);
      time.textContent = `${formatClock(current)} / ${formatClock(duration)}`;
      playBtn.replaceChildren(icon(playing ? 'pause' : 'play'));
      playBtn.setAttribute('aria-label', playing ? AUDIO_LABELS.pause : AUDIO_LABELS.play);
      playBtn.setAttribute('data-tip', playing ? AUDIO_LABELS.pause : AUDIO_LABELS.play);
      playBtn.setAttribute('aria-pressed', String(playing));
      const r = audioPlayer.rate;
      rateBtn.textContent = `${r}×`;
      rateBtn.setAttribute('aria-label', `Velocidade de reprodução: ${r}×. Clique para mudar.`);
      button.classList.toggle('is-playing', playing);
      return true;
    };
    const unsubscribe = audioPlayer.subscribe(() => {
      if (!sync()) unsubscribe();
    });

    seek.addEventListener('input', () => {
      dragging = true;
      time.textContent = `${formatClock(Number(seek.value))} / ${formatClock(Number(seek.max))}`;
    });
    seek.addEventListener('change', () => {
      dragging = false;
      audioPlayer.select(meta());
      audioPlayer.seek(Number(seek.value));
    });
    rateBtn.addEventListener('click', () => {
      const i = RATES.indexOf(audioPlayer.rate as (typeof RATES)[number]);
      audioPlayer.setRate(RATES[(i + 1) % RATES.length]!);
    });

    const download = iconButton({ icon: 'download', label: AUDIO_LABELS.download, tip: `Baixar o MP3 (${sizeLabel(a.bytes ?? 0)})`, align: 'end', up: true, href: audioUrl(page.id, undefined, true) });
    download.setAttribute('download', '');

    const el = h(
      'div',
      { class: 'audio-player', role: 'group', 'aria-label': `Player da página ${page.order_index}` },
      playBtn,
      seek,
      time,
      h(
        'div',
        { class: 'audio-tools' },
        rateBtn,
        iconButton({ icon: 'refresh', label: AUDIO_LABELS.regenerate, tip: `${AUDIO_LABELS.regenerate} (substitui este áudio; usa tokens de voz)`, align: 'end', up: true, onClick: () => void regenerate() }),
        iconButton({ icon: 'trash', label: AUDIO_LABELS.remove, align: 'end', up: true, onClick: () => void remove() }),
        download,
      ),
      a.error ? h('p', { class: 'audio-note' }, `A última tentativa de gerar de novo falhou: ${a.error}. Este é o áudio anterior.`) : null,
    );
    queueMicrotask(() => sync());
    return el;
  }

  paint();
  return { button, panel };
}
