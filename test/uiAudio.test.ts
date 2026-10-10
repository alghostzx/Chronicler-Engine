// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/connection.js';
import { createRepositories, type Repositories } from '../src/db/index.js';
import { buildApp } from '../src/server.js';
import { FAKE_KEY, mockGateway, type MockGateway } from './helpers.js';

/** UI da narração: o cliente real no jsdom contra o servidor real (Gemini e <audio> simulados). */
const realFetch = globalThis.fetch;
const INDEX = readFileSync(join(process.cwd(), 'public', 'index.html'), 'utf8');

let app: Awaited<ReturnType<typeof buildApp>>;
let repos: Repositories;
let gateway: MockGateway;
let sessionId: string;
const plays: string[] = [];
let pauses = 0;

async function waitFor<T>(fn: () => T | null | undefined | false, what: string, timeout = 4000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`Tempo esgotado esperando: ${what}\nDOM: ${document.body.textContent?.slice(0, 700)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const byLabel = (label: string, root: ParentNode = document) => root.querySelector<HTMLElement>(`[aria-label="${label}"]`);
const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const text = () => document.body.textContent ?? '';
const modalButton = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('[role=dialog] button')).find((b) => b.textContent === label);

async function boot(hash: string): Promise<void> {
  gateway = mockGateway();
  repos = createRepositories(openDatabase(':memory:'));
  repos.settings.set('gemini_api_key', FAKE_KEY);
  sessionId = repos.sessions.create({ title: 'Crônica do Teste', system_rules: 'R', world_context: '', active_theme: 'cyberpunk' }).id;
  repos.pages.append(sessionId, { player_instruction: 'a', generated_text: 'A neblina subia do porto.' });
  repos.pages.append(sessionId, { player_instruction: 'b', generated_text: 'Varn não acolhia ninguém.' });
  app = await buildApp(loadConfig({ PUBLIC_DIR: '/inexistente' }), { repos, gatewayFactory: () => gateway, audio: { retryDelaysMs: [0] } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  globalThis.fetch = ((url: string, init?: RequestInit) => realFetch(base + url, init)) as typeof fetch;

  document.documentElement.className = '';
  document.body.innerHTML = INDEX.slice(INDEX.indexOf('<body'), INDEX.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '').replace(/^<body[^>]*>/, '');
  location.hash = hash.replace('<id>', sessionId);
  await new Promise((r) => setTimeout(r, 30));
  vi.resetModules();
  await import('../client/main');
  const { setAudioPollInterval } = await import('../client/audioUi');
  setAudioPollInterval(15);
}

beforeEach(() => {
  localStorage.clear();
  plays.length = 0;
  pauses = 0;
  // jsdom não implementa reprodução de mídia.
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    plays.push(this.getAttribute('src') ?? '');
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {
    pauses++;
  });
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  globalThis.fetch = realFetch;
  await app?.close();
});

const card = (n: number) => document.querySelector<HTMLElement>(`section.page-card[data-page-index="${n}"]`)!;

describe('UI — narração das páginas', () => {
  it('gera o áudio (progresso) e abre o player; ouvir de novo não chama a API', async () => {
    await boot('#/s/<id>');
    await waitFor(() => card(1), 'cartão da página 1');

    const listen = byLabel('Ouvir esta página', card(1))! as HTMLButtonElement;
    expect(listen.getAttribute('data-tip')).toContain('Gerar a narração');
    expect(listen.querySelectorAll('svg')).toHaveLength(1);
    expect(card(1).querySelector('.audio-panel')!.classList.contains('hidden')).toBe(true);

    click(listen);
    await waitFor(() => card(1).querySelector('[data-audio-panel] .audio-status') || card(1).querySelector('.audio-player'), 'progresso ou player');
    const player = await waitFor(() => card(1).querySelector<HTMLElement>('.audio-player'), 'player');
    expect(gateway.synthRequests).toHaveLength(1);
    expect(gateway.synthRequests[0]).toMatchObject({ voice: 'Gacrux', text: 'A neblina subia do porto.' });
    expect(listen.getAttribute('aria-expanded')).toBe('true');
    expect(listen.disabled).toBe(false);

    // Controles do player: um ícone por ação, rótulos em pt-BR.
    for (const label of ['Tocar', 'Gerar o áudio de novo', 'Apagar o áudio', 'Baixar o áudio (.mp3)']) {
      const el = byLabel(label, player)!;
      expect(el, label).not.toBeNull();
      expect(el.querySelectorAll('svg')).toHaveLength(1);
      expect(el.getAttribute('data-tip')).toBeTruthy();
    }
    expect(byLabel('Baixar o áudio (.mp3)', player)!.getAttribute('href')).toBe(`/api/narrative/pages/${repos.pages.listAll(sessionId)[0]!.id}/audio?download=true`);
    expect(player.querySelector('input[type=range]')).not.toBeNull();
    expect(player.querySelector('.audio-time')!.textContent).toMatch(/^0:00 \/ 0:0\d$/);

    // Tocar usa o MP3 guardado (e só ele).
    click(byLabel('Tocar', player)!);
    await waitFor(() => plays.length === 1, 'play');
    expect(plays[0]).toMatch(new RegExp(`/api/narrative/pages/${repos.pages.listAll(sessionId)[0]!.id}/audio\\?v=`));
    expect(gateway.synthRequests).toHaveLength(1);
  });

  it('o botão do rodapé abre e fecha o player (e toca/pausa)', async () => {
    await boot('#/s/<id>');
    await waitFor(() => card(1), 'cartão');
    const page = repos.pages.listAll(sessionId)[0]!;
    // áudio pronto antes de abrir a tela (como se tivesse sido gerado antes)
    await app.inject({ method: 'POST', url: `/api/narrative/pages/${page.id}/audio` });
    await waitFor(() => repos.audio.meta(page.id), 'áudio gerado');
    location.hash = '#/';
    await new Promise((r) => setTimeout(r, 40));
    location.hash = `#/s/${sessionId}`;
    await waitFor(() => card(1)?.querySelector('[aria-label="Ouvir esta página"]'), 'sessão reaberta');

    const listen = byLabel('Ouvir esta página', card(1))!;
    expect(listen.getAttribute('aria-expanded')).toBe('false');
    expect(card(1).querySelector('.audio-player')).toBeNull();
    click(listen);
    await waitFor(() => card(1).querySelector('.audio-player'), 'player aberto');
    await waitFor(() => plays.length === 1, 'tocou ao abrir');
    expect(listen.getAttribute('aria-expanded')).toBe('true');
    click(listen);
    await waitFor(() => !card(1).querySelector('.audio-player'), 'player fechado');
    expect(listen.getAttribute('aria-expanded')).toBe('false');
  });

  it('gerar de novo pede confirmação, e apagar remove o áudio (o texto fica)', async () => {
    await boot('#/s/<id>');
    await waitFor(() => card(1), 'cartão');
    const page = repos.pages.listAll(sessionId)[0]!;
    click(byLabel('Ouvir esta página', card(1))!);
    await waitFor(() => card(1).querySelector('.audio-player'), 'player');

    click(byLabel('Gerar o áudio de novo', card(1))!);
    const confirm = await waitFor(() => modalButton('Gerar de novo'), 'confirmação');
    expect(text()).toContain('substituirá a atual');
    click(confirm);
    await waitFor(() => gateway.synthRequests.length === 2, 'segunda síntese');
    await waitFor(() => card(1).querySelector('.audio-player'), 'player de volta');
    expect(repos.audio.usage().count).toBe(1);

    click(byLabel('Apagar o áudio', card(1))!);
    click(await waitFor(() => modalButton('Apagar'), 'confirmar apagar'));
    await waitFor(() => !repos.audio.meta(page.id), 'áudio apagado no banco');
    await waitFor(() => !card(1).querySelector('.audio-player'), 'player sumiu');
    expect(repos.pages.get(page.id)!.generated_text).toBe('A neblina subia do porto.');
    expect(byLabel('Ouvir esta página', card(1))!.getAttribute('data-tip')).toContain('Gerar a narração');
  });

  it('mostra o erro da geração em pt-BR com opção de tentar de novo', async () => {
    await boot('#/s/<id>');
    gateway.synthesize = async () => {
      throw new Error('O texto foi bloqueado');
    };
    await waitFor(() => card(1), 'cartão');
    click(byLabel('Ouvir esta página', card(1))!);
    const err = await waitFor(() => card(1).querySelector('.audio-error'), 'erro');
    expect(err.textContent).toContain('Não foi possível gerar a narração');
    expect(byLabel('Tentar gerar o áudio de novo', card(1))).not.toBeNull();
    expect(repos.audio.usage().count).toBe(0);
  });

  it('editar o texto da página some com o áudio na interface', async () => {
    await boot('#/s/<id>');
    await waitFor(() => card(1), 'cartão');
    click(byLabel('Ouvir esta página', card(1))!);
    await waitFor(() => card(1).querySelector('.audio-player'), 'player');
    click(byLabel('Editar texto da página', card(1))!);
    const ta = await waitFor(() => document.querySelector<HTMLTextAreaElement>('section[data-page-id] textarea'), 'editor');
    ta.value = 'Texto novo.';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    click(await waitFor(() => Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Salvar edição'), 'salvar'));
    await waitFor(() => text().includes('Texto novo.'), 'texto salvo');
    expect(repos.audio.usage().count).toBe(0);
    expect(card(1).querySelector('.audio-player')).toBeNull();
    expect(byLabel('Ouvir esta página', card(1))!.getAttribute('data-tip')).toContain('Gerar a narração');
  });

  it('o leitor de volume também narra as páginas consumidas', async () => {
    await boot('#/');
    // volume criado direto no banco (as duas páginas viram "consumidas")
    repos.archives.create(sessionId, { summary_text: 'Sinopse.', covered_page_start_index: 1, covered_page_end_index: 2 });
    repos.pages.archiveRange(sessionId, 1, 2);
    location.hash = '#/';
    await new Promise((r) => setTimeout(r, 40));
    location.hash = `#/s/${sessionId}/v/1`;
    await waitFor(() => card(1), 'leitor de volume');
    click(byLabel('Ouvir esta página', card(1))!);
    await waitFor(() => card(1).querySelector('.audio-player'), 'player no volume');
    expect(gateway.synthRequests[0]!.text).toBe('A neblina subia do porto.');
    expect(card(1).querySelector('[aria-label="Editar texto da página"]')).toBeNull();
  });
});

describe('UI — configurações de voz', () => {
  it('página Opções: padrão global desligado, voz Gacrux, salvar e apagar tudo', async () => {
    await boot('#/opcoes');
    const auto = await waitFor(() => document.querySelector<HTMLInputElement>('#tts-auto'), 'cartão de voz');
    expect(auto.checked).toBe(false);
    const voice = byLabel('Voz do narrador') as HTMLSelectElement;
    expect(voice.value).toBe('Gacrux');
    expect(voice.options).toHaveLength(30);
    expect((byLabel('Modelo de voz') as HTMLSelectElement).value).toBe('gemini-3.8-flash-tts');
    expect((byLabel('Estilo da narração') as HTMLTextAreaElement).value).toContain('velho narrador');
    expect(text()).toContain('Nenhum áudio guardado.');

    auto.checked = true;
    auto.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => repos.settings.get('tts_auto_default') === '1', 'padrão global ligado');

    voice.value = 'Algenib';
    click(await waitFor(() => Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Salvar voz'), 'salvar voz'));
    await waitFor(() => repos.settings.get('tts_voice') === 'Algenib', 'voz salva');
  });

  it('amostra de voz usa a voz escolhida no formulário', async () => {
    await boot('#/opcoes');
    await waitFor(() => document.querySelector('#tts-auto'), 'cartão de voz');
    const created = vi.fn(() => 'blob:amostra');
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = created;
    (byLabel('Voz do narrador') as HTMLSelectElement).value = 'Charon';
    click(await waitFor(() => Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Ouvir amostra'), 'botão amostra'));
    await waitFor(() => gateway.synthRequests.length === 1, 'síntese da amostra');
    expect(gateway.synthRequests[0]).toMatchObject({ voice: 'Charon' });
    await waitFor(() => created.mock.calls.length === 1 && plays.length === 1, 'amostra tocando');
  });

  it('gaveta da sessão: aba Voz altera a geração automática só desta sessão', async () => {
    await boot('#/s/<id>');
    await waitFor(() => card(1), 'cartão');
    click(byLabel('Contexto da sessão')!);
    click(await waitFor(() => Array.from(document.querySelectorAll<HTMLElement>('[role=tab]')).find((t) => t.textContent === 'Voz'), 'aba Voz'));
    const select = await waitFor(() => byLabel('Narração automática desta sessão') as HTMLSelectElement | null, 'seletor');
    expect(select.options[select.selectedIndex]!.textContent).toBe('Herdar o padrão global (desligada)');
    select.value = 'on';
    click(Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Salvar' && b.closest('aside'))!);
    await waitFor(() => repos.sessions.get(sessionId)!.tts_auto === true, 'tts_auto salvo');
    expect(repos.settings.get('tts_auto_default')).toBeUndefined();
  });
});
