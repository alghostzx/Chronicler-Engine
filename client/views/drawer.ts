import { api, type Archive, type ModelsInfo, type Session, type SettingsInfo, type TtsSettingsInfo } from '../api';
import { iconButton } from '../controls';
import { icon } from '../icons';
import { formatNumber, h, mount, paragraphs, toast } from '../dom';
import { modelOptions } from './options';
import { openVolumeExport } from './volumeExport';

export interface DrawerHooks {
  getSession(): Session;
  getArchives(): Archive[];
  /** Sessão atualizada pelo servidor (após salvar). */
  onSessionSaved(session: Session): void;
}

const readLabel = (n: number): string => (n === 1 ? 'Ler a página' : `Ler as ${formatNumber(n)} páginas`);

type Tab = 'mundo' | 'regras' | 'modelo' | 'voz' | 'cronica';

const TABS: { id: Tab; label: string }[] = [
  { id: 'mundo', label: 'Mundo' },
  { id: 'regras', label: 'Regras' },
  { id: 'modelo', label: 'Modelo' },
  { id: 'voz', label: 'Voz' },
  { id: 'cronica', label: 'Crônica' },
];

/**
 * Gaveta de Contexto (docs/interface.md#o-tome-e-a-doca): edição do mundo, regras do Narrador, modelo/limite e leitura
 * dos volumes arquivados. Salvar dispara `onSessionSaved`, que recalcula o HP (docs/narrador.md#hp-do-narrador).
 */
export function createDrawer(hooks: DrawerHooks): { el: HTMLElement; refresh(): void } {
  let tab: Tab = 'mundo';
  let models: ModelsInfo | null = null;
  let defaultRules: string | null = null;

  const tabsBar = h('div', { class: 'flex border-b border-line', role: 'tablist' });
  const content = h('div', { class: 'flex-1 overflow-y-auto p-4' });
  const el = h(
    'aside',
    { class: 'flex h-full w-full flex-col border-l border-line bg-panel', 'aria-label': 'Contexto da sessão' },
    tabsBar,
    content,
  );

  async function save(patch: Partial<Session>, okMessage: string): Promise<void> {
    try {
      const { session } = await api<{ session: Session }>('PUT', `/api/sessions/${hooks.getSession().id}/context`, patch);
      hooks.onSessionSaved(session);
      toast(okMessage, 'success');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  function renderTabs() {
    mount(
      tabsBar,
      ...TABS.map((t) =>
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            'aria-selected': t.id === tab ? 'true' : 'false',
            class: `flex-1 px-2 py-2 font-display text-sm transition ${t.id === tab ? 'border-b-2 border-accent text-accent' : 'text-muted hover:text-ink'}`,
            onClick: () => {
              tab = t.id;
              renderTabs();
              renderContent();
            },
          },
          t.label,
        ),
      ),
    );
  }

  function textareaTab(opts: {
    label: string;
    hint: string;
    value: string;
    field: 'world_context' | 'system_rules';
    allowEmpty: boolean;
    restore?: () => Promise<string | null>;
  }) {
    const ta = h('textarea', { class: 'input min-h-[50vh] flex-1 font-reading text-sm leading-6', 'aria-label': opts.label, value: opts.value });
    const saveBtn = h(
      'button',
      {
        class: 'btn btn-primary',
        type: 'button',
        onClick: async () => {
          if (!opts.allowEmpty && ta.value.trim() === '') {
            toast('Este campo não pode ficar vazio.', 'error');
            return;
          }
          saveBtn.disabled = true;
          await save({ [opts.field]: ta.value } as Partial<Session>, 'Contexto salvo.');
          saveBtn.disabled = false;
        },
      },
      'Salvar',
    );
    mount(
      content,
      h(
        'div',
        { class: 'flex h-full flex-col gap-2' },
        h('p', { class: 'text-xs text-muted' }, opts.hint),
        ta,
        h(
          'div',
          { class: 'flex gap-2' },
          saveBtn,
          opts.restore
            ? h(
                'button',
                {
                  class: 'btn',
                  type: 'button',
                  onClick: async () => {
                    const v = await opts.restore!();
                    if (v !== null) ta.value = v;
                  },
                },
                'Restaurar padrão',
              )
            : null,
        ),
      ),
    );
  }

  async function renderModelTab() {
    const session = hooks.getSession();
    mount(content, h('p', { class: 'text-sm text-muted' }, 'Consultando modelos…'));
    try {
      models ??= await api<ModelsInfo>('GET', '/api/models');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    const select = h(
      'select',
      { class: 'input', 'aria-label': 'Modelo da sessão' },
      ...(models ? modelOptions(models, session.model, true) : [h('option', { value: '' }, 'Padrão global')]),
    );
    const limit = h('input', { class: 'input', type: 'number', min: '1000', max: '10000000', step: '1000', value: String(session.token_limit), 'aria-label': 'Limite de tokens' });
    mount(
      content,
      h(
        'div',
        { class: 'space-y-4' },
        h('div', null, h('label', { class: 'label' }, 'Modelo desta sessão'), select),
        h(
          'div',
          null,
          h('label', { class: 'label' }, 'Limite de tokens'),
          limit,
          h('p', { class: 'mt-1 text-xs text-muted' }, 'Define o “HP” do contexto. Atual: ' + formatNumber(session.token_limit) + ' tokens.'),
        ),
        h(
          'button',
          {
            class: 'btn btn-primary',
            type: 'button',
            onClick: () => {
              const n = Number(limit.value);
              if (!Number.isInteger(n) || n < 1000) {
                toast('Informe um limite inteiro de pelo menos 1.000 tokens.', 'error');
                return;
              }
              void save({ model: select.value || null, token_limit: n }, 'Modelo e limite salvos.');
            },
          },
          'Salvar',
        ),
        h('p', { class: 'text-xs text-muted' }, 'A chave da API e o modelo padrão global ficam em “Opções”, no menu inicial.'),
      ),
    );
  }

  /** Narração automática desta sessão: herda o padrão global (desligado de fábrica), liga ou desliga. */
  async function renderVoiceTab() {
    const session = hooks.getSession();
    mount(content, h('p', { class: 'text-sm text-muted' }, 'Consultando a narração…'));
    let tts: TtsSettingsInfo | null = null;
    try {
      tts = await api<TtsSettingsInfo>('GET', '/api/settings/tts');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    const current = session.tts_auto === null ? 'inherit' : session.tts_auto ? 'on' : 'off';
    const select = h(
      'select',
      { class: 'input', 'aria-label': 'Narração automática desta sessão' },
      h('option', { value: 'inherit', selected: current === 'inherit' }, `Herdar o padrão global (${tts?.auto_default ? 'ligada' : 'desligada'})`),
      h('option', { value: 'on', selected: current === 'on' }, 'Ligada: narrar cada página nova'),
      h('option', { value: 'off', selected: current === 'off' }, 'Desligada: só narrar quando eu pedir'),
    );
    const currentDlg = session.tts_auto_dialogue === null ? 'inherit' : session.tts_auto_dialogue ? 'on' : 'off';
    const selectDlg = h(
      'select',
      { class: 'input', 'aria-label': 'Narração automática dos diálogos desta sessão' },
      h('option', { value: 'inherit', selected: currentDlg === 'inherit' }, `Herdar o padrão global (${tts?.auto_dialogue_default ? 'ligada' : 'desligada'})`),
      h('option', { value: 'on', selected: currentDlg === 'on' }, 'Ligada: narrar cada página de diálogo'),
      h('option', { value: 'off', selected: currentDlg === 'off' }, 'Desligada: só narrar quando eu pedir'),
    );
    mount(
      content,
      h(
        'div',
        { class: 'space-y-4' },
        h('div', null, h('label', { class: 'label' }, 'Narração automática'), select),
        h('div', null, h('label', { class: 'label' }, 'Narração automática dos diálogos'), selectDlg),
        h(
          'p',
          { class: 'text-xs text-muted' },
          'Ligada, o áudio de cada página nova é gerado em segundo plano pela voz configurada, e consome tokens de voz da API. Desligada, use o ícone de alto-falante de cada página para gerar o áudio quando quiser. As falas soltas do Modo Diálogo nunca são narradas: só a página que a conversa vira, depois de encerrada.',
        ),
        h(
          'button',
          {
            class: 'btn btn-primary',
            type: 'button',
            onClick: () =>
              void save(
                {
                  tts_auto: select.value === 'inherit' ? null : select.value === 'on',
                  tts_auto_dialogue: selectDlg.value === 'inherit' ? null : selectDlg.value === 'on',
                },
                'Narração automática salva.',
              ),
          },
          'Salvar',
        ),
        h('p', { class: 'text-xs text-muted' }, 'A voz, o estilo, o modelo de voz e o padrão global ficam em “Narração por voz”, em “Opções” no menu inicial.'),
      ),
    );
  }

  function renderArchiveTab() {
    const archives = hooks.getArchives();
    if (archives.length === 0) {
      mount(content, h('p', { class: 'text-sm text-muted' }, 'Nenhum volume arquivado ainda. Ao compactar a crônica, as sinopses aparecem aqui.'));
      return;
    }
    mount(
      content,
      h(
        'div',
        { class: 'space-y-4' },
        ...archives.map((a) =>
          h(
            'details',
            { class: 'rounded border border-line bg-main p-3', open: archives.length === 1 },
            h('summary', { class: 'cursor-pointer font-display text-strong' }, `Volume ${a.volume_number} — páginas ${a.covered_page_start_index} a ${a.covered_page_end_index}`),
            h('div', { class: 'mt-3 space-y-2 text-sm leading-6' }, ...paragraphs(a.summary_text).map((p) => h('p', null, p))),
            h(
              'div',
              { class: 'mt-3 flex items-center gap-2' },
              h('a', { class: 'btn', href: `#/s/${a.session_id}/v/${a.volume_number}` }, icon('book', 16), readLabel(a.covered_page_end_index - a.covered_page_start_index + 1)),
              iconButton({ icon: 'download', label: `Salvar Volume ${a.volume_number} em Markdown`, tip: 'Salvar este volume como arquivo Markdown (.md)', align: 'start', up: true, onClick: () => openVolumeExport(a) }),
            ),
          ),
        ),
      ),
    );
  }

  async function ensureDefaultRules(): Promise<string | null> {
    if (defaultRules !== null) return defaultRules;
    try {
      defaultRules = (await api<SettingsInfo>('GET', '/api/settings')).default_system_rules;
      return defaultRules;
    } catch (err) {
      toast((err as Error).message, 'error');
      return null;
    }
  }

  function renderContent() {
    const session = hooks.getSession();
    if (tab === 'mundo') {
      textareaTab({
        label: 'Contexto do mundo',
        hint: 'Mundo, personagens e regras do universo. Os volumes compactados da crônica são anexados aqui, sob “Crônica — Volume N”.',
        value: session.world_context,
        field: 'world_context',
        allowEmpty: true,
      });
    } else if (tab === 'regras') {
      textareaTab({
        label: 'Regras do Narrador',
        hint: 'Instruções permanentes de sistema enviadas ao Narrador em todo turno.',
        value: session.system_rules,
        field: 'system_rules',
        allowEmpty: false,
        restore: ensureDefaultRules,
      });
    } else if (tab === 'modelo') {
      void renderModelTab();
    } else if (tab === 'voz') {
      void renderVoiceTab();
    } else {
      renderArchiveTab();
    }
  }

  renderTabs();
  renderContent();
  return {
    el,
    refresh() {
      renderTabs();
      renderContent();
    },
  };
}
