// Gera os SVGs do logo da tela inicial a partir da arte ANSI em scripts/logo/ (a fonte da arte):
//   public/logo.svg          faixa única “CHRONICLER ENGINE” (telas largas)
//   public/logo-stacked.svg  “CHRONICLER” sobre “ENGINE”, letras maiores (celular)
// Cores da paleta Srcery. Uso: npm run logo
import fs from 'node:fs';
import { parseAnsiLogo, splitAtWidestGap, toSvg, trim } from './logo/convert.js';

const SOURCE = 'scripts/logo/echo-chronicler-engine-logo.sh';
const grid = trim(parseAnsiLogo(fs.readFileSync(SOURCE, 'utf8')));
const [first, second] = splitAtWidestGap(grid);

fs.writeFileSync('public/logo.svg', toSvg([grid]));
fs.writeFileSync('public/logo-stacked.svg', toSvg([first, second], 4));
console.log(`logo.svg: ${grid[0]!.length}×${grid.length} células`);
console.log(`logo-stacked.svg: ${first[0]!.length} + ${second[0]!.length} colunas`);
