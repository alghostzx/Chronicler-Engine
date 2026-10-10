import { randomUUID } from 'node:crypto';
import type { Db } from '../connection.js';
import type { ChronicleArchive } from '../types.js';

export class ArchivesRepository {
  constructor(private readonly db: Db) {}

  /** Cria o próximo volume da crônica (numeração incremental por sessão). */
  create(
    sessionId: string,
    input: { summary_text: string; covered_page_start_index: number; covered_page_end_index: number },
  ): ChronicleArchive {
    const id = randomUUID();
    const row = this.db
      .prepare('SELECT COALESCE(MAX(volume_number), 0) AS max FROM chronicle_archives WHERE session_id = ?')
      .get(sessionId) as { max: number };
    this.db
      .prepare(
        `INSERT INTO chronicle_archives
           (id, session_id, volume_number, summary_text, covered_page_start_index, covered_page_end_index)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        sessionId,
        row.max + 1,
        input.summary_text,
        input.covered_page_start_index,
        input.covered_page_end_index,
      );
    return this.db.prepare('SELECT * FROM chronicle_archives WHERE id = ?').get(id) as ChronicleArchive;
  }

  get(id: string): ChronicleArchive | undefined {
    return this.db.prepare('SELECT * FROM chronicle_archives WHERE id = ?').get(id) as ChronicleArchive | undefined;
  }

  list(sessionId: string): ChronicleArchive[] {
    return this.db
      .prepare('SELECT * FROM chronicle_archives WHERE session_id = ? ORDER BY volume_number ASC')
      .all(sessionId) as ChronicleArchive[];
  }
}
