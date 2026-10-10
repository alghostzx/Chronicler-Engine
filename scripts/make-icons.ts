// Gera os ícones PNG do app instalável (manifesto) a partir de public/favicon.svg, usando um
// Chromium headless. Saída em public/icons/: icon-192.png, icon-512.png e icon-maskable-512.png
// (versão "maskable": fundo cheio e desenho reduzido à zona segura de 80%, para o Android recortar
// em círculo/squircle sem cortar o tomo). Uso: npm run icons
// Requer um navegador do Playwright ou `CHROME_PATH=/caminho/do/chrome`.
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { findChrome } from './chrome.js';

const OUT = 'public/icons';
fs.mkdirSync(OUT, { recursive: true });

const svg = fs.readFileSync('public/favicon.svg', 'utf8');
const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const BG = '#1e1710';

/** Ícone "any": o próprio favicon (quadrado arredondado com cantos transparentes). */
const any = (size: number): string => svg.replace('<svg ', `<svg width="${size}" height="${size}" `);
/** Ícone maskable: sem cantos arredondados; o desenho (sem o retângulo de fundo) fica em 70%. */
const maskable = (size: number): string => {
  const art = inner.replace(/<rect[^>]*\/>/, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}"><rect width="64" height="64" fill="${BG}"/><g transform="translate(32 32) scale(.7) translate(-32 -32)">${art}</g></svg>`;
};

const executablePath = findChrome();
if (!executablePath) {
  console.error('Chromium não encontrado: defina CHROME_PATH ou instale um navegador do Playwright.');
  process.exit(1);
}
const browser = await chromium.launch({ executablePath });
try {
  const jobs: [file: string, size: number, markup: string, transparent: boolean][] = [
    ['icon-192.png', 192, any(192), true],
    ['icon-512.png', 512, any(512), true],
    ['icon-maskable-512.png', 512, maskable(512), false],
  ];
  for (const [file, size, markup, transparent] of jobs) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<!doctype html><body style="margin:0;background:transparent">${markup}</body>`);
    await page.screenshot({ path: `${OUT}/${file}`, omitBackground: transparent, clip: { x: 0, y: 0, width: size, height: size } });
    await page.close();
    console.log(`${OUT}/${file} (${size}×${size})`);
  }
} finally {
  await browser.close();
}
