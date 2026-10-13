import { randomUUID } from 'node:crypto';
import type { Db } from '../connection.js';
import type { DialogueMessage, DialogueSession } from '../types.js';

export class DialogueActiveError extends Error {
  constructor(sessionId: string) {
    super(`A sessão ${sessionId} já possui um diálogo ativo.`);
    this.name = 'DialogueActiveError';
  }
}

export class DialoguesRepository {
  constructor(private readonly db: Db) {}

  /**
   * Cria um diálogo ativo. Falha com `DialogueActiveError` se a sessão já tiver um (docs/modo-dialogo.md#ativação).
   * `redoPageId`: página de diálogo que este diálogo vai substituir ao ser encerrado.
   */
  create(
    sessionId: string,
    npcName: string,
    dynamicSystemPrompt: string,
    opts: { playerName?: string | null; redoPageId?: string | null } = {},
  ): DialogueSession {
    const id = randomUUID();
    try {
      this.db
        .prepare(
          `INSERT INTO dialogue_sessions (id, session_id, npc_name, dynamic_system_prompt, player_name, redo_page_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, sessionId, npcName, dynamicSystemPrompt, opts.playerName ?? null, opts.redoPageId ?? null);
    } catch (err) {
      if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new DialogueActiveError(sessionId);
      }
      throw err;
    }
    return this.get(id)!;
  }

  get(id: string): DialogueSession | undefined {
    return this.db.prepare('SELECT * FROM dialogue_sessions WHERE id = ?').get(id) as DialogueSession | undefined;
  }

  getActive(sessionId: string): DialogueSession | undefined {
    return this.db
      .prepare(`SELECT * FROM dialogue_sessions WHERE session_id = ? AND status = 'active'`)
      .get(sessionId) as DialogueSession | undefined;
  }

  /** Diálogo concluído que gerou a página (guarda a persona do NPC, necessária para refazê-lo). */
  getByPage(pageId: string): DialogueSession | undefined {
    return this.db.prepare('SELECT * FROM dialogue_sessions WHERE page_id = ?').get(pageId) as DialogueSession | undefined;
  }

  /**
   * Encerra o diálogo e o liga à página que ele gerou. As mensagens são apagadas: a partir daqui o
   * texto da página (editável) é a fonte da verdade.
   */
  conclude(id: string, pageId: string): void {
    this.db
      .prepare(`UPDATE dialogue_sessions SET status = 'concluded', page_id = ?, redo_page_id = NULL WHERE id = ?`)
      .run(pageId, id);
    this.db.prepare('DELETE FROM dialogue_messages WHERE dialogue_session_id = ?').run(id);
  }

  /** Remove o diálogo concluído de uma página (ao ser substituído por um refeito). */
  deleteByPage(pageId: string): boolean {
    return this.db.prepare('DELETE FROM dialogue_sessions WHERE page_id = ?').run(pageId).changes > 0;
  }

  /** Remove o diálogo e suas mensagens (cascata). Usado no cancelamento. */
  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM dialogue_sessions WHERE id = ?').run(id).changes > 0;
  }

  addMessage(dialogueSessionId: string, sender: 'player' | 'npc', content: string): DialogueMessage {
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO dialogue_messages (id, dialogue_session_id, sender, content) VALUES (?, ?, ?, ?)`)
      .run(id, dialogueSessionId, sender, content);
    return this.db.prepare('SELECT * FROM dialogue_messages WHERE id = ?').get(id) as DialogueMessage;
  }

  /** Mensagens em ordem de inserção (rowid desempata mensagens no mesmo segundo). */
  listMessages(dialogueSessionId: string): DialogueMessage[] {
    return this.db
      .prepare('SELECT * FROM dialogue_messages WHERE dialogue_session_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(dialogueSessionId) as DialogueMessage[];
  }
}
