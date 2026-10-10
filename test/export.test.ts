import { beforeEach, describe, expect, it } from 'vitest';
import { buildStoryMarkdown, buildVolumeMarkdown, contentDisposition, slugify } from '../src/export.js';
import { makeApp, type TestApp } from './helpers.js';

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});

describe('exportação em Markdown (módulo puro)', () => {
  const base = { exportedAt: new Date('2026-10-09T12:00:00Z') };

  it('gera título, metadados e a prosa das páginas', () => {
    const md = buildStoryMarkdown({
      ...base,
      session: { title: 'A Queda de Valdoria', world_context: 'Um reino antigo.' },
      pages: [{ generated_text: 'Primeiro.\n\nSegundo.' }, { generated_text: '  Terceiro.  ' }],
      includeContext: false,
    });
    expect(md).toBe(
      '# A Queda de Valdoria\n\n*Exportado do Chronicler Engine em 2026-10-09 · 2 páginas*\n\nPrimeiro.\n\nSegundo.\n\n---\n\nTerceiro.\n',
    );
  });

  it('inclui o contexto do mundo quando pedido', () => {
    const md = buildStoryMarkdown({
      ...base,
      session: { title: 'T', world_context: 'Mundo.\n\n## Crônica — Volume 1\n\nSinopse.' },
      pages: [{ generated_text: 'Texto.' }],
      includeContext: true,
    });
    expect(md).toContain('## Mundo e personagens\n\nMundo.');
    expect(md).toContain('## Crônica — Volume 1');
    expect(md.indexOf('## Narrativa')).toBeGreaterThan(md.indexOf('Sinopse.'));
  });

  it('normaliza título com quebras de linha e usa o singular para 1 página', () => {
    const md = buildStoryMarkdown({
      ...base,
      session: { title: 'Linha 1\nLinha 2', world_context: '' },
      pages: [{ generated_text: 'x' }],
      includeContext: true,
    });
    expect(md.startsWith('# Linha 1 Linha 2\n')).toBe(true);
    expect(md).toContain('1 página*');
    expect(md).not.toContain('## Mundo');
  });

  it('exporta um volume: sinopse opcional, faixa de páginas e separadores', () => {
    const input = {
      exportedAt: new Date('2026-10-09T12:00:00Z'),
      session: { title: 'Crônica X' },
      archive: { volume_number: 2, summary_text: 'Resumo do volume.', covered_page_start_index: 5, covered_page_end_index: 6 },
      pages: [{ generated_text: 'Cinco.' }, { generated_text: 'Seis.' }],
    };
    const md = buildVolumeMarkdown({ ...input, includeSummary: true });
    expect(md).toBe(
      '# Crônica X — Volume 2\n\n*Exportado do Chronicler Engine em 2026-10-09 · páginas 5 a 6 (2 páginas)*\n\n## Sinopse\n\nResumo do volume.\n\n## Narrativa\n\nCinco.\n\n---\n\nSeis.\n',
    );
    const bare = buildVolumeMarkdown({ ...input, includeSummary: false });
    expect(bare).not.toContain('Sinopse');
    expect(bare).toContain('Cinco.\n\n---\n\nSeis.');
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
    for (const text of ['Página um.', 'Página dois.', 'Página três.']) {
      t.repos.pages.append(s.id, { player_instruction: 'segredo do jogador', generated_text: text });
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
    expect(res.body).toContain('Página um.\n\n---\n\nPágina dois.\n\n---\n\nPágina três.');
    expect(res.body).toContain('3 páginas*');
    expect(res.body).not.toContain('segredo do jogador');
    expect(res.body).not.toContain('Mundo X');
  });

  it('inclui páginas arquivadas na compactação e o contexto sob demanda', async () => {
    const s = seed();
    t.repos.pages.archiveRange(s.id, 1, 2);
    const res = await t.app.inject({ method: 'GET', url: `/api/sessions/${s.id}/export?include_context=true` });
    expect(res.body).toContain('Página um.');
    expect(res.body).toContain('Página dois.');
    expect(res.body).toContain('## Mundo e personagens\n\nMundo X');
  });

  it('filtra por escopo: all (padrão), active (só o Tome) e archived (só os volumes)', async () => {
    const s = seed();
    t.repos.pages.archiveRange(s.id, 1, 2);
    const get = (q: string) => t.app.inject({ method: 'GET', url: `/api/sessions/${s.id}/export${q}` });

    const all = await get('?scope=all');
    expect(all.body).toContain('Página um.');
    expect(all.body).toContain('Página três.');
    expect(all.body).toContain('3 páginas*');

    const active = await get('?scope=active');
    expect(active.body).not.toContain('Página um.');
    expect(active.body).not.toContain('Página dois.');
    expect(active.body).toContain('Página três.');
    expect(active.body).toContain('1 página*');
    expect(active.body).not.toContain('---');
    expect(active.headers['content-disposition']).toContain('minha-cronica-no-tome.md');

    const archived = await get('?scope=archived');
    expect(archived.body).toContain('Página um.\n\n---\n\nPágina dois.');
    expect(archived.body).not.toContain('Página três.');
    expect(archived.body).toContain('2 páginas*');
    expect(archived.headers['content-disposition']).toContain('minha-cronica-volumes.md');
    expect(archived.body).not.toContain('segredo do jogador');

    expect((await get('?scope=outro')).statusCode).toBe(400);
  });

  it('scope=archived sem nenhum volume responde 409 em vez de um arquivo vazio', async () => {
    const s = seed();
    const res = await t.app.inject({ method: 'GET', url: `/api/sessions/${s.id}/export?scope=archived` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('Nenhuma página');
  });

  it('retorna 404 para sessão inexistente', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/sessions/nao-existe/export' });
    expect(res.statusCode).toBe(404);
  });
});
