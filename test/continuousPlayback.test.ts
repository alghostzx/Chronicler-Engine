import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContinuousPlayback, type ContinuousState, type EndInfo, type PlayerPort, type StatusPage } from '../client/continuousPlayback';
import type { TrackMeta } from '../client/audioPlayer';

class FakePlayer implements PlayerPort {
  state = { pageId: null as string | null, playing: false, time: 0, duration: 0 };
  played: string[] = [];
  skip: { next: () => void; previous: () => void } | null = null;
  private subs = new Set<() => void>();
  private endedFns = new Set<() => void>();
  private failedFns = new Set<() => void>();
  private notify() {
    for (const fn of [...this.subs]) fn();
  }
  async play(t: TrackMeta) {
    this.state = { ...this.state, pageId: t.pageId, playing: true, time: 0 };
    this.played.push(t.pageId);
    this.notify();
  }
  pause() {
    this.state = { ...this.state, playing: false };
    this.notify();
  }
  seek(s: number) {
    this.state = { ...this.state, time: s };
  }
  subscribe(fn: () => void) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
  onEnded(fn: () => void) {
    this.endedFns.add(fn);
    return () => this.endedFns.delete(fn);
  }
  onFailed(fn: () => void) {
    this.failedFns.add(fn);
    return () => this.failedFns.delete(fn);
  }
  setSkipHandlers(h: { next: () => void; previous: () => void } | null) {
    this.skip = h;
  }
  /** A faixa termina sozinha (o `<audio>` real zera o tempo e avisa). */
  end() {
    this.state = { ...this.state, playing: false, time: 0 };
    this.notify();
    for (const fn of [...this.endedFns]) fn();
  }
  fail() {
    for (const fn of [...this.failedFns]) fn();
  }
  /** O usuário toca outra página pelo botão "Ouvir" dela. */
  userPlays(id: string) {
    this.state = { ...this.state, pageId: id, playing: true, time: 0 };
    this.notify();
  }
  stopExternal() {
    this.state = { pageId: null, playing: false, time: 0, duration: 0 };
    this.notify();
  }
}

type St = 'ready' | 'generating' | 'error' | null;
const page = (n: number, st: St): StatusPage => ({
  page_id: `p${n}`,
  order_index: n,
  kind: 'narrative',
  audio: st === null ? null : st === 'error' ? { status: 'error', error: 'falhou' } : { status: st, created_at: `v${n}`, duration_ms: 1000 },
});

describe('ContinuousPlayback', () => {
  let player: FakePlayer;
  let server: StatusPage[];
  let ends: EndInfo[];
  let changes: Array<[string, string | null]>;
  let cp: ContinuousPlayback;

  const make = () => {
    cp = new ContinuousPlayback(player, {
      fetchStatus: async () => server.map((p) => ({ ...p })),
      track: (p) => ({ pageId: p.page_id, version: p.audio?.created_at ?? '', title: `Página ${p.order_index}`, artist: 'Crônica' }),
      onPageChange: (id, prev) => changes.push([id, prev]),
      onEnd: (i) => ends.push(i),
      pollMs: 100,
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    player = new FakePlayer();
    server = [];
    ends = [];
    changes = [];
  });
  afterEach(() => {
    cp?.dispose();
    vi.useRealTimers();
  });

  it('toca da página clicada (inclusive) até a última, encadeando ao fim de cada uma', () => {
    server = [page(1, 'ready'), page(2, 'ready'), page(3, 'ready'), page(4, 'ready')];
    make();
    expect(cp.start({ pages: server, fromPageId: 'p2', mode: 'all' })).toEqual({ ok: true });
    expect(player.played).toEqual(['p2']);
    player.end();
    expect(player.played).toEqual(['p2', 'p3']);
    player.end();
    player.end();
    expect(player.played).toEqual(['p2', 'p3', 'p4']);
    expect(ends).toEqual([{ kind: 'finished' }]);
    expect(cp.running).toBe(false);
    expect(changes).toEqual([['p2', null], ['p3', 'p2'], ['p4', 'p3']]);
    expect(player.skip).toBeNull();
  });

  it('só-as-que-já-têm: para na primeira sem áudio, sem pular para as seguintes', () => {
    server = [page(1, 'ready'), page(2, 'ready'), page(3, null), page(4, 'ready')];
    make();
    cp.start({ pages: server, fromPageId: 'p1', mode: 'ready-prefix' });
    expect(cp.state?.stopsAt).toBe(3);
    expect(cp.state?.pageIds).toEqual(['p1', 'p2']);
    player.end();
    player.end();
    expect(player.played).toEqual(['p1', 'p2']);
    expect(ends).toEqual([{ kind: 'blocked', page: 3, reason: 'no-audio' }]);
  });

  it('só-as-que-já-têm: se a própria página clicada não tem áudio, não começa', () => {
    server = [page(1, null), page(2, 'ready')];
    make();
    expect(cp.start({ pages: server, fromPageId: 'p1', mode: 'ready-prefix' })).toEqual({ ok: false });
    expect(player.played).toEqual([]);
    expect(cp.running).toBe(false);
  });

  it('modo "tudo": espera a geração da próxima página e toca assim que ela fica pronta', async () => {
    server = [page(1, 'ready'), page(2, 'generating'), page(3, 'generating')];
    make();
    const seen: Array<ContinuousState | null> = [];
    cp.subscribe((s) => seen.push(s));
    cp.start({ pages: server, fromPageId: 'p1', mode: 'all' });
    expect(cp.state?.generating).toBe(2);
    player.end(); // acabou a 1 e a 2 ainda gera
    expect(cp.state?.phase).toBe('waiting');
    expect(cp.state?.currentNumber).toBe(2);
    expect(player.played).toEqual(['p1']);
    expect(ends).toEqual([]);
    await vi.advanceTimersByTimeAsync(250);
    expect(player.played).toEqual(['p1']); // segue gerando
    server = [page(1, 'ready'), page(2, 'ready'), page(3, 'generating')];
    await vi.advanceTimersByTimeAsync(150);
    expect(player.played).toEqual(['p1', 'p2']);
    expect(cp.state?.phase).toBe('playing');
    server = [page(1, 'ready'), page(2, 'ready'), page(3, 'ready')];
    player.end(); // a 3 ainda constava como "gerando" na última consulta
    expect(cp.state?.phase).toBe('waiting');
    await vi.advanceTimersByTimeAsync(150);
    expect(player.played).toEqual(['p1', 'p2', 'p3']);
    expect(seen.some((s) => s?.phase === 'waiting')).toBe(true);
  });

  it('espera sem falsa tomada de controle (a faixa anterior segue carregada no reprodutor)', async () => {
    server = [page(1, 'ready'), page(2, 'generating')];
    make();
    cp.start({ pages: server, fromPageId: 'p1', mode: 'all' });
    player.end();
    player.pause(); // eventos do reprodutor enquanto espera
    player.seek(0);
    expect(cp.running).toBe(true);
    expect(ends).toEqual([]);
  });

  it('geração que falha: toca até chegar nela e então para, avisando o erro', async () => {
    server = [page(1, 'ready'), page(2, 'generating')];
    make();
    cp.start({ pages: server, fromPageId: 'p1', mode: 'all' });
    player.end();
    server = [page(1, 'ready'), page(2, 'error')];
    await vi.advanceTimersByTimeAsync(150);
    expect(ends).toEqual([{ kind: 'blocked', page: 2, reason: 'error', message: 'falhou' }]);
  });

  it('página que some (apagada) enquanto se espera a geração: para sem áudio', async () => {
    server = [page(1, 'ready'), page(2, 'generating')];
    make();
    cp.start({ pages: server, fromPageId: 'p1', mode: 'all' });
    player.end();
    server = [page(1, 'ready')];
    await vi.advanceTimersByTimeAsync(150);
    expect(ends).toEqual([{ kind: 'blocked', page: 2, reason: 'no-audio' }]);
  });

  it('Interromper pausa o áudio e encerra (sem cancelar gerações) com o motivo "stopped"', () => {
    server = [page(1, 'ready'), page(2, 'ready')];
    make();
    cp.start({ pages: server, fromPageId: 'p1', mode: 'all' });
    cp.stop();
    expect(player.state.playing).toBe(false);
    expect(ends).toEqual([{ kind: 'stopped' }]);
    expect(cp.running).toBe(false);
    // terminar depois não encadeia nada
    player.end();
    expect(player.played).toEqual(['p1']);
  });

  it('o usuário tocar outra página encerra o modo (takeover)', () => {
    server = [page(1, 'ready'), page(2, 'ready'), page(3, 'ready')];
    make();
    cp.start({ pages: server, fromPageId: 'p1', mode: 'all' });
    player.userPlays('p3');
    expect(ends).toEqual([{ kind: 'takeover' }]);
    player.end();
    expect(player.played).toEqual(['p1']);
  });

  it('o reprodutor parado por fora (página editada) encerra o modo (external)', () => {
    server = [page(1, 'ready'), page(2, 'ready')];
    make();
    cp.start({ pages: server, fromPageId: 'p1', mode: 'all' });
    player.stopExternal();
    expect(ends).toEqual([{ kind: 'external' }]);
  });

  it('pausar e retomar a página não encerra o modo', () => {
    server = [page(1, 'ready'), page(2, 'ready')];
    make();
    cp.start({ pages: server, fromPageId: 'p1', mode: 'all' });
    player.pause();
    expect(cp.state?.phase).toBe('paused');
    player.userPlays('p1');
    expect(cp.state?.phase).toBe('playing');
    expect(ends).toEqual([]);
  });

  it('próxima e anterior (teclas de mídia) trocam de página; "anterior" volta ao início se já passou de 3 s', () => {
    server = [page(1, 'ready'), page(2, 'ready'), page(3, 'ready')];
    make();
    cp.start({ pages: server, fromPageId: 'p1', mode: 'all' });
    expect(player.skip).not.toBeNull();
    player.skip!.next();
    expect(player.played).toEqual(['p1', 'p2']);
    player.state = { ...player.state, time: 10 };
    player.skip!.previous();
    expect(player.played).toEqual(['p1', 'p2']);
    expect(player.state.time).toBe(0);
    player.skip!.previous();
    expect(player.played).toEqual(['p1', 'p2', 'p1']);
    player.skip!.next();
    player.skip!.next();
    player.skip!.next(); // na última não avança
    expect(player.played.slice(-1)).toEqual(['p3']);
    expect(cp.running).toBe(true);
  });

  it('falha ao carregar o áudio encerra com "failed"', () => {
    server = [page(1, 'ready'), page(2, 'ready')];
    make();
    cp.start({ pages: server, fromPageId: 'p1', mode: 'all' });
    player.fail();
    expect(ends).toEqual([{ kind: 'failed', page: 1 }]);
  });

  it('start de novo (botão clicado durante o modo) recomeça da nova página', () => {
    server = [page(1, 'ready'), page(2, 'ready'), page(3, 'ready')];
    make();
    cp.start({ pages: server, fromPageId: 'p1', mode: 'all' });
    cp.start({ pages: server, fromPageId: 'p2', mode: 'all' });
    expect(cp.state?.pageIds).toEqual(['p2', 'p3']);
    expect(player.played).toEqual(['p1', 'p2']);
    expect(ends).toEqual([]); // reiniciar não é encerrar
  });

  it('dispose encerra em silêncio, avisando só os assinantes do estado', () => {
    server = [page(1, 'ready'), page(2, 'ready')];
    make();
    const seen: Array<ContinuousState | null> = [];
    cp.subscribe((s) => seen.push(s));
    cp.start({ pages: server, fromPageId: 'p1', mode: 'all' });
    cp.dispose();
    expect(ends).toEqual([]);
    expect(seen[seen.length - 1]).toBeNull();
    expect(player.skip).toBeNull();
  });

  it('informa as páginas sendo geradas em segundo plano e o estado novo do servidor', async () => {
    server = [page(1, 'ready'), page(2, 'generating'), page(3, 'generating')];
    const statuses: StatusPage[][] = [];
    cp = new ContinuousPlayback(player, {
      fetchStatus: async () => server.map((p) => ({ ...p })),
      track: (p) => ({ pageId: p.page_id, version: '', title: '', artist: '' }),
      onStatus: (p) => statuses.push(p),
      pollMs: 100,
    });
    cp.start({ pages: server, fromPageId: 'p1', mode: 'all' });
    await vi.advanceTimersByTimeAsync(120);
    expect(statuses.length).toBeGreaterThan(0);
    server = [page(1, 'ready'), page(2, 'ready'), page(3, 'generating')];
    await vi.advanceTimersByTimeAsync(120);
    expect(cp.state?.generating).toBe(1);
  });
});
