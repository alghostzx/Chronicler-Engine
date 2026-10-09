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

describe('blocks', () => {
  it('atribui order_index incremental e lista só ativos em ordem', () => {
    const a = repos.blocks.append(sessionId, { player_instruction: 'i1', generated_text: 't1' });
    const b = repos.blocks.append(sessionId, { player_instruction: 'i2', generated_text: 't2' });
    expect([a.order_index, b.order_index]).toEqual([1, 2]);
    expect(repos.blocks.listActive(sessionId).map((x) => x.generated_text)).toEqual(['t1', 't2']);
    expect(repos.blocks.last(sessionId)!.id).toBe(b.id);
  });

  it('edição de texto preserva blocos posteriores', () => {
    const a = repos.blocks.append(sessionId, { player_instruction: 'i1', generated_text: 't1' });
    repos.blocks.append(sessionId, { player_instruction: 'i2', generated_text: 't2' });
    repos.blocks.updateText(a.id, 'editado');
    expect(repos.blocks.listActive(sessionId).map((x) => x.generated_text)).toEqual(['editado', 't2']);
  });

  it('deleteAfter remove apenas blocos posteriores', () => {
    const [a] = [1, 2, 3].map((n) =>
      repos.blocks.append(sessionId, { player_instruction: `i${n}`, generated_text: `t${n}` }),
    );
    expect(repos.blocks.deleteAfter(sessionId, a!.order_index)).toBe(2);
    expect(repos.blocks.listAll(sessionId)).toHaveLength(1);
  });

  it('arquivamento exclui do corpus e não reutiliza order_index', () => {
    for (const n of [1, 2, 3, 4]) {
      repos.blocks.append(sessionId, { player_instruction: null, generated_text: `t${n}` });
    }
    expect(repos.blocks.archiveRange(sessionId, 1, 3)).toBe(3);
    expect(repos.blocks.listActive(sessionId).map((x) => x.order_index)).toEqual([4]);
    expect(repos.blocks.append(sessionId, { player_instruction: null, generated_text: 't5' }).order_index).toBe(5);
    expect(repos.blocks.listAll(sessionId)).toHaveLength(5);
  });

  it('ON DELETE CASCADE remove blocos ao apagar a sessão', () => {
    repos.blocks.append(sessionId, { player_instruction: null, generated_text: 't' });
    repos.sessions.delete(sessionId);
    expect(repos.blocks.listAll(sessionId)).toHaveLength(0);
  });

  it('transaction faz rollback em caso de erro', () => {
    repos.blocks.append(sessionId, { player_instruction: null, generated_text: 't1' });
    expect(() =>
      repos.transaction(() => {
        repos.blocks.deleteAfter(sessionId, 0);
        throw new Error('falha');
      }),
    ).toThrow('falha');
    expect(repos.blocks.listAll(sessionId)).toHaveLength(1);
  });
});

describe('archives', () => {
  it('numera volumes de forma incremental', () => {
    const v1 = repos.archives.create(sessionId, {
      summary_text: 's1',
      covered_block_start_index: 1,
      covered_block_end_index: 3,
    });
    const v2 = repos.archives.create(sessionId, {
      summary_text: 's2',
      covered_block_start_index: 4,
      covered_block_end_index: 6,
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

    repos.dialogues.conclude(d.id);
    expect(repos.dialogues.getActive(sessionId)).toBeUndefined();
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
