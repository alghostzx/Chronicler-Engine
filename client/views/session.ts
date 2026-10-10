import {
  api,
  ApiError,
  streamTurn,
  type Page,
  type Dialogue,
  type DialogueMessage,
  type SessionDetail,
  type ThemeId,
  type TokenInfo,
  type Session,
} from '../api';
import { downloadStoryMarkdown } from '../download';
import { confirmModal, countPages, formatNumber, h, mount, openModal, paragraphs, toast } from '../dom';
import { applyTheme } from '../theme';
import { createModeControl, createThemeControl, iconButton } from '../controls';
import { pageCard, pageHeader } from '../pageCard';
import { openCompaction } from './compaction';
import { createDrawer } from './drawer';

interface DialogueState {
  dialogue: Dialogue;
  messages: DialogueMessage[];
  /** O NPC sinalizou que quer encerrar (`npc_wants_to_end`): destaca o botão de encerrar. */
  wantsEnd: boolean;
  /** Aguardando a resposta do NPC. */
  waiting: boolean;
}

interface Ghost {
  text: string;
  /** Página sendo regenerada (o fantasma ocupa o seu lugar); undefined = nova página no fim. */
  replaceId?: string;
}

const HP_COLORS: Record<TokenInfo['state'], string> = {
  green: 'bg-hp-ok',
  yellow: 'bg-hp-warn',
  red: 'bg-hp-low',
};

/**
 * Tela da sessão: Tome Interativo (uma folha por página), Gaveta de Contexto e Doca de Ação
 * (design §7.1). Retorna a função de limpeza chamada pelo roteador ao sair da tela.
 */
export async function renderSession(root: HTMLElement, sessionId: string): Promise<() => void> {
  mount(root, h('p', { class: 'p-8 text-center text-muted' }, 'Abrindo o Tome…'));

  let detail: SessionDetail;
  try {
    detail = await api<SessionDetail>('GET', `/api/sessions/${sessionId}`);
  } catch (err) {
    mount(
      root,
      h(
        'div',
        { class: 'p-8 text-center' },
        h('p', { class: 'text-hp-low' }, (err as Error).message),
        h('a', { href: '#/', class: 'btn mt-4' }, 'Voltar à biblioteca'),
      ),
    );
    return () => {};
  }

  // --- Estado ---------------------------------------------------------------------------------
  let tokens: TokenInfo | null = null;
  let tokensError = false;
  let busy = false;
  let ghost: Ghost | null = null;
  let dlg: DialogueState | null = null;
  let editingId: string | null = null;
  let drawerOpen = false;
  let controller: AbortController | null = null;
  let disposed = false;

  const session = (): Session => detail.session;
  applyTheme(session().active_theme);
  document.title = `${session().title} — Chronicler Engine`;

  // --- Elementos fixos --------------------------------------------------------------------------
  const tomeScroll = h('div', { class: 'flex-1 overflow-y-auto', id: 'tome-scroll' });
  const tomePage = h('article', { class: 'mx-auto max-w-3xl space-y-6 px-3 py-6 font-reading text-lg text-ink sm:px-5 sm:py-8 prose-tome-host' });
  tomeScroll.appendChild(tomePage);
  const dock = h('footer', { class: 'border-t border-line bg-panel px-4 py-3' });
  const titleEl = h('h1', { class: 'min-w-0 flex-1 truncate font-display text-lg text-strong' }, session().title);
  const drawerWrap = h('div', { class: 'hidden absolute inset-y-0 right-0 z-30 w-full max-w-md lg:static lg:z-auto lg:w-[26rem] lg:max-w-none' });

  const drawer = createDrawer({
    getSession: session,
    getArchives: () => detail.archives,
    onSessionSaved: (s) => {
      detail = { ...detail, session: s };
      titleEl.textContent = s.title;
      void refreshTokens(); // evento: contexto salvo → recalcula o HP
    },
  });
  drawerWrap.appendChild(drawer.el);

  const themeControl = createThemeControl(session().active_theme, async (theme) => {
    applyTheme(theme);
    try {
      const { session: s } = await api<{ session: Session }>('PUT', `/api/sessions/${sessionId}/context`, { active_theme: theme });
      detail = { ...detail, session: s };
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  });

  const drawerBtn = iconButton({ icon: 'panel', label: 'Contexto da sessão', tip: 'Mostrar ou ocultar o contexto (mundo, personagens e crônica)', align: 'end', onClick: () => toggleDrawer() });
  drawerBtn.setAttribute('aria-expanded', 'false');
  const exportBtn = iconButton({ icon: 'download', label: 'Salvar em Markdown', tip: 'Salvar a crônica como arquivo Markdown (.md)', align: 'end', onClick: () => openExport() });

  function openExport(): void {
    const withContext = h('input', { type: 'checkbox', id: 'export-context', class: 'mr-2' });
    const go = h('button', { class: 'btn btn-primary', type: 'button' }, 'Baixar arquivo .md');
    const modal = openModal(
      'Salvar crônica em Markdown',
      h(
        'div',
        { class: 'space-y-3' },
        h('p', { class: 'text-sm text-muted' }, 'O arquivo contém o título e toda a prosa da crônica, inclusive os capítulos já compactados. Suas instruções (prompts) não são incluídas.'),
        h('label', { class: 'flex items-center text-sm text-ink', for: 'export-context' }, withContext, 'Incluir o mundo, os personagens e as sinopses dos volumes'),
        h('div', { class: 'flex justify-end gap-2' }, h('button', { class: 'btn', type: 'button', onClick: () => modal.close() }, 'Cancelar'), go),
      ),
    );
    go.addEventListener('click', async () => {
      go.disabled = true;
      try {
        const name = await downloadStoryMarkdown(sessionId, withContext.checked);
        toast(`Arquivo “${name}” gerado.`, 'success');
        modal.close();
      } catch (err) {
        go.disabled = false;
        toast((err as Error).message, 'error');
      }
    });
  }

  function toggleDrawer(): void {
    drawerOpen = !drawerOpen;
    drawerWrap.classList.toggle('hidden', !drawerOpen);
    drawerBtn.setAttribute('aria-expanded', String(drawerOpen));
    if (drawerOpen) drawer.refresh();
  }

  mount(
    root,
    h(
      'div',
      { class: 'flex h-screen flex-col' },
      h(
        'header',
        { class: 'flex items-center gap-2 border-b border-line bg-panel px-3 py-2' },
        iconButton({ icon: 'library', label: 'Voltar à biblioteca', tip: 'Voltar à biblioteca de crônicas', align: 'start', href: '#/' }),
        titleEl,
        themeControl.el,
        createModeControl(),
        exportBtn,
        drawerBtn,
      ),
      h('div', { class: 'relative flex min-h-0 flex-1' }, h('main', { class: 'flex min-w-0 flex-1 flex-col' }, tomeScroll, dock), drawerWrap),
    ),
  );

  // --- Dados ---------------------------------------------------------------------------------------
  /** Recalcula o HP. Chamado apenas por eventos (abrir, página gerada/regenerada, edição, contexto, compactação). */
  async function refreshTokens(): Promise<void> {
    try {
      tokens = await api<TokenInfo>('GET', `/api/sessions/${sessionId}/token-count`);
      tokensError = false;
    } catch {
      tokensError = true;
    }
    if (!disposed) renderDock();
  }

  async function reloadDetail(): Promise<void> {
    detail = await api<SessionDetail>('GET', `/api/sessions/${sessionId}`);
    drawer.refresh();
  }

  async function loadDialogue(): Promise<void> {
    try {
      const r = await api<{ dialogue: Dialogue | null; messages: DialogueMessage[] }>('GET', `/api/sessions/${sessionId}/dialogue/active`);
      dlg = r.dialogue ? { dialogue: r.dialogue, messages: r.messages, wantsEnd: dlg?.dialogue.id === r.dialogue.id ? dlg.wantsEnd : false, waiting: false } : null;
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  function setBusy(v: boolean): void {
    busy = v;
    renderDock();
    renderTome(false);
  }

  // --- Tome ------------------------------------------------------------------------------------------
  function nearBottom(): boolean {
    return tomeScroll.scrollHeight - tomeScroll.scrollTop - tomeScroll.clientHeight < 160;
  }
  function scrollToEnd(): void {
    tomeScroll.scrollTop = tomeScroll.scrollHeight;
  }

  let ghostTextEl: HTMLElement | null = null;

  /** Número da próxima página (absoluto): considera também as páginas já consumidas pelos volumes. */
  function nextPageIndex(): number {
    const active = detail.pages.reduce((m, x) => Math.max(m, x.order_index), 0);
    const archived = detail.archives.reduce((m, x) => Math.max(m, x.covered_page_end_index), 0);
    return Math.max(active, archived) + 1;
  }

  function ghostArticle(): HTMLElement {
    const replaced = ghost?.replaceId ? detail.pages.find((x) => x.id === ghost!.replaceId) : undefined;
    ghostTextEl = h('div', { class: 'cursor-blink whitespace-pre-wrap leading-8', 'aria-live': 'polite' }, ghost?.text ?? '');
    return h('section', { class: 'page-card is-ghost', 'aria-label': 'Página sendo escrita' }, pageHeader(replaced?.order_index ?? nextPageIndex()), h('div', { class: 'page-card-body' }, ghostTextEl));
  }

  function pageArticle(b: Page, dimmed: boolean): HTMLElement {
    if (editingId === b.id) return editArticle(b);
    const laterCount = detail.pages.filter((x) => x.order_index > b.order_index).length;
    return pageCard({
      page: b,
      dimmed,
      dropCap: b.order_index === 1,
      busy: busy || !!dlg,
      laterCount,
      onEditText: () => {
        editingId = b.id;
        renderTome(false);
      },
      onEditPrompt: () => openRegenerate(b),
      onBranch: () => void branchFrom(b, laterCount),
    });
  }

  function editArticle(b: Page): HTMLElement {
    const ta = h('textarea', { class: 'input min-h-[12rem] font-reading text-base leading-7', 'aria-label': 'Editar página', value: b.generated_text });
    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Salvar edição');
    saveBtn.addEventListener('click', async () => {
      if (ta.value.trim() === '') {
        toast('O texto da página não pode ficar vazio.', 'error');
        return;
      }
      saveBtn.disabled = true;
      try {
        const { page } = await api<{ page: Page }>('PUT', `/api/narrative/pages/${b.id}`, { generated_text: ta.value });
        detail = { ...detail, pages: detail.pages.map((x) => (x.id === page.id ? page : x)) };
        editingId = null;
        renderTome(false);
        void refreshTokens(); // evento: edição
      } catch (err) {
        saveBtn.disabled = false;
        toast((err as Error).message, 'error');
      }
    });
    queueMicrotask(() => ta.focus());
    return h(
      'section',
      { class: 'page-card is-editing', 'data-page-id': b.id, 'data-page-index': String(b.order_index) },
      pageHeader(b.order_index),
      h('div', { class: 'page-card-body' }, ta),
      h(
        'footer',
        { class: 'page-card-actions flex-wrap justify-start' },
        saveBtn,
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onClick: () => {
              editingId = null;
              renderTome(false);
            },
          },
          'Cancelar',
        ),
        h('p', { class: 'self-center text-xs text-muted' }, 'A edição manual preserva as páginas seguintes.'),
      ),
    );
  }

  function dialogueCard(): HTMLElement | null {
    if (!dlg) return null;
    const d = dlg;
    return h(
      'section',
      { class: 'card border-accent font-sans text-base', 'aria-label': `Diálogo com ${d.dialogue.npc_name}` },
      h('h3', { class: 'mb-3 font-display text-sm uppercase tracking-wider text-accent' }, `Diálogo — ${d.dialogue.npc_name}`),
      d.messages.length === 0 ? h('p', { class: 'text-sm text-muted' }, `Diga algo a ${d.dialogue.npc_name} para começar a conversa.`) : null,
      h(
        'div',
        { class: 'space-y-2' },
        ...d.messages.map((m) =>
          h(
            'p',
            { class: m.sender === 'npc' ? 'text-ink' : 'text-muted italic' },
            h('strong', { class: m.sender === 'npc' ? 'text-accent' : 'text-strong' }, m.sender === 'npc' ? `${d.dialogue.npc_name}: ` : 'Você: '),
            m.content,
          ),
        ),
        d.waiting ? h('p', { class: 'cursor-blink text-muted' }, `${d.dialogue.npc_name} está respondendo…`) : null,
      ),
    );
  }

  /** Reconstrói o Tome. `stick` força a rolagem ao fim (novo conteúdo). */
  function renderTome(stick: boolean): void {
    const follow = stick || nearBottom();
    const target = ghost?.replaceId ? detail.pages.find((b) => b.id === ghost!.replaceId) : undefined;
    const items: (HTMLElement | null)[] = [];

    if (detail.pages.length === 0 && !ghost && !dlg) {
      items.push(
        h(
          'div',
          { class: 'py-16 text-center text-muted' },
          h('p', { class: 'font-display text-2xl text-strong' }, 'O Tome está em branco'),
          h('p', { class: 'mt-2 text-base' }, 'Descreva a cena inicial ou a primeira ação do seu personagem na Doca abaixo.'),
        ),
      );
    }
    for (const b of detail.pages) {
      if (ghost && ghost.replaceId === b.id) items.push(ghostArticle());
      else items.push(pageArticle(b, !!target && b.order_index > target.order_index));
    }
    if (ghost && !ghost.replaceId) items.push(ghostArticle());
    items.push(dialogueCard());
    mount(tomePage, ...items);
    if (!ghost) ghostTextEl = null;
    if (follow) scrollToEnd();
  }

  // --- Doca de Ação ---------------------------------------------------------------------------------
  let inputValue = '';
  let dockTa: HTMLTextAreaElement | null = null;
  function hpBar(): HTMLElement {
    if (!tokens) {
      return h('p', { class: 'text-xs text-muted' }, tokensError ? 'HP do contexto indisponível (verifique a chave da API).' : 'Calculando o HP do contexto…');
    }
    const pct = Math.max(0, Math.min(100, tokens.hp_percent));
    return h(
      'div',
      { class: 'flex items-center gap-3', title: `Modelo: ${tokens.model}` },
      h('span', { class: 'font-display text-xs uppercase tracking-wider text-muted' }, 'HP'),
      h(
        'div',
        { class: 'h-2 flex-1 overflow-hidden rounded bg-main ring-1 ring-line', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct)), 'aria-label': 'HP do contexto' },
        h('div', { class: `h-full transition-all ${HP_COLORS[tokens.state]}`, style: `width:${pct}%` }),
      ),
      h('span', { class: 'whitespace-nowrap text-xs text-muted' }, `${pct.toFixed(0)}% — ${formatNumber(tokens.tokens_used)} / ${formatNumber(tokens.token_limit)} tokens`),
    );
  }

  function renderDock(): void {
    const hadFocus = !!dockTa && document.activeElement === dockTa;
    const selStart = dockTa?.selectionStart ?? 0;
    const selEnd = dockTa?.selectionEnd ?? 0;
    const inDialogue = !!dlg;
    const ta = h('textarea', {
      class: 'input min-h-[3.5rem] flex-1 resize-y font-reading',
      rows: '2',
      value: inputValue,
      disabled: busy || (inDialogue && dlg!.waiting),
      'aria-label': inDialogue ? 'Sua fala' : 'Instrução para o Narrador',
      placeholder: inDialogue ? `Fale com ${dlg!.dialogue.npc_name}…` : 'O que o seu personagem faz? Descreva a ação, a cena ou a direção da história… (Ctrl+Enter envia)',
    });
    ta.addEventListener('input', () => {
      inputValue = ta.value;
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void submit();
      }
    });
    const send = h(
      'button',
      { class: 'btn btn-primary self-stretch px-5', type: 'button', disabled: busy || (inDialogue && dlg!.waiting), onClick: () => void submit() },
      busy ? 'Narrando…' : inDialogue ? 'Falar' : 'Enviar',
    );

    const red = tokens?.state === 'red';
    const compact = h(
      'button',
      {
        class: `btn ${red && !inDialogue ? 'btn-pulse' : ''}`,
        type: 'button',
        disabled: busy || inDialogue,
        title: inDialogue ? 'Encerre o diálogo antes de compactar.' : 'Resume os capítulos antigos para liberar contexto',
        onClick: () => void compactChronicle(),
      },
      'Compactar Crônica',
    );

    const dialogueBar = dlg
      ? h(
          'div',
          { class: 'mb-2 flex flex-wrap items-center gap-2' },
          h('span', { class: 'font-display text-sm text-accent' }, `Falando com: ${dlg.dialogue.npc_name}`),
          dlg.wantsEnd ? h('span', { class: 'text-xs text-hp-warn' }, `${dlg.dialogue.npc_name} deseja encerrar a conversa.`) : null,
          h(
            'button',
            { class: `btn ${dlg.wantsEnd ? 'btn-primary btn-pulse' : ''}`, type: 'button', disabled: busy || dlg.waiting, onClick: () => void concludeDialogue() },
            'Encerrar Diálogo e Narrar',
          ),
          h('button', { class: 'btn btn-danger', type: 'button', disabled: busy || dlg.waiting, onClick: () => void cancelDialogue() }, 'Descartar'),
        )
      : null;

    mount(
      dock,
      h(
        'div',
        { class: 'mx-auto max-w-3xl space-y-2' },
        h('div', { class: 'flex flex-wrap items-center gap-x-3 gap-y-2' }, h('div', { class: 'min-w-[16rem] flex-1' }, hpBar()), compact),
        dialogueBar,
        h('div', { class: 'flex gap-2' }, ta, send),
      ),
    );
    // Preserva foco e cursor quando a doca é reconstruída (ex.: HP recalculado enquanto o jogador digita).
    if (hadFocus) {
      ta.focus();
      ta.setSelectionRange(selStart, selEnd);
    } else if (!busy && !(inDialogue && dlg!.waiting) && document.activeElement === document.body && !editingId && !document.querySelector('[role=dialog]')) {
      ta.focus();
    }
    dockTa = ta;
  }

  // --- Ações ----------------------------------------------------------------------------------------
  /** Executa um turno narrativo (SSE). Retorna true se uma página foi persistida. */
  async function runTurn(url: string, body: unknown, replaceId?: string): Promise<boolean> {
    if (busy) return false;
    controller = new AbortController();
    ghost = { text: '', replaceId };
    ghostTextEl = null;
    setBusy(true);
    renderTome(true);

    let gotPage = false;
    let newDialogue = false;
    try {
      await streamTurn(
        url,
        body,
        {
          onChunk: (text) => {
            if (!ghost) return;
            ghost.text += text;
            const follow = nearBottom();
            if (ghostTextEl) ghostTextEl.textContent = ghost.text;
            if (follow) scrollToEnd();
          },
          onPage: () => {
            gotPage = true;
          },
          onDialogueTrigger: () => {
            newDialogue = true;
          },
          onError: (message) => toast(message, 'error'),
        },
        controller.signal,
      );
    } catch (err) {
      toast(err instanceof ApiError ? (err.code === 'missing_api_key' ? 'Configure a chave da API na tela inicial.' : err.message) : 'Falha inesperada.', 'error');
    }
    controller = null;
    if (disposed) return gotPage;

    ghost = null;
    try {
      if (gotPage) {
        await reloadDetail();
        if (newDialogue || dlg) await loadDialogue();
      }
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    busy = false;
    renderTome(gotPage);
    renderDock();
    if (gotPage) void refreshTokens(); // evento: página gerada/regenerada
    return gotPage;
  }

  async function submit(): Promise<void> {
    const text = inputValue.trim();
    if (text === '' || busy) return;
    if (dlg) {
      await sendDialogueMessage(text);
      return;
    }
    const ok = await runTurn(`/api/sessions/${sessionId}/narrative/next`, { player_instruction: text });
    if (ok) {
      inputValue = '';
      renderDock();
    }
  }

  function openRegenerate(b: Page): void {
    const later = detail.pages.filter((x) => x.order_index > b.order_index).length;
    const ta = h('textarea', {
      class: 'input min-h-[8rem]',
      'aria-label': 'Instrução do jogador',
      value: b.player_instruction ?? '',
      placeholder: 'Descreva o que deve acontecer neste trecho…',
    });
    const go = h('button', { class: `btn btn-primary ${later > 0 ? 'btn-danger' : ''}`, type: 'button' }, later > 0 ? `Re-gerar e descartar ${countPages(later)}` : 'Re-gerar');
    const modal = openModal(
      'Prompt de Origem',
      h(
        'div',
        { class: 'space-y-3' },
        h('p', { class: 'text-sm text-muted' }, 'Esta é a instrução que originou a página. Edite-a (se quiser) e peça ao Narrador para reescrevê-la.'),
        ta,
        later > 0
          ? h(
              'p',
              { class: 'rounded border border-hp-low p-2 text-sm text-hp-low' },
              `Atenção: re-gerar esta página descarta definitivamente ${later === 1 ? 'a página seguinte' : `as ${countPages(later)} seguintes`}, pois a história posterior deixaria de fazer sentido. O texto atual só é substituído se a geração der certo.`,
            )
          : null,
        h('div', { class: 'flex justify-end gap-2' }, h('button', { class: 'btn', type: 'button', onClick: () => modal.close() }, 'Cancelar'), go),
      ),
    );
    go.addEventListener('click', () => {
      const instruction = ta.value.trim();
      if (instruction === '') {
        toast('Informe a instrução do jogador.', 'error');
        return;
      }
      modal.close();
      void runTurn(`/api/narrative/pages/${b.id}/regenerate`, { player_instruction: instruction, confirm_truncate: later > 0 }, b.id);
    });
  }

  async function branchFrom(b: Page, later: number): Promise<void> {
    if (later === 0) {
      toast('Esta já é a última página; continue a história na Doca.', 'info');
      return;
    }
    const ok = await confirmModal(
      'Ramificar a partir daqui',
      `A história volta a este ponto e ${later === 1 ? 'a página seguinte será descartada' : `as ${countPages(later)} seguintes serão descartadas`} definitivamente. Deseja continuar?`,
      { danger: true, confirmLabel: 'Descartar e ramificar' },
    );
    if (!ok) return;
    try {
      await api('POST', `/api/narrative/pages/${b.id}/branch`, { confirm_truncate: true });
      await reloadDetail();
      renderTome(true);
      void refreshTokens();
      toast('Ramificação criada. Continue a história a partir desta página.', 'success');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  async function compactChronicle(): Promise<void> {
    if (busy || dlg) return;
    const ok = await openCompaction(sessionId);
    if (!ok) return;
    try {
      await reloadDetail();
      renderTome(false);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    void refreshTokens(); // evento: compactação consolidada
  }

  // --- Diálogo ----------------------------------------------------------------------------------------
  async function sendDialogueMessage(text: string): Promise<void> {
    if (!dlg || dlg.waiting) return;
    const state = dlg;
    state.waiting = true;
    renderTome(true);
    renderDock();
    try {
      const r = await api<{ player_message: DialogueMessage; npc_message: DialogueMessage; npc_wants_to_end: boolean }>(
        'POST',
        `/api/dialogue/${state.dialogue.id}/message`,
        { message: text },
      );
      state.messages = [...state.messages, r.player_message, r.npc_message];
      state.wantsEnd = r.npc_wants_to_end;
      inputValue = '';
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    state.waiting = false;
    if (disposed) return;
    renderTome(true);
    renderDock();
  }

  async function concludeDialogue(): Promise<void> {
    if (!dlg || busy) return;
    if (dlg.messages.length === 0) {
      toast('Troque ao menos uma fala antes de encerrar, ou use “Descartar”.', 'info');
      return;
    }
    const id = dlg.dialogue.id;
    const ok = await runTurn(`/api/dialogue/${id}/conclude`, {});
    if (ok) {
      await loadDialogue();
      renderTome(true);
      renderDock();
    }
  }

  async function cancelDialogue(): Promise<void> {
    if (!dlg) return;
    const yes = await confirmModal('Descartar diálogo', 'Descartar esta conversa? Nada dela será narrado na crônica.', { danger: true, confirmLabel: 'Descartar' });
    if (!yes) return;
    try {
      await api('POST', `/api/dialogue/${dlg.dialogue.id}/cancel`);
      dlg = null;
      renderTome(false);
      renderDock();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  // --- Início ------------------------------------------------------------------------------------------
  if (detail.active_dialogue) await loadDialogue(); // reconexão pós-reload
  renderTome(true);
  renderDock();
  void refreshTokens(); // evento: abrir a sessão

  return () => {
    disposed = true;
    controller?.abort();
    document.title = 'Chronicler Engine';
  };
}
