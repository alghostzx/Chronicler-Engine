import { api, type ModelsInfo, type SettingsInfo } from '../api';
import { formatNumber, h, mount, toast, confirmModal } from '../dom';
import { applyTitleScreen } from '../theme';
import { createTtsSettingsCard } from './ttsSettings';
import { iconButton, fullscreenButton } from '../controls';

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

/**
 * Página de Opções (`#/opcoes`): conexão com o Gemini (chave e modelo padrão) e narração por voz.
 * Usa a mesma paleta Srcery da tela inicial.
 */
export async function renderOptions(root: HTMLElement): Promise<void> {
  applyTitleScreen();
  mount(root, h('p', { class: 'p-8 text-center text-muted' }, 'Abrindo as opções…'));

  let settings: SettingsInfo;
  try {
    settings = await api<SettingsInfo>('GET', '/api/settings');
  } catch (err) {
    mount(root, h('p', { class: 'p-8 text-center text-hp-low' }, (err as Error).message), h('p', { class: 'text-center' }, h('a', { href: '#/', class: 'btn' }, 'Voltar ao menu')));
    return;
  }

  const keyBox = h('div');
  const defaultSelectHost = h('div');
  let models: ModelsInfo = { models: [], default_model: settings.default_model, effective_default_model: settings.default_model, available: false };

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

  const rerender = () => {
    renderKey();
    renderDefaultModel();
  };

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
        { class: 'flex min-w-0 gap-2' },
        select,
        h('button', { class: 'btn shrink-0', type: 'button', title: 'Consultar novamente a API', onClick: async () => { await loadModels(true); renderDefaultModel(); toast('Lista de modelos atualizada.', 'success'); } }, 'Atualizar'),
      ),
      !models.available ? h('p', { class: 'mt-1 text-xs text-hp-warn' }, 'Não foi possível consultar a lista de modelos agora.') : null,
    );
  }

  document.title = 'Opções — Chronicler Engine';
  const tools = fullscreenButton();
  mount(
    root,
    h(
      'div',
      { class: 'options-screen' },
      h(
        'main',
        { class: 'mx-auto w-full min-w-0 max-w-3xl space-y-6' },
        h(
          'header',
          { class: 'flex items-center gap-3' },
          iconButton({ icon: 'back', label: 'Voltar ao menu inicial', tip: 'Voltar ao menu inicial', align: 'start', href: '#/' }),
          h('h1', { class: 'min-w-0 flex-1 truncate font-display text-2xl font-bold text-strong' }, 'Opções'),
          tools,
        ),
        h(
          'section',
          { class: 'card min-w-0 space-y-4', 'aria-label': 'Conexão com o Gemini' },
          h('h2', { class: 'font-display text-lg text-strong' }, 'Conexão com o Gemini'),
          keyBox,
          defaultSelectHost,
        ),
        createTtsSettingsCard(),
      ),
    ),
  );

  await loadModels();
  rerender();
}
