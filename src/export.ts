import type { NarrativeBlock, Session } from './db/types.js';

export interface StoryExportInput {
  session: Pick<Session, 'title' | 'world_context'>;
  /** Todos os blocos da sessão em ordem, inclusive os arquivados pela compactação. */
  blocks: Pick<NarrativeBlock, 'generated_text'>[];
  exportedAt: Date;
  /** Inclui o contexto do mundo (que já carrega as sinopses `## Crônica — Volume N`). */
  includeContext: boolean;
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Monta o Markdown da história: título, a prosa de todos os blocos (texto original, mesmo dos
 * arquivados) e, opcionalmente, o contexto do mundo. Meta-instruções do jogador não entram.
 */
export function buildStoryMarkdown(input: StoryExportInput): string {
  const title = oneLine(input.session.title) || 'Crônica sem título';
  const parts: string[] = [`# ${title}`];

  const day = input.exportedAt.toISOString().slice(0, 10);
  const count = input.blocks.length;
  parts.push(`*Exportado do Chronicler Engine em ${day} · ${count} ${count === 1 ? 'bloco' : 'blocos'}*`);

  const context = input.session.world_context.trim();
  if (input.includeContext && context) {
    parts.push('## Mundo e personagens', context);
  }
  if (input.includeContext && context && count > 0) parts.push('## Narrativa');

  for (const block of input.blocks) {
    const text = block.generated_text.trim();
    if (text) parts.push(text);
  }
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
export function contentDisposition(title: string): string {
  const utf8Name = oneLine(title).replace(/[\\/:*?"<>|]+/g, '-').slice(0, 120) || 'cronica';
  return `attachment; filename="${slugify(title)}.md"; filename*=UTF-8''${encodeURIComponent(utf8Name)}.md`;
}
