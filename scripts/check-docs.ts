/**
 * Verificação da documentação (`npm run check:docs`; também roda em `npm test`).
 *
 * Mantém os documentos sem links mortos e sem rotas desatualizadas:
 *  1. todo link/imagem relativo de README.md, TASKS.md e docs/*.md aponta para um arquivo existente;
 *  2. toda âncora `#seção` existe no documento de destino (regras de *slug* do GitHub);
 *  3. a tabela de rotas de docs/api.md é idêntica às rotas registradas em src/;
 *  4. não restam referências ao antigo design document (arquivo ou símbolo de seção numerada).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Texto do antigo documento, montado em partes para este arquivo não casar com a própria regra. */
const OLD_DOC_NAME = ['chronicler', 'engine', 'design', 'document'].join('_');
const SECTION_SIGN = String.fromCharCode(0xa7);

/** Remove blocos de código cercados (o conteúdo deles não é Markdown de verdade). */
function stripFences(md: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of md.split('\n')) {
    const m = /^\s*(```+|~~~+)/.exec(line);
    if (m) {
      const marker = m[1]!.slice(0, 3);
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      out.push('');
      continue;
    }
    out.push(fence === null ? line : '');
  }
  return out.join('\n');
}

/** *Slug* de um título, como o GitHub gera (minúsculas, sem pontuação, espaços viram hífens). */
export function slugify(heading: string): string {
  const plain = heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links
    .replace(/[`*]/g, '') // código e ênfase
    .replace(/<[^>]+>/g, '') // HTML
    .trim()
    .toLowerCase();
  return plain.replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s/g, '-');
}

/** Todas as âncoras de um documento (com o sufixo `-1`, `-2`… das repetições). */
export function anchorsOf(md: string): Set<string> {
  const seen = new Map<string, number>();
  const anchors = new Set<string>();
  for (const line of stripFences(md).split('\n')) {
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = slugify(m[1]!);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  return anchors;
}

/** Links e imagens relativos (Markdown `](alvo)` e HTML `src=`/`href=`). */
export function linksOf(md: string): string[] {
  const body = stripFences(md);
  const targets: string[] = [];
  for (const m of body.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) targets.push(m[1]!);
  for (const m of body.matchAll(/\b(?:src|href)="([^"]+)"/g)) targets.push(m[1]!);
  return targets;
}

function docFiles(root: string): string[] {
  const files = ['README.md', 'TASKS.md'].filter((f) => existsSync(path.join(root, f)));
  const docsDir = path.join(root, 'docs');
  if (existsSync(docsDir)) {
    for (const f of readdirSync(docsDir).sort()) if (f.endsWith('.md')) files.push(`docs/${f}`);
  }
  return files;
}

function checkLinks(root: string, files: string[], errors: string[]): void {
  const anchorCache = new Map<string, Set<string>>();
  const anchorsFor = (abs: string): Set<string> => {
    let a = anchorCache.get(abs);
    if (!a) {
      a = anchorsOf(readFileSync(abs, 'utf8'));
      anchorCache.set(abs, a);
    }
    return a;
  };

  for (const file of files) {
    const abs = path.join(root, file);
    const md = readFileSync(abs, 'utf8');
    for (const raw of linksOf(md)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) continue; // http:, https:, mailto:…
      const hashAt = raw.indexOf('#');
      const rawPath = hashAt === -1 ? raw : raw.slice(0, hashAt);
      const rawAnchor = hashAt === -1 ? '' : raw.slice(hashAt + 1);
      let target = abs;
      if (rawPath !== '') {
        target = path.resolve(path.dirname(abs), decodeURIComponent(rawPath));
        if (!existsSync(target)) {
          errors.push(`${file}: link quebrado → ${raw}`);
          continue;
        }
      }
      if (rawAnchor !== '' && target.endsWith('.md') && statSync(target).isFile()) {
        const wanted = decodeURIComponent(rawAnchor).toLowerCase();
        if (!anchorsFor(target).has(wanted)) {
          errors.push(`${file}: âncora inexistente → ${raw}`);
        }
      }
    }
  }
}

/** Rotas registradas no código (`app.get('/api/…')` etc.), no formato `METHOD /caminho`. */
export function routesInCode(root: string): Set<string> {
  const files = [path.join(root, 'src/server.ts')];
  const routesDir = path.join(root, 'src/routes');
  for (const f of readdirSync(routesDir)) if (f.endsWith('.ts')) files.push(path.join(routesDir, f));
  const routes = new Set<string>();
  const re = /\bapp\.(get|post|put|delete|patch)\s*(?:<[\s\S]*?>)?\s*\(\s*'([^']+)'/g;
  for (const file of files) {
    for (const m of readFileSync(file, 'utf8').matchAll(re)) {
      routes.add(`${m[1]!.toUpperCase()} ${m[2]!}`);
    }
  }
  return routes;
}

/** Rotas documentadas: células `` `METHOD /caminho` `` na primeira coluna das tabelas de docs/api.md. */
export function routesInDocs(root: string): Set<string> {
  const md = stripFences(readFileSync(path.join(root, 'docs/api.md'), 'utf8'));
  const routes = new Set<string>();
  for (const line of md.split('\n')) {
    const m = /^\|\s*`(GET|POST|PUT|DELETE|PATCH) (\/[^`]*)`\s*\|/.exec(line);
    if (m) routes.add(`${m[1]!} ${m[2]!}`);
  }
  return routes;
}

function checkRoutes(root: string, errors: string[]): void {
  const code = routesInCode(root);
  const docs = routesInDocs(root);
  for (const r of [...code].sort()) if (!docs.has(r)) errors.push(`docs/api.md: rota sem documentação → ${r}`);
  for (const r of [...docs].sort()) if (!code.has(r)) errors.push(`docs/api.md: rota inexistente no código → ${r}`);
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.git' || name === 'assets') continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
}

function checkStaleReferences(root: string, errors: string[]): void {
  const files: string[] = [];
  for (const dir of ['src', 'client', 'test', 'scripts', 'docs']) {
    const abs = path.join(root, dir);
    if (existsSync(abs)) walk(abs, files);
  }
  for (const f of ['README.md', 'TASKS.md', 'Dockerfile', 'docker-compose.yml']) files.push(path.join(root, f));
  const textual = /\.(ts|mjs|css|md|yml|html)$|Dockerfile$/;
  for (const abs of files) {
    if (!textual.test(abs) || !existsSync(abs)) continue;
    const rel = path.relative(root, abs);
    if (rel.startsWith(`docs${path.sep}screenshots`)) continue;
    const text = readFileSync(abs, 'utf8');
    if (text.includes(OLD_DOC_NAME)) errors.push(`${rel}: referência ao antigo design document`);
    if (text.includes(SECTION_SIGN)) errors.push(`${rel}: símbolo de seção numerada (resquício do antigo design document)`);
  }
}

/** Roda todas as verificações e devolve a lista de problemas (vazia = tudo certo). */
export function checkDocs(root: string = ROOT): string[] {
  const errors: string[] = [];
  const files = docFiles(root);
  checkLinks(root, files, errors);
  checkRoutes(root, errors);
  checkStaleReferences(root, errors);
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkDocs();
  const files = docFiles(ROOT);
  if (errors.length > 0) {
    console.error(`check:docs: ${errors.length} problema(s)\n`);
    for (const e of errors) console.error(`  ✗ ${e}`);
    process.exit(1);
  }
  console.log(`check:docs: ok — ${files.length} documentos, ${routesInDocs(ROOT).size} rotas conferidas`);
}
