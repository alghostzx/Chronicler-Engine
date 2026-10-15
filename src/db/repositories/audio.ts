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

export interface AudioChunk {
  page_id: string;
  chunk_index: number;
  chunk_sha256: string;
  voice: string;
  model: string;
  style: string;
  duration_ms: number;
  audio: Buffer;
  created_at: string;
}

export interface PutAudioChunkInput {
  chunk_index: number;
  chunk_sha256: string;
  voice: string;
  model: string;
  style: string;
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

  /** Retorna todos os trechos salvos para a página, ordenados por chunk_index. */
  getChunks(pageId: string): AudioChunk[] {
    return this.db
      .prepare(
        `SELECT page_id, chunk_index, chunk_sha256, voice, model, style, duration_ms, audio, created_at
         FROM page_audio_chunks WHERE page_id = ? ORDER BY chunk_index ASC`,
      )
      .all(pageId) as AudioChunk[];
  }

  /** Substitui todos os trechos de uma página em transação atômica. */
  replaceChunks(pageId: string, chunks: PutAudioChunkInput[]): void {
    const insert = this.db.prepare(
      `INSERT INTO page_audio_chunks (page_id, chunk_index, chunk_sha256, voice, model, style, duration_ms, audio)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM page_audio_chunks WHERE page_id = ?').run(pageId);
      for (const c of chunks) {
        insert.run(pageId, c.chunk_index, c.chunk_sha256, c.voice, c.model, c.style, c.duration_ms, c.audio);
      }
    })();
    this.reclaim();
  }

  /** Apaga apenas o MP3 consolidado de page_audio, preservando os trechos em page_audio_chunks para reuso. */
  deleteAudio(pageId: string): boolean {
    const removed = this.db.prepare('DELETE FROM page_audio WHERE page_id = ?').run(pageId).changes > 0;
    if (removed) this.reclaim();
    return removed;
  }

  /** Apaga o áudio consolidado e todos os trechos da página. */
  delete(pageId: string): boolean {
    let removed = false;
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM page_audio_chunks WHERE page_id = ?').run(pageId);
      removed = this.db.prepare('DELETE FROM page_audio WHERE page_id = ?').run(pageId).changes > 0;
    })();
    if (removed) this.reclaim();
    return removed;
  }

  deleteAll(): number {
    let n = 0;
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM page_audio_chunks').run();
      n = this.db.prepare('DELETE FROM page_audio').run().changes;
    })();
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
