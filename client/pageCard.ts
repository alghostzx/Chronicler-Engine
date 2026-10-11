import type { Page } from './api';
import { h, paragraphs } from './dom';
import { audioControls } from './audioUi';
import { iconButton } from './controls';
import { icon } from './icons';

/** Rótulos (aria-label) das ações de página: um ícone por ação, sempre visível. */
export const PAGE_ACTIONS = {
  editText: 'Editar texto da página',
  editPrompt: 'Editar prompt e re-gerar',
  redoDialogue: 'Refazer diálogo',
  branch: 'Ramificar a partir desta página',
  listen: 'Ouvir esta página',
} as const;

export interface PageCardOptions {
  page: Page;
  /** Somente leitura (leitor de volumes): sem rodapé de ações. */
  readonly?: boolean;
  /** Página que será descartada numa re-geração em andamento: esmaecida. */
  dimmed?: boolean;
  /** Letra capitular (apenas a página 1 da história). */
  dropCap?: boolean;
  /** Desabilita as ações enquanto há geração ou diálogo em andamento. */
  busy?: boolean;
  /** Título da crônica (aparece nos controles de mídia do sistema ao ouvir a página). */
  sessionTitle?: string;
  /** Quantas páginas vêm depois desta (0 = última: não há o que ramificar). */
  laterCount?: number;
  onEditText?: () => void;
  onEditPrompt?: () => void;
  /** Páginas de diálogo: abre um novo diálogo que, ao ser encerrado, substitui esta página. */
  onRedoDialogue?: () => void;
  /** Esta página será substituída ao encerrar o diálogo refeito em andamento. */
  replacing?: boolean;
  onBranch?: () => void;
}

/** Cabeçalho comum: "Página N" (número absoluto, nunca reaproveitado) e, se houver, o selo da página. */
export function pageHeader(index: number, ...badges: (HTMLElement | null)[]): HTMLElement {
  return h('header', { class: 'page-card-header' }, h('h2', { class: 'page-card-title' }, `Página ${index}`), ...badges);
}

/** Selo de página de diálogo (cabeçalho): "Diálogo com {NPC}". */
export function dialogueBadge(npcName: string | null): HTMLElement {
  return h('span', { class: 'page-badge', 'data-badge': 'dialogue' }, icon('dialogue', 14), npcName ? `Diálogo com ${npcName}` : 'Diálogo');
}

/** Parágrafo de página: nas de diálogo, o rótulo inicial `**Falante:**` vira destaque (tolera edições). */
function pageParagraph(text: string, dialogue: boolean): HTMLElement {
  const m = dialogue ? /^\*\*(.{1,80}?):\*\*\s*([\s\S]*)$/.exec(text) : null;
  if (!m) return h('p', null, text);
  return h('p', { class: 'dialogue-line' }, h('strong', { class: 'dialogue-speaker' }, `${m[1]}:`), ' ', m[2]);
}

/** Cartão de uma página: folha separada, cabeçalho numerado, prosa e ações em ícones. */
export function pageCard(o: PageCardOptions): HTMLElement {
  const { page } = o;
  const children: HTMLElement[] = [
    pageHeader(
      page.order_index,
      page.kind === 'dialogue' ? dialogueBadge(page.npc_name) : null,
      o.replacing ? h('span', { class: 'page-badge is-warning', 'data-badge': 'replacing' }, 'Será substituída ao encerrar o novo diálogo') : null,
    ),
    h(
      'div',
      { class: `prose-tome page-card-body ${o.dropCap ? 'drop-cap' : ''}` },
      ...paragraphs(page.generated_text).map((p) => pageParagraph(p, page.kind === 'dialogue')),
    ),
  ];
  // Narração: o botão "Ouvir" fica sempre no rodapé (inclusive em páginas somente leitura, como as
  // de volumes) e o painel (gerando/erro/player) logo acima dele.
  const audio = audioControls(page, { sessionTitle: o.sessionTitle ?? 'Crônica' });
  children.push(audio.panel);
  const footer: HTMLElement[] = [audio.button];
  audio.button.classList.add('mr-auto');
  if (!o.readonly) {
    const last = (o.laterCount ?? 0) === 0;
    const dialogue = page.kind === 'dialogue';
    const action = (icon: 'pencil' | 'prompt' | 'redoDialogue' | 'branch', label: string, tip: string, onClick?: () => void, disabled = false) =>
      iconButton({ icon, label, tip, align: 'end', up: true, extraClass: 'page-action', disabled: disabled || !!o.busy, onClick });
    footer.push(
      action('pencil', PAGE_ACTIONS.editText, 'Editar o texto desta página', o.onEditText),
      dialogue
        ? action('redoDialogue', PAGE_ACTIONS.redoDialogue, 'Refazer este diálogo do zero (só substitui a página, e descarta as seguintes, ao encerrar o novo)', o.onRedoDialogue)
        : action('prompt', PAGE_ACTIONS.editPrompt, 'Editar o prompt de origem e re-gerar esta página', o.onEditPrompt),
      action(
        'branch',
        PAGE_ACTIONS.branch,
        last ? 'Esta já é a última página; continue a história na Doca' : 'Ramificar: continuar a história a partir desta página',
        o.onBranch,
        last,
      ),
    );
  }
  children.push(h('footer', { class: 'page-card-actions', role: 'group', 'aria-label': `Ações da página ${page.order_index}` }, ...footer));
  return h('section', { class: `page-card ${o.dimmed ? 'is-dimmed' : ''} ${o.replacing ? 'is-replaced' : ''}`, 'data-page-id': page.id, 'data-page-index': String(page.order_index) }, ...children);
}
