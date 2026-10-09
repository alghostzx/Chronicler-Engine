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

  /** Cria um diálogo ativo. Falha com `DialogueActiveError` se a sessão já tiver um (§11.6). */
  create(sessionId: string, npcName: string, dynamicSystemPrompt: string): DialogueSession {
    const id = randomUUID();
    try {
      this.db
        .prepare(
          `INSERT INTO dialogue_sessions (id, session_id, npc_name, dynamic_system_prompt) VALUES (?, ?, ?, ?)`,
        )
        .run(id, sessionId, npcName, dynamicSystemPrompt);
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

  conclude(id: string): void {
    this.db.prepare(`UPDATE dialogue_sessions SET status = 'concluded' WHERE id = ?`).run(id);
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
