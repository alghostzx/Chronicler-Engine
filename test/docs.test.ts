import { describe, expect, it } from 'vitest';
import { anchorsOf, checkDocs, slugify } from '../scripts/check-docs.js';

describe('documentação', () => {
  it('não tem links mortos, âncoras inexistentes, rotas desatualizadas nem resquícios do antigo design document', () => {
    expect(checkDocs()).toEqual([]);
  });

  it('gera âncoras como o GitHub', () => {
    expect(slugify('Reprodução contínua')).toBe('reprodução-contínua');
    expect(slugify('Empacotamento (Docker)')).toBe('empacotamento-docker');
    expect(slugify('`narrative_pages`')).toBe('narrative_pages');
    expect(slugify('Celular: app shell, tela cheia e PWA')).toBe('celular-app-shell-tela-cheia-e-pwa');
  });

  it('ignora títulos dentro de blocos de código e numera repetições', () => {
    const md = ['# A', '```', '# Falso', '```', '## B', '## B'].join('\n');
    expect([...anchorsOf(md)]).toEqual(['a', 'b', 'b-1']);
  });
});
