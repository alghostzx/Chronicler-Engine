/**
 * Limitador de requisições por janela deslizante: no máximo `limit` requisições em qualquer intervalo
 * de `windowMs` (+ `marginMs` de folga, porque o relógio do servidor da API não é o nosso). Cada
 * chamada à API (inclusive retentativas) pede uma vaga com `acquire`; sem vaga, espera, em ordem de
 * chegada, até a requisição mais antiga sair da janela.
 */

export interface RateLimiterOptions {
  /** Requisições permitidas por janela. */
  limit: number;
  /** Tamanho da janela. */
  windowMs?: number;
  /** Folga somada à janela. */
  marginMs?: number;
  now?: () => number;
}

interface Waiter {
  resolve: () => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class RateLimiter {
  private readonly limit: number;
  private readonly spanMs: number;
  private readonly now: () => number;
  private readonly stamps: number[] = [];
  private readonly waiters: Waiter[] = [];
  private blockedUntil = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(opts: RateLimiterOptions) {
    this.limit = Math.max(1, Math.floor(opts.limit));
    this.spanMs = (opts.windowMs ?? 60_000) + (opts.marginMs ?? 1_000);
    this.now = opts.now ?? Date.now;
  }

  /** Espera uma vaga e a consome. Rejeita (sem consumir) se `signal` abortar enquanto espera. */
  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(signal.reason);
          this.schedule();
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
      this.pump();
    });
  }

  /** A API pediu para esperar (429): ninguém passa antes de `ms`. Nunca encurta um bloqueio já existente. */
  penalize(ms: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + ms);
    this.schedule();
  }

  /** Há requisições aguardando vaga (ou o limitador está bloqueado com alguém na espera). */
  get throttled(): boolean {
    return this.waiters.length > 0;
  }

  /** Quanto falta (ms) para a próxima vaga; 0 se há vaga agora. */
  get waitMs(): number {
    this.prune();
    const now = this.now();
    const free = this.stamps.length < this.limit ? now : this.stamps[0]! + this.spanMs;
    return Math.max(0, Math.max(free, this.blockedUntil) - now);
  }

  private prune(): void {
    const cutoff = this.now() - this.spanMs;
    while (this.stamps.length > 0 && this.stamps[0]! <= cutoff) this.stamps.shift();
  }

  private pump(): void {
    this.prune();
    while (this.waiters.length > 0 && this.now() >= this.blockedUntil && this.stamps.length < this.limit) {
      const waiter = this.waiters.shift()!;
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
      this.stamps.push(this.now());
      waiter.resolve();
    }
    this.schedule();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.waiters.length === 0) return;
    this.timer = setTimeout(() => this.pump(), Math.max(1, this.waitMs));
    this.timer.unref?.();
  }
}
