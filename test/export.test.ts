import { beforeEach, describe, expect, it } from 'vitest';
import { buildStoryMarkdown, contentDisposition, slugify } from '../src/export.js';
import { makeApp, type TestApp } from './helpers.js';

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});

describe('exportação em Markdown (módulo puro)', () => {
  const base = { exportedAt: new Date('2026-10-09T12:00:00Z') };

  it('gera título, metadados e a prosa dos blocos', () => {
    const md = buildStoryMarkdown({
      ...base,
      session: { title: 'A Queda de Valdoria', world_context: 'Um reino antigo.' },
      blocks: [{ generated_text: 'Primeiro.\n\nSegundo.' }, { generated_text: '  Terceiro.  ' }],
      includeContext: false,
    });
    expect(md).toBe(
      '# A Queda de Valdoria\n\n*Exportado do Chronicler Engine em 2026-10-09 · 2 blocos*\n\nPrimeiro.\n\nSegundo.\n\nTerceiro.\n',
    );
  });

  it('inclui o contexto do mundo quando pedido', () => {
    const md = buildStoryMarkdown({
      ...base,
      session: { title: 'T', world_context: 'Mundo.\n\n## Crônica — Volume 1\n\nSinopse.' },
      blocks: [{ generated_text: 'Texto.' }],
      includeContext: true,
    });
    expect(md).toContain('## Mundo e personagens\n\nMundo.');
    expect(md).toContain('## Crônica — Volume 1');
    expect(md.indexOf('## Narrativa')).toBeGreaterThan(md.indexOf('Sinopse.'));
  });

  it('normaliza título com quebras de linha e usa o singular para 1 bloco', () => {
    const md = buildStoryMarkdown({
      ...base,
      session: { title: 'Linha 1\nLinha 2', world_context: '' },
      blocks: [{ generated_text: 'x' }],
      includeContext: true,
    });
    expect(md.startsWith('# Linha 1 Linha 2\n')).toBe(true);
    expect(md).toContain('1 bloco*');
    expect(md).not.toContain('## Mundo');
  });

  it('gera nomes de arquivo seguros', () => {
    expect(slugify('A Queda de Valdoria!')).toBe('a-queda-de-valdoria');
    expect(slugify('Ação & Reação: ñandú')).toBe('acao-reacao-nandu');
    expect(slugify('???')).toBe('cronica');
    const header = contentDisposition('Crônica: "Sol/Lua"');
    expect(header).toContain('filename="cronica-sol-lua.md"');
    expect(header).toContain("filename*=UTF-8''Cr%C3%B4nica-%20-Sol-Lua-.md");
  });
});

describe('GET /api/sessions/:id/export', () => {
  function seed() {
    const s = t.repos.sessions.create({ title: 'Minha Crônica', system_rules: 'r', world_context: 'Mundo X' });
    for (const text of ['Bloco um.', 'Bloco dois.', 'Bloco três.']) {
      t.repos.blocks.append(s.id, { player_instruction: 'segredo do jogador', generated_text: text });
    }
    return s;
  }

  it('baixa o Markdown como anexo, sem prompts do jogador nem contexto por padrão', async () => {
    const s = seed();
    const res = await t.app.inject({ method: 'GET', url: `/api/sessions/${s.id}/export` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.headers['content-disposition']).toContain('attachment; filename="minha-cronica.md"');
    expect(res.body).toContain('# Minha Crônica');
    expect(res.body).toContain('Bloco um.\n\nBloco dois.\n\nBloco três.');
    expect(res.body).not.toContain('segredo do jogador');
    expect(res.body).not.toContain('Mundo X');
  });

  it('inclui blocos arquivados na compactação e o contexto sob demanda', async () => {
    const s = seed();
    t.repos.blocks.archiveRange(s.id, 1, 2);
    const res = await t.app.inject({ method: 'GET', url: `/api/sessions/${s.id}/export?include_context=true` });
    expect(res.body).toContain('Bloco um.');
    expect(res.body).toContain('Bloco dois.');
    expect(res.body).toContain('## Mundo e personagens\n\nMundo X');
  });

  it('retorna 404 para sessão inexistente', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/sessions/nao-existe/export' });
    expect(res.statusCode).toBe(404);
  });
});
