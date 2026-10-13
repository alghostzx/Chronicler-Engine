import type { ContinuousState } from './continuousPlayback';
import { h, openModal } from './dom';

/** Texto de estado da barra do player no modo contínuo (separado do DOM para ser testável). */
export function statusText(s: ContinuousState): string {
  const parts: string[] = [];
  if (s.phase === 'waiting') parts.push(`Aguardando a narração da Página ${s.currentNumber}…`);
  else parts.push(s.phase === 'playing' ? 'Tocando' : 'Pausado');
  if (s.generating > 0) parts.push(`gerando ${s.generating} ${s.generating === 1 ? 'página' : 'páginas'} em segundo plano`);
  if (s.stopsAt !== null) parts.push(`para na Página ${s.stopsAt}, que não tem áudio`);
  return parts.join(' · ');
}

/** "Páginas 4, 5 e 7" / "Páginas 4 a 9 e 12" (sequências de 3 ou mais viram intervalo). */
export function formatPageList(numbers: number[]): string {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const items: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    if (j - i >= 2) items.push(`${sorted[i]} a ${sorted[j]}`);
    else for (let k = i; k <= j; k++) items.push(String(sorted[k]));
    i = j + 1;
  }
  const body = items.length > 1 ? `${items.slice(0, -1).join(', ')} e ${items[items.length - 1]}` : (items[0] ?? '');
  return `${sorted.length === 1 ? 'Página' : 'Páginas'} ${body}`;
}

export type GenerateChoice = 'generate' | 'ready';

/** Acima disso o aviso de custo fica em destaque. */
export const MANY_PAGES = 10;

/**
 * Pergunta o que fazer com as páginas sem narração: gerar (custa tokens) e reproduzir tudo, tocar só as
 * que já têm (para na primeira sem áudio) ou cancelar (`null`).
 */
export function askGenerate(opts: { missing: number[]; generating: number }): Promise<GenerateChoice | null> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v: GenerateChoice | null) => {
      if (settled) return;
      settled = true;
      modal.close();
      resolve(v);
    };
    const n = opts.missing.length;
    const many = n > MANY_PAGES;
    const modal = openModal(
      'Páginas sem narração',
      h(
        'div',
        { 'data-continuous-ask': '' },
        h(
          'div',
          { class: 'space-y-2 text-sm leading-6 text-ink' },
          h('p', null, `${formatPageList(opts.missing)} ainda ${n === 1 ? 'não tem' : 'não têm'} áudio.`),
          opts.generating > 0 ? h('p', { class: 'text-muted' }, `Outras ${opts.generating} já estão sendo geradas.`) : null,
          h(
            'p',
            { class: many ? 'font-semibold text-hp-low' : 'text-muted' },
            many
              ? `Atenção: gerar ${n} narrações consome muitos tokens da sua chave da API.`
              : 'Gerar a narração consome tokens da sua chave da API (uma geração por página).',
          ),
          h('p', { class: 'text-muted' }, '“Só reproduzir” toca as páginas que já têm áudio e para na primeira que não tiver, sem pular nenhuma.'),
        ),
        h(
          'div',
          { class: 'mt-4 flex flex-wrap justify-end gap-2' },
          h('button', { class: 'btn', type: 'button', onClick: () => settle(null) }, 'Cancelar'),
          h('button', { class: 'btn', type: 'button', 'data-choice': 'ready', onClick: () => settle('ready') }, 'Só reproduzir as que já têm'),
          h('button', { class: `btn btn-primary ${many ? 'btn-danger' : ''}`, type: 'button', 'data-choice': 'generate', onClick: () => settle('generate') }, 'Gerar e reproduzir'),
        ),
      ),
      { onClose: () => settle(null) },
    );
  });
}
