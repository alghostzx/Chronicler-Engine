/** Ícones SVG inline (traço de 24×24). Sem dependências externas e sem innerHTML. */

type Shape = [tag: 'path' | 'circle' | 'rect' | 'polyline' | 'line', attrs: Record<string, string>];

const ICONS = {
  /** Biblioteca de crônicas. */
  library: [
    ['path', { d: 'm16 6 4 14' }],
    ['path', { d: 'M12 6v14' }],
    ['path', { d: 'M8 8v12' }],
    ['path', { d: 'M4 4v16' }],
  ],
  /** Salvar/baixar arquivo. */
  download: [
    ['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }],
    ['polyline', { points: '7 10 12 15 17 10' }],
    ['line', { x1: '12', y1: '15', x2: '12', y2: '3' }],
  ],
  /** Painel lateral de contexto. */
  panel: [
    ['rect', { x: '3', y: '3', width: '18', height: '18', rx: '2' }],
    ['path', { d: 'M15 3v18' }],
  ],
  palette: [
    ['circle', { cx: '13.5', cy: '6.5', r: '0.5' }],
    ['circle', { cx: '17.5', cy: '10.5', r: '0.5' }],
    ['circle', { cx: '8.5', cy: '7.5', r: '0.5' }],
    ['circle', { cx: '6.5', cy: '12.5', r: '0.5' }],
    [
      'path',
      {
        d: 'M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z',
      },
    ],
  ],
  sun: [
    ['circle', { cx: '12', cy: '12', r: '4' }],
    ['path', { d: 'M12 2v2' }],
    ['path', { d: 'M12 20v2' }],
    ['path', { d: 'm4.93 4.93 1.41 1.41' }],
    ['path', { d: 'm17.66 17.66 1.41 1.41' }],
    ['path', { d: 'M2 12h2' }],
    ['path', { d: 'M20 12h2' }],
    ['path', { d: 'm6.34 17.66-1.41 1.41' }],
    ['path', { d: 'm19.07 4.93-1.41 1.41' }],
  ],
  moon: [['path', { d: 'M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z' }]],
  monitor: [
    ['rect', { x: '2', y: '3', width: '20', height: '14', rx: '2' }],
    ['path', { d: 'M8 21h8' }],
    ['path', { d: 'M12 17v4' }],
  ],
  check: [['polyline', { points: '20 6 9 17 4 12' }]],
  /** Editar o texto da página: lápis. */
  pencil: [
    ['path', { d: 'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z' }],
    ['path', { d: 'm15 5 4 4' }],
  ],
  /** Editar o prompt (a instrução enviada ao Narrador) e re-gerar: balão de fala com linhas de texto. */
  prompt: [
    ['path', { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' }],
    ['path', { d: 'M7 8h10' }],
    ['path', { d: 'M7 12h6' }],
  ],
  /** Ramificar a história a partir da página: bifurcação. */
  branch: [
    ['line', { x1: '6', y1: '3', x2: '6', y2: '15' }],
    ['circle', { cx: '18', cy: '6', r: '3' }],
    ['circle', { cx: '6', cy: '18', r: '3' }],
    ['path', { d: 'M18 9a9 9 0 0 1-9 9' }],
  ],
  /** Ler um volume (páginas já consumidas pela crônica): livro aberto. */
  book: [
    ['path', { d: 'M12 7v14' }],
    ['path', { d: 'M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z' }],
  ],
  /** Entrar em tela cheia: cantos que se afastam. */
  fullscreen: [
    ['path', { d: 'M8 3H5a2 2 0 0 0-2 2v3' }],
    ['path', { d: 'M21 8V5a2 2 0 0 0-2-2h-3' }],
    ['path', { d: 'M3 16v3a2 2 0 0 0 2 2h3' }],
    ['path', { d: 'M16 21h3a2 2 0 0 0 2-2v-3' }],
  ],
  /** Sair da tela cheia: cantos que se aproximam. */
  fullscreenExit: [
    ['path', { d: 'M8 3v3a2 2 0 0 1-2 2H3' }],
    ['path', { d: 'M21 8h-3a2 2 0 0 1-2-2V3' }],
    ['path', { d: 'M3 16h3a2 2 0 0 1 2 2v3' }],
    ['path', { d: 'M16 21v-3a2 2 0 0 1 2-2h3' }],
  ],
  /** Ouvir a página (narração): alto-falante com ondas. */
  volume: [
    ['path', { d: 'M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z' }],
    ['path', { d: 'M16 9a5 5 0 0 1 0 6' }],
    ['path', { d: 'M19.364 18.364a9 9 0 0 0 0-12.728' }],
  ],
  /** Tocar. */
  play: [['path', { d: 'M6 4v16l14-8z' }]],
  /** Pausar. */
  pause: [
    ['rect', { x: '6', y: '4', width: '4', height: '16', rx: '1' }],
    ['rect', { x: '14', y: '4', width: '4', height: '16', rx: '1' }],
  ],
  /** Gerar de novo / tentar de novo: seta circular. */
  refresh: [
    ['path', { d: 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8' }],
    ['path', { d: 'M21 3v5h-5' }],
  ],
  /** Apagar. */
  trash: [
    ['path', { d: 'M3 6h18' }],
    ['path', { d: 'M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6' }],
    ['path', { d: 'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2' }],
  ],
  /** Cancelar / fechar. */
  close: [
    ['path', { d: 'M18 6 6 18' }],
    ['path', { d: 'm6 6 12 12' }],
  ],
  /** Trabalhando (gira por CSS). */
  loader: [['path', { d: 'M21 12a9 9 0 1 1-6.219-8.56' }]],
  /** Voltar. */
  back: [
    ['path', { d: 'm12 19-7-7 7-7' }],
    ['path', { d: 'M19 12H5' }],
  ],
} satisfies Record<string, Shape[]>;

export type IconName = keyof typeof ICONS;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Cria um ícone decorativo (aria-hidden); o rótulo fica no botão que o contém. */
export function icon(name: IconName, size = 18): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  const attrs: Record<string, string> = {
    viewBox: '0 0 24 24',
    width: String(size),
    height: String(size),
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
    class: 'shrink-0',
  };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
  for (const [tag, a] of ICONS[name] as Shape[]) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(a)) node.setAttribute(k, v);
    svg.appendChild(node);
  }
  return svg;
}
