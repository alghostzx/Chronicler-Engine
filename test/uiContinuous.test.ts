// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/connection.js';
import { createRepositories, type Repositories } from '../src/db/index.js';
import { buildApp } from '../src/server.js';
import { FAKE_KEY, mockGateway, type MockGateway } from './helpers.js';

/** UI da reprodução contínua: o cliente real no jsdom contra o servidor real (Gemini e <audio> simulados). */
const realFetch = globalThis.fetch;
const INDEX = readFileSync(join(process.cwd(), 'public', 'index.html'), 'utf8');

let app: Awaited<ReturnType<typeof buildApp>>;
let repos: Repositories;
let gateway: MockGateway;
let sessionId: string;
let audioEl: HTMLMediaElement | null = null;
const plays: string[] = [];

async function waitFor<T>(fn: () => T | null | undefined | false, what: string, timeout = 4000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`Tempo esgotado esperando: ${what}\nDOM: ${document.body.textContent?.slice(0, 900)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const byLabel = (label: string, root: ParentNode = document) => root.querySelector<HTMLElement>(`[aria-label="${label}"]`);
const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const text = () => document.body.textContent ?? '';
const modalButton = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('[role=dialog] button')).find((b) => b.textContent === label);
const card = (n: number) => document.querySelector<HTMLElement>(`section.page-card[data-page-index="${n}"]`)!;
const bar = () => document.querySelector<HTMLElement>('[data-player-bar]')!;
const barVisible = () => !!bar() && !bar().classList.contains('hidden');
const playFrom = (n: number) => byLabel('Reproduzir a partir daqui', card(n)) as HTMLButtonElement;
const pageId = (n: number) => repos.pages.listAll(sessionId)[n - 1]!.id;
const ended = () => audioEl!.dispatchEvent(new Event('ended'));

async function makeAudio(...pages: number[]): Promise<void> {
  for (const n of pages) {
    const id = pageId(n);
    await app.inject({ method: 'POST', url: `/api/narrative/pages/${id}/audio` });
    await waitFor(() => repos.audio.meta(id), `áudio da página ${n}`);
  }
}

async function boot(): Promise<void> {
  gateway = mockGateway();
  repos = createRepositories(openDatabase(':memory:'));
  repos.settings.set('gemini_api_key', FAKE_KEY);
  sessionId = repos.sessions.create({ title: 'Crônica do Teste', system_rules: 'R', world_context: '', active_theme: 'cyberpunk' }).id;
  for (const t of ['A neblina subia do porto.', 'Varn não acolhia ninguém.', 'O sino tocou três vezes.']) {
    repos.pages.append(sessionId, { player_instruction: 'x', generated_text: t });
  }
  app = await buildApp(loadConfig({ PUBLIC_DIR: '/inexistente' }), { repos, gatewayFactory: () => gateway, audio: { retryDelaysMs: [0] } });
  await app.listen({ port: 0, host: '127.0.0.1' });
}

async function openSession(): Promise<void> {
  const addr = app.server.address();
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  globalThis.fetch = ((url: string, init?: RequestInit) => realFetch(base + url, init)) as typeof fetch;
  document.documentElement.className = '';
  document.body.innerHTML = INDEX.slice(INDEX.indexOf('<body'), INDEX.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '').replace(/^<body[^>]*>/, '');
  location.hash = `#/s/${sessionId}`;
  await new Promise((r) => setTimeout(r, 30));
  vi.resetModules();
  await import('../client/main');
  const { setAudioPollInterval } = await import('../client/audioUi');
  setAudioPollInterval(15);
  await waitFor(() => card(1), 'cartão da página 1');
}

beforeEach(() => {
  localStorage.clear();
  plays.length = 0;
  audioEl = null;
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    audioEl = this;
    plays.push(this.getAttribute('src') ?? '');
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  globalThis.fetch = realFetch;
  await app?.close();
});

describe('UI — reprodução contínua', () => {
  it('o botão existe em cada página (um ícone, rótulo e dica), desabilitado só na última', async () => {
    await boot();
    await openSession();
    for (const n of [1, 2, 3]) {
      const b = playFrom(n);
      expect(b, `página ${n}`).not.toBeNull();
      expect(b.querySelectorAll('svg')).toHaveLength(1);
      expect(b.getAttribute('data-tip')).toBeTruthy();
    }
    expect(playFrom(1).disabled).toBe(false);
    expect(playFrom(2).disabled).toBe(false);
    expect(playFrom(3).disabled).toBe(true);
    expect(playFrom(3).getAttribute('data-tip')).toContain('última página');
    expect(barVisible()).toBe(false);
  });

  it('com todas as narrações prontas: não pergunta nada, mostra o banner e encadeia até o fim', async () => {
    await boot();
    await makeAudio(1, 2, 3);
    await openSession();
    click(playFrom(1));
    await waitFor(() => plays.length === 1, 'tocou a página 1');
    expect(plays[0]).toContain(`/api/narrative/pages/${pageId(1)}/audio`);
    expect(document.querySelector('[role=dialog]')).toBeNull();
    expect(barVisible()).toBe(true);
    expect(bar().getAttribute('role')).toBe('region');
    expect(bar().textContent).toContain('Reproduzindo «Crônica do Teste» em modo contínuo');
    expect(bar().textContent).toContain('Página 1 · 1 de 3');
    // o player mora na barra (não nas páginas): controles de mídia e anterior/próxima
    expect(bar().getAttribute('data-mode')).toBe('continuous');
    for (const label of ['Página anterior', 'Tocar', 'Próxima página']) expect(byLabel(label, bar()), label).not.toBeNull();
    expect(bar().querySelector('input[type=range]')).not.toBeNull();
    expect(card(1).querySelector('.audio-player')).toBeNull();

    ended();
    await waitFor(() => plays.length === 2, 'tocou a página 2');
    expect(plays[1]).toContain(pageId(2));
    await waitFor(() => bar().textContent!.includes('Página 2 · 2 de 3'), 'barra na página 2');
    expect(card(2).querySelector('.audio-player')).toBeNull();

    ended();
    await waitFor(() => plays.length === 3, 'tocou a página 3');
    ended();
    await waitFor(() => !barVisible(), 'banner some ao concluir');
    expect(text()).toContain('Reprodução contínua concluída.');
  });

  it('anterior/próxima da barra navegam pelas páginas; a próxima some no fim da lista', async () => {
    await boot();
    await makeAudio(1, 2, 3);
    await openSession();
    click(playFrom(1));
    await waitFor(() => plays.length === 1, 'tocou a página 1');
    const nextBtn = byLabel('Próxima página', bar()) as HTMLButtonElement;
    const prevBtn = byLabel('Página anterior', bar()) as HTMLButtonElement;
    expect(nextBtn.disabled).toBe(false);

    click(nextBtn);
    await waitFor(() => plays.length === 2, 'próxima: página 2');
    expect(plays[1]).toContain(pageId(2));
    click(nextBtn);
    await waitFor(() => plays.length === 3, 'próxima: página 3');
    await waitFor(() => bar().textContent!.includes('Página 3 · 3 de 3'), 'detalhe da página 3');
    expect(nextBtn.disabled).toBe(true);

    click(prevBtn); // a faixa está no início (tempo 0): volta uma página
    await waitFor(() => plays.length === 4, 'anterior: página 2');
    expect(plays[3]).toContain(pageId(2));
    expect(bar().textContent).toContain('Página 2 · 2 de 3');
  });

  it('o botão Tocar/Pausar da barra comanda o reprodutor', async () => {
    await boot();
    await makeAudio(1, 2, 3);
    await openSession();
    click(playFrom(1));
    await waitFor(() => plays.length === 1, 'tocou a página 1');
    const play = byLabel('Tocar', bar())!;
    click(play); // o reprodutor simulado segue "pausado": o clique retoma a mesma faixa
    await waitFor(() => plays.length === 2, 'retomou');
    expect(plays[1]).toBe(plays[0]);
  });

  it('a barra também aparece para uma página tocada fora do modo contínuo, sem Interromper', async () => {
    await boot();
    await makeAudio(1);
    await openSession();
    expect(barVisible()).toBe(false);
    click(byLabel('Ouvir esta página', card(1))!);
    await waitFor(() => barVisible(), 'barra');
    expect(bar().getAttribute('data-mode')).toBe('single');
    expect(bar().textContent).toContain('Tocando a Página 1 de «Crônica do Teste»');
    const stop = byLabel('Interromper a reprodução contínua', bar())!;
    expect(stop.classList.contains('hidden')).toBe(true);
    expect((byLabel('Próxima página', bar()) as HTMLElement).classList.contains('hidden')).toBe(true);
    click(byLabel('Fechar o player', bar())!);
    await waitFor(() => !barVisible(), 'barra fechada');
  });

  it('começando da página 2: a 1 fica de fora', async () => {
    await boot();
    await makeAudio(1, 2, 3);
    await openSession();
    click(playFrom(2));
    await waitFor(() => plays.length === 1, 'tocou');
    expect(plays[0]).toContain(pageId(2));
    expect(bar().textContent).toContain('Página 2 · 1 de 2');
  });

  it('Interromper para o áudio e esconde o banner', async () => {
    await boot();
    await makeAudio(1, 2, 3);
    await openSession();
    click(playFrom(1));
    await waitFor(() => barVisible(), 'banner');
    const stop = byLabel('Interromper a reprodução contínua', bar())!;
    expect(stop.textContent).toContain('Interromper');
    expect(stop.querySelectorAll('svg')).toHaveLength(1);
    click(stop);
    await waitFor(() => !barVisible(), 'banner escondido');
    ended();
    await new Promise((r) => setTimeout(r, 50));
    expect(plays).toHaveLength(1);
  });

  it('com páginas sem áudio: pergunta (3 opções, lista as páginas); "Só reproduzir" para na primeira sem áudio', async () => {
    await boot();
    await makeAudio(1);
    await openSession();
    click(playFrom(1));
    await waitFor(() => document.querySelector('[role=dialog]'), 'modal');
    expect(text()).toContain('Páginas 2 e 3 ainda não têm áudio.');
    expect(text()).toContain('consome tokens');
    for (const l of ['Cancelar', 'Só reproduzir as que já têm', 'Gerar e reproduzir']) expect(modalButton(l), l).toBeDefined();
    expect(plays).toHaveLength(0);

    click(modalButton('Só reproduzir as que já têm')!);
    await waitFor(() => plays.length === 1, 'tocou a página 1');
    expect(gateway.synthRequests).toHaveLength(1); // só a gerada no preparo; nada novo
    expect(bar().textContent).toContain('para na Página 2');
    ended();
    await waitFor(() => !barVisible(), 'encerra');
    expect(text()).toContain('Parei na Página 2: ela não tem áudio.');
    expect(plays).toHaveLength(1);
  });

  it('Cancelar na pergunta não toca nem gera nada', async () => {
    await boot();
    await openSession();
    click(playFrom(1));
    await waitFor(() => document.querySelector('[role=dialog]'), 'modal');
    expect(text()).toContain('Páginas 1 a 3 ainda não têm áudio.');
    click(modalButton('Cancelar')!);
    await waitFor(() => !document.querySelector('[role=dialog]'), 'fechou');
    await new Promise((r) => setTimeout(r, 60));
    expect(plays).toHaveLength(0);
    expect(gateway.synthRequests).toHaveLength(0);
    expect(barVisible()).toBe(false);
  });

  it('"Gerar e reproduzir": gera as faltantes em lote e toca em sequência, esperando as que ainda geram', async () => {
    await boot();
    await openSession();
    click(playFrom(1));
    await waitFor(() => modalButton('Gerar e reproduzir'), 'modal');
    click(modalButton('Gerar e reproduzir')!);
    await waitFor(() => plays.length === 1, 'tocou a página 1 quando ficou pronta', 6000);
    expect(plays[0]).toContain(pageId(1));
    await waitFor(() => repos.audio.meta(pageId(2)) && repos.audio.meta(pageId(3)), 'as três geradas');
    expect(gateway.synthRequests.map((r) => r.text)).toEqual(expect.arrayContaining(['A neblina subia do porto.', 'Varn não acolhia ninguém.', 'O sino tocou três vezes.']));
    ended();
    await waitFor(() => plays.length === 2, 'página 2', 6000);
    ended();
    await waitFor(() => plays.length === 3, 'página 3', 6000);
    ended();
    await waitFor(() => !barVisible(), 'concluído');
    expect(text()).toContain('Reprodução contínua concluída.');
  });

  it('sair da tela encerra o modo em silêncio', async () => {
    await boot();
    await makeAudio(1, 2, 3);
    await openSession();
    click(playFrom(1));
    await waitFor(() => barVisible(), 'banner');
    location.hash = '#/';
    await waitFor(() => !document.querySelector('[data-continuous-bar]'), 'tela trocada');
    expect(text()).not.toContain('Reprodução contínua concluída.');
  });
});
