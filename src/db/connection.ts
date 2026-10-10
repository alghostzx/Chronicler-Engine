import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';

export type Db = Database.Database;

/**
 * Abre (criando se necessário) o banco SQLite e aplica o schema de forma idempotente.
 * Aceita `:memory:` para testes.
 */
export function openDatabase(databasePath: string): Db {
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }
  const db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  if (databasePath !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `Banco de dados com versão de schema (${current}) mais nova que a suportada (${SCHEMA_VERSION}).`,
    );
  }
  // Banco criado por uma versão anterior (user_version 1..SCHEMA_VERSION-1): sem migração (pré-pré-alpha).
  if (current > 0 && current < SCHEMA_VERSION) {
    throw new Error(
      `Banco de dados com versão de schema antiga (${current}); esta versão (${SCHEMA_VERSION}) não oferece migração. ` +
        'O projeto está em fase pré-alpha: apague o arquivo do banco (a pasta ./data) e inicie novamente.',
    );
  }
  if (current === 0) {
    // Só tem efeito antes da primeira tabela existir: permite devolver ao disco o espaço dos
    // áudios apagados (`incremental_vacuum`) em vez de o arquivo só crescer.
    db.pragma('auto_vacuum = INCREMENTAL');
  }
  db.exec(SCHEMA_SQL);
  if (current < SCHEMA_VERSION) {
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
}
