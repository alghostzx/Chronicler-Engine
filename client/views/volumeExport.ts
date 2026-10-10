import type { Archive } from '../api';
import { downloadVolumeMarkdown } from '../download';
import { h, openModal, toast } from '../dom';

/** Modal "Salvar volume em Markdown": a sinopse vem incluída, com opção de omiti-la. */
export function openVolumeExport(archive: Archive): void {
  const withSummary = h('input', { type: 'checkbox', id: 'export-summary', class: 'mr-2', checked: true });
  const go = h('button', { class: 'btn btn-primary', type: 'button' }, 'Baixar arquivo .md');
  const pages = archive.covered_page_end_index - archive.covered_page_start_index + 1;
  const modal = openModal(
    `Salvar Volume ${archive.volume_number} em Markdown`,
    h(
      'div',
      { class: 'space-y-3' },
      h('p', { class: 'text-sm text-muted' }, `O arquivo contém as ${pages} páginas (${archive.covered_page_start_index} a ${archive.covered_page_end_index}) que este volume consumiu, separadas por “---”. Suas instruções (prompts) não são incluídas.`),
      h('label', { class: 'flex items-center text-sm text-ink', for: 'export-summary' }, withSummary, 'Incluir a sinopse do volume'),
      h('div', { class: 'flex justify-end gap-2' }, h('button', { class: 'btn', type: 'button', onClick: () => modal.close() }, 'Cancelar'), go),
    ),
  );
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      const name = await downloadVolumeMarkdown(archive.id, withSummary.checked);
      toast(`Arquivo “${name}” gerado.`, 'success');
      modal.close();
    } catch (err) {
      go.disabled = false;
      toast((err as Error).message, 'error');
    }
  });
}
