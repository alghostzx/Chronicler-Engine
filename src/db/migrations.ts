import type { Db } from './connection.js';

/**
 * Migrações do banco (SQLite `PRAGMA user_version`).
 *
 * Política (alpha): bancos existentes são migrados. Só se quebra o banco (exigindo apagar `./data`)
 * quando migrar for muito problemático ou inflaria o programa com migrações demais — e isso deve ser
 * dito no README e no design document. Cada migração roda numa transação, junto com a troca do
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
];
