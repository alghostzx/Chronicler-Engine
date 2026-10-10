import { api, ApiError, THEMES, type ModelsInfo, type Session, type SettingsInfo, type ThemeId } from '../api';
import { fullscreenButton } from '../controls';
import { h, mount, openModal, toast, confirmModal, type ModalHandle } from '../dom';
import { applyTitleScreen } from '../theme';
import { modelOptions } from './options';

const DEFAULT_LIMIT = 1_000_000;

/** Estados da tela de título: só o menu ou um quadro sobreposto (rotas `#/`, `#/continuar`, `#/nova`). */
export type TitleView = 'menu' | 'continuar' | 'nova';

export interface TitleHandle {
  /** Troca o quadro exibido sem recarregar nada (rotas da própria tela de título). */
  show(view: TitleView): void;
  dispose(): void;
}

/**
 * Tela de título: logo (SVG, paleta Srcery), legenda e menu Continuar / Nova Crônica / Opções.
 * Continuar e Nova Crônica abrem quadros sobre o menu (com o fundo escurecido); Opções é uma página.
 */
export async function renderTitle(root: HTMLElement, initial: TitleView): Promise<TitleHandle> {
  applyTitleScreen();
  document.title = 'Chronicler Engine';
  mount(root, h('p', { class: 'p-8 text-center text-muted' }, 'Abrindo a crônica…'));

  let settings: SettingsInfo;
  let sessions: Session[];
  try {
    [settings, { sessions }] = await Promise.all([
      api<SettingsInfo>('GET', '/api/settings'),
      api<{ sessions: Session[] }>('GET', '/api/sessions'),
    ]);
  } catch (err) {
    mount(root, h('p', { class: 'p-8 text-center text-hp-low' }, (err as Error).message));
    return { show: () => undefined, dispose: () => undefined };
  }
  let models: ModelsInfo = { models: [], default_model: settings.default_model, effective_default_model: settings.default_model, available: false };
  if (settings.api_key_configured) {
    try {
      models = await api<ModelsInfo>('GET', '/api/models');
    } catch {
      /* sem a lista, o formulário usa o modelo padrão */
    }
  }

  // --- Quadro "Nova Crônica" ------------------------------------------------------------------
  function createForm(): HTMLFormElement {
    const titleInput = h('input', { class: 'input', required: true, maxlength: '200', placeholder: 'Ex.: A Queda de Valdoria', 'aria-label': 'Título da crônica' });
    const themeSelect = h('select', { class: 'input', 'aria-label': 'Tema' }, ...THEMES.map((t) => h('option', { value: t.id }, t.label)));
    const limitInput = h('input', { class: 'input', type: 'number', min: '1000', max: '10000000', step: '1000', value: String(DEFAULT_LIMIT), 'aria-label': 'Limite de tokens' });
    const worldInput = h('textarea', { class: 'input min-h-[8rem] font-reading', placeholder: 'Mundo, personagens, regras do universo… (opcional; pode editar depois)', 'aria-label': 'Contexto do mundo' });
    const modelSelect = settings.api_key_configured ? h('select', { class: 'input', 'aria-label': 'Modelo da sessão' }, ...modelOptions(models, null, true)) : null;
    return h(
      'form',
      {
        class: 'space-y-3',
        onSubmit: async (e: Event) => {
          e.preventDefault();
          try {
            const { session } = await api<{ session: Session }>('POST', '/api/sessions', {
              title: titleInput.value.trim(),
              active_theme: themeSelect.value as ThemeId,
              token_limit: Number(limitInput.value) || DEFAULT_LIMIT,
              world_context: worldInput.value,
              model: modelSelect && modelSelect.value ? modelSelect.value : null,
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
        { class: 'grid grid-cols-1 gap-3 sm:grid-cols-2' },
        h('div', { class: 'min-w-0' }, h('label', { class: 'label' }, 'Tema visual'), themeSelect),
        h('div', { class: 'min-w-0' }, h('label', { class: 'label' }, 'Limite de tokens (contexto)'), limitInput),
      ),
      h('div', null, h('label', { class: 'label' }, 'Modelo'), modelSelect ?? h('p', { class: 'text-xs text-muted' }, 'Usará o modelo padrão.')),
      h('div', null, h('label', { class: 'label' }, 'Mundo e personagens'), worldInput),
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Iniciar nova crônica'),
    );
  }

  // --- Quadro "Continuar" ---------------------------------------------------------------------
  function sessionList(): HTMLElement {
    const box = h('div', { class: 'space-y-2' });
    const paint = () => {
      if (sessions.length === 0) {
        mount(box, h('p', { class: 'text-sm text-muted' }, 'Nenhuma crônica ainda. Comece uma em “Nova Crônica”.'));
        return;
      }
      mount(
        box,
        ...sessions.map((s) =>
          h(
            'div',
            { class: 'flex min-w-0 items-center justify-between gap-2 rounded border border-line bg-main px-3 py-2' },
            h(
              'div',
              { class: 'min-w-0 flex-1' },
              h('a', { href: `#/s/${s.id}`, class: 'block truncate font-display text-strong hover:text-accent' }, s.title),
              h('p', { class: 'truncate text-xs text-muted' }, new Date(s.updated_at).toLocaleString('pt-BR')),
            ),
            h(
              'button',
              {
                class: 'btn btn-danger shrink-0',
                type: 'button',
                'aria-label': `Excluir ${s.title}`,
                onClick: async () => {
                  if (!(await confirmModal('Excluir crônica', `Excluir “${s.title}” e todo o seu histórico? Isto não pode ser desfeito.`, { danger: true, confirmLabel: 'Excluir' }))) return;
                  try {
                    await api('DELETE', `/api/sessions/${s.id}`);
                    sessions = sessions.filter((x) => x.id !== s.id);
                    paint();
                    syncMenu();
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
    };
    paint();
    return box;
  }

  // --- Menu -----------------------------------------------------------------------------------
  let current: TitleView = 'menu';
  let modal: ModalHandle | null = null;
  /** Há uma entrada de histórico criada por um clique do menu (o "voltar" a desfaz). */
  let pushed = false;
  /** Fechamento causado por troca de rota (não deve navegar de novo). */
  let programmatic = false;

  const goto = (hash: string) => {
    pushed = true;
    location.hash = hash;
  };

  const noChronicles = () => sessions.length === 0;
  const continueItem = h('button', { type: 'button', class: 'title-menu-item', onClick: () => (noChronicles() ? toast('Nenhuma crônica ainda. Comece uma em “Nova Crônica”.', 'info') : goto('#/continuar')) }, 'Continuar');
  const newItem = h('button', { type: 'button', class: 'title-menu-item', onClick: () => goto('#/nova') }, 'Nova Crônica');
  const optionsItem = h('a', { href: '#/opcoes', class: 'title-menu-item' }, 'Opções');
  const items: HTMLElement[] = [continueItem, newItem, optionsItem];

  const notice = h('p', { class: 'title-notice', role: 'status' }, 'Para o Narrador responder, conecte a sua chave do Gemini em “Opções”.');
  function syncMenu(): void {
    const empty = noChronicles();
    continueItem.setAttribute('aria-disabled', String(empty));
    continueItem.setAttribute('data-tip', 'Nenhuma crônica ainda');
    continueItem.classList.toggle('tip', empty);
    continueItem.classList.toggle('tip-up', empty);
    const missingKey = !settings.api_key_configured;
    optionsItem.classList.toggle('is-pulsing', missingKey);
    notice.hidden = !missingKey;
  }
  syncMenu();

  const nav = h('nav', { class: 'title-menu', 'aria-label': 'Menu principal' }, ...items);
  nav.addEventListener('keydown', (e) => {
    const at = items.indexOf(document.activeElement as HTMLElement);
    const move = e.key === 'ArrowDown' ? at + 1 : e.key === 'ArrowUp' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : null;
    if (move === null) return;
    e.preventDefault();
    items[(move + items.length) % items.length]!.focus();
  });
  // Setas/Enter funcionam também sem foco prévio (teclado em tela de título de jogo).
  const onWindowKey = (e: KeyboardEvent) => {
    if (modal || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    if (items.includes(document.activeElement as HTMLElement)) return;
    e.preventDefault();
    (e.key === 'ArrowDown' ? items[0]! : items[items.length - 1]!).focus();
  };
  window.addEventListener('keydown', onWindowKey);

  mount(
    root,
    h(
      'main',
      { class: 'title-screen' },
      h('div', { class: 'title-tools' }, fullscreenButton()),
      h(
        'header',
        { class: 'title-hero' },
        h(
          'h1',
          null,
          h(
            'picture',
            null,
            h('source', { media: '(max-width: 767px)', srcset: '/logo-stacked.svg' }),
            h('img', { class: 'title-logo', src: '/logo.svg', alt: 'Chronicler Engine', decoding: 'async' }),
          ),
        ),
        h('p', { class: 'title-tagline' }, 'Escreva a sua crônica com um Narrador de IA.'),
      ),
      nav,
      notice,
    ),
  );

  // --- Quadros --------------------------------------------------------------------------------
  function closeModal(): void {
    if (!modal) return;
    programmatic = true;
    const m = modal;
    modal = null;
    m.close();
    programmatic = false;
  }

  /** O usuário fechou o quadro (Esc, clique fora ou Fechar): volta ao menu pelo histórico. */
  function dismissedByUser(): void {
    modal = null;
    current = 'menu';
    if (pushed) {
      pushed = false;
      history.back();
    } else {
      location.replace('#/');
    }
  }

  function open(view: Exclude<TitleView, 'menu'>): void {
    const title = view === 'continuar' ? 'Continuar' : 'Nova crônica';
    const content = view === 'continuar' ? sessionList() : createForm();
    modal = openModal(title, content, {
      wide: view === 'nova',
      closeButton: true,
      onClose: () => {
        if (!programmatic) dismissedByUser();
      },
    });
  }

  function show(view: TitleView): void {
    if (view === current && (view === 'menu') === !modal) return;
    closeModal();
    current = view;
    if (view !== 'menu') open(view);
  }

  show(initial);
  if (initial === 'menu' && window.matchMedia?.('(pointer: fine)').matches) {
    (items.find((i) => i.getAttribute('aria-disabled') !== 'true') ?? items[0])!.focus();
  }

  return {
    show,
    dispose() {
      window.removeEventListener('keydown', onWindowKey);
      closeModal();
    },
  };
}
