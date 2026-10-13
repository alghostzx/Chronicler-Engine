import { randomUUID } from 'node:crypto';
import type { Db } from '../connection.js';
import type { Session } from '../types.js';

export interface CreateSessionInput {
  title: string;
  system_rules: string;
  world_context: string;
  active_theme?: string;
  token_limit?: number;
  model?: string | null;
  tts_auto?: boolean | null;
}

export type UpdateSessionInput = Partial<
  Pick<Session, 'title' | 'system_rules' | 'world_context' | 'active_theme' | 'token_limit' | 'model' | 'tts_auto'>
>;

const UPDATABLE: (keyof UpdateSessionInput)[] = [
  'title',
  'system_rules',
  'world_context',
  'active_theme',
  'token_limit',
  'model',
  'tts_auto',
];

type SessionRow = Omit<Session, 'tts_auto'> & { tts_auto: number | null };

const toFlag = (value: number | null | undefined): boolean | null => (value === null || value === undefined ? null : value !== 0);

const toSession = (row: SessionRow): Session => ({
  ...row,
  tts_auto: toFlag(row.tts_auto),
});

const toColumn = (value: unknown): string | number | null => {
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value as string | number | null;
};

export class SessionsRepository {
  constructor(private readonly db: Db) {}

  create(input: CreateSessionInput): Session {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO sessions (id, title, system_rules, world_context, active_theme, token_limit, model, tts_auto)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.title,
        input.system_rules,
        input.world_context,
        input.active_theme ?? 'medieval',
        input.token_limit ?? 1_000_000,
        input.model ?? null,
        toColumn(input.tts_auto ?? null),
      );
    return this.get(id)!;
  }

  get(id: string): Session | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
    return row && toSession(row);
  }

  list(): Session[] {
    return (
      this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC, created_at DESC').all() as SessionRow[]
    ).map(toSession);
  }

  update(id: string, patch: UpdateSessionInput): Session | undefined {
    const keys = UPDATABLE.filter((k) => patch[k] !== undefined);
    if (keys.length > 0) {
      const sets = keys.map((k) => `${k} = ?`).join(', ');
      this.db
        .prepare(`UPDATE sessions SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(...keys.map((k) => toColumn(patch[k])), id);
    }
    return this.get(id);
  }

  touch(id: string): void {
    this.db.prepare('UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id).changes > 0;
  }
}
