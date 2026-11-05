import { api, ApiError, type CompactionPreview, type Page } from '../api';
import { h, openModal, toast } from '../dom';

/** Calcula a página limite sugerida (~75% do peso em caracteres, preservando ao menos a última página). */
export function suggestCompactionEndIndex(pages: Pick<Page, 'order_index' | 'generated_text'>[]): number {
  const total = pages.reduce((sum, p) => sum + p.generated_text.length, 0);
  const limit = total * 0.75;
  let cumulative = 0;
  let cut = 0;
  for (const p of pages) {
    cumulative += p.generated_text.length;
    if (cumulative > limit) break;
    cut++;
  }
  cut = Math.min(Math.max(cut, 1), pages.length - 1);
  return pages[cut - 1]!.order_index;
}

/**
 * Fluxo de compactação (docs/narrador.md#compactação-livro-de-crônicas): o autor escolhe até qual página compactar (pré-selecionada em
 * ~75% do peso), gera a minuta da sinopse sob demanda (nada é gravado), revisa/edita e só então consolida.
 * Resolve `true` se a crônica foi compactada.
 */
export async function openCompaction(
  sessionId: string,
  activePages: Page[],
  nextVolumeNumber = 1,
): Promise<boolean> {
  const sorted = [...activePages].sort((a, b) => a.order_index - b.order_index);
  if (sorted.length < 2) {
    toast('É preciso ao menos 2 páginas ativas para compactar a crônica.', 'error');
    return false;
  }

  const suggestedEnd = suggestCompactionEndIndex(sorted);
  const candidates = sorted.slice(0, -1);

  return new Promise((resolve) => {
    let committed = false;
    let currentPreview: CompactionPreview | null = null;
    let generating = false;

    const select = h(
      'select',
      { class: 'input', 'aria-label': 'Compactar até a página' },
      ...candidates.map((page, idx) => {
        const toArchive = idx + 1;
        const toKeep = sorted.length - toArchive;
        const clean = page.generated_text.replace(/\s+/g, ' ').trim();
        const snippet = clean.slice(0, 48) + (clean.length > 48 ? '…' : '');
        const tag = page.order_index === suggestedEnd ? ' · sugerido (~75%)' : '';
        return h(
          'option',
          { value: String(page.order_index) },
          `Até a Página ${page.order_index} (${toArchive} ${toArchive === 1 ? 'página' : 'páginas'}, mantém ${toKeep}${tag}) — “${snippet}”`,
        );
      }),
    );
    select.value = String(suggestedEnd);

    const summaryInfo = h('p', { class: 'text-sm text-muted' });
    const statusArea = h('div', { class: 'space-y-2' });
    const ta = h('textarea', {
      class: 'input min-h-[40vh] font-reading text-sm leading-6',
      'aria-label': 'Sinopse da crônica',
    });

    const generateBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Gerar minuta');
    const commitBtn = h('button', { class: 'btn btn-primary hidden', type: 'button' }, `Consolidar Volume ${nextVolumeNumber}`);

    const modal = openModal('Compactar Crônica', h('div'), {
      wide: true,
      onClose: () => resolve(committed),
    });

    const updateSummaryInfo = () => {
      const endOrder = Number(select.value);
      const cut = sorted.findIndex((p) => p.order_index === endOrder) + 1;
      const toArchive = Math.max(1, cut);
      const toKeep = sorted.length - toArchive;
      const startOrder = sorted[0]!.order_index;
      const vol = currentPreview?.next_volume_number ?? nextVolumeNumber;
      const rangeText =
        toArchive === 1
          ? `A Página ${startOrder} vira o Volume ${vol}`
          : `${toArchive} páginas antigas (${startOrder} a ${endOrder}) viram o Volume ${vol}`;
      const keepText =
        toKeep === 1
          ? 'a página mais recente permanece intacta no Tome.'
          : `as ${toKeep} mais recentes permanecem intactas no Tome.`;
      summaryInfo.textContent = `${rangeText}; ${keepText}`;

      if (currentPreview) {
        const matches = currentPreview.covered_page_end_index === endOrder;
        commitBtn.disabled = generating || !matches;
        generateBtn.textContent = 'Gerar nova minuta';
        generateBtn.className = matches ? 'btn' : 'btn btn-primary';
      } else {
        generateBtn.textContent = 'Gerar minuta';
        generateBtn.className = 'btn btn-primary';
      }
    };

    select.addEventListener('change', updateSummaryInfo);

    generateBtn.addEventListener('click', async () => {
      if (generating) return;
      generating = true;
      select.disabled = true;
      generateBtn.disabled = true;
      commitBtn.disabled = true;
      statusArea.replaceChildren(
        h('p', { class: 'text-sm text-muted cursor-blink' }, 'O Narrador está resumindo os capítulos antigos…'),
      );

      const endOrder = Number(select.value);
      try {
        const preview = await api<CompactionPreview>('POST', `/api/sessions/${sessionId}/compact/preview`, {
          covered_page_end_index: endOrder,
        });
        currentPreview = preview;
        ta.value = preview.summary_text;
        commitBtn.textContent = `Consolidar Volume ${preview.next_volume_number}`;
        commitBtn.classList.remove('hidden');
        statusArea.replaceChildren(
          h(
            'p',
            { class: 'text-xs text-muted' },
            'Revise e edite a sinopse antes de consolidar — o texto original das páginas arquivadas deixa de ser enviado ao Narrador.',
          ),
          ta,
        );
        ta.focus();
      } catch (err) {
        const message = err instanceof ApiError ? err.message : 'Falha ao compactar a crônica.';
        toast(message, 'error');
        if (!currentPreview) {
          statusArea.replaceChildren();
        } else {
          statusArea.replaceChildren(
            h(
              'p',
              { class: 'text-xs text-muted' },
              'Revise e edite a sinopse antes de consolidar — o texto original das páginas arquivadas deixa de ser enviado ao Narrador.',
            ),
            ta,
          );
        }
      } finally {
        generating = false;
        select.disabled = false;
        generateBtn.disabled = false;
        updateSummaryInfo();
      }
    });

    commitBtn.addEventListener('click', async () => {
      if (!currentPreview || generating) return;
      if (ta.value.trim() === '') {
        toast('A sinopse não pode ficar vazia.', 'error');
        return;
      }
      commitBtn.disabled = true;
      generateBtn.disabled = true;
      select.disabled = true;
      try {
        await api('POST', `/api/sessions/${sessionId}/compact/commit`, {
          summary_text: ta.value,
          covered_page_start_index: currentPreview.covered_page_start_index,
          covered_page_end_index: currentPreview.covered_page_end_index,
        });
        committed = true;
        toast('Crônica compactada.', 'success');
        modal.close();
      } catch (err) {
        commitBtn.disabled = false;
        generateBtn.disabled = false;
        select.disabled = false;
        toast(err instanceof ApiError ? err.message : 'Falha ao consolidar.', 'error');
      }
    });

    updateSummaryInfo();
    modal.body.replaceChildren(
      h(
        'div',
        { class: 'space-y-3' },
        h(
          'label',
          { class: 'block space-y-1 text-sm' },
          h('span', { class: 'font-medium text-ink-strong' }, 'Compactar até qual página?'),
          select,
        ),
        summaryInfo,
        statusArea,
        h(
          'div',
          { class: 'flex flex-wrap justify-end gap-2' },
          h('button', { class: 'btn', type: 'button', onClick: () => modal.close() }, 'Cancelar'),
          generateBtn,
          commitBtn,
        ),
      ),
    );
    select.focus();
  });
}
