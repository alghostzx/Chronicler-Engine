import type { ChronicleArchive, Page, Session } from './db/types.js';

/** Quais páginas entram na exportação da crônica. */
export type ExportScope = 'all' | 'active' | 'archived';

export interface StoryExportInput {
  session: Pick<Session, 'title' | 'world_context'>;
  /**
   * Páginas a exportar, em ordem. O escopo (`all`/`active`/`archived`) é decidido por quem chama:
   * as páginas já consumidas por volumes continuam existindo e podem ser exportadas.
   */
  pages: Pick<Page, 'generated_text'>[];
  exportedAt: Date;
  /** Inclui o contexto do mundo (que já carrega as sinopses `## Crônica — Volume N`). */
  includeContext: boolean;
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Separador entre páginas: régua horizontal do Markdown, com linhas em branco ao redor. */
export const PAGE_SEPARATOR = '---';

const plural = (n: number) => `${n} ${n === 1 ? 'página' : 'páginas'}`;

/** Texto das páginas (sem as vazias) intercalado com o separador `---`. */
function pageBlocks(pages: Pick<Page, 'generated_text'>[]): string[] {
  const texts = pages.map((p) => p.generated_text.trim()).filter((t) => t !== '');
  return texts.flatMap((text, i) => (i === 0 ? [text] : [PAGE_SEPARATOR, text]));
}

/**
 * Monta o Markdown da história: título, a prosa das páginas (texto original, mesmo das já
 * consumidas por volumes) separadas por `---` e, opcionalmente, o contexto do mundo.
 * Meta-instruções do jogador (prompts) nunca entram.
 */
export function buildStoryMarkdown(input: StoryExportInput): string {
  const title = oneLine(input.session.title) || 'Crônica sem título';
  const parts: string[] = [`# ${title}`];

  const day = input.exportedAt.toISOString().slice(0, 10);
  parts.push(`*Exportado do Chronicler Engine em ${day} · ${plural(input.pages.length)}*`);

  const context = input.session.world_context.trim();
  if (input.includeContext && context) {
    parts.push('## Mundo e personagens', context);
  }
  if (input.includeContext && context && input.pages.length > 0) parts.push('## Narrativa');

  parts.push(...pageBlocks(input.pages));
  return parts.join('\n\n') + '\n';
}

export interface VolumeExportInput {
  session: Pick<Session, 'title'>;
  archive: Pick<ChronicleArchive, 'volume_number' | 'summary_text' | 'covered_page_start_index' | 'covered_page_end_index'>;
  /** Páginas consumidas por este volume, em ordem. */
  pages: Pick<Page, 'generated_text'>[];
  exportedAt: Date;
  /** Inclui a sinopse (`## Sinopse`) antes das páginas. */
  includeSummary: boolean;
}

/** Título usado no cabeçalho e no nome do arquivo de um volume. */
export const volumeTitle = (title: string, volumeNumber: number): string =>
  `${oneLine(title) || 'Crônica sem título'} — Volume ${volumeNumber}`;

/** Markdown de um volume: título, metadados, sinopse opcional e as páginas que ele consumiu. */
export function buildVolumeMarkdown(input: VolumeExportInput): string {
  const { archive } = input;
  const parts: string[] = [`# ${volumeTitle(input.session.title, archive.volume_number)}`];
  const day = input.exportedAt.toISOString().slice(0, 10);
  parts.push(
    `*Exportado do Chronicler Engine em ${day} · páginas ${archive.covered_page_start_index} a ${archive.covered_page_end_index} (${plural(input.pages.length)})*`,
  );
  const summary = archive.summary_text.trim();
  if (input.includeSummary && summary) parts.push('## Sinopse', summary);
  if (input.includeSummary && summary && input.pages.length > 0) parts.push('## Narrativa');
  parts.push(...pageBlocks(input.pages));
  return parts.join('\n\n') + '\n';
}

/** Nome de arquivo ASCII seguro a partir do título (`a-queda-de-valdoria`). */
export function slugify(title: string): string {
  const slug = title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'cronica';
}

/** Valor do cabeçalho Content-Disposition com nome ASCII e nome UTF-8 (RFC 6266). */
export function contentDisposition(title: string, ext = 'md'): string {
  const utf8Name = oneLine(title).replace(/[\\/:*?"<>|]+/g, '-').slice(0, 120) || 'cronica';
  return `attachment; filename="${slugify(title)}.${ext}"; filename*=UTF-8''${encodeURIComponent(utf8Name)}.${ext}`;
}
