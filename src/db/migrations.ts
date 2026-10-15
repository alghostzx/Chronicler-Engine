import type { Db } from './connection.js';

/**
 * Migrações do banco (SQLite `PRAGMA user_version`).
 *
 * Política (alpha): bancos existentes são migrados. Só se quebra o banco (exigindo apagar `./data`)
 * quando migrar for muito problemático ou inflaria o programa com migrações demais — e isso deve ser
 * dito no README e em docs/modelo-de-dados.md. Cada migração roda numa transação, junto com a troca do
 * `user_version`; falhando, nada é alterado. Antes de migrar um banco em arquivo, o runner faz uma
 * cópia (`<arquivo>.v<versão-antiga>.bak`).
 *
 * Para criar uma migração: aumente `SCHEMA_VERSION` em `schema.ts`, atualize `SCHEMA_SQL` (banco novo)
 * e acrescente aqui `{ version: N, up }`. O teste `migrations.test.ts` compara o schema obtido pelos
 * dois caminhos (banco novo × migrado a partir da versão anterior).
 */
export interface Migration {
  /** Versão do schema depois de aplicada. */
  version: number;
  description: string;
  up(db: Db): void;
}

/**
 * Menor versão de schema que ainda sabe migrar. Bancos mais antigos (1 e 2, da fase pré-alpha, sem
 * `page_audio`/`auto_vacuum`) são recusados com uma mensagem clara.
 */
export const MIN_MIGRATABLE_VERSION = 3;

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 4,
    description: 'diálogo como página (kind/npc_name em páginas; page_id/redo_page_id/player_name em diálogos; tts_auto_dialogue)',
    up(db) {
      db.exec(`
        ALTER TABLE sessions ADD COLUMN tts_auto_dialogue INTEGER;
        ALTER TABLE narrative_pages ADD COLUMN kind TEXT NOT NULL DEFAULT 'narrative' CHECK (kind IN ('narrative', 'dialogue'));
        ALTER TABLE narrative_pages ADD COLUMN npc_name TEXT;
        ALTER TABLE dialogue_sessions ADD COLUMN player_name TEXT;
        ALTER TABLE dialogue_sessions ADD COLUMN page_id TEXT REFERENCES narrative_pages(id) ON DELETE CASCADE;
        ALTER TABLE dialogue_sessions ADD COLUMN redo_page_id TEXT REFERENCES narrative_pages(id) ON DELETE CASCADE;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_dialogue_page ON dialogue_sessions(page_id) WHERE page_id IS NOT NULL;
        -- Diálogos concluídos antes desta versão já viraram páginas de prosa (a "costura"): ficam como
        -- páginas normais e as conversas brutas, sem página ligada, são descartadas (mensagens em cascata).
        DELETE FROM dialogue_sessions WHERE status = 'concluded';
      `);
    },
  },
  {
    version: 5,
    description: 'diálogo narrado (narrative_pages.raw_dialogue: página de diálogo com a transcrição crua)',
    up(db) {
      db.exec(`
        ALTER TABLE narrative_pages ADD COLUMN raw_dialogue INTEGER NOT NULL DEFAULT 0 CHECK (raw_dialogue IN (0, 1));
        -- Todas as páginas de diálogo criadas até a v4 guardam a transcrição crua.
        UPDATE narrative_pages SET raw_dialogue = 1 WHERE kind = 'dialogue';
      `);
    },
  },
  {
    version: 6,
    description: 'narração automática única (remove sessions.tts_auto_dialogue e a configuração global dos diálogos)',
    up(db) {
      db.exec(`
        ALTER TABLE sessions DROP COLUMN tts_auto_dialogue;
        DELETE FROM app_settings WHERE key = 'tts_auto_dialogue_default';
      `);
    },
  },
  {
    version: 7,
    description: 'cache de trechos de áudio por página (page_audio_chunks)',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS page_audio_chunks (
            page_id TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            chunk_sha256 TEXT NOT NULL,
            voice TEXT NOT NULL,
            model TEXT NOT NULL,
            style TEXT NOT NULL,
            duration_ms INTEGER NOT NULL,
            audio BLOB NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (page_id, chunk_index),
            FOREIGN KEY (page_id) REFERENCES narrative_pages(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_audio_chunks_lookup
            ON page_audio_chunks(page_id, chunk_sha256, voice, model, style);
      `);
    },
  },
];
