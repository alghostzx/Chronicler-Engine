// Copia as fontes (apenas subconjunto latin, woff2) dos pacotes @fontsource para public/fonts/ e
// gera public/fonts/fonts.css. Executado manualmente (npm run fonts); o resultado é versionado,
// então o app não depende de CDN nem de node_modules em produção.
import fs from 'node:fs';
import path from 'node:path';

const FONTS = [
  { pkg: 'cinzel', family: 'Cinzel', variants: [[400, 'normal'], [700, 'normal']] },
  { pkg: 'merriweather', family: 'Merriweather', variants: [[400, 'normal'], [400, 'italic'], [700, 'normal']] },
  { pkg: 'jetbrains-mono', family: 'JetBrains Mono', variants: [[400, 'normal'], [700, 'normal']] },
  { pkg: 'special-elite', family: 'Special Elite', variants: [[400, 'normal']] },
  { pkg: 'inter', family: 'Inter', variants: [[400, 'normal'], [600, 'normal']] },
  { pkg: 'lora', family: 'Lora', variants: [[400, 'normal'], [400, 'italic'], [700, 'normal']] },
];

const outDir = 'public/fonts';
fs.mkdirSync(path.join(outDir, 'licenses'), { recursive: true });

let css = '/* Gerado por scripts/copy-fonts.mjs — fontes OFL empacotadas localmente (subconjunto latin). */\n';
for (const { pkg, family, variants } of FONTS) {
  const base = path.join('node_modules', '@fontsource', pkg);
  for (const [weight, style] of variants) {
    const file = `${pkg}-latin-${weight}-${style}.woff2`;
    const src = path.join(base, 'files', file);
    if (!fs.existsSync(src)) throw new Error(`Fonte ausente: ${src}`);
    fs.copyFileSync(src, path.join(outDir, file));
    css +=
      `@font-face {\n  font-family: '${family}';\n  font-style: ${style};\n  font-weight: ${weight};\n  font-display: swap;\n` +
      `  src: url('/fonts/${file}') format('woff2');\n}\n`;
  }
  const license = path.join(base, 'LICENSE');
  if (fs.existsSync(license)) fs.copyFileSync(license, path.join(outDir, 'licenses', `${pkg}.txt`));
}
fs.writeFileSync(path.join(outDir, 'fonts.css'), css);
console.log(`Fontes copiadas para ${outDir}/`);
