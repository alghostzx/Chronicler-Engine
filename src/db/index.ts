import { openDatabase, type Db } from './connection.js';
import { ArchivesRepository } from './repositories/archives.js';
import { BlocksRepository } from './repositories/blocks.js';
import { DialoguesRepository } from './repositories/dialogues.js';
import { SessionsRepository } from './repositories/sessions.js';
import { SettingsRepository } from './repositories/settings.js';

export interface Repositories {
  db: Db;
  settings: SettingsRepository;
  sessions: SessionsRepository;
  blocks: BlocksRepository;
  archives: ArchivesRepository;
  dialogues: DialoguesRepository;
  /** Executa `fn` numa transação SQLite (rollback automático se lançar exceção). */
  transaction<T>(fn: () => T): T;
}

export function createRepositories(db: Db): Repositories {
  return {
    db,
    settings: new SettingsRepository(db),
    sessions: new SessionsRepository(db),
    blocks: new BlocksRepository(db),
    archives: new ArchivesRepository(db),
    dialogues: new DialoguesRepository(db),
    transaction: <T>(fn: () => T): T => db.transaction(fn)(),
  };
}

export function openRepositories(databasePath: string): Repositories {
  return createRepositories(openDatabase(databasePath));
}

export * from './types.js';
