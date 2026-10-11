import { randomUUID } from 'node:crypto';
import type { Db } from '../connection.js';
import type { Page, PageKind } from '../types.js';

type PageRow = Omit<Page, 'is_archived'> & { is_archived: number | null };

const toPage = (row: PageRow): Page => ({ ...row, is_archived: Boolean(row.is_archived) });

export interface AppendPageInput {
  player_instruction: string | null;
  generated_text: string;
  model_identifier?: string | null;
  /** Padrão `narrative`. Páginas de diálogo guardam a transcrição e o nome do NPC. */
  kind?: PageKind;
  npc_name?: string | null;
}

export class PagesRepository {
  constructor(private readonly db: Db) {}

  /**
   * Acrescenta uma página ao fim da sessão. O `order_index` considera também as páginas
   * arquivados, de modo que os índices nunca são reutilizados após uma compactação.
   */
  append(sessionId: string, input: AppendPageInput): Page {
    const id = randomUUID();
    const row = this.db
      .prepare('SELECT COALESCE(MAX(order_index), 0) AS max FROM narrative_pages WHERE session_id = ?')
      .get(sessionId) as { max: number };
    this.db
      .prepare(
        `INSERT INTO narrative_pages (id, session_id, order_index, player_instruction, generated_text, model_identifier, kind, npc_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        sessionId,
        row.max + 1,
        input.player_instruction,
        input.generated_text,
        input.model_identifier ?? null,
        input.kind ?? 'narrative',
        input.npc_name ?? null,
      );
    return this.get(id)!;
  }

  get(id: string): Page | undefined {
    const row = this.db.prepare('SELECT * FROM narrative_pages WHERE id = ?').get(id) as PageRow | undefined;
    return row && toPage(row);
  }

  /** Páginas ativas (não arquivadas) em ordem cronológica — o corpus enviado ao Gemini. */
  listActive(sessionId: string): Page[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM narrative_pages WHERE session_id = ? AND is_archived = FALSE ORDER BY order_index ASC`,
        )
        .all(sessionId) as PageRow[]
    ).map(toPage);
  }

  listAll(sessionId: string): Page[] {
    return (
      this.db
        .prepare('SELECT * FROM narrative_pages WHERE session_id = ? ORDER BY order_index ASC')
        .all(sessionId) as PageRow[]
    ).map(toPage);
  }

  /**
   * Páginas já consumidas por um volume (arquivadas) com `order_index` entre `from` e `to`, em ordem.
   * Continuam existindo para leitura e exportação, mas ficam fora do contexto da IA.
   */
  listArchivedRange(sessionId: string, from: number, to: number): Page[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM narrative_pages
           WHERE session_id = ? AND is_archived = TRUE AND order_index BETWEEN ? AND ?
           ORDER BY order_index ASC`,
        )
        .all(sessionId, from, to) as PageRow[]
    ).map(toPage);
  }

  /** Última página ativa da sessão, se houver. */
  last(sessionId: string): Page | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM narrative_pages WHERE session_id = ? AND is_archived = FALSE ORDER BY order_index DESC LIMIT 1`,
      )
      .get(sessionId) as PageRow | undefined;
    return row && toPage(row);
  }

  /** Edição manual: altera só o texto, preservando páginas posteriores (§6.1). */
  updateText(id: string, generatedText: string): Page | undefined {
    this.db
      .prepare('UPDATE narrative_pages SET generated_text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(generatedText, id);
    return this.get(id);
  }

  /** Substitui instrução, texto e modelo de uma página (resultado de uma regeneração por IA). */
  replaceGeneration(
    id: string,
    input: { player_instruction: string | null; generated_text: string; model_identifier?: string | null },
  ): Page | undefined {
    this.db
      .prepare(
        `UPDATE narrative_pages
         SET player_instruction = ?, generated_text = ?, model_identifier = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .run(input.player_instruction, input.generated_text, input.model_identifier ?? null, id);
    return this.get(id);
  }

  /** Remove todas as páginas com `order_index` maior que o informado (§6.2). */
  deleteAfter(sessionId: string, orderIndex: number): number {
    return this.db
      .prepare('DELETE FROM narrative_pages WHERE session_id = ? AND order_index > ?')
      .run(sessionId, orderIndex).changes;
  }

  /** Marca como arquivadas as páginas ativas com `order_index` entre `from` e `to` (inclusive). */
  archiveRange(sessionId: string, from: number, to: number): number {
    return this.db
      .prepare(
        `UPDATE narrative_pages SET is_archived = TRUE, updated_at = CURRENT_TIMESTAMP
         WHERE session_id = ? AND order_index BETWEEN ? AND ? AND is_archived = FALSE`,
      )
      .run(sessionId, from, to).changes;
  }
}
