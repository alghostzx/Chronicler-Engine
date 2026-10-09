// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/connection.js';
import { createRepositories } from '../src/db/index.js';
import { buildApp } from '../src/server.js';
import { FAKE_KEY, mockGateway, narratorJson, npcJson, type MockGateway } from './helpers.js';

/**
 * Teste de integração da UI: o bundle real do cliente roda no jsdom contra o servidor Fastify
 * verdadeiro (SQLite em memória + Gemini mockado), numa porta efêmera de loopback.
 */
const realFetch = globalThis.fetch;
const INDEX = readFileSync(join(process.cwd(), 'public', 'index.html'), 'utf8');

let app: Awaited<ReturnType<typeof buildApp>>;
let gateway: MockGateway;

async function waitFor<T>(fn: () => T | null | undefined | false, what: string, timeout = 4000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`Tempo esgotado esperando: ${what}\nDOM: ${document.body.textContent?.slice(0, 600)}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

const buttons = () => Array.from(document.querySelectorAll('button'));
const button = (label: string | RegExp) =>
  buttons().find((b) => (typeof label === 'string' ? b.textContent === label : label.test(b.textContent ?? '')));
const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const text = () => document.body.textContent ?? '';

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function boot(opts: { withKey: boolean; hash?: string }): Promise<void> {
  gateway = mockGateway();
  const repos = createRepositories(openDatabase(':memory:'));
  if (opts.withKey) repos.settings.set('gemini_api_key', FAKE_KEY);
  app = await buildApp(loadConfig({ PUBLIC_DIR: '/inexistente' }), { repos, gatewayFactory: () => gateway });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  globalThis.fetch = ((url: string, init?: RequestInit) => realFetch(base + url, init)) as typeof fetch;

  document.documentElement.className = '';
  document.body.innerHTML = INDEX.slice(INDEX.indexOf('<body'), INDEX.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '').replace(/^<body[^>]*>/, '');
  location.hash = opts.hash ?? '#/';
  vi.resetModules();
  await import('../client/main');
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  await app?.close();
});

describe('UI — tela inicial', () => {
  it('pede a chave, valida, lista só modelos de texto e cria uma sessão', async () => {
    await boot({ withKey: false });
    const input = await waitFor(() => document.querySelector<HTMLInputElement>('input[type=password]'), 'campo da chave');
    type(input, FAKE_KEY);
    click(await waitFor(() => button('Validar e salvar'), 'botão validar'));

    await waitFor(() => text().includes('Chave da API do Gemini configurada'), 'chave configurada');
    const select = await waitFor(() => document.querySelector<HTMLSelectElement>('select[aria-label="Modelo padrão global"]'), 'seletor de modelo');
    const labels = Array.from(select.options).map((o) => o.textContent ?? '');
    expect(labels.some((l) => l.includes('gemini-2.5-flash-lite'))).toBe(true);
    expect(labels.some((l) => /image|tts/i.test(l))).toBe(false);

    type(document.querySelector<HTMLInputElement>('input[aria-label="Título da crônica"]')!, 'A Queda de Valdoria');
    document.querySelector('form.space-y-3')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => location.hash.startsWith('#/s/'), 'navegação para a sessão');
    await waitFor(() => text().includes('O Tome está em branco'), 'tome vazio');
    expect(document.title).toContain('A Queda de Valdoria');
  });
});

describe('UI — sessão', () => {
  async function openNewSession(): Promise<string> {
    await boot({ withKey: true });
    await waitFor(() => document.querySelector('input[aria-label="Título da crônica"]'), 'home');
    type(document.querySelector<HTMLInputElement>('input[aria-label="Título da crônica"]')!, 'Teste');
    (document.querySelector<HTMLSelectElement>('select[aria-label="Tema"]')!).value = 'cyberpunk';
    document.querySelector('form.space-y-3')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => location.hash.startsWith('#/s/') && text().includes('O Tome está em branco'), 'sessão aberta');
    return location.hash.slice(4);
  }

  async function send(msg: string, label: string | RegExp = 'Enviar'): Promise<void> {
    const ta = await waitFor(() => document.querySelector<HTMLTextAreaElement>('footer textarea:not([disabled])'), 'doca habilitada');
    type(ta, msg);
    click(await waitFor(() => button(label), `botão ${String(label)}`));
  }

  it('narra, edita, re-gera descartando posteriores, e mostra o HP', async () => {
    await openNewSession();
    await waitFor(() => text().includes('HP'), 'barra de HP');

    gateway.queue(narratorJson('A porta rangeu.\n\nUma sombra cruzou o corredor.'));
    await send('Abro a porta');
    await waitFor(() => text().includes('A porta rangeu.'), 'primeiro bloco');
    expect(document.querySelectorAll('.prose-tome p').length).toBe(2);
    expect(document.documentElement.classList.contains('theme-cyberpunk')).toBe(true);
    await waitFor(() => /\d+% — /.test(text()), 'HP calculado');

    gateway.queue(narratorJson('O silêncio voltou.'));
    await send('Espero');
    await waitFor(() => text().includes('O silêncio voltou.'), 'segundo bloco');
    expect(document.querySelectorAll('section[data-block-id]').length).toBe(2);

    // Edição manual do primeiro bloco preserva o segundo.
    click(button('Editar Texto')!);
    const editor = await waitFor(() => document.querySelector<HTMLTextAreaElement>('section[data-block-id] textarea'), 'editor');
    type(editor, 'A porta gemeu.');
    click(await waitFor(() => button('Salvar edição'), 'salvar edição'));
    await waitFor(() => text().includes('A porta gemeu.'), 'texto editado');
    expect(text()).toContain('O silêncio voltou.');

    // Re-geração do primeiro bloco avisa e descarta o segundo.
    click(button('Ver Prompt de Origem / Re-gerar')!);
    const modalTa = await waitFor(() => document.querySelector<HTMLTextAreaElement>('[role=dialog] textarea'), 'modal');
    expect(modalTa.value).toBe('Abro a porta');
    expect(text()).toContain('descarta definitivamente os 1 bloco(s)');
    gateway.queue(narratorJson('A porta explodiu.'));
    click(button(/Re-gerar e descartar 1/)!);
    await waitFor(() => text().includes('A porta explodiu.') && !text().includes('O silêncio voltou.'), 'bloco regerado e posterior descartado');
    expect(document.querySelectorAll('section[data-block-id]').length).toBe(1);
  });

  it('conduz um diálogo com NPC do gatilho até a costura em prosa', async () => {
    await openNewSession();
    gateway.queue(narratorJson('Um mercador surge.', { activate: true, npc_name: 'Mercador', dynamic_system_prompt: 'Você é um mercador astuto.' }));
    await send('Entro na feira');
    await waitFor(() => text().includes('Falando com: Mercador'), 'modo diálogo');

    gateway.queue(npcJson('Olá, viajante!', true));
    await send('Bom dia', 'Falar');
    await waitFor(() => text().includes('Mercador: Olá, viajante!'), 'resposta do NPC');
    expect(text()).toContain('Mercador deseja encerrar a conversa.');
    expect(button('Compactar Crônica')!.disabled).toBe(true);

    gateway.queue(narratorJson('O mercador acenou e partiu.'));
    click(button('Encerrar Diálogo e Narrar')!);
    await waitFor(() => text().includes('O mercador acenou e partiu.') && !text().includes('Falando com'), 'diálogo encerrado');
  });

  it('reconecta ao diálogo ativo ao recarregar a página', async () => {
    const id = await openNewSession();
    gateway.queue(narratorJson('Um guarda surge.', { activate: true, npc_name: 'Guarda', dynamic_system_prompt: 'Você é um guarda.' }));
    await send('Avanço');
    await waitFor(() => text().includes('Falando com: Guarda'), 'diálogo');

    // Simula reload: troca de rota e volta, reconstruindo o estado a partir do servidor.
    location.hash = '#/';
    await waitFor(() => text().includes('Suas crônicas'), 'home');
    location.hash = `#/s/${id}`;
    await waitFor(() => text().includes('Falando com: Guarda'), 'diálogo restaurado');
  });

  it('compacta a crônica pela UI (minuta editável → consolidar) e mostra o volume na gaveta', async () => {
    await openNewSession();
    for (const [i, msg] of ['Primeiro capítulo.', 'Segundo capítulo.', 'Terceiro capítulo.'].entries()) {
      gateway.queue(narratorJson(msg));
      await send(`Ação ${i}`);
      await waitFor(() => text().includes(msg) && !button('Narrando…'), msg);
    }
    gateway.queue('Sinopse: tudo começou no primeiro capítulo.');
    click(button('Compactar Crônica')!);
    const ta = await waitFor(() => document.querySelector<HTMLTextAreaElement>('[role=dialog] textarea'), 'minuta da sinopse');
    expect(ta.value).toContain('Sinopse');
    type(ta, 'Sinopse editada pelo jogador.');
    click(await waitFor(() => button(/Consolidar Volume 1/), 'botão consolidar'));
    await waitFor(() => !document.querySelector('[role=dialog]') && !text().includes('Primeiro capítulo.'), 'blocos arquivados somem do tome');
    expect(text()).toContain('Terceiro capítulo.');

    click(button('Contexto')!);
    click(await waitFor(() => button('Crônica'), 'aba Crônica'));
    await waitFor(() => text().includes('Volume 1'), 'volume listado');
    click(document.querySelector('summary')!);
    expect(text()).toContain('Sinopse editada pelo jogador.');
  });

  it('ramifica a partir de um bloco anterior descartando os seguintes', async () => {
    await openNewSession();
    for (const msg of ['Cena A.', 'Cena B.']) {
      gateway.queue(narratorJson(msg));
      await send(`Ir para ${msg}`);
      await waitFor(() => text().includes(msg) && !button('Narrando…'), msg);
    }
    click(button('Ramificar a partir daqui')!);
    click(await waitFor(() => button('Descartar e ramificar'), 'confirmação'));
    await waitFor(() => !text().includes('Cena B.'), 'bloco B descartado');
    expect(text()).toContain('Cena A.');
  });

  it('mostra erro do Narrador e mantém o texto digitado', async () => {
    await openNewSession();
    gateway.queue('isto não é JSON válido');
    await send('Faço algo');
    await waitFor(() => document.querySelector('#toasts div'), 'toast de erro');
    const ta = await waitFor(() => document.querySelector<HTMLTextAreaElement>('footer textarea:not([disabled])'), 'doca liberada');
    expect(ta.value).toBe('Faço algo');
    expect(document.querySelectorAll('section[data-block-id]').length).toBe(0);
  });
});
