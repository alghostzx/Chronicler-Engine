import { toast } from './dom';

/**
 * Reprodutor único de narrações: um só `<audio>` para o app inteiro, de modo que tocar uma página
 * pausa a que estava tocando. Os controles de cada página (client/audioUi.ts) apenas refletem
 * este estado e não guardam áudio nenhum.
 */

export const RATES = [0.75, 1, 1.25, 1.5] as const;
const RATE_KEY = 'chronicler.audioRate';

export interface TrackMeta {
  pageId: string;
  /** Muda quando o áudio é gerado de novo (evita cache do navegador). */
  version: string;
  title: string;
  artist: string;
  /** Duração conhecida pelo servidor, usada até o navegador ler os metadados do MP3. */
  durationMs?: number;
}

export interface PlayerState {
  pageId: string | null;
  playing: boolean;
  time: number;
  duration: number;
}

export const audioUrl = (pageId: string, version?: string, download = false): string =>
  `/api/narrative/pages/${pageId}/audio${download ? '?download=true' : version ? `?v=${encodeURIComponent(version)}` : ''}`;

function savedRate(): number {
  try {
    const n = Number(localStorage.getItem(RATE_KEY));
    return (RATES as readonly number[]).includes(n) ? n : 1;
  } catch {
    return 1;
  }
}

class AudioPlayer {
  private readonly el = new Audio();
  private readonly listeners = new Set<() => void>();
  private fallbackDuration = 0;
  private track: TrackMeta | null = null;
  rate = savedRate();

  constructor() {
    this.el.preload = 'metadata';
    this.el.playbackRate = this.rate;
    for (const ev of ['timeupdate', 'play', 'pause', 'ended', 'loadedmetadata', 'durationchange', 'seeked']) {
      this.el.addEventListener(ev, () => this.emit());
    }
    this.el.addEventListener('ended', () => {
      this.el.currentTime = 0;
      this.emit();
    });
    this.el.addEventListener('error', () => {
      if (!this.track) return;
      toast('Não foi possível reproduzir o áudio desta página.', 'error');
      this.emit();
    });
  }

  get state(): PlayerState {
    const real = this.el.duration;
    return {
      pageId: this.track?.pageId ?? null,
      playing: !!this.track && !this.el.paused && !this.el.ended,
      time: this.track ? this.el.currentTime || 0 : 0,
      duration: Number.isFinite(real) && real > 0 ? real : this.fallbackDuration,
    };
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of [...this.listeners]) fn();
  }

  /** Prepara a faixa (sem tocar). Trocar de página interrompe a anterior. */
  select(track: TrackMeta): void {
    if (this.track?.pageId === track.pageId && this.track.version === track.version) return;
    this.el.pause();
    this.track = track;
    this.fallbackDuration = (track.durationMs ?? 0) / 1000;
    this.el.src = audioUrl(track.pageId, track.version);
    this.el.playbackRate = this.rate;
    this.updateMediaSession();
    this.emit();
  }

  async play(track: TrackMeta): Promise<void> {
    this.select(track);
    try {
      await this.el.play();
    } catch (err) {
      if ((err as DOMException)?.name !== 'AbortError') toast('Não foi possível iniciar o áudio.', 'error');
    }
  }

  pause(): void {
    this.el.pause();
  }

  seek(seconds: number): void {
    if (!this.track) return;
    this.el.currentTime = Math.max(0, seconds);
    this.emit();
  }

  setRate(rate: number): void {
    this.rate = rate;
    this.el.playbackRate = rate;
    try {
      localStorage.setItem(RATE_KEY, String(rate));
    } catch {
      /* armazenamento indisponível */
    }
    this.emit();
  }

  /** Para e esquece a faixa atual (página editada, apagada, ou tela fechada). */
  stop(): void {
    if (!this.track) return;
    this.el.pause();
    this.track = null;
    this.el.removeAttribute('src');
    this.el.load();
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
    this.emit();
  }

  /** Para se a página tocando deixou de existir (ex.: descartada numa ramificação). */
  stopUnless(existingPageIds: Set<string>): void {
    if (this.track && !existingPageIds.has(this.track.pageId)) this.stop();
  }

  private updateMediaSession(): void {
    if (!('mediaSession' in navigator) || !this.track || typeof MediaMetadata === 'undefined') return;
    const ms = navigator.mediaSession;
    ms.metadata = new MediaMetadata({ title: this.track.title, artist: this.track.artist, album: 'Chronicler Engine' });
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => void this.el.play()],
      ['pause', () => this.el.pause()],
      ['seekbackward', () => this.seek(this.el.currentTime - 10)],
      ['seekforward', () => this.seek(this.el.currentTime + 10)],
      ['seekto', (d) => typeof d.seekTime === 'number' && this.seek(d.seekTime)],
    ];
    for (const [action, handler] of handlers) {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        /* ação não suportada neste navegador */
      }
    }
  }
}

export const audioPlayer = new AudioPlayer();

export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
