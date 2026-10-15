import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimiter } from '../src/tts/rateLimiter.js';

/** Janela deslizante de requisições (relógio simulado). */
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const limiter = (limit: number, windowMs = 60_000, marginMs = 0) => new RateLimiter({ limit, windowMs, marginMs });

/** Pede `n` vagas; devolve quantas já foram concedidas (promessas resolvidas) sem avançar o relógio. */
async function grants(l: RateLimiter, n: number): Promise<{ granted: () => number; all: Promise<void[]> }> {
  let count = 0;
  const all = Promise.all(Array.from({ length: n }, () => l.acquire().then(() => void count++)));
  await Promise.resolve();
  await Promise.resolve();
  return { granted: () => count, all };
}

describe('RateLimiter', () => {
  it('concede até o limite na hora e segura o excedente até a requisição mais antiga sair da janela', async () => {
    const l = limiter(3, 1000);
    const g = await grants(l, 5);
    expect(g.granted()).toBe(3);
    expect(l.throttled).toBe(true);
    expect(l.waitMs).toBe(1000);

    await vi.advanceTimersByTimeAsync(999);
    expect(g.granted()).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(g.granted()).toBe(5); // as três primeiras saíram juntas da janela
    await g.all;
    expect(l.throttled).toBe(false);
  });

  it('página de 7 trechos seguida de uma de 5, com limite 10: só os 3 primeiros da segunda passam; o resto espera o cooldown', async () => {
    const l = limiter(10, 60_000);
    const first = await grants(l, 7);
    expect(first.granted()).toBe(7);
    await vi.advanceTimersByTimeAsync(30_000); // a primeira página levou 30 s
    const second = await grants(l, 5);
    expect(second.granted()).toBe(3);
    expect(l.waitMs).toBe(30_000); // a mais antiga (t = 0) sai da janela aos 60 s
    await vi.advanceTimersByTimeAsync(30_000);
    expect(second.granted()).toBe(5);
  });

  it('página de 5 seguida de uma de 4, com limite 10: não há espera', async () => {
    const l = limiter(10, 60_000);
    await grants(l, 5);
    await vi.advanceTimersByTimeAsync(20_000);
    const second = await grants(l, 4);
    expect(second.granted()).toBe(4);
    expect(l.throttled).toBe(false);
    expect(l.waitMs).toBe(0);
  });

  it('uma ligeira folga (margem) alarga a janela', async () => {
    const l = limiter(1, 1000, 500);
    await grants(l, 1);
    const g = await grants(l, 1);
    await vi.advanceTimersByTimeAsync(1499);
    expect(g.granted()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(g.granted()).toBe(1);
  });

  it('atende na ordem de chegada', async () => {
    const l = limiter(1, 100);
    const order: number[] = [];
    const ps = [1, 2, 3].map((n) => l.acquire().then(() => order.push(n)));
    await vi.advanceTimersByTimeAsync(300);
    await Promise.all(ps);
    expect(order).toEqual([1, 2, 3]);
  });

  it('penalize (429) bloqueia todos pelo tempo pedido, mesmo com vaga na janela', async () => {
    const l = limiter(10, 60_000);
    l.penalize(5000);
    const g = await grants(l, 2);
    expect(g.granted()).toBe(0);
    expect(l.waitMs).toBe(5000);
    await vi.advanceTimersByTimeAsync(4999);
    expect(g.granted()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(g.granted()).toBe(2);
  });

  it('penalize nunca encurta um bloqueio que já existe', async () => {
    const l = limiter(10, 60_000);
    l.penalize(5000);
    l.penalize(1000);
    expect(l.waitMs).toBe(5000);
  });

  it('abortar enquanto espera rejeita e não consome a vaga', async () => {
    const l = limiter(1, 1000);
    await grants(l, 1);
    const ctl = new AbortController();
    const waiting = l.acquire(ctl.signal);
    const next = await grants(l, 1);
    ctl.abort(new Error('cancelado'));
    await expect(waiting).rejects.toThrow('cancelado');
    await vi.advanceTimersByTimeAsync(1000);
    expect(next.granted()).toBe(1); // quem vinha depois não ficou preso atrás do abortado
    expect(l.throttled).toBe(false);
  });

  it('um sinal que já nasce abortado rejeita na hora', async () => {
    await expect(limiter(5).acquire(AbortSignal.abort(new Error('já cancelado')))).rejects.toThrow('já cancelado');
  });

  it('limite inválido vira 1 (nunca trava para sempre)', async () => {
    const l = new RateLimiter({ limit: 0, windowMs: 100, marginMs: 0 });
    await l.acquire();
    expect(l.waitMs).toBe(100);
  });
});
