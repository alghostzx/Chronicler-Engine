import { beforeEach, describe, expect, it } from 'vitest';
import { computeHp } from '../src/ai/tokens.js';
import { makeApp, mockGateway, withKey, type TestApp } from './helpers.js';

describe('computeHp', () => {
  it('calcula o percentual restante conforme a fórmula do HP', () => {
    expect(computeHp(0, 1_000_000)).toEqual({ hp_percent: 100, state: 'green' });
    expect(computeHp(250_000, 1_000_000)).toEqual({ hp_percent: 75, state: 'green' });
    expect(computeHp(123_456, 1_000_000)).toEqual({ hp_percent: 87.7, state: 'green' });
  });

  it('respeita os limiares de estado do HP (≥50 verde, ≥20 amarelo, <20 vermelho)', () => {
    expect(computeHp(500_000, 1_000_000).state).toBe('green'); // exatamente 50%
    expect(computeHp(500_001, 1_000_000).state).toBe('yellow');
    expect(computeHp(800_000, 1_000_000).state).toBe('yellow'); // exatamente 20%
    expect(computeHp(800_001, 1_000_000).state).toBe('red');
    expect(computeHp(999_000, 1_000_000).state).toBe('red');
  });

  it('limita entre 0 e 100 e tolera limite inválido', () => {
    expect(computeHp(2_000_000, 1_000_000)).toEqual({ hp_percent: 0, state: 'red' });
    expect(computeHp(-5, 1_000_000).hp_percent).toBe(100);
    expect(computeHp(10, 0)).toEqual({ hp_percent: 0, state: 'red' });
  });
});

describe('GET /api/sessions/:id/token-count', () => {
  let t: TestApp;
  let sessionId: string;

  beforeEach(async () => {
    t = withKey(await makeApp(mockGateway({ countTokens: () => 150_000 })));
    sessionId = t.repos.sessions.create({
      title: 'x',
      system_rules: 'REGRAS',
      world_context: 'MUNDO',
      token_limit: 1_000_000,
      model: 'gemini-2.5-flash',
    }).id;
  });

  const get = (id = sessionId) => t.app.inject({ method: 'GET', url: `/api/sessions/${id}/token-count` });

  it('usa countTokens real sobre o payload e devolve o HP', async () => {
    t.repos.pages.append(sessionId, { player_instruction: 'INSTR-META', generated_text: 'Prosa da página um.' });
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      tokens_used: 150_000,
      token_limit: 1_000_000,
      model: 'gemini-2.5-flash',
      hp_percent: 85,
      state: 'green',
    });

    // O payload medido contém regras, mundo e corpus — e nenhuma meta-instrução passada.
    const measured = t.gateway.countRequests[0]!;
    expect(measured.model).toBe('gemini-2.5-flash');
    expect(measured.systemInstruction).toBe('REGRAS');
    expect(measured.userText).toContain('MUNDO');
    expect(measured.userText).toContain('Prosa da página um.');
    expect(measured.userText).not.toContain('INSTR-META');
  });

  it('não conta páginas arquivadas', async () => {
    t.repos.pages.append(sessionId, { player_instruction: null, generated_text: 'ANTIGO-ARQUIVADO' });
    t.repos.pages.append(sessionId, { player_instruction: null, generated_text: 'RECENTE' });
    t.repos.pages.archiveRange(sessionId, 1, 1);
    await get();
    const measured = t.gateway.countRequests[0]!;
    expect(measured.userText).toContain('RECENTE');
    expect(measured.userText).not.toContain('ANTIGO-ARQUIVADO');
  });

  it('respeita o token_limit da sessão (estado vermelho)', async () => {
    t.repos.sessions.update(sessionId, { token_limit: 160_000 });
    expect((await get()).json()).toMatchObject({ hp_percent: 6.3, state: 'red' });
  });

  it('reaproveita o cache quando o conteúdo não mudou e recalcula quando muda', async () => {
    await get();
    await get();
    expect(t.gateway.countRequests).toHaveLength(1);
    t.repos.pages.append(sessionId, { player_instruction: null, generated_text: 'nova página' });
    await get();
    expect(t.gateway.countRequests).toHaveLength(2);
    // editar o texto também muda o payload
    const last = t.repos.pages.last(sessionId)!;
    t.repos.pages.updateText(last.id, 'página editada');
    await get();
    expect(t.gateway.countRequests).toHaveLength(3);
  });

  it('404 sem sessão, 409 sem chave, 502 se a contagem falhar', async () => {
    expect((await get('nao-existe')).statusCode).toBe(404);

    const bare = await makeApp();
    const sid = bare.repos.sessions.create({ title: 'x', system_rules: 'r', world_context: '' }).id;
    const noKey = await bare.app.inject({ method: 'GET', url: `/api/sessions/${sid}/token-count` });
    expect(noKey.statusCode).toBe(409);
    expect(noKey.json().code).toBe('missing_api_key');

    const failing = withKey(await makeApp(mockGateway({ countTokensFails: true })));
    const fid = failing.repos.sessions.create({ title: 'x', system_rules: 'r', world_context: '' }).id;
    const res = await failing.app.inject({ method: 'GET', url: `/api/sessions/${fid}/token-count` });
    expect(res.statusCode).toBe(502);
  });
});
