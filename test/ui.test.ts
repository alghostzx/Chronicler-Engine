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

/**
 * Cada `boot` reimporta o cliente (`vi.resetModules`) e a instância anterior continuaria ouvindo
 * `hashchange`/`keydown` da mesma janela, abrindo quadros duplicados. Guarda os ouvintes para
 * removê-los antes de subir a próxima instância.
 */
const windowListeners: Array<[string, EventListenerOrEventListenerObject]> = [];
const addWindowListener = window.addEventListener.bind(window) as typeof window.addEventListener;
window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
  if (type === 'hashchange' || type === 'keydown') windowListeners.push([type, listener]);
  addWindowListener(type, listener, options);
}) as typeof window.addEventListener;

async function boot(opts: { withKey: boolean; hash?: string }): Promise<void> {
  for (const [type, listener] of windowListeners.splice(0)) window.removeEventListener(type, listener);

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

/** Abre a tela de título e o quadro "Nova Crônica" (rota `#/nova`). */
async function openNewChronicleFrame(withKey = true): Promise<void> {
  await boot({ withKey, hash: '#/nova' });
  await waitFor(() => document.querySelector('[role="dialog"] input[aria-label="Título da crônica"]'), 'quadro Nova Crônica');
}

const menuItem = (label: string) => Array.from(document.querySelectorAll<HTMLElement>('.title-menu-item')).find((i) => i.textContent === label);

describe('UI — tela inicial', () => {
  it('mostra logo (SVG), legenda e o menu Continuar / Nova Crônica / Opções, no tema Srcery sem persistir', async () => {
    await boot({ withKey: true });
    await waitFor(() => document.querySelector('.title-menu'), 'menu');
    const logo = document.querySelector<HTMLImageElement>('h1 img.title-logo')!;
    expect(logo.getAttribute('src')).toBe('/logo.svg');
    expect(logo.alt).toBe('Chronicler Engine');
    expect(document.querySelector('h1 picture source')!.getAttribute('srcset')).toBe('/logo-stacked.svg');
    expect(text()).toContain('Escreva a sua crônica com um Narrador de IA.');
    expect(Array.from(document.querySelectorAll('.title-menu-item')).map((i) => i.textContent)).toEqual(['Continuar', 'Nova Crônica', 'Opções']);
    expect(document.documentElement.classList.contains('theme-srcery')).toBe(true);
    expect(document.documentElement.classList.contains('mode-dark')).toBe(true);
    expect(localStorage.getItem('chronicler.theme')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('.title-notice')!.hasAttribute('hidden')).toBe(true);
  });

  it('sem chave avisa e pulsa em Opções; sem crônicas o Continuar fica desabilitado', async () => {
    await boot({ withKey: false });
    await waitFor(() => document.querySelector('.title-menu'), 'menu');
    expect(menuItem('Opções')!.classList.contains('is-pulsing')).toBe(true);
    const notice = document.querySelector('.title-notice')!;
    expect(notice.hasAttribute('hidden')).toBe(false);
    expect(notice.textContent).toContain('Opções');
    const cont = menuItem('Continuar')!;
    expect(cont.getAttribute('aria-disabled')).toBe('true');
    click(cont);
    expect(location.hash).toBe('#/');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('Nova Crônica abre o quadro sobreposto; Esc e Fechar o dispensam voltando ao menu', async () => {
    await boot({ withKey: true });
    await waitFor(() => document.querySelector('.title-menu'), 'menu');
    click(menuItem('Nova Crônica')!);
    await waitFor(() => document.querySelector('[role="dialog"] input[aria-label="Título da crônica"]'), 'quadro');
    expect(location.hash).toBe('#/nova');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await waitFor(() => !document.querySelector('[role="dialog"]'), 'quadro fechado');
    await waitFor(() => location.hash === '#/', 'voltou ao menu');

    click(menuItem('Nova Crônica')!);
    await waitFor(() => document.querySelector('[role="dialog"]'), 'quadro de novo');
    click(byLabel('Fechar')!);
    await waitFor(() => !document.querySelector('[role="dialog"]'), 'fechado pelo botão');
    await waitFor(() => location.hash === '#/', 'menu de novo');
  });

  it('Continuar lista as crônicas, abre uma e permite excluir com confirmação', async () => {
    await openNewChronicleFrame();
    type(document.querySelector<HTMLInputElement>('input[aria-label="Título da crônica"]')!, 'Primeira');
    document.querySelector('[role="dialog"] form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => location.hash.startsWith('#/s/'), 'sessão criada');
    const id = location.hash.slice(4);
    await waitFor(() => text().includes('O Tome está em branco'), 'sessão aberta');

    location.hash = '#/';
    await waitFor(() => document.querySelector('.title-menu'), 'menu');
    expect(menuItem('Continuar')!.getAttribute('aria-disabled')).toBe('false');
    click(menuItem('Continuar')!);
    const link = await waitFor(() => document.querySelector<HTMLAnchorElement>('[role="dialog"] a[href^="#/s/"]'), 'lista');
    expect(link.textContent).toBe('Primeira');
    expect(link.getAttribute('href')).toBe(`#/s/${id}`);

    click(byLabel('Excluir Primeira')!);
    const confirm = await waitFor(
      () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find((b) => b.textContent === 'Excluir' && b.closest('[role="dialog"]')!.textContent!.includes('Excluir crônica')),
      'confirmar',
    );
    click(confirm);
    await waitFor(() => text().includes('Nenhuma crônica ainda'), 'lista vazia');
  });

  it('a página Opções reúne a conexão com o Gemini e a narração por voz', async () => {
    await boot({ withKey: true, hash: '#/opcoes' });
    await waitFor(() => document.querySelector('.options-screen'), 'opções');
    await waitFor(() => document.querySelector('select[aria-label="Modelo padrão global"]'), 'seletor de modelo');
    expect(text()).toContain('Conexão com o Gemini');
    expect(text()).toContain('Narração por voz');
    expect(byLabel('Voltar ao menu inicial')!.getAttribute('href')).toBe('#/');
    expect(document.documentElement.classList.contains('theme-srcery')).toBe(true);
  });

  it('não gera rolagem horizontal no celular: grades de 1 coluna e filhos com min-w-0', async () => {
    await openNewChronicleFrame();
    // Sem `grid-cols-*` explícito a coluna implícita é `auto` e cresce com a <option> mais longa.
    const grids = Array.from(document.querySelectorAll('[role="dialog"] .grid'));
    expect(grids.length).toBeGreaterThanOrEqual(1);
    for (const g of grids) expect(g.className).toMatch(/\bgrid-cols-1\b/);
    for (const g of grids) for (const child of Array.from(g.children)) expect(child.className).toMatch(/\bmin-w-0\b/);
    for (const f of Array.from(document.querySelectorAll('[role="dialog"] select, [role="dialog"] input:not([type=checkbox]), [role="dialog"] textarea'))) {
      expect(f.className).toMatch(/\binput\b/); // `.input` aplica w-full min-w-0 max-w-full
    }
  });

  it('pede a chave nas Opções, valida, lista só modelos de texto e cria uma sessão', async () => {
    await boot({ withKey: false, hash: '#/opcoes' });
    const input = await waitFor(() => document.querySelector<HTMLInputElement>('input[type=password]'), 'campo da chave');
    type(input, FAKE_KEY);
    click(await waitFor(() => button('Validar e salvar'), 'botão validar'));

    await waitFor(() => text().includes('Chave da API do Gemini configurada'), 'chave configurada');
    const select = await waitFor(() => document.querySelector<HTMLSelectElement>('select[aria-label="Modelo padrão global"]'), 'seletor de modelo');
    const labels = Array.from(select.options).map((o) => o.textContent ?? '');
    expect(labels.some((l) => l.includes('gemini-2.5-flash-lite'))).toBe(true);
    expect(labels.some((l) => /image|tts/i.test(l))).toBe(false);

    location.hash = '#/nova';
    type(await waitFor(() => document.querySelector<HTMLInputElement>('input[aria-label="Título da crônica"]'), 'quadro nova'), 'A Queda de Valdoria');
    document.querySelector('[role="dialog"] form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => location.hash.startsWith('#/s/'), 'navegação para a sessão');
    await waitFor(() => text().includes('O Tome está em branco'), 'tome vazio');
    expect(document.title).toContain('A Queda de Valdoria');
    expect(document.documentElement.classList.contains('theme-srcery')).toBe(false);
  });
});

describe('UI — sessão', () => {
  async function openNewSession(): Promise<string> {
    await boot({ withKey: true, hash: '#/nova' });
    await waitFor(() => document.querySelector('[role="dialog"] input[aria-label="Título da crônica"]'), 'home');
    type(document.querySelector<HTMLInputElement>('input[aria-label="Título da crônica"]')!, 'Teste');
    (document.querySelector<HTMLSelectElement>('select[aria-label="Tema"]')!).value = 'cyberpunk';
    document.querySelector('[role="dialog"] form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
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

    // Cada página é um cartão separado, numerado de forma absoluta, com 5 ações (ouvir, reproduzir a partir daqui, editar texto, editar prompt, ramificar) só em ícone sempre visíveis.
    const cards = Array.from(document.querySelectorAll<HTMLElement>('section.page-card[data-page-id]'));
    expect(cards.map((c) => c.querySelector('.page-card-title')?.textContent)).toEqual(['Página 1', 'Página 2']);
    for (const card of cards) {
      const actions = Array.from(card.querySelectorAll<HTMLButtonElement>('.page-card-actions button.page-action'));
      expect(actions.map((b) => b.getAttribute('aria-label'))).toEqual(['Ouvir esta página', 'Reproduzir a partir daqui', 'Editar texto da página', 'Editar prompt e re-gerar', 'Ramificar a partir desta página']);
      for (const b of actions) {
        expect(b.textContent).toBe(''); // só ícone
        expect(b.querySelectorAll('svg').length).toBe(1); // um único ícone por ação
        expect(b.getAttribute('data-tip')).toBeTruthy(); // tooltip
        expect(b.className).not.toMatch(/opacity-0|md:opacity-0|group-hover/); // nunca depende de hover
      }
    }
    const icons = Array.from(cards[0]!.querySelectorAll('.page-card-actions .page-action svg')).map((s) => s.innerHTML);
    expect(new Set(icons).size).toBe(5); // glifos distintos
    // O menu "Opções do áudio" só existe com áudio pronto: sem áudio fica escondido (fora do rodapé visível).
    for (const c of cards) expect(c.querySelector('.page-action-menu')!.parentElement!.classList.contains('hidden')).toBe(true);
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

  it('conduz um diálogo com NPC do gatilho até virar uma página de prosa com as falas literais', async () => {
    await openNewSession();
    gateway.queue(narratorJson('Um mercador surge.', { activate: true, npc_name: 'Mercador', player_name: 'Aldric', dynamic_system_prompt: 'Você é um mercador astuto.' }));
    await send('Entro na feira');
    await waitFor(() => text().includes('Falando com: Mercador'), 'modo diálogo');

    gateway.queue(npcJson('Olá, viajante!', true));
    await send('Bom dia', 'Falar');
    await waitFor(() => text().includes('Mercador: Olá, viajante!'), 'resposta do NPC');
    expect(text()).toContain('Aldric: Bom dia'); // rótulo do jogador inferido pelo Narrador
    expect(text()).toContain('Mercador deseja encerrar a conversa.');
    expect(button('Compactar Crônica')!.disabled).toBe(true);

    // Encerrar chama o Narrador: ele escreve a prosa em volta das falas, que ficam literais.
    const callsBefore = gateway.requests.length;
    gateway.queue(narratorJson('O mercador abriu um sorriso.\n\n— Bom dia, — disse Aldric.\n\n— Olá, viajante! — saudou o mercador.'));
    click(button('Encerrar diálogo')!);
    await waitFor(() => document.querySelectorAll('section.page-card[data-page-id]').length === 2 && !text().includes('Falando com'), 'diálogo encerrado');
    expect(gateway.requests.length).toBe(callsBefore + 1);
    expect(gateway.requests.at(-1)!.userText).toContain('**Aldric:** Bom dia');

    const card = document.querySelectorAll<HTMLElement>('section.page-card[data-page-id]')[1]!;
    expect(card.querySelector('.page-card-title')!.textContent).toBe('Página 2');
    expect(card.querySelector('[data-badge="dialogue"]')!.textContent).toBe('Diálogo com Mercador');
    expect(card.querySelectorAll('.dialogue-speaker')).toHaveLength(0); // página narrada: sem rótulos de falante
    expect(card.textContent).toContain('— Olá, viajante!');
    // A ação "editar prompt" vira "Refazer diálogo" (glifo próprio) nas páginas de diálogo; "Narrar diálogo" só nas cruas.
    const labels = Array.from(card.querySelectorAll('.page-card-actions button.page-action')).map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual(['Ouvir esta página', 'Reproduzir a partir daqui', 'Editar texto da página', 'Refazer diálogo', 'Ramificar a partir desta página']);
    const first = document.querySelector('section.page-card[data-page-index="1"]')!;
    expect(first.querySelector('[data-badge]')).toBeNull();
    expect(first.querySelector('[aria-label="Editar prompt e re-gerar"]')).not.toBeNull();
    expect(first.querySelector('[aria-label="Refazer diálogo"]')).toBeNull();
    expect(first.querySelector('[aria-label="Narrar diálogo"]')).toBeNull();
  });

  it('se o Narrador não mantém as falas em 3 tentativas, grava a transcrição crua; “Narrar diálogo” reprocessa sem tocar nas seguintes', async () => {
    await openNewSession();
    gateway.queue(narratorJson('Um mercador surge.', { activate: true, npc_name: 'Mercador', player_name: 'Aldric', dynamic_system_prompt: 'Você é um mercador astuto.' }));
    await send('Entro na feira');
    await waitFor(() => text().includes('Falando com: Mercador'), 'modo diálogo');
    gateway.queue(npcJson('Olá, viajante!', false));
    await send('Bom dia', 'Falar');
    await waitFor(() => text().includes('Mercador: Olá, viajante!'), 'resposta do NPC');

    const bad = narratorJson('O mercador sorriu.\n\n— Bom dia.');
    gateway.queue(bad, bad, bad);
    click(button('Encerrar diálogo')!);
    await waitFor(() => document.querySelector('[data-badge="dialogue"]') && !text().includes('Falando com'), 'fallback gravado');
    expect(text()).toContain('conseguiu manter as falas intactas');
    const card = () => document.querySelector<HTMLElement>('section.page-card[data-page-index="2"]')!;
    expect(Array.from(card().querySelectorAll('.dialogue-speaker')).map((e) => e.textContent)).toEqual(['Aldric:', 'Mercador:']);
    const labels = Array.from(card().querySelectorAll('.page-card-actions button.page-action')).map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual(['Ouvir esta página', 'Reproduzir a partir daqui', 'Editar texto da página', 'Narrar diálogo', 'Refazer diálogo', 'Ramificar a partir desta página']);

    gateway.queue(narratorJson('A feira seguiu seu curso.'));
    await send('Sigo caminho');
    await waitFor(() => text().includes('A feira seguiu seu curso.'), 'página seguinte');

    // Narrar o diálogo cru: a página vira prosa; a seguinte continua lá, sem esmaecer.
    click(card().querySelector<HTMLElement>('[aria-label="Narrar diálogo"]')!);
    await waitFor(() => document.querySelector('[role=dialog]'), 'confirmação');
    expect(text()).toContain('As demais páginas não mudam');
    gateway.queue(narratorJson('O mercador abriu um sorriso.\n\n— Bom dia, — disse Aldric.\n\n— Olá, viajante! — saudou o mercador.'));
    click(await waitFor(() => button('Narrar diálogo'), 'confirmar'));
    await waitFor(() => card().textContent!.includes('O mercador abriu um sorriso.') && !document.querySelector('.is-ghost'), 'diálogo narrado');
    expect(card().querySelectorAll('.dialogue-speaker')).toHaveLength(0);
    expect(card().querySelector('[aria-label="Narrar diálogo"]')).toBeNull();
    expect(document.querySelectorAll('section.page-card[data-page-id]').length).toBe(3);
    expect(text()).toContain('A feira seguiu seu curso.');
    expect(document.querySelector('.is-dimmed')).toBeNull();
  });

  it('refaz um diálogo sem perdas até encerrar o novo; descartar mantém tudo; editar não mexe nas seguintes', async () => {
    await openNewSession();
    gateway.queue(narratorJson('Um mercador surge.', { activate: true, npc_name: 'Mercador', dynamic_system_prompt: 'Você é um mercador astuto.' }));
    await send('Entro na feira');
    await waitFor(() => text().includes('Falando com: Mercador'), 'modo diálogo');
    gateway.queue(npcJson('Olá, viajante!', false));
    await send('Bom dia', 'Falar');
    await waitFor(() => text().includes('Protagonista: Bom dia'), 'rótulo padrão do jogador');
    gateway.queue(narratorJson('— Bom dia.\n\n— Olá, viajante!'));
    click(button('Encerrar diálogo')!);
    await waitFor(() => document.querySelector('[data-badge="dialogue"]'), 'página de diálogo');
    gateway.queue(narratorJson('A feira ficou para trás.'));
    await send('Sigo caminho');
    await waitFor(() => text().includes('A feira ficou para trás.'), 'página seguinte');

    // Editar o texto da página de diálogo preserva a seguinte (não há re-geração).
    click(document.querySelector<HTMLElement>('section[data-page-index="2"] [aria-label="Editar texto da página"]')!);
    const editor = await waitFor(() => document.querySelector<HTMLTextAreaElement>('section[data-page-id] textarea'), 'editor');
    type(editor, '— Bom dia!\n\n— Salve!');
    click(await waitFor(() => button('Salvar edição'), 'salvar edição'));
    await waitFor(() => text().includes('Salve!'), 'texto editado');
    expect(text()).toContain('A feira ficou para trás.');

    // Refazer: confirmação avisa da página seguinte; o novo diálogo começa sem apagar nada.
    click(document.querySelector<HTMLElement>('[aria-label="Refazer diálogo"]')!);
    await waitFor(() => document.querySelector('[role=dialog]'), 'confirmação');
    expect(text()).toContain('a página seguinte será descartada');
    click(await waitFor(() => button('Refazer diálogo'), 'confirmar'));
    await waitFor(() => text().includes('Refazendo diálogo — Falando com: Mercador'), 'novo diálogo ativo');
    expect(text()).toContain('Será substituída ao encerrar o novo diálogo');
    expect(document.querySelectorAll('section.page-card[data-page-id]').length).toBe(3); // nada foi apagado ainda
    expect(document.querySelector('section[data-page-index="3"]')!.classList.contains('is-dimmed')).toBe(true);

    // Descartar: tudo continua como estava.
    click(button('Descartar')!);
    click(await waitFor(() => Array.from(document.querySelectorAll('[role=dialog] button')).find((b) => b.textContent === 'Descartar'), 'confirmar descarte') as HTMLElement);
    await waitFor(() => !text().includes('Refazendo diálogo'), 'diálogo descartado');
    expect(text()).toContain('Salve!');
    expect(text()).toContain('A feira ficou para trás.');
    expect(document.querySelector('[data-badge="replacing"]')).toBeNull();

    // Refazer de novo e dessa vez encerrar: a página é substituída e a seguinte descartada.
    click(document.querySelector<HTMLElement>('[aria-label="Refazer diálogo"]')!);
    click(await waitFor(() => button('Refazer diálogo'), 'confirmar'));
    await waitFor(() => text().includes('Refazendo diálogo — Falando com: Mercador'), 'novo diálogo');
    gateway.queue(npcJson('Que tal esta mercadoria?', false));
    await send('Mostre-me algo', 'Falar');
    await waitFor(() => text().includes('Mercador: Que tal esta mercadoria?'), 'resposta');
    gateway.queue(narratorJson('— Mostre-me algo.\n\n— Que tal esta mercadoria?'));
    click(await waitFor(() => button(/Encerrar e substituir a página 2/), 'encerrar e substituir'));
    await waitFor(() => !text().includes('Refazendo diálogo') && !text().includes('A feira ficou para trás.') && !document.querySelector('.is-ghost'), 'página substituída');
    const cards = Array.from(document.querySelectorAll<HTMLElement>('section.page-card[data-page-id]'));
    expect(cards.length).toBe(2);
    expect(cards[1]!.textContent).toContain('Que tal esta mercadoria?');
    expect(cards[1]!.textContent).not.toContain('Salve!');
  });

  it('reconecta ao diálogo ativo ao recarregar a página', async () => {
    const id = await openNewSession();
    gateway.queue(narratorJson('Um guarda surge.', { activate: true, npc_name: 'Guarda', dynamic_system_prompt: 'Você é um guarda.' }));
    await send('Avanço');
    await waitFor(() => text().includes('Falando com: Guarda'), 'diálogo');

    // Simula reload: troca de rota e volta, reconstruindo o estado a partir do servidor.
    location.hash = '#/';
    await waitFor(() => text().includes('Continuar'), 'home');
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
    const readOnlyActions = Array.from(document.querySelectorAll('.page-card-actions button.page-action'));
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
      'Voltar ao menu inicial',
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
