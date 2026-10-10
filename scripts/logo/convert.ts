// Converte a arte ANSI do logo (echo-chronicler-engine-logo.sh) em SVG com a paleta Srcery.
// Funções puras (sem E/S) para poderem ser testadas; a CLI está em scripts/make-logo.ts.
//
// Cada caractere do terminal vira uma célula de 1 × 2 unidades (a proporção de uma fonte mono):
//   █ célula cheia   ▀ metade de cima   ▄ metade de baixo   ░ ▒ ▓ cheia com 25 / 50 / 75 % de opacidade.
// Fundos (SGR 40–47/100–107) preenchem a célula inteira por baixo do glifo. Espaços sem fundo ficam
// transparentes, então o logo se apoia em qualquer fundo escuro.

/** Paleta Srcery (https://srcery.sh). */
export const SRCERY = {
  black: '#121110',
  red: '#EF2F27',
  green: '#519F50',
  yellow: '#FBB829',
  blue: '#2C78BF',
  magenta: '#E02C6D',
  cyan: '#0AAEB3',
  white: '#C5B088',
  brightBlack: '#917E6B',
  brightRed: '#F75341',
  brightGreen: '#98BC37',
  brightYellow: '#FED06E',
  brightBlue: '#68A8E4',
  brightMagenta: '#FF5C8F',
  brightCyan: '#2BE4D0',
  brightWhite: '#FCE8C3',
} as const;

const NORMAL = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const;
const BRIGHT = ['brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const;

/** Cor de primeiro plano de um código SGR (30–37, 90–97) ou `null`. */
export function foreground(code: number): string | null {
  if (code >= 30 && code <= 37) return SRCERY[NORMAL[code - 30]!];
  if (code >= 90 && code <= 97) return SRCERY[BRIGHT[code - 90]!];
  return null;
}
/** Cor de fundo de um código SGR (40–47, 100–107) ou `null`. */
export function background(code: number): string | null {
  if (code >= 40 && code <= 47) return SRCERY[NORMAL[code - 40]!];
  if (code >= 100 && code <= 107) return SRCERY[BRIGHT[code - 100]!];
  return null;
}

export interface Cell {
  ch: string;
  fg: string | null;
  bg: string | null;
}
export type Grid = Cell[][];

const SHADE: Record<string, number> = { '░': 0.25, '▒': 0.5, '▓': 0.75 };
const SUPPORTED = new Set([' ', '█', '▀', '▄', ...Object.keys(SHADE)]);

/** Lê as linhas `echo -e "…"` do script e devolve a grade de células (linhas × colunas, retangular). */
export function parseAnsiLogo(script: string): Grid {
  const grid: Grid = [];
  for (const line of script.split('\n')) {
    const m = /^echo -e "(.*)"\s*$/.exec(line.trimEnd());
    if (!m) continue;
    let fg: string | null = null;
    let bg: string | null = null;
    const row: Cell[] = [];
    for (const part of m[1]!.split(/(\\033\[[0-9;]*m)/)) {
      const sgr = /^\\033\[([0-9;]*)m$/.exec(part);
      if (sgr) {
        for (const code of sgr[1]!.split(';').map((c) => (c === '' ? 0 : Number(c)))) {
          if (code === 0) {
            fg = null;
            bg = null;
          } else if (foreground(code)) fg = foreground(code);
          else if (background(code)) bg = background(code);
        }
        continue;
      }
      for (const ch of part) {
        if (!SUPPORTED.has(ch)) throw new Error(`Caractere não suportado no logo: ${JSON.stringify(ch)}`);
        row.push({ ch, fg, bg });
      }
    }
    grid.push(row);
  }
  const width = Math.max(0, ...grid.map((r) => r.length));
  for (const row of grid) while (row.length < width) row.push({ ch: ' ', fg: null, bg: null });
  return grid;
}

const isEmpty = (c: Cell): boolean => c.bg === null && (c.ch === ' ' || c.fg === null);

/** Colunas inteiramente vazias. */
function emptyColumns(grid: Grid): boolean[] {
  const width = grid[0]?.length ?? 0;
  return Array.from({ length: width }, (_, x) => grid.every((row) => isEmpty(row[x]!)));
}

/** Recorta colunas vazias nas bordas. */
export function trim(grid: Grid): Grid {
  const empty = emptyColumns(grid);
  const first = empty.indexOf(false);
  const last = empty.lastIndexOf(false);
  if (first < 0) return grid.map(() => []);
  return grid.map((row) => row.slice(first, last + 1));
}

/**
 * Divide a grade na maior faixa de colunas vazias (a lacuna entre as palavras). Devolve as duas
 * metades já recortadas.
 */
export function splitAtWidestGap(grid: Grid): [Grid, Grid] {
  const t = trim(grid);
  const e = emptyColumns(t);
  let best = { start: -1, len: 0 };
  for (let x = 0; x < e.length; ) {
    if (!e[x]) {
      x++;
      continue;
    }
    let y = x;
    while (y < e.length && e[y]) y++;
    if (y - x > best.len) best = { start: x, len: y - x };
    x = y;
  }
  if (best.len === 0) throw new Error('Nenhuma lacuna entre as palavras do logo.');
  return [trim(t.map((r) => r.slice(0, best.start))), trim(t.map((r) => r.slice(best.start + best.len)))];
}

interface Run {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Retângulos de uma grade deslocados por (dx, dy), agrupados por `fill|opacidade`, com corridas horizontais fundidas. */
function collect(grid: Grid, dx: number, dy: number, into: Map<string, Run[]>): void {
  const add = (fill: string, opacity: number, x: number, y: number, h: number) => {
    const key = `${fill}|${opacity}`;
    const list = into.get(key) ?? [];
    const last = list[list.length - 1];
    if (last && last.y === dy + y && last.h === h && last.x + last.w === dx + x) last.w += 1;
    else list.push({ x: dx + x, y: dy + y, w: 1, h });
    into.set(key, list);
  };
  // Fundos primeiro (ficam por baixo de qualquer glifo).
  grid.forEach((row, y) => row.forEach((c, x) => c.bg && add(c.bg, 1, x, y * 2, 2)));
}

/** Gera o SVG de uma ou mais grades empilhadas (centralizadas), com `gap` unidades entre elas. */
export function toSvg(grids: Grid[], gap = 0): string {
  const width = Math.max(...grids.map((g) => g[0]?.length ?? 0));
  const bgs = new Map<string, Run[]>();
  const fgs = new Map<string, Run[]>();
  let y = 0;
  for (const g of grids) {
    const w = g[0]?.length ?? 0;
    const dx = Math.floor((width - w) / 2);
    collect(g, dx, y, bgs);
    g.forEach((row, r) =>
      row.forEach((c, x) => {
        if (!c.fg || c.ch === ' ') return;
        const Y = y + r * 2;
        const put = (opacity: number, top: number, h: number) => {
          const key = `${c.fg}|${opacity}`;
          const list = fgs.get(key) ?? [];
          const last = list[list.length - 1];
          if (last && last.y === Y + top && last.h === h && last.x + last.w === dx + x) last.w += 1;
          else list.push({ x: dx + x, y: Y + top, w: 1, h });
          fgs.set(key, list);
        };
        if (c.ch === '█') put(1, 0, 2);
        else if (c.ch === '▀') put(1, 0, 1);
        else if (c.ch === '▄') put(1, 1, 1);
        else put(SHADE[c.ch]!, 0, 2);
      }),
    );
    y += g.length * 2 + gap;
  }
  const height = y - gap;
  const paths = (map: Map<string, Run[]>): string =>
    [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, runs]) => {
        const [fill, opacity] = key.split('|') as [string, string];
        const d = runs.map((r) => `M${r.x} ${r.y}h${r.w}v${r.h}h-${r.w}z`).join('');
        return `<path fill="${fill}"${opacity === '1' ? '' : ` fill-opacity="${opacity}"`} d="${d}"/>`;
      })
      .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges">${paths(bgs)}${paths(fgs)}</svg>\n`;
}
