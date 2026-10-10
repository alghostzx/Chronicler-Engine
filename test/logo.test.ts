import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SRCERY, parseAnsiLogo, splitAtWidestGap, toSvg, trim } from '../scripts/logo/convert.js';

const script = (...lines: string[]): string => lines.map((l) => `echo -e "${l}"`).join('\n');
const root = process.cwd();

describe('conversor do logo (ANSI → SVG, paleta Srcery)', () => {
  it('lê cores de primeiro plano e de fundo da paleta Srcery e completa a grade', () => {
    const grid = parseAnsiLogo(script('\\033[31m█\\033[0m \\033[103m \\033[0m', '\\033[92m▀\\033[0m'));
    expect(grid).toHaveLength(2);
    expect(grid[0]).toHaveLength(3);
    expect(grid[1]).toHaveLength(3); // linhas curtas são preenchidas
    expect(grid[0]![0]).toEqual({ ch: '█', fg: SRCERY.red, bg: null });
    expect(grid[0]![2]).toEqual({ ch: ' ', fg: null, bg: SRCERY.brightYellow });
    expect(grid[1]![0]!.fg).toBe(SRCERY.brightGreen);
    expect(grid[1]![2]).toEqual({ ch: ' ', fg: null, bg: null });
  });

  it('ignora linhas que não são `echo -e` e recusa caracteres desconhecidos', () => {
    expect(parseAnsiLogo('#!/bin/bash\n# comentário\n' + script('█'))).toHaveLength(1);
    expect(() => parseAnsiLogo(script('X'))).toThrow(/não suportado/);
  });

  it('recorta bordas vazias e divide na maior lacuna entre as palavras', () => {
    const grid = parseAnsiLogo(script('  \\033[31m█\\033[0m \\033[32m█\\033[0m     \\033[34m█\\033[0m  '));
    expect(trim(grid)[0]).toHaveLength(9);
    const [a, b] = splitAtWidestGap(grid);
    expect(a[0]).toHaveLength(3);
    expect(b[0]).toHaveLength(1);
    expect(b[0]![0]!.fg).toBe(SRCERY.blue);
  });

  it('gera SVG válido: células de 1×2, sombras como opacidade, meios blocos e um <path> por cor', () => {
    const svg = toSvg([parseAnsiLogo(script('\\033[31m█▀▄\\033[33m░▒▓\\033[0m'))]);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 6 2"')).toBe(true);
    expect(svg).toContain(`<path fill="${SRCERY.red}" d="M0 0h1v2h-1zM1 0h1v1h-1zM2 1h1v1h-1z"/>`);
    expect(svg).toContain(`fill="${SRCERY.yellow}" fill-opacity="0.25"`);
    expect(svg).toContain('fill-opacity="0.5"');
    expect(svg).toContain('fill-opacity="0.75"');
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
  });

  it('empilha as grades com o espaçamento pedido, centralizando a mais estreita', () => {
    const a = parseAnsiLogo(script('\\033[31m███\\033[0m'));
    const b = parseAnsiLogo(script('\\033[32m█\\033[0m'));
    const svg = toSvg([a, b], 2);
    expect(svg).toContain('viewBox="0 0 3 6"');
    expect(svg).toContain(`<path fill="${SRCERY.green}" d="M1 4h1v2h-1z"/>`);
  });
});

describe('arquivos do logo', () => {
  const source = readFileSync(join(root, 'scripts/logo/echo-chronicler-engine-logo.sh'), 'utf8');
  const grid = trim(parseAnsiLogo(source));
  const [first, second] = splitAtWidestGap(grid);

  it('os SVGs versionados em public/ correspondem ao que `npm run logo` gera', () => {
    expect(readFileSync(join(root, 'public/logo.svg'), 'utf8')).toBe(toSvg([grid]));
    expect(readFileSync(join(root, 'public/logo-stacked.svg'), 'utf8')).toBe(toSvg([first, second], 4));
  });

  it('só usa cores da paleta Srcery e fica leve', () => {
    const palette = new Set(Object.values(SRCERY).map((c) => c.toLowerCase()));
    for (const file of ['public/logo.svg', 'public/logo-stacked.svg']) {
      const svg = readFileSync(join(root, file), 'utf8');
      const fills = Array.from(svg.matchAll(/fill="(#[0-9a-fA-F]{6})"/g), (m) => m[1]!.toLowerCase());
      expect(fills.length).toBeGreaterThan(0);
      for (const f of fills) expect(palette.has(f)).toBe(true);
      expect(svg.length).toBeLessThan(30_000);
    }
  });
});
