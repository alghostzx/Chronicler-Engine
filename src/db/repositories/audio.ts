import type { Db } from '../connection.js';

/** Metadados do áudio de uma página (sem o BLOB). */
export interface AudioMeta {
  page_id: string;
  text_sha256: string;
  voice: string;
  model: string;
  style: string;
  mime: string;
  duration_ms: number;
  bytes: number;
  created_at: string;
}

export interface PutAudioInput {
  text_sha256: string;
  voice: string;
  model: string;
  style: string;
  mime?: string;
  duration_ms: number;
  audio: Buffer;
}

const META_COLUMNS = 'page_id, text_sha256, voice, model, style, mime, duration_ms, bytes, created_at';

/**
 * Áudio narrado de cada página, em tabela própria (listar páginas nunca carrega BLOBs).
 * `ON DELETE CASCADE` cobre ramificação e exclusão de sessão; edição e regeneração mantêm a
 * página, então quem as executa precisa chamar `delete` explicitamente.
 */
export class AudioRepository {
  constructor(private readonly db: Db) {}

  meta(pageId: string): AudioMeta | undefined {
    return this.db.prepare(`SELECT ${META_COLUMNS} FROM page_audio WHERE page_id = ?`).get(pageId) as
      | AudioMeta
      | undefined;
  }

  /** Metadados de várias páginas de uma vez (chave: `page_id`). */
  metaFor(pageIds: string[]): Map<string, AudioMeta> {
    const result = new Map<string, AudioMeta>();
    // O SQLite limita as variáveis de uma consulta; processa em lotes.
    for (let i = 0; i < pageIds.length; i += 500) {
      const batch = pageIds.slice(i, i + 500);
      const rows = this.db
        .prepare(`SELECT ${META_COLUMNS} FROM page_audio WHERE page_id IN (${batch.map(() => '?').join(',')})`)
        .all(...batch) as AudioMeta[];
      for (const row of rows) result.set(row.page_id, row);
    }
    return result;
  }

  blob(pageId: string): Buffer | undefined {
    const row = this.db.prepare('SELECT audio FROM page_audio WHERE page_id = ?').get(pageId) as
      | { audio: Buffer }
      | undefined;
    return row?.audio;
  }

  /** Grava (ou substitui) o áudio de uma página. */
  put(pageId: string, input: PutAudioInput): AudioMeta {
    this.db
      .prepare(
        `INSERT INTO page_audio (page_id, text_sha256, voice, model, style, mime, duration_ms, bytes, audio)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(page_id) DO UPDATE SET
           text_sha256 = excluded.text_sha256, voice = excluded.voice, model = excluded.model,
           style = excluded.style, mime = excluded.mime, duration_ms = excluded.duration_ms,
           bytes = excluded.bytes, audio = excluded.audio, created_at = CURRENT_TIMESTAMP`,
      )
      .run(
        pageId,
        input.text_sha256,
        input.voice,
        input.model,
        input.style,
        input.mime ?? 'audio/mpeg',
        input.duration_ms,
        input.audio.length,
        input.audio,
      );
    this.reclaim();
    return this.meta(pageId)!;
  }

  delete(pageId: string): boolean {
    const removed = this.db.prepare('DELETE FROM page_audio WHERE page_id = ?').run(pageId).changes > 0;
    if (removed) this.reclaim();
    return removed;
  }

  deleteAll(): number {
    const n = this.db.prepare('DELETE FROM page_audio').run().changes;
    if (n > 0) this.reclaim();
    return n;
  }

  usage(): { count: number; bytes: number } {
    return this.db
      .prepare('SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM page_audio')
      .get() as { count: number; bytes: number };
  }

  /**
   * Devolve ao sistema de arquivos as páginas livres deixadas por áudios apagados
   * (`auto_vacuum = INCREMENTAL`). Não roda dentro de uma transação; quem apaga em transação
   * chama de novo depois dela.
   */
  reclaim(): void {
    if (this.db.inTransaction) return;
    this.db.pragma('incremental_vacuum');
  }
}
