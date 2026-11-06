import { randomUUID } from 'node:crypto';
import type { Db } from '../connection.js';
import type { DialogueMessage, DialogueParticipant, DialogueSession } from '../types.js';

export class DialogueActiveError extends Error {
  constructor(sessionId: string) {
    super(`A sessão ${sessionId} já possui um diálogo ativo.`);
    this.name = 'DialogueActiveError';
  }
}

export interface NewDialogueParticipant {
  npc_name: string;
  dynamic_system_prompt: string;
}

/** Formata a lista de nomes dos NPCs para cabeçalhos e selos (ex.: "Elena", "Elena e Guarda", "A, B e C"). */
export function formatParticipantsNames(names: string[]): string {
  const clean = names.map((n) => n.trim()).filter((n) => n.length > 0);
  if (clean.length === 0) return '';
  if (clean.length === 1) return clean[0]!;
  if (clean.length === 2) return `${clean[0]!} e ${clean[1]!}`;
  return `${clean.slice(0, -1).join(', ')} e ${clean.at(-1)!}`;
}

export class DialoguesRepository {
  constructor(private readonly db: Db) {}

  /**
   * Cria um diálogo ativo. Falha com `DialogueActiveError` se a sessão já tiver um (docs/modo-dialogo.md#ativação).
   * `redoPageId`: página de diálogo que este diálogo vai substituir ao ser encerrado.
   * `participants`: lista inicial de NPCs (se omitida, cria 1 participante com `npcName` e `dynamicSystemPrompt`).
   */
  create(
    sessionId: string,
    npcName: string,
    dynamicSystemPrompt: string,
    opts: {
      playerName?: string | null;
      redoPageId?: string | null;
      participants?: NewDialogueParticipant[];
    } = {},
  ): DialogueSession {
    const id = randomUUID();
    const list =
      opts.participants && opts.participants.length > 0
        ? opts.participants
        : [{ npc_name: npcName, dynamic_system_prompt: dynamicSystemPrompt }];
    const summaryName = formatParticipantsNames(list.map((p) => p.npc_name)) || npcName;
    const firstPrompt = list[0]?.dynamic_system_prompt ?? dynamicSystemPrompt;

    try {
      this.db.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO dialogue_sessions (id, session_id, npc_name, dynamic_system_prompt, player_name, redo_page_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(id, sessionId, summaryName, firstPrompt, opts.playerName ?? null, opts.redoPageId ?? null);

        const ins = this.db.prepare(
          `INSERT INTO dialogue_participants (id, dialogue_session_id, order_index, npc_name, dynamic_system_prompt)
           VALUES (?, ?, ?, ?, ?)`,
        );
        list.forEach((p, idx) => {
          ins.run(randomUUID(), id, idx + 1, p.npc_name, p.dynamic_system_prompt);
        });
      })();
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

  /** Diálogo concluído que gerou a página (guarda a persona dos NPCs, necessária para refazê-lo). */
  getByPage(pageId: string): DialogueSession | undefined {
    return this.db.prepare('SELECT * FROM dialogue_sessions WHERE page_id = ?').get(pageId) as DialogueSession | undefined;
  }

  /** Lista os NPCs participantes do diálogo em ordem de turno. */
  listParticipants(dialogueSessionId: string): DialogueParticipant[] {
    return this.db
      .prepare(
        'SELECT * FROM dialogue_participants WHERE dialogue_session_id = ? ORDER BY order_index ASC, rowid ASC',
      )
      .all(dialogueSessionId) as DialogueParticipant[];
  }

  getParticipant(participantId: string): DialogueParticipant | undefined {
    return this.db
      .prepare('SELECT * FROM dialogue_participants WHERE id = ?')
      .get(participantId) as DialogueParticipant | undefined;
  }

  addParticipant(dialogueSessionId: string, npcName: string, dynamicSystemPrompt: string): DialogueParticipant {
    const id = randomUUID();
    this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT COALESCE(MAX(order_index), 0) AS max_idx FROM dialogue_participants WHERE dialogue_session_id = ?')
        .get(dialogueSessionId) as { max_idx: number };
      this.db
        .prepare(
          `INSERT INTO dialogue_participants (id, dialogue_session_id, order_index, npc_name, dynamic_system_prompt)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, dialogueSessionId, row.max_idx + 1, npcName, dynamicSystemPrompt);
      this.syncSessionSummary(dialogueSessionId);
    })();
    return this.getParticipant(id)!;
  }

  updateParticipant(
    participantId: string,
    patch: { npc_name?: string; dynamic_system_prompt?: string },
  ): DialogueParticipant | undefined {
    const current = this.getParticipant(participantId);
    if (!current) return undefined;
    const nextName = patch.npc_name !== undefined ? patch.npc_name : current.npc_name;
    const nextPrompt =
      patch.dynamic_system_prompt !== undefined ? patch.dynamic_system_prompt : current.dynamic_system_prompt;
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE dialogue_participants SET npc_name = ?, dynamic_system_prompt = ? WHERE id = ?')
        .run(nextName, nextPrompt, participantId);
      if (nextName !== current.npc_name) {
        this.db
          .prepare(
            `UPDATE dialogue_messages SET speaker_name = ?
             WHERE dialogue_session_id = ? AND sender = 'npc' AND speaker_name = ?`,
          )
          .run(nextName, current.dialogue_session_id, current.npc_name);
      }
      this.syncSessionSummary(current.dialogue_session_id);
    })();
    return this.getParticipant(participantId);
  }

  removeParticipant(participantId: string): boolean {
    const current = this.getParticipant(participantId);
    if (!current) return false;
    let removed = false;
    this.db.transaction(() => {
      removed = this.db.prepare('DELETE FROM dialogue_participants WHERE id = ?').run(participantId).changes > 0;
      if (removed) this.syncSessionSummary(current.dialogue_session_id);
    })();
    return removed;
  }

  private syncSessionSummary(dialogueSessionId: string): void {
    const list = this.listParticipants(dialogueSessionId);
    if (list.length === 0) return;
    const summaryName = formatParticipantsNames(list.map((p) => p.npc_name));
    const firstPrompt = list[0]!.dynamic_system_prompt;
    this.db
      .prepare('UPDATE dialogue_sessions SET npc_name = ?, dynamic_system_prompt = ? WHERE id = ?')
      .run(summaryName, firstPrompt, dialogueSessionId);
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

  addMessage(
    dialogueSessionId: string,
    sender: 'player' | 'npc',
    content: string,
    speakerName?: string | null,
  ): DialogueMessage {
    const id = randomUUID();
    let resolvedSpeaker: string | null = null;
    if (sender === 'npc') {
      resolvedSpeaker =
        speakerName ??
        this.listParticipants(dialogueSessionId)[0]?.npc_name ??
        this.get(dialogueSessionId)?.npc_name ??
        null;
    }
    this.db
      .prepare(
        `INSERT INTO dialogue_messages (id, dialogue_session_id, sender, content, speaker_name) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, dialogueSessionId, sender, content, resolvedSpeaker);
    return this.db.prepare('SELECT * FROM dialogue_messages WHERE id = ?').get(id) as DialogueMessage;
  }

  /** Mensagens em ordem de inserção (rowid desempata mensagens no mesmo segundo). */
  listMessages(dialogueSessionId: string): DialogueMessage[] {
    return this.db
      .prepare('SELECT * FROM dialogue_messages WHERE dialogue_session_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(dialogueSessionId) as DialogueMessage[];
  }
}
