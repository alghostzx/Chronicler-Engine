import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/connection.js';
import { SCHEMA_VERSION } from '../src/db/schema.js';
import { MIGRATIONS, MIN_MIGRATABLE_VERSION } from '../src/db/migrations.js';
import { SCHEMA_V3_SQL } from './fixtures/schemaV3.js';

/** Cria um banco em arquivo no schema v3 (como o de um usuário que ainda não atualizou) com dados. */
function bancoV3(seed = true): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicler-mig-'));
  const file = path.join(dir, 'chronicler.db');
  const raw = new Database(file);
  raw.pragma('foreign_keys = ON');
  raw.pragma('auto_vacuum = INCREMENTAL');
  raw.exec(SCHEMA_V3_SQL);
  raw.pragma('user_version = 3');
  if (seed) {
    raw.exec(`
      INSERT INTO app_settings (key, value) VALUES ('gemini_api_key', 'segredo'), ('tts_voice', 'Gacrux');
      INSERT INTO sessions (id, title, system_rules, world_context, tts_auto) VALUES ('s1', 'Crônica', 'regras', 'mundo', 1);
      INSERT INTO narrative_pages (id, session_id, order_index, player_instruction, generated_text) VALUES
        ('p1', 's1', 1, 'abre', 'Prosa um.'), ('p2', 's1', 2, '[Diálogo com Elena]', 'Costura em prosa.');
      INSERT INTO page_audio (page_id, text_sha256, voice, model, style, duration_ms, bytes, audio) VALUES ('p1', 'h', 'Gacrux', 'm', 's', 1000, 3, x'010203');
      INSERT INTO dialogue_sessions (id, session_id, npc_name, dynamic_system_prompt, status) VALUES
        ('d-old', 's1', 'Elena', 'persona', 'concluded'), ('d-live', 's1', 'Guarda', 'persona 2', 'active');
      INSERT INTO dialogue_messages (id, dialogue_session_id, sender, content) VALUES
        ('m1', 'd-old', 'player', 'oi'), ('m2', 'd-live', 'player', 'olá');
    `);
  }
  raw.close();
  return file;
}

const columns = (db: Database.Database, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }[])
    .map((c) => `${c.name}|${c.type}|${c.notnull}|${c.dflt_value}|${c.pk}`)
    .sort();
const schemaObjects = (db: Database.Database) =>
  (db.prepare(`SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all() as { type: string; name: string }[]).map((o) => `${o.type}:${o.name}`);

describe('migrações do banco', () => {
  it('as versões são sequenciais e terminam em SCHEMA_VERSION', () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions).toEqual(Array.from({ length: SCHEMA_VERSION - MIN_MIGRATABLE_VERSION }, (_, i) => MIN_MIGRATABLE_VERSION + 1 + i));
  });

  it('migrar o v3 produz o mesmo schema de um banco novo (tabelas, colunas e índices)', () => {
    const migrated = openDatabase(bancoV3(false));
    const fresh = openDatabase(':memory:');
    expect(migrated.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(schemaObjects(migrated)).toEqual(schemaObjects(fresh));
    for (const table of ['sessions', 'narrative_pages', 'dialogue_sessions', 'dialogue_messages', 'page_audio', 'chronicle_archives', 'app_settings']) {
      expect(columns(migrated, table), table).toEqual(columns(fresh, table));
    }
    // as chaves estrangeiras com cascata das colunas novas também valem no banco migrado
    const fks = (db: Database.Database) => (db.prepare('PRAGMA foreign_key_list(dialogue_sessions)').all() as { from: string; table: string; on_delete: string }[]).map((f) => `${f.from}->${f.table}:${f.on_delete}`).sort();
    expect(fks(migrated)).toEqual(fks(fresh));
    expect(migrated.pragma('foreign_key_check')).toEqual([]);
  });

  it('preserva os dados (chave, crônicas, páginas, áudio) e acerta os diálogos', () => {
    const file = bancoV3();
    const db = openDatabase(file);
    expect(db.prepare(`SELECT value FROM app_settings WHERE key = 'gemini_api_key'`).get()).toEqual({ value: 'segredo' });
    expect(db.prepare('SELECT title, tts_auto, tts_auto_dialogue FROM sessions').get()).toEqual({ title: 'Crônica', tts_auto: 1, tts_auto_dialogue: null });
    expect(db.prepare('SELECT id, kind, npc_name, generated_text FROM narrative_pages ORDER BY order_index').all()).toEqual([
      { id: 'p1', kind: 'narrative', npc_name: null, generated_text: 'Prosa um.' },
      { id: 'p2', kind: 'narrative', npc_name: null, generated_text: 'Costura em prosa.' },
    ]);
    expect(db.prepare('SELECT bytes, length(audio) AS n FROM page_audio').get()).toEqual({ bytes: 3, n: 3 });
    // a conversa concluída (já virou prosa antes) é descartada; a ativa continua, sem página ligada
    expect(db.prepare('SELECT id, status, player_name, page_id, redo_page_id FROM dialogue_sessions').all()).toEqual([
      { id: 'd-live', status: 'active', player_name: null, page_id: null, redo_page_id: null },
    ]);
    expect(db.prepare('SELECT id FROM dialogue_messages').all()).toEqual([{ id: 'm2' }]);
  });

  it('copia o banco antes de migrar (arquivo .v3.bak, íntegro e ainda na versão 3)', () => {
    const file = bancoV3();
    openDatabase(file).close();
    const backup = `${file}.v3.bak`;
    expect(fs.existsSync(backup)).toBe(true);
    const old = new Database(backup, { readonly: true });
    expect(old.pragma('user_version', { simple: true })).toBe(3);
    expect(old.prepare('SELECT COUNT(*) AS n FROM dialogue_sessions').get()).toEqual({ n: 2 });
    old.close();
  });

  it('abrir de novo um banco já migrado não faz nada (sem novo backup)', () => {
    const file = bancoV3();
    openDatabase(file).close();
    fs.rmSync(`${file}.v3.bak`);
    const db = openDatabase(file);
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(fs.existsSync(`${file}.v3.bak`)).toBe(false);
  });

  it('banco novo nasce na versão atual e sem backup', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicler-mig-'));
    const file = path.join(dir, 'novo.db');
    const db = openDatabase(file);
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.bak'))).toEqual([]);
  });

  it('falha na migração desfaz tudo (versão e schema intactos) e explica o erro', () => {
    const file = bancoV3();
    const raw = new Database(file);
    raw.exec('ALTER TABLE dialogue_sessions ADD COLUMN redo_page_id TEXT'); // conflito: a migração tentará criá-la
    raw.close();
    expect(() => openDatabase(file)).toThrow(/Falha ao migrar o banco para a versão 4/);
    const check = new Database(file);
    expect(check.pragma('user_version', { simple: true })).toBe(3);
    const cols = (check.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain('tts_auto_dialogue'); // o ALTER anterior foi revertido junto
    check.close();
  });

  it('recusa versões anteriores à primeira migrável, com instrução clara', () => {
    for (const v of [1, 2]) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicler-mig-'));
      const file = path.join(dir, 'velho.db');
      const raw = new Database(file);
      raw.pragma(`user_version = ${v}`);
      raw.close();
      expect(() => openDatabase(file)).toThrow(new RegExp(`versão ${MIN_MIGRATABLE_VERSION}.*Apague`));
    }
  });
});
