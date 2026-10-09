import {
  api,
  ApiError,
  THEMES,
  type ModelsInfo,
  type Session,
  type SettingsInfo,
  type ThemeId,
} from '../api';
import { formatNumber, h, mount, toast, confirmModal } from '../dom';
import { applyTheme, createModeSelect } from '../theme';

const DEFAULT_LIMIT = 1_000_000;

/** Monta um <select> de modelos a partir de /api/models. */
export function modelOptions(models: ModelsInfo, selected: string | null, includeInherit: boolean): HTMLOptionElement[] {
  const opts: HTMLOptionElement[] = [];
  if (includeInherit) {
    opts.push(h('option', { value: '', selected: !selected }, `Padrão global (${models.effective_default_model})`));
  }
  const ids = new Set(models.models.map((m) => m.id));
  // Mantém visível um modelo salvo que a API já não lista.
  if (selected && !ids.has(selected)) {
    opts.push(h('option', { value: selected, selected: true }, `${selected} (indisponível)`));
  }
  for (const m of models.models) {
    const limit = m.inputTokenLimit ? ` — ${formatNumber(m.inputTokenLimit)} tokens de entrada` : '';
    opts.push(
      h(
        'option',
        { value: m.id, selected: (includeInherit ? selected : selected ?? models.effective_default_model) === m.id },
        `${m.displayName || m.id} (${m.id})${limit}`,
      ),
    );
  }
  return opts;
}

export async function renderHome(root: HTMLElement): Promise<void> {
  applyTheme('medieval');
  mount(root, h('p', { class: 'p-8 text-center text-muted' }, 'Abrindo a biblioteca…'));

  let settings: SettingsInfo;
  let sessions: Session[];
  try {
    [settings, { sessions }] = await Promise.all([
      api<SettingsInfo>('GET', '/api/settings'),
      api<{ sessions: Session[] }>('GET', '/api/sessions'),
    ]);
  } catch (err) {
    mount(root, h('p', { class: 'p-8 text-center text-hp-low' }, (err as Error).message));
    return;
  }

  const modelsBox = h('div');
  const keyBox = h('div');
  const defaultSelectHost = h('div');
  const listBox = h('div', { class: 'space-y-2' });
  let models: ModelsInfo = { models: [], default_model: settings.default_model, effective_default_model: settings.default_model, available: false };

  const rerender = () => {
    renderKey();
    renderDefaultModel();
    renderList();
    renderModelSelect();
  };

  async function loadModels(refresh = false): Promise<void> {
    if (!settings.api_key_configured) {
      models = { models: [], default_model: settings.default_model, effective_default_model: settings.default_model, available: false };
      return;
    }
    try {
      models = await api<ModelsInfo>('GET', `/api/models${refresh ? '?refresh=true' : ''}`);
    } catch (err) {
      toast(`Não foi possível listar os modelos: ${(err as Error).message}`, 'error');
    }
  }

  // --- Chave de API ---------------------------------------------------------------------------
  function renderKey() {
    if (settings.api_key_configured) {
      mount(
        keyBox,
        h(
          'div',
          { class: 'flex flex-wrap items-center justify-between gap-2' },
          h('p', { class: 'text-sm' }, h('span', { class: 'text-hp-ok' }, '● '), 'Chave da API do Gemini configurada.'),
          h(
            'button',
            {
              class: 'btn btn-danger',
              type: 'button',
              onClick: async () => {
                if (!(await confirmModal('Remover chave', 'Remover a chave da API deste servidor? Será preciso informá-la novamente para gerar texto.', { danger: true, confirmLabel: 'Remover' }))) return;
                try {
                  settings = { ...settings, ...(await api<Partial<SettingsInfo>>('DELETE', '/api/settings/key')) };
                  await loadModels();
                  rerender();
                  toast('Chave removida.', 'success');
                } catch (err) {
                  toast((err as Error).message, 'error');
                }
              },
            },
            'Remover chave',
          ),
        ),
      );
      return;
    }
    const input = h('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: 'Cole aqui a sua chave da API do Gemini', 'aria-label': 'Chave da API do Gemini' });
    const save = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Validar e salvar');
    mount(
      keyBox,
      h(
        'form',
        {
          class: 'flex flex-col gap-2 sm:flex-row',
          onSubmit: async (e: Event) => {
            e.preventDefault();
            if (!input.value.trim()) return;
            save.disabled = true;
            save.textContent = 'Validando…';
            try {
              await api('POST', '/api/settings/key', { api_key: input.value.trim() });
              settings = { ...settings, api_key_configured: true };
              await loadModels(true);
              settings = await api<SettingsInfo>('GET', '/api/settings');
              rerender();
              toast('Chave validada e salva.', 'success');
            } catch (err) {
              toast((err as Error).message, 'error');
              save.disabled = false;
              save.textContent = 'Validar e salvar';
            }
          },
        },
        input,
        save,
      ),
      h('p', { class: 'mt-2 text-xs text-muted' }, 'A chave fica gravada apenas no banco local deste servidor e nunca é devolvida ao navegador.'),
    );
  }

  // --- Modelo padrão ---------------------------------------------------------------------------
  function renderDefaultModel() {
    if (!settings.api_key_configured) {
      mount(defaultSelectHost, h('p', { class: 'text-sm text-muted' }, `Modelo padrão: ${settings.default_model} (informe a chave para listar os disponíveis).`));
      return;
    }
    const select = h('select', { class: 'input', 'aria-label': 'Modelo padrão global' }, ...modelOptions(models, settings.default_model, false));
    select.addEventListener('change', async () => {
      try {
        await api('PUT', '/api/settings/model', { default_model: select.value });
        settings = { ...settings, default_model: select.value };
        models = { ...models, default_model: select.value, effective_default_model: select.value };
        toast('Modelo padrão atualizado.', 'success');
      } catch (err) {
        toast((err as Error).message, 'error');
      }
    });
    mount(
      defaultSelectHost,
      h('label', { class: 'label' }, 'Modelo padrão'),
      h(
        'div',
        { class: 'flex gap-2' },
        select,
        h('button', { class: 'btn', type: 'button', title: 'Consultar novamente a API', onClick: async () => { await loadModels(true); renderDefaultModel(); toast('Lista de modelos atualizada.', 'success'); } }, 'Atualizar'),
      ),
      !models.available ? h('p', { class: 'mt-1 text-xs text-hp-warn' }, 'Não foi possível consultar a lista de modelos agora.') : null,
    );
  }

  // --- Nova sessão -----------------------------------------------------------------------------
  const titleInput = h('input', { class: 'input', required: true, maxlength: '200', placeholder: 'Ex.: A Queda de Valdoria', 'aria-label': 'Título da crônica' });
  const themeSelect = h('select', { class: 'input', 'aria-label': 'Tema' }, ...THEMES.map((t) => h('option', { value: t.id }, t.label)));
  const limitInput = h('input', { class: 'input', type: 'number', min: '1000', max: '10000000', step: '1000', value: String(DEFAULT_LIMIT), 'aria-label': 'Limite de tokens' });
  const worldInput = h('textarea', { class: 'input min-h-[8rem] font-reading', placeholder: 'Mundo, personagens, regras do universo… (opcional; pode editar depois)', 'aria-label': 'Contexto do mundo' });
  const modelHost = h('div');

  function renderModelSelect() {
    if (!settings.api_key_configured) {
      mount(modelHost, h('p', { class: 'text-xs text-muted' }, 'Usará o modelo padrão.'));
      return;
    }
    mount(modelHost, h('select', { class: 'input', id: 'new-model', 'aria-label': 'Modelo da sessão' }, ...modelOptions(models, null, true)));
  }

  const createForm = h(
    'form',
    {
      class: 'space-y-3',
      onSubmit: async (e: Event) => {
        e.preventDefault();
        const modelSel = document.getElementById('new-model') as HTMLSelectElement | null;
        try {
          const { session } = await api<{ session: Session }>('POST', '/api/sessions', {
            title: titleInput.value.trim(),
            active_theme: themeSelect.value as ThemeId,
            token_limit: Number(limitInput.value) || DEFAULT_LIMIT,
            world_context: worldInput.value,
            model: modelSel && modelSel.value ? modelSel.value : null,
          });
          location.hash = `#/s/${session.id}`;
        } catch (err) {
          toast(err instanceof ApiError ? err.message : 'Não foi possível criar a crônica.', 'error');
        }
      },
    },
    h('div', null, h('label', { class: 'label' }, 'Título'), titleInput),
    h(
      'div',
      { class: 'grid gap-3 sm:grid-cols-2' },
      h('div', null, h('label', { class: 'label' }, 'Tema visual'), themeSelect),
      h('div', null, h('label', { class: 'label' }, 'Limite de tokens (contexto)'), limitInput),
    ),
    h('div', null, h('label', { class: 'label' }, 'Modelo'), modelHost),
    h('div', null, h('label', { class: 'label' }, 'Mundo e personagens'), worldInput),
    h('button', { class: 'btn btn-primary', type: 'submit' }, 'Iniciar nova crônica'),
  );

  // --- Lista -----------------------------------------------------------------------------------
  function renderList() {
    if (sessions.length === 0) {
      mount(listBox, h('p', { class: 'text-sm text-muted' }, 'Nenhuma crônica ainda. Comece uma ao lado.'));
      return;
    }
    mount(
      listBox,
      ...sessions.map((s) =>
        h(
          'div',
          { class: 'flex items-center justify-between gap-2 rounded border border-line bg-main px-3 py-2' },
          h(
            'a',
            { href: `#/s/${s.id}`, class: 'min-w-0 flex-1 truncate font-display text-strong hover:text-accent' },
            s.title,
            h('span', { class: 'ml-2 text-xs text-muted' }, new Date(s.updated_at).toLocaleString('pt-BR')),
          ),
          h(
            'button',
            {
              class: 'btn btn-danger',
              type: 'button',
              'aria-label': `Excluir ${s.title}`,
              onClick: async () => {
                if (!(await confirmModal('Excluir crônica', `Excluir “${s.title}” e todo o seu histórico? Isto não pode ser desfeito.`, { danger: true, confirmLabel: 'Excluir' }))) return;
                try {
                  await api('DELETE', `/api/sessions/${s.id}`);
                  sessions = sessions.filter((x) => x.id !== s.id);
                  renderList();
                } catch (err) {
                  toast((err as Error).message, 'error');
                }
              },
            },
            'Excluir',
          ),
        ),
      ),
    );
  }

  mount(
    root,
    h(
      'main',
      { class: 'mx-auto max-w-5xl space-y-6 p-4 sm:p-8' },
      h(
        'header',
        { class: 'text-center' },
        h('div', { class: 'mb-2 flex justify-end' }, createModeSelect()),
        h('h1', { class: 'font-display text-4xl font-bold text-strong' }, 'Chronicler Engine'),
        h('p', { class: 'mt-1 text-muted' }, 'Escreva a sua crônica com um Narrador de IA.'),
      ),
      h(
        'section',
        { class: 'card space-y-4' },
        h('h2', { class: 'font-display text-lg text-strong' }, 'Conexão com o Gemini'),
        keyBox,
        defaultSelectHost,
      ),
      h(
        'div',
        { class: 'grid gap-6 md:grid-cols-2' },
        h('section', { class: 'card' }, h('h2', { class: 'mb-3 font-display text-lg text-strong' }, 'Nova crônica'), createForm),
        h('section', { class: 'card' }, h('h2', { class: 'mb-3 font-display text-lg text-strong' }, 'Suas crônicas'), listBox),
      ),
    ),
  );

  await loadModels();
  rerender();
}
