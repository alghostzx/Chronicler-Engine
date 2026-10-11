import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { createRepositories, type Repositories } from '../src/db/index.js';
import { openDatabase } from '../src/db/connection.js';
import { DialogueActiveError } from '../src/db/repositories/dialogues.js';

let repos: Repositories;
let sessionId: string;

beforeEach(() => {
  repos = createRepositories(openDatabase(':memory:'));
  sessionId = repos.sessions.create({ title: 'Teste', system_rules: 'regras', world_context: 'mundo' }).id;
});

describe('versão do schema', () => {
  function bancoComVersao(version: number): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicler-db-'));
    const file = path.join(dir, 'chronicler.db');
    const raw = new Database(file);
    raw.pragma(`user_version = ${version}`);
    raw.close();
    return file;
  }

  it('recusa banco de versão anterior à primeira migrável com instrução clara', () => {
    expect(() => openDatabase(bancoComVersao(1))).toThrow(/Apague/);
  });

  it('recusa banco de versão mais nova que a suportada', () => {
    expect(() => openDatabase(bancoComVersao(999))).toThrow(/mais nova/);
  });
});

describe('settings', () => {
  it('grava, atualiza e remove valores', () => {
    expect(repos.settings.get('k')).toBeUndefined();
    repos.settings.set('k', 'a');
    repos.settings.set('k', 'b');
    expect(repos.settings.get('k')).toBe('b');
    repos.settings.delete('k');
    expect(repos.settings.get('k')).toBeUndefined();
  });
});

describe('sessions', () => {
  it('aplica padrões e permite atualização parcial', () => {
    const s = repos.sessions.get(sessionId)!;
    expect(s.active_theme).toBe('medieval');
    expect(s.token_limit).toBe(1_000_000);
    expect(s.model).toBeNull();

    const updated = repos.sessions.update(sessionId, { world_context: 'novo', token_limit: 500, model: 'm' })!;
    expect(updated.world_context).toBe('novo');
    expect(updated.system_rules).toBe('regras');
    expect(updated.token_limit).toBe(500);
    expect(updated.model).toBe('m');
  });

  it('lista sessões', () => {
    repos.sessions.create({ title: 'Outra', system_rules: 'r', world_context: 'w' });
    expect(repos.sessions.list()).toHaveLength(2);
  });
});

describe('pages', () => {
  it('atribui order_index incremental e lista só ativos em ordem', () => {
    const a = repos.pages.append(sessionId, { player_instruction: 'i1', generated_text: 't1' });
    const b = repos.pages.append(sessionId, { player_instruction: 'i2', generated_text: 't2' });
    expect([a.order_index, b.order_index]).toEqual([1, 2]);
    expect(repos.pages.listActive(sessionId).map((x) => x.generated_text)).toEqual(['t1', 't2']);
    expect(repos.pages.last(sessionId)!.id).toBe(b.id);
  });

  it('edição de texto preserva páginas posteriores', () => {
    const a = repos.pages.append(sessionId, { player_instruction: 'i1', generated_text: 't1' });
    repos.pages.append(sessionId, { player_instruction: 'i2', generated_text: 't2' });
    repos.pages.updateText(a.id, 'editado');
    expect(repos.pages.listActive(sessionId).map((x) => x.generated_text)).toEqual(['editado', 't2']);
  });

  it('deleteAfter remove apenas páginas posteriores', () => {
    const [a] = [1, 2, 3].map((n) =>
      repos.pages.append(sessionId, { player_instruction: `i${n}`, generated_text: `t${n}` }),
    );
    expect(repos.pages.deleteAfter(sessionId, a!.order_index)).toBe(2);
    expect(repos.pages.listAll(sessionId)).toHaveLength(1);
  });

  it('arquivamento exclui do corpus e não reutiliza order_index', () => {
    for (const n of [1, 2, 3, 4]) {
      repos.pages.append(sessionId, { player_instruction: null, generated_text: `t${n}` });
    }
    expect(repos.pages.archiveRange(sessionId, 1, 3)).toBe(3);
    expect(repos.pages.listActive(sessionId).map((x) => x.order_index)).toEqual([4]);
    expect(repos.pages.append(sessionId, { player_instruction: null, generated_text: 't5' }).order_index).toBe(5);
    expect(repos.pages.listAll(sessionId)).toHaveLength(5);
  });

  it('ON DELETE CASCADE remove páginas ao apagar a sessão', () => {
    repos.pages.append(sessionId, { player_instruction: null, generated_text: 't' });
    repos.sessions.delete(sessionId);
    expect(repos.pages.listAll(sessionId)).toHaveLength(0);
  });

  it('transaction faz rollback em caso de erro', () => {
    repos.pages.append(sessionId, { player_instruction: null, generated_text: 't1' });
    expect(() =>
      repos.transaction(() => {
        repos.pages.deleteAfter(sessionId, 0);
        throw new Error('falha');
      }),
    ).toThrow('falha');
    expect(repos.pages.listAll(sessionId)).toHaveLength(1);
  });
});

describe('archives', () => {
  it('numera volumes de forma incremental', () => {
    const v1 = repos.archives.create(sessionId, {
      summary_text: 's1',
      covered_page_start_index: 1,
      covered_page_end_index: 3,
    });
    const v2 = repos.archives.create(sessionId, {
      summary_text: 's2',
      covered_page_start_index: 4,
      covered_page_end_index: 6,
    });
    expect([v1.volume_number, v2.volume_number]).toEqual([1, 2]);
    expect(repos.archives.list(sessionId).map((a) => a.summary_text)).toEqual(['s1', 's2']);
  });
});

describe('dialogues', () => {
  it('permite apenas um diálogo ativo por sessão', () => {
    const d = repos.dialogues.create(sessionId, 'Elena', 'prompt');
    expect(repos.dialogues.getActive(sessionId)!.id).toBe(d.id);
    expect(() => repos.dialogues.create(sessionId, 'Outro', 'p')).toThrow(DialogueActiveError);

    const page = repos.pages.append(sessionId, { player_instruction: null, generated_text: 'Falas.', kind: 'dialogue', npc_name: 'Elena' });
    repos.dialogues.addMessage(d.id, 'player', 'oi');
    repos.dialogues.conclude(d.id, page.id);
    expect(repos.dialogues.getActive(sessionId)).toBeUndefined();
    expect(repos.dialogues.get(d.id)).toMatchObject({ status: 'concluded', page_id: page.id });
    expect(repos.dialogues.listMessages(d.id)).toEqual([]); // a página é a fonte da verdade
    expect(repos.dialogues.getByPage(page.id)!.id).toBe(d.id);
    expect(repos.dialogues.create(sessionId, 'Outro', 'p').status).toBe('active');
  });

  it('mantém mensagens na ordem de inserção', () => {
    const d = repos.dialogues.create(sessionId, 'Elena', 'prompt');
    repos.dialogues.addMessage(d.id, 'player', 'oi');
    repos.dialogues.addMessage(d.id, 'npc', 'olá');
    repos.dialogues.addMessage(d.id, 'player', 'tchau');
    expect(repos.dialogues.listMessages(d.id).map((m) => m.content)).toEqual(['oi', 'olá', 'tchau']);
  });
});
