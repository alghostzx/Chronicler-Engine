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
const byLabel = (label: string) => document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
/** Abre um menu de ícone (tema/modo) e escolhe uma opção pelo texto. */
function chooseOption(control: string, option: string): void {
  click(byLabel(control)!);
  const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')).find((i) => i.textContent === option);
  if (!item) throw new Error(`Opção não encontrada: ${option}`);
  click(item);
}
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
  // O jsdom despacha `hashchange` de forma assíncrona: deixa o evento pendente passar antes de
  // registrar o roteador desta instância, senão ele re-renderizaria a tela no meio do teste.
  await new Promise((r) => setTimeout(r, 30));
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
  it('não gera rolagem horizontal no celular: grades de 1 coluna e filhos com min-w-0', async () => {
    await boot({ withKey: true });
    await waitFor(() => document.querySelector('input[aria-label="Título da crônica"]'), 'home');
    // Sem `grid-cols-*` explícito a coluna implícita é `auto` e cresce com a <option> mais longa.
    const grids = Array.from(document.querySelectorAll('main .grid'));
    expect(grids.length).toBeGreaterThanOrEqual(2);
    for (const g of grids) expect(g.className).toMatch(/\bgrid-cols-1\b/);
    for (const g of grids) for (const child of Array.from(g.children)) expect(child.className).toMatch(/\bmin-w-0\b/);
    for (const f of Array.from(document.querySelectorAll('main select, main input:not([type=checkbox]), main textarea'))) {
      expect(f.className).toMatch(/\binput\b/); // `.input` aplica w-full min-w-0 max-w-full
    }
    expect(document.querySelector('main')!.className).toMatch(/\bmin-w-0\b/);
  });

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
    await waitFor(() => document.querySelectorAll('.prose-tome p').length === 2, 'primeira página persistida');
    expect(text()).toContain('A porta rangeu.');
    expect(document.documentElement.classList.contains('theme-cyberpunk')).toBe(true);
    await waitFor(() => /\d+% — /.test(text()), 'HP calculado');

    gateway.queue(narratorJson('O silêncio voltou.'));
    await send('Espero');
    await waitFor(() => text().includes('O silêncio voltou.'), 'segunda página');
    expect(document.querySelectorAll('section[data-page-id]').length).toBe(2);

    // Cada página é um cartão separado, numerado de forma absoluta, com 4 ações (ouvir, editar texto, editar prompt, ramificar) só em ícone sempre visíveis.
    const cards = Array.from(document.querySelectorAll<HTMLElement>('section.page-card[data-page-id]'));
    expect(cards.map((c) => c.querySelector('.page-card-title')?.textContent)).toEqual(['Página 1', 'Página 2']);
    for (const card of cards) {
      const actions = Array.from(card.querySelectorAll<HTMLButtonElement>('.page-card-actions button'));
      expect(actions.map((b) => b.getAttribute('aria-label'))).toEqual(['Ouvir esta página', 'Editar texto da página', 'Editar prompt e re-gerar', 'Ramificar a partir desta página']);
      for (const b of actions) {
        expect(b.textContent).toBe(''); // só ícone
        expect(b.querySelectorAll('svg').length).toBe(1); // um único ícone por ação
        expect(b.getAttribute('data-tip')).toBeTruthy(); // tooltip
        expect(b.className).not.toMatch(/opacity-0|md:opacity-0|group-hover/); // nunca depende de hover
      }
    }
    const icons = Array.from(cards[0]!.querySelectorAll('.page-card-actions svg')).map((s) => s.innerHTML);
    expect(new Set(icons).size).toBe(4); // glifos distintos
    expect(cards[0]!.querySelector<HTMLButtonElement>('[aria-label="Ramificar a partir desta página"]')!.disabled).toBe(false);
    expect(cards[1]!.querySelector<HTMLButtonElement>('[aria-label="Ramificar a partir desta página"]')!.disabled).toBe(true); // última página
    expect(cards[0]!.querySelector('.drop-cap')).not.toBeNull();
    expect(cards[1]!.querySelector('.drop-cap')).toBeNull();

    // Edição manual da primeira página preserva a segunda.
    click(byLabel('Editar texto da página')!);
    const editor = await waitFor(() => document.querySelector<HTMLTextAreaElement>('section[data-page-id] textarea'), 'editor');
    type(editor, 'A porta gemeu.');
    click(await waitFor(() => button('Salvar edição'), 'salvar edição'));
    await waitFor(() => text().includes('A porta gemeu.'), 'texto editado');
    expect(text()).toContain('O silêncio voltou.');

    // Re-geração da primeira página avisa e descarta a segunda.
    click(byLabel('Editar prompt e re-gerar')!);
    const modalTa = await waitFor(() => document.querySelector<HTMLTextAreaElement>('[role=dialog] textarea'), 'modal');
    expect(modalTa.value).toBe('Abro a porta');
    expect(text()).toContain('descarta definitivamente a página seguinte');
    gateway.queue(narratorJson('A porta explodiu.'));
    click(button(/Re-gerar e descartar 1/)!);
    await waitFor(() => text().includes('A porta explodiu.') && !text().includes('O silêncio voltou.'), 'página regerada e posterior descartada');
    expect(document.querySelectorAll('section[data-page-id]').length).toBe(1);
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
    await waitFor(() => !document.querySelector('[role=dialog]') && !text().includes('Primeiro capítulo.'), 'páginas arquivadas somem do tome');
    expect(text()).toContain('Terceiro capítulo.');

    click(byLabel('Contexto da sessão')!);
    click(await waitFor(() => button('Crônica'), 'aba Crônica'));
    await waitFor(() => text().includes('Volume 1'), 'volume listado');
    click(document.querySelector('summary')!);
    expect(text()).toContain('Sinopse editada pelo jogador.');

    // As páginas consumidas continuam legíveis: o Tome aponta para o volume e o leitor é uma página própria.
    expect(document.querySelector('nav[aria-label^="Páginas anteriores"] a')!.getAttribute('href')).toMatch(/\/v\/1$/);
    const read = Array.from(document.querySelectorAll('a')).find((a) => /^Ler as 2 páginas$/.test(a.textContent ?? ''))!;
    expect(read.getAttribute('href')).toMatch(/\/v\/1$/);
    click(read);
    location.hash = read.getAttribute('href')!;
    await waitFor(() => text().includes('Primeiro capítulo.'), 'leitor de volume');
    const cards = Array.from(document.querySelectorAll<HTMLElement>('section.page-card'));
    expect(cards.map((c) => c.querySelector('.page-card-title')?.textContent)).toEqual(['Página 1', 'Página 2']);
    expect(text()).toContain('Segundo capítulo.');
    expect(text()).not.toContain('Terceiro capítulo.');
    // Somente leitura: o rodapé só tem o ícone de ouvir (sem editar nem ramificar).
    const readOnlyActions = Array.from(document.querySelectorAll('.page-card-actions button'));
    expect(readOnlyActions.map((b) => b.getAttribute('aria-label'))).toEqual(['Ouvir esta página', 'Ouvir esta página']);
    expect(document.querySelector('textarea')).toBeNull();
    expect(byLabel('Salvar volume em Markdown')).not.toBeNull();
    expect(document.querySelector('a[aria-label="Voltar ao Tome"]')!.getAttribute('href')).toMatch(/^#\/s\//);
    expect(document.documentElement.classList.contains('theme-cyberpunk')).toBe(true);

    // Volume inexistente: mensagem clara em vez de tela vazia.
    location.hash = `${location.hash.replace(/\/v\/1$/, '')}/v/9`;
    await waitFor(() => text().includes('O Volume 9 não existe'), 'volume inexistente');
  });

  it('ramifica a partir de uma página anterior descartando as seguintes', async () => {
    await openNewSession();
    for (const msg of ['Cena A.', 'Cena B.']) {
      gateway.queue(narratorJson(msg));
      await send(`Ir para ${msg}`);
      await waitFor(() => text().includes(msg) && !button('Narrando…'), msg);
    }
    click(byLabel('Ramificar a partir desta página')!);
    click(await waitFor(() => button('Descartar e ramificar'), 'confirmação'));
    await waitFor(() => !text().includes('Cena B.'), 'página B descartada');
    expect(text()).toContain('Cena A.');
  });

  it('salva a crônica em .md pelo botão do cabeçalho (com e sem contexto)', async () => {
    await openNewSession();
    gateway.queue(narratorJson('A porta rangeu.'));
    await send('Abro a porta');
    await waitFor(() => text().includes('A porta rangeu.') && !button('Narrando…'), 'página');

    const blobs: Blob[] = [];
    const downloads: string[] = [];
    URL.createObjectURL = ((b: Blob) => (blobs.push(b), 'blob:teste')) as typeof URL.createObjectURL;
    URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    const readBlob = (b: Blob) =>
      new Promise<string>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.readAsText(b);
      });

    click(byLabel('Salvar em Markdown')!);
    click(await waitFor(() => button('Baixar arquivo .md'), 'modal de exportação'));
    await waitFor(() => downloads.length === 1, 'download disparado');
    expect(downloads[0]).toBe('Teste.md');
    const plain = await readBlob(blobs[0]!);
    expect(plain).toContain('# Teste');
    expect(plain).toContain('A porta rangeu.');
    expect(plain).not.toContain('Abro a porta');
    await waitFor(() => !document.querySelector('[role=dialog]'), 'modal fechada');

    await fetch(`/api/sessions/${location.hash.slice(4)}/context`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ world_context: 'Reino de Valdoria.' }),
    });
    click(byLabel('Salvar em Markdown')!);
    const box = await waitFor(() => document.querySelector<HTMLInputElement>('#export-context'), 'checkbox de contexto');
    box.checked = true;
    click(button('Baixar arquivo .md')!);
    await waitFor(() => downloads.length === 2, 'segundo download');
    const withCtx = await readBlob(blobs[1]!);
    expect(withCtx).toContain('## Mundo e personagens\n\nReino de Valdoria.');
    expect(withCtx).toContain('## Narrativa');
    expect(plain).not.toContain('Valdoria');
    clickSpy.mockRestore();
  });

  it('exporta por escopo (completa, Tome, volumes) e salva um volume com ou sem sinopse', async () => {
    await openNewSession();
    for (const [i, msg] of ['Primeiro capítulo.', 'Segundo capítulo.', 'Terceiro capítulo.'].entries()) {
      gateway.queue(narratorJson(msg));
      await send(`Ação ${i}`);
      await waitFor(() => text().includes(msg) && !button('Narrando…'), msg);
    }
    gateway.queue('Sinopse do primeiro volume.');
    click(button('Compactar Crônica')!);
    await waitFor(() => document.querySelector<HTMLTextAreaElement>('[role=dialog] textarea'), 'minuta');
    click(await waitFor(() => button(/Consolidar Volume 1/), 'consolidar'));
    await waitFor(() => !document.querySelector('[role=dialog]') && !text().includes('Primeiro capítulo.'), 'compactado');

    const blobs: Blob[] = [];
    const downloads: string[] = [];
    URL.createObjectURL = ((b: Blob) => (blobs.push(b), 'blob:teste')) as typeof URL.createObjectURL;
    URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    const readBlob = (b: Blob) =>
      new Promise<string>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.readAsText(b);
      });

    // Só as páginas dos volumes.
    click(byLabel('Salvar em Markdown')!);
    const radios = await waitFor(() => Array.from(document.querySelectorAll<HTMLInputElement>('input[name="export-scope"]')), 'escopos');
    expect(radios.map((r) => r.value)).toEqual(['all', 'active', 'archived']);
    expect(radios.every((r) => !r.disabled)).toBe(true);
    expect(radios[0]!.checked).toBe(true);
    radios[2]!.checked = true;
    click(button('Baixar arquivo .md')!);
    await waitFor(() => downloads.length === 1, 'download dos volumes');
    expect(downloads[0]).toBe('Teste — volumes.md');
    const archivedMd = await readBlob(blobs[0]!);
    expect(archivedMd).toContain('Primeiro capítulo.\n\n---\n\nSegundo capítulo.');
    expect(archivedMd).not.toContain('Terceiro capítulo.');

    // Só o Tome.
    click(byLabel('Salvar em Markdown')!);
    const again = await waitFor(() => Array.from(document.querySelectorAll<HTMLInputElement>('input[name="export-scope"]')), 'escopos 2');
    again[1]!.checked = true;
    click(button('Baixar arquivo .md')!);
    await waitFor(() => downloads.length === 2, 'download do Tome');
    const activeMd = await readBlob(blobs[1]!);
    expect(activeMd).toContain('Terceiro capítulo.');
    expect(activeMd).not.toContain('Primeiro capítulo.');

    // Volume pela gaveta, sem a sinopse.
    click(byLabel('Contexto da sessão')!);
    click(await waitFor(() => button('Crônica'), 'aba Crônica'));
    click(await waitFor(() => byLabel('Salvar Volume 1 em Markdown'), 'ícone de salvar volume'));
    const box = await waitFor(() => document.querySelector<HTMLInputElement>('#export-summary'), 'checkbox da sinopse');
    expect(box.checked).toBe(true); // sinopse incluída por padrão
    box.checked = false;
    click(button('Baixar arquivo .md')!);
    await waitFor(() => downloads.length === 3, 'download do volume');
    expect(downloads[2]).toBe('Teste — Volume 1.md');
    const volumeMd = await readBlob(blobs[2]!);
    expect(volumeMd).toContain('# Teste — Volume 1');
    expect(volumeMd).toContain('Primeiro capítulo.');
    expect(volumeMd).not.toContain('Sinopse');
    clickSpy.mockRestore();
  });

  it('alterna entre modo claro e escuro mantendo o tema da sessão', async () => {
    await openNewSession();
    chooseOption('Modo claro ou escuro', 'Escuro');
    expect(document.documentElement.classList.contains('mode-dark')).toBe(true);
    expect(document.documentElement.classList.contains('theme-cyberpunk')).toBe(true);
    chooseOption('Modo claro ou escuro', 'Claro');
    expect(document.documentElement.classList.contains('mode-light')).toBe(true);
    expect(localStorage.getItem('chronicler.mode')).toBe('light');
  });

  it('o cabeçalho da sessão usa só ícones, cada um com rótulo acessível e tooltip', async () => {
    await openNewSession();
    const header = document.querySelector('header')!;
    const controls = Array.from(header.querySelectorAll<HTMLElement>('a.btn, button.btn'));
    expect(controls.map((c) => c.getAttribute('aria-label'))).toEqual([
      'Voltar à biblioteca',
      'Tema visual',
      'Modo claro ou escuro',
      'Salvar em Markdown',
      'Contexto da sessão',
    ]);
    for (const c of controls) {
      expect(c.textContent).toBe(''); // sem texto visível, apenas o SVG
      expect(c.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
      expect(c.getAttribute('data-tip')).toBeTruthy();
      expect(c.classList.contains('tip')).toBe(true);
    }
    expect(header.querySelector('select')).toBeNull();
    expect(byLabel('Tema visual')!.getAttribute('data-tip')).toBe('Tema visual: Cyberpunk (Neon)');
  });

  it('o menu de tema troca o tema, fecha com Esc e com clique fora', async () => {
    await openNewSession();
    click(byLabel('Tema visual')!);
    expect(byLabel('Tema visual')!.getAttribute('aria-expanded')).toBe('true');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(byLabel('Tema visual')!.getAttribute('aria-expanded')).toBe('false');
    click(byLabel('Tema visual')!);
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(byLabel('Tema visual')!.getAttribute('aria-expanded')).toBe('false');

    chooseOption('Tema visual', 'Medieval (Pergaminho)');
    expect(document.documentElement.classList.contains('theme-medieval')).toBe(true);
    expect(byLabel('Tema visual')!.getAttribute('data-tip')).toBe('Tema visual: Medieval (Pergaminho)');
  });

  it('mostra erro do Narrador e mantém o texto digitado', async () => {
    await openNewSession();
    gateway.queue('isto não é JSON válido');
    await send('Faço algo');
    await waitFor(() => document.querySelector('#toasts div'), 'toast de erro');
    const ta = await waitFor(() => document.querySelector<HTMLTextAreaElement>('footer textarea:not([disabled])'), 'doca liberada');
    expect(ta.value).toBe('Faço algo');
    expect(document.querySelectorAll('section[data-page-id]').length).toBe(0);
  });
});
