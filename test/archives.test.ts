import { beforeEach, describe, expect, it } from 'vitest';
import { makeApp, mockGateway, narratorJson, withKey, type TestApp } from './helpers.js';

/**
 * Páginas consumidas por volumes: saem do contexto da IA, do HP e da compactação seguinte,
 * mas continuam legíveis e exportáveis pelo jogador.
 */
let t: TestApp;
let sessionId: string;

beforeEach(async () => {
  t = withKey(await makeApp(mockGateway({ countTokens: () => 1000 })));
  sessionId = t.repos.sessions.create({ title: 'Saga', system_rules: 'r', world_context: 'Mundo base.' }).id;
  for (let i = 1; i <= 8; i++) {
    t.repos.pages.append(sessionId, { player_instruction: `prompt secreto ${i}`, generated_text: `Prosa ${i}.` });
  }
});

async function compactFirstSix(): Promise<string> {
  const res = await t.app.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/compact/commit`,
    payload: { summary_text: 'Resumo do volume um.', covered_page_start_index: 1, covered_page_end_index: 6 },
  });
  expect(res.statusCode).toBe(200);
  return res.json().archive.id as string;
}

describe('GET /api/archives/:id/pages', () => {
  it('devolve as páginas consumidas pelo volume, em ordem e com a numeração absoluta', async () => {
    const id = await compactFirstSix();
    const res = await t.app.inject({ method: 'GET', url: `/api/archives/${id}/pages` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.archive).toMatchObject({ volume_number: 1, covered_page_start_index: 1, covered_page_end_index: 6 });
    expect(body.pages.map((p: { order_index: number }) => p.order_index)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(body.pages[0].generated_text).toBe('Prosa 1.');
    expect(body.pages.every((p: { is_archived: boolean }) => p.is_archived)).toBe(true);
  });

  it('o segundo volume só traz as suas próprias páginas', async () => {
    await compactFirstSix();
    for (let i = 9; i <= 12; i++) t.repos.pages.append(sessionId, { player_instruction: null, generated_text: `Prosa ${i}.` });
    t.gateway.queue('Resumo dois.');
    const pv = (await t.app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/compact/preview` })).json();
    const commit = await t.app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/compact/commit`,
      payload: { summary_text: pv.summary_text, covered_page_start_index: pv.covered_page_start_index, covered_page_end_index: pv.covered_page_end_index },
    });
    const v2 = commit.json().archive;
    const res = await t.app.inject({ method: 'GET', url: `/api/archives/${v2.id}/pages` });
    const idx = res.json().pages.map((p: { order_index: number }) => p.order_index);
    expect(idx[0]).toBe(7);
    expect(idx.at(-1)).toBe(v2.covered_page_end_index);
    expect(idx).not.toContain(1);
  });

  it('404 para volume inexistente', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/archives/nao-existe/pages' })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: '/api/archives/nao-existe/export' })).statusCode).toBe(404);
  });
});

describe('GET /api/archives/:id/export', () => {
  it('exporta o volume com sinopse, páginas separadas por --- e sem os prompts do jogador', async () => {
    const id = await compactFirstSix();
    const res = await t.app.inject({ method: 'GET', url: `/api/archives/${id}/export` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.headers['content-disposition']).toContain('saga-volume-1.md');
    expect(res.body).toContain('# Saga — Volume 1');
    expect(res.body).toContain('páginas 1 a 6 (6 páginas)');
    expect(res.body).toContain('## Sinopse\n\nResumo do volume um.');
    expect(res.body).toContain('Prosa 1.\n\n---\n\nProsa 2.');
    expect(res.body).toContain('Prosa 6.');
    expect(res.body).not.toContain('Prosa 7.');
    expect(res.body).not.toContain('prompt secreto');
  });

  it('permite omitir a sinopse', async () => {
    const id = await compactFirstSix();
    const res = await t.app.inject({ method: 'GET', url: `/api/archives/${id}/export?include_summary=false` });
    expect(res.body).not.toContain('Sinopse');
    expect(res.body).toContain('Prosa 3.');
  });
});

describe('páginas arquivadas × contexto da IA', () => {
  it('ficam fora do contexto, do HP e da próxima compactação, mas dentro da leitura e da exportação', async () => {
    const id = await compactFirstSix();

    // Fora do contexto da IA / HP: o payload medido traz a sinopse e só as páginas ativas.
    expect((await t.app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/token-count` })).statusCode).toBe(200);
    const measured = t.gateway.countRequests.at(-1)!;
    expect(measured.userText).toContain('Resumo do volume um.');
    expect(measured.userText).toContain('Prosa 7.');
    expect(measured.userText).not.toContain('Prosa 3.');

    // Fora do Tome (páginas ativas do detalhe da sessão).
    const detail = (await t.app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` })).json();
    expect(detail.pages.map((p: { order_index: number }) => p.order_index)).toEqual([7, 8]);

    // Fora do próximo narrador: nenhuma página arquivada na requisição.
    t.gateway.queue(narratorJson('Nova cena.'));
    await t.app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/narrative/next`, payload: { player_instruction: 'Sigo adiante' } });
    const sent = JSON.stringify(t.gateway.requests.at(-1));
    expect(sent).toContain('Resumo do volume um.');
    expect(sent).not.toContain('Prosa 2.');

    // Dentro da leitura e da exportação.
    const read = (await t.app.inject({ method: 'GET', url: `/api/archives/${id}/pages` })).json();
    expect(read.pages).toHaveLength(6);
    const exported = await t.app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/export` });
    for (let i = 1; i <= 8; i++) expect(exported.body).toContain(`Prosa ${i}.`);
    expect(exported.body).toContain('Nova cena.');
  });
});
