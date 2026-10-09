import { randomUUID } from 'node:crypto';
import type { Db } from '../connection.js';
import type { NarrativeBlock } from '../types.js';

type BlockRow = Omit<NarrativeBlock, 'is_archived'> & { is_archived: number | null };

const toBlock = (row: BlockRow): NarrativeBlock => ({ ...row, is_archived: Boolean(row.is_archived) });

export interface AppendBlockInput {
  player_instruction: string | null;
  generated_text: string;
  model_identifier?: string | null;
}

export class BlocksRepository {
  constructor(private readonly db: Db) {}

  /**
   * Acrescenta um bloco ao fim da sessão. O `order_index` considera também os blocos
   * arquivados, de modo que os índices nunca são reutilizados após uma compactação.
   */
  append(sessionId: string, input: AppendBlockInput): NarrativeBlock {
    const id = randomUUID();
    const row = this.db
      .prepare('SELECT COALESCE(MAX(order_index), 0) AS max FROM narrative_blocks WHERE session_id = ?')
      .get(sessionId) as { max: number };
    this.db
      .prepare(
        `INSERT INTO narrative_blocks (id, session_id, order_index, player_instruction, generated_text, model_identifier)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, sessionId, row.max + 1, input.player_instruction, input.generated_text, input.model_identifier ?? null);
    return this.get(id)!;
  }

  get(id: string): NarrativeBlock | undefined {
    const row = this.db.prepare('SELECT * FROM narrative_blocks WHERE id = ?').get(id) as BlockRow | undefined;
    return row && toBlock(row);
  }

  /** Blocos ativos (não arquivados) em ordem cronológica — o corpus enviado ao Gemini. */
  listActive(sessionId: string): NarrativeBlock[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM narrative_blocks WHERE session_id = ? AND is_archived = FALSE ORDER BY order_index ASC`,
        )
        .all(sessionId) as BlockRow[]
    ).map(toBlock);
  }

  listAll(sessionId: string): NarrativeBlock[] {
    return (
      this.db
        .prepare('SELECT * FROM narrative_blocks WHERE session_id = ? ORDER BY order_index ASC')
        .all(sessionId) as BlockRow[]
    ).map(toBlock);
  }

  /** Último bloco ativo da sessão, se houver. */
  last(sessionId: string): NarrativeBlock | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM narrative_blocks WHERE session_id = ? AND is_archived = FALSE ORDER BY order_index DESC LIMIT 1`,
      )
      .get(sessionId) as BlockRow | undefined;
    return row && toBlock(row);
  }

  /** Edição manual: altera só o texto, preservando blocos posteriores (§6.1). */
  updateText(id: string, generatedText: string): NarrativeBlock | undefined {
    this.db
      .prepare('UPDATE narrative_blocks SET generated_text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(generatedText, id);
    return this.get(id);
  }

  /** Substitui instrução, texto e modelo de um bloco (resultado de uma regeneração por IA). */
  replaceGeneration(
    id: string,
    input: { player_instruction: string | null; generated_text: string; model_identifier?: string | null },
  ): NarrativeBlock | undefined {
    this.db
      .prepare(
        `UPDATE narrative_blocks
         SET player_instruction = ?, generated_text = ?, model_identifier = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .run(input.player_instruction, input.generated_text, input.model_identifier ?? null, id);
    return this.get(id);
  }

  /** Remove todos os blocos com `order_index` maior que o informado (§6.2). */
  deleteAfter(sessionId: string, orderIndex: number): number {
    return this.db
      .prepare('DELETE FROM narrative_blocks WHERE session_id = ? AND order_index > ?')
      .run(sessionId, orderIndex).changes;
  }

  /** Marca como arquivados os blocos ativos com `order_index` entre `from` e `to` (inclusive). */
  archiveRange(sessionId: string, from: number, to: number): number {
    return this.db
      .prepare(
        `UPDATE narrative_blocks SET is_archived = TRUE, updated_at = CURRENT_TIMESTAMP
         WHERE session_id = ? AND order_index BETWEEN ? AND ? AND is_archived = FALSE`,
      )
      .run(sessionId, from, to).changes;
  }
}
