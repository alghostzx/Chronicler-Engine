import type { AudioInfo } from './api';
import type { TrackMeta } from './audioPlayer';

/**
 * Reprodução contínua: toca em sequência as páginas do Tome a partir de uma delas, no mesmo
 * reprodutor (`<audio>`) das páginas, esperando a geração das que ainda não ficaram prontas.
 * Este módulo é só a máquina de estados: não conhece o DOM, nem a API, nem o `<audio>` real
 * (tudo entra por `PlayerPort` e `ContinuousDeps`), o que a deixa testável.
 */

/** Estado do áudio de uma página, como `GET /api/sessions/:id/audio` o devolve. */
export interface StatusPage {
  page_id: string;
  order_index: number;
  kind: 'narrative' | 'dialogue';
  audio: AudioInfo | null;
}

/** O que o controlador usa do reprodutor (o `AudioPlayer` real o satisfaz). */
export interface PlayerPort {
  readonly state: { pageId: string | null; playing: boolean; time: number; duration: number };
  play(track: TrackMeta): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  subscribe(fn: () => void): () => void;
  /** A faixa terminou sozinha. */
  onEnded(fn: () => void): () => void;
  /** O navegador não conseguiu carregar/tocar a faixa. */
  onFailed(fn: () => void): () => void;
  /** Teclas de mídia / tela de bloqueio (próxima e anterior); `null` desliga. */
  setSkipHandlers(handlers: { next: () => void; previous: () => void } | null): void;
}

export type Phase = 'playing' | 'paused' | 'waiting';

export interface ContinuousState {
  pageIds: string[];
  /** Números (absolutos) das páginas da faixa, na mesma ordem de `pageIds`. */
  numbers: number[];
  index: number;
  currentPageId: string;
  currentNumber: number;
  phase: Phase;
  /** Páginas depois da atual ainda sendo geradas em segundo plano. */
  generating: number;
  /** Modo "só as que já têm": número da primeira página sem áudio, onde a reprodução vai parar. */
  stopsAt: number | null;
}

export type EndInfo =
  | { kind: 'finished' }
  | { kind: 'stopped' } // Interromper
  | { kind: 'takeover' } // o usuário tocou outra página
  | { kind: 'external' } // o reprodutor foi parado por fora (página editada/apagada, tela fechada)
  | { kind: 'blocked'; page: number; reason: 'no-audio' | 'error'; message?: string }
  | { kind: 'failed'; page: number };

export interface ContinuousDeps {
  fetchStatus(): Promise<StatusPage[]>;
  track(page: StatusPage): TrackMeta;
  /** A página atual mudou (inclusive a primeira). */
  onPageChange?(pageId: string, previousId: string | null): void;
  /** Estados novos do servidor (para manter os dados da tela em dia). */
  onStatus?(pages: StatusPage[]): void;
  /** O modo terminou (não é chamado em `dispose`). */
  onEnd?(info: EndInfo): void;
  pollMs?: number;
}

export interface StartOptions {
  pages: StatusPage[];
  fromPageId: string;
  /**
   * `all`: toda a faixa, esperando a geração das páginas que faltam;
   * `ready-prefix`: só até a primeira página sem áudio pronto, sem pular para as seguintes.
   */
  mode: 'all' | 'ready-prefix';
}

export class ContinuousPlayback {
  private list: StatusPage[] = [];
  private known = new Map<string, StatusPage>();
  private index = 0;
  private active = false;
  private waiting = false;
  private expected: string | null = null;
  /** Esperando a geração: a faixa anterior ainda está carregada no reprodutor e não conta como "outra página". */
  private loaded = new Set<string>();
  private stopsAt: number | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribers: Array<() => void> = [];
  private readonly listeners = new Set<(s: ContinuousState | null) => void>();
  private lastKey = '';

  constructor(
    private readonly player: PlayerPort,
    private readonly deps: ContinuousDeps,
  ) {}

  get running(): boolean {
    return this.active;
  }

  subscribe(fn: (s: ContinuousState | null) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get state(): ContinuousState | null {
    if (!this.active) return null;
    const current = this.list[this.index]!;
    const s = this.player.state;
    const phase: Phase = this.waiting ? 'waiting' : s.playing ? 'playing' : 'paused';
    let generating = 0;
    for (const p of this.list.slice(this.index + 1)) {
      const st = this.known.get(p.page_id)?.audio?.status;
      if (st === 'generating') generating++;
    }
    return {
      pageIds: this.list.map((p) => p.page_id),
      numbers: this.list.map((p) => p.order_index),
      index: this.index,
      currentPageId: current.page_id,
      currentNumber: current.order_index,
      phase,
      generating,
      stopsAt: this.stopsAt,
    };
  }

  // --- Controle -----------------------------------------------------------------------------
  /** Inicia (ou reinicia) o modo. Devolve `false` se não há o que tocar (a primeira página não tem áudio). */
  start(opts: StartOptions): { ok: boolean } {
    this.teardown();
    const sorted = [...opts.pages].sort((a, b) => a.order_index - b.order_index);
    const from = sorted.findIndex((p) => p.page_id === opts.fromPageId);
    if (from < 0) return { ok: false };
    const range = sorted.slice(from);
    let list = range;
    this.stopsAt = null;
    if (opts.mode === 'ready-prefix') {
      const firstMissing = range.findIndex((p) => p.audio?.status !== 'ready');
      if (firstMissing === 0) return { ok: false };
      if (firstMissing > 0) {
        list = range.slice(0, firstMissing);
        this.stopsAt = range[firstMissing]!.order_index;
      }
    }
    this.list = list;
    this.known = new Map(list.map((p) => [p.page_id, p]));
    this.index = 0;
    this.active = true;
    this.waiting = false;
    this.expected = null;
    this.lastKey = '';

    this.unsubscribers.push(
      this.player.onEnded(() => this.handleEnded()),
      this.player.onFailed(() => this.handleFailed()),
      this.player.subscribe(() => this.handlePlayerChange()),
    );
    this.player.setSkipHandlers({ next: () => this.next(), previous: () => this.previous() });
    this.playCurrent(null);
    return { ok: true };
  }

  /** "Interromper": para o áudio (as gerações em andamento seguem no servidor). */
  stop(): void {
    if (!this.active) return;
    this.player.pause();
    this.finish({ kind: 'stopped' });
  }

  /** Encerra em silêncio (tela fechada): sem eventos nem avisos. */
  dispose(): void {
    this.teardown();
    this.emit();
  }

  next(): void {
    if (this.active && this.index + 1 < this.list.length) this.goTo(this.index + 1);
  }

  previous(): void {
    if (!this.active) return;
    if (this.player.state.time > 3 || this.index === 0) this.player.seek(0);
    else this.goTo(this.index - 1);
  }

  // --- Internos -----------------------------------------------------------------------------
  private teardown(): void {
    this.active = false;
    this.waiting = false;
    this.expected = null;
    this.loaded.clear();
    clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    for (const off of this.unsubscribers.splice(0)) off();
    if (this.list.length > 0) this.player.setSkipHandlers(null);
    this.list = [];
  }

  private finish(info: EndInfo): void {
    if (!this.active) return;
    this.teardown();
    this.emit();
    this.deps.onEnd?.(info);
  }

  private emit(): void {
    const s = this.state;
    const key = s ? JSON.stringify([s.index, s.phase, s.generating, s.stopsAt, s.pageIds.length]) : '';
    if (key === this.lastKey) return;
    this.lastKey = key;
    for (const fn of [...this.listeners]) fn(s);
  }

  private goTo(i: number): void {
    const previous = this.list[this.index]!.page_id;
    this.index = i;
    this.playCurrent(previous);
  }

  private playCurrent(previousId: string | null, notify = true): void {
    const page = this.list[this.index]!;
    const info = this.known.get(page.page_id)?.audio ?? null;
    if (info?.status === 'ready') {
      this.waiting = false;
      this.expected = page.page_id;
      this.loaded.clear();
      void this.player.play(this.deps.track(this.known.get(page.page_id)!));
      if (notify) this.deps.onPageChange?.(page.page_id, previousId);
      this.ensurePolling();
      this.emit();
    } else if (info?.status === 'generating') {
      // A reprodução alcançou a geração: espera (a página atual já é a do banner).
      this.waiting = true;
      this.expected = page.page_id;
      const loadedId = this.player.state.pageId;
      if (loadedId !== null) this.loaded.add(loadedId);
      this.deps.onPageChange?.(page.page_id, previousId);
      this.ensurePolling();
      this.emit();
    } else {
      this.finish(
        info?.status === 'error'
          ? { kind: 'blocked', page: page.order_index, reason: 'error', message: info.error }
          : { kind: 'blocked', page: page.order_index, reason: 'no-audio' },
      );
    }
  }

  private handleEnded(): void {
    if (!this.active || this.player.state.pageId !== this.expected || this.waiting) return;
    if (this.index + 1 >= this.list.length) {
      this.finish(this.stopsAt === null ? { kind: 'finished' } : { kind: 'blocked', page: this.stopsAt, reason: 'no-audio' });
      return;
    }
    this.goTo(this.index + 1);
  }

  private handleFailed(): void {
    if (!this.active) return;
    this.finish({ kind: 'failed', page: this.list[this.index]!.order_index });
  }

  private handlePlayerChange(): void {
    if (!this.active) return;
    const id = this.player.state.pageId;
    if (this.waiting) {
      if (id !== null && id !== this.expected && !this.loaded.has(id)) this.finish({ kind: 'takeover' });
      return;
    }
    if (id === null) this.finish({ kind: 'external' });
    else if (id !== this.expected) this.finish({ kind: 'takeover' });
    else this.emit();
  }

  // --- Acompanhamento da geração -----------------------------------------------------------------
  private needsPolling(): boolean {
    if (this.waiting) return true;
    return this.list.slice(this.index + 1).some((p) => {
      const st = this.known.get(p.page_id)?.audio?.status;
      return st === 'generating';
    });
  }

  private ensurePolling(): void {
    if (!this.active || this.pollTimer !== undefined || !this.needsPolling()) return;
    this.pollTimer = setTimeout(() => void this.poll(), this.deps.pollMs ?? 1500);
  }

  private async poll(): Promise<void> {
    this.pollTimer = undefined;
    if (!this.active) return;
    let pages: StatusPage[] | undefined;
    try {
      pages = await this.deps.fetchStatus();
    } catch {
      /* falha transitória de rede: tenta de novo no próximo ciclo */
    }
    if (!this.active) return;
    if (pages) {
      const byId = new Map(pages.map((p) => [p.page_id, p]));
      for (const p of this.list) {
        // Página que sumiu do Tome (descartada): sem áudio a tocar.
        this.known.set(p.page_id, byId.get(p.page_id) ?? { ...p, audio: null });
      }
      this.deps.onStatus?.(pages);
      if (this.waiting) {
        const st = this.known.get(this.list[this.index]!.page_id)?.audio?.status;
        if (st !== 'generating') {
          this.waiting = false;
          this.playCurrent(null, false); // pronta → toca (o banner já mostra a página); erro/sem áudio → encerra
          if (!this.active) return;
        }
      }
      this.emit();
    }
    this.ensurePolling();
  }
}
