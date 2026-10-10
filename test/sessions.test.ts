import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SYSTEM_RULES } from '../src/prompts/narrator.js';
import { makeApp, type TestApp } from './helpers.js';

let t: TestApp;

beforeEach(async () => {
  t = await makeApp();
});

const create = async (payload: Record<string, unknown> = { title: 'Crônica de Teste' }) =>
  t.app.inject({ method: 'POST', url: '/api/sessions', payload });

describe('sessões', () => {
  it('cria sessão com padrões (regras canônicas, tema e limite)', async () => {
    const res = await create();
    expect(res.statusCode).toBe(201);
    const { session } = res.json();
    expect(session.system_rules).toBe(DEFAULT_SYSTEM_RULES);
    expect(session.world_context).toBe('');
    expect(session.active_theme).toBe('medieval');
    expect(session.token_limit).toBe(1_000_000);
    expect(session.model).toBeNull();
  });

  it('valida o corpo da requisição', async () => {
    expect((await create({})).statusCode).toBe(400);
    expect((await create({ title: 'x', active_theme: 'inexistente' })).statusCode).toBe(400);
    expect((await create({ title: 'x', token_limit: 5 })).statusCode).toBe(400);
  });

  it('lista sessões e retorna detalhes com páginas ativas', async () => {
    const { session } = (await create()).json();
    t.repos.pages.append(session.id, { player_instruction: 'i', generated_text: 'a' });
    t.repos.pages.append(session.id, { player_instruction: 'i', generated_text: 'b' });
    t.repos.pages.archiveRange(session.id, 1, 1);

    const list = await t.app.inject({ method: 'GET', url: '/api/sessions' });
    expect(list.json().sessions).toHaveLength(1);

    const detail = (await t.app.inject({ method: 'GET', url: `/api/sessions/${session.id}` })).json();
    expect(detail.session.id).toBe(session.id);
    expect(detail.pages.map((b: { generated_text: string }) => b.generated_text)).toEqual(['b']);
    expect(detail.active_dialogue).toBeNull();
  });

  it('inclui o diálogo ativo no detalhe (reconexão pós-reload)', async () => {
    const { session } = (await create()).json();
    const d = t.repos.dialogues.create(session.id, 'Elena', 'prompt');
    const detail = (await t.app.inject({ method: 'GET', url: `/api/sessions/${session.id}` })).json();
    expect(detail.active_dialogue.id).toBe(d.id);
  });

  it('atualiza contexto, regras, tema, modelo e limite parcialmente', async () => {
    const { session } = (await create()).json();
    const res = await t.app.inject({
      method: 'PUT',
      url: `/api/sessions/${session.id}/context`,
      payload: { world_context: 'Reino de Aldor', active_theme: 'cyberpunk', token_limit: 200000, model: 'gemini-2.5-pro' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().session).toMatchObject({
      world_context: 'Reino de Aldor',
      active_theme: 'cyberpunk',
      token_limit: 200000,
      model: 'gemini-2.5-pro',
      system_rules: DEFAULT_SYSTEM_RULES,
    });

    const reset = await t.app.inject({
      method: 'PUT',
      url: `/api/sessions/${session.id}/context`,
      payload: { model: null },
    });
    expect(reset.json().session.model).toBeNull();
  });

  it('rejeita atualização vazia e campos desconhecidos', async () => {
    const { session } = (await create()).json();
    const url = `/api/sessions/${session.id}/context`;
    expect((await t.app.inject({ method: 'PUT', url, payload: {} })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'PUT', url, payload: { id: 'x' } })).statusCode).toBe(400);
  });

  it('retorna 404 para sessão inexistente', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/sessions/nao-existe' })).statusCode).toBe(404);
    expect(
      (await t.app.inject({ method: 'PUT', url: '/api/sessions/nao-existe/context', payload: { title: 'x' } })).statusCode,
    ).toBe(404);
  });

  it('exclui sessão', async () => {
    const { session } = (await create()).json();
    expect((await t.app.inject({ method: 'DELETE', url: `/api/sessions/${session.id}` })).statusCode).toBe(204);
    expect((await t.app.inject({ method: 'GET', url: `/api/sessions/${session.id}` })).statusCode).toBe(404);
  });
});
