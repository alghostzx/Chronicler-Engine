import type { Page } from './api';
import { h, paragraphs } from './dom';
import { iconButton } from './controls';

/** Rótulos (aria-label) das ações de página: um ícone por ação, sempre visível. */
export const PAGE_ACTIONS = {
  editText: 'Editar texto da página',
  editPrompt: 'Editar prompt e re-gerar',
  branch: 'Ramificar a partir desta página',
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
  /** Quantas páginas vêm depois desta (0 = última: não há o que ramificar). */
  laterCount?: number;
  onEditText?: () => void;
  onEditPrompt?: () => void;
  onBranch?: () => void;
}

/** Cabeçalho comum: "Página N" (número absoluto, nunca reaproveitado). */
export function pageHeader(index: number): HTMLElement {
  return h('header', { class: 'page-card-header' }, h('h2', { class: 'page-card-title' }, `Página ${index}`));
}

/** Cartão de uma página: folha separada, cabeçalho numerado, prosa e ações em ícones. */
export function pageCard(o: PageCardOptions): HTMLElement {
  const { page } = o;
  const children: (HTMLElement | null)[] = [
    pageHeader(page.order_index),
    h('div', { class: `prose-tome page-card-body ${o.dropCap ? 'drop-cap' : ''}` }, ...paragraphs(page.generated_text).map((p) => h('p', null, p))),
  ];
  if (!o.readonly) {
    const last = (o.laterCount ?? 0) === 0;
    const action = (icon: 'pencil' | 'prompt' | 'branch', label: string, tip: string, onClick?: () => void, disabled = false, align: 'center' | 'end' = 'center') =>
      iconButton({ icon, label, tip, align, up: true, extraClass: 'page-action', disabled: disabled || !!o.busy, onClick });
    children.push(
      h(
        'footer',
        { class: 'page-card-actions', role: 'group', 'aria-label': `Ações da página ${page.order_index}` },
        action('pencil', PAGE_ACTIONS.editText, 'Editar o texto desta página', o.onEditText),
        action('prompt', PAGE_ACTIONS.editPrompt, 'Editar o prompt de origem e re-gerar esta página', o.onEditPrompt),
        action(
          'branch',
          PAGE_ACTIONS.branch,
          last ? 'Esta já é a última página; continue a história na Doca' : 'Ramificar: continuar a história a partir desta página',
          o.onBranch,
          last,
          'end',
        ),
      ),
    );
  }
  return h('section', { class: `page-card ${o.dimmed ? 'is-dimmed' : ''}`, 'data-page-id': page.id, 'data-page-index': String(page.order_index) }, ...children);
}
