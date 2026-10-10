import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Os 8 temas (4 temas × claro/escuro) precisam sustentar o cartão de página: texto legível sobre a
 * "folha", ícones das ações visíveis e a folha distinguível do fundo do Tome. Estas verificações
 * leem as variáveis CSS reais de `client/styles.css`; a renderização final é conferida no Chromium
 * por `npm run check:paginas`.
 */
const CSS = readFileSync(join(process.cwd(), 'client', 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const THEMES = ['medieval', 'cyberpunk', 'pos-apocaliptico', 'contemporaneo'] as const;
const MODES = ['light', 'dark'] as const;
const REQUIRED = ['--bg-main', '--bg-panel', '--text-main', '--text-muted', '--text-strong', '--accent', '--border', '--page-bg', '--page-border', '--page-shadow'];

function tokens(theme: string, mode: string): Record<string, string> {
  const wanted = `.theme-${theme}.mode-${mode}`;
  const out: Record<string, string> = {};
  for (const m of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1]!.split(',').map((s) => s.trim());
    // `:root` descreve o tema padrão (medieval claro) antes de qualquer classe no <html>.
    if (!selectors.includes(wanted) && !(theme === 'medieval' && mode === 'light' && selectors.includes(':root'))) continue;
    for (const d of m[2]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[d[1]!] = d[2]!.trim();
  }
  return out;
}

function rgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`Cor não suportada: ${hex}`);
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** Razão de contraste WCAG entre duas cores hex. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const COMBOS = THEMES.flatMap((t) => MODES.map((m) => [t, m] as const));

describe('cartão de página nos 8 temas', () => {
  it('há 8 combinações (4 temas × claro/escuro)', () => {
    expect(COMBOS).toHaveLength(8);
  });

  describe.each(COMBOS)('%s / %s', (theme, mode) => {
    const t = tokens(theme, mode);

    it('define todas as variáveis usadas pela página', () => {
      for (const v of REQUIRED) expect(t[v], `${theme}/${mode} sem ${v}`).toBeTruthy();
    });

    it('texto principal, forte e esmaecido legíveis sobre a folha (≥ 4,5:1)', () => {
      expect(contrast(t['--text-main']!, t['--page-bg']!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t['--text-strong']!, t['--page-bg']!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t['--text-muted']!, t['--page-bg']!)).toBeGreaterThanOrEqual(4.5);
    });

    it('ícones das ações (cor do texto) e destaque (acento) visíveis sobre a folha (≥ 3:1)', () => {
      expect(contrast(t['--text-main']!, t['--page-bg']!)).toBeGreaterThanOrEqual(3);
      expect(contrast(t['--accent']!, t['--page-bg']!)).toBeGreaterThanOrEqual(3);
    });

    it('a folha se distingue do fundo do Tome (borda ≥ 1,3:1 contra o fundo)', () => {
      expect(contrast(t['--page-border']!, t['--bg-main']!)).toBeGreaterThanOrEqual(1.3);
      expect(t['--page-shadow']).toMatch(/rgb\(/);
    });

    it('a borda da folha também aparece contra a própria folha (divisórias do cabeçalho e do rodapé)', () => {
      expect(contrast(t['--page-border']!, t['--page-bg']!)).toBeGreaterThanOrEqual(1.2);
    });
  });
});
