import { api, ApiError, type CompactionPreview } from '../api';
import { h, openModal, toast } from '../dom';

/**
 * Fluxo de compactação (design §3.4/§6.4): gera a minuta da sinopse (nada é gravado), deixa o
 * jogador revisá-la e só então consolida. Resolve `true` se a crônica foi compactada.
 */
export async function openCompaction(sessionId: string): Promise<boolean> {
  return new Promise((resolve) => {
    let committed = false;
    const modal = openModal(
      'Compactar Crônica',
      h('p', { class: 'text-sm text-muted cursor-blink' }, 'O Narrador está resumindo os capítulos antigos…'),
      { wide: true, onClose: () => resolve(committed) },
    );

    const fail = (err: unknown) => {
      const message = err instanceof ApiError ? err.message : 'Falha ao compactar a crônica.';
      toast(message, 'error');
      modal.close();
    };

    api<CompactionPreview>('POST', `/api/sessions/${sessionId}/compact/preview`)
      .then((preview) => {
        const ta = h('textarea', {
          class: 'input min-h-[40vh] font-reading text-sm leading-6',
          'aria-label': 'Sinopse da crônica',
          value: preview.summary_text,
        });
        const commit = h('button', { class: 'btn btn-primary', type: 'button' }, `Consolidar Volume ${preview.next_volume_number}`);
        commit.addEventListener('click', async () => {
          if (ta.value.trim() === '') {
            toast('A sinopse não pode ficar vazia.', 'error');
            return;
          }
          commit.disabled = true;
          try {
            await api('POST', `/api/sessions/${sessionId}/compact/commit`, {
              summary_text: ta.value,
              covered_page_start_index: preview.covered_page_start_index,
              covered_page_end_index: preview.covered_page_end_index,
            });
            committed = true;
            toast('Crônica compactada.', 'success');
            modal.close();
          } catch (err) {
            commit.disabled = false;
            toast(err instanceof ApiError ? err.message : 'Falha ao consolidar.', 'error');
          }
        });
        modal.body.replaceChildren(
          h(
            'div',
            { class: 'space-y-3' },
            h(
              'p',
              { class: 'text-sm text-muted' },
              `${preview.pages_to_archive} páginas antigas (${preview.covered_page_start_index} a ${preview.covered_page_end_index}) viram o Volume ${preview.next_volume_number}; as ${preview.pages_to_keep} mais recentes permanecem intactas. Revise e edite a sinopse antes de consolidar — o texto original das páginas arquivadas deixa de ser enviado ao Narrador.`,
            ),
            ta,
            h('div', { class: 'flex justify-end gap-2' }, h('button', { class: 'btn', type: 'button', onClick: () => modal.close() }, 'Cancelar'), commit),
          ),
        );
        ta.focus();
      })
      .catch(fail);
  });
}
