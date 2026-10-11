import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS, MIN_MIGRATABLE_VERSION } from './migrations.js';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';

export type Db = Database.Database;

/**
 * Abre (criando se necessário) o banco SQLite. Banco novo recebe o schema atual; banco existente é
 * migrado até `SCHEMA_VERSION` (ver `migrations.ts`). Aceita `:memory:` para testes.
 */
export function openDatabase(databasePath: string): Db {
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }
  const db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  if ((db.pragma('user_version', { simple: true }) as number) === 0) {
    // Banco novo. Só tem efeito antes de qualquer escrita (inclusive a troca para WAL): permite
    // devolver ao disco o espaço dos áudios apagados (`incremental_vacuum`) em vez de o arquivo
    // só crescer.
    db.pragma('auto_vacuum = INCREMENTAL');
  }
  if (databasePath !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  try {
    prepareSchema(db, databasePath);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

function prepareSchema(db: Db, databasePath: string): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current === 0) {
    db.exec(SCHEMA_SQL);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    return;
  }
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `Banco de dados com versão de schema (${current}) mais nova que a suportada (${SCHEMA_VERSION}). ` +
        'Atualize o Chronicler Engine.',
    );
  }
  if (current < MIN_MIGRATABLE_VERSION) {
    throw new Error(
      `Banco de dados com versão de schema antiga (${current}); esta versão (${SCHEMA_VERSION}) só migra a partir da ` +
        `versão ${MIN_MIGRATABLE_VERSION}. Apague o arquivo do banco (a pasta ./data) e inicie novamente.`,
    );
  }
  const pending = MIGRATIONS.filter((m) => m.version > current).sort((a, b) => a.version - b.version);
  if (pending.length === 0) return;

  if (databasePath !== ':memory:') {
    // Cópia de segurança antes de alterar o banco (o WAL é esvaziado para o arquivo ficar completo).
    db.pragma('wal_checkpoint(TRUNCATE)');
    fs.copyFileSync(databasePath, `${databasePath}.v${current}.bak`);
  }
  for (const m of pending) {
    try {
      db.transaction(() => {
        m.up(db);
        db.pragma(`user_version = ${m.version}`);
      })();
    } catch (err) {
      throw new Error(`Falha ao migrar o banco para a versão ${m.version} (${m.description}): ${(err as Error).message}`, { cause: err });
    }
  }
}
