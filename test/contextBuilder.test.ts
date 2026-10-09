import { describe, expect, it } from 'vitest';
import { buildCorpus, buildNarratorRequest } from '../src/ai/contextBuilder.js';

const blocks = [
  { order_index: 2, generated_text: 'Segundo.', player_instruction: 'INSTRUCAO-SECRETA-2' },
  { order_index: 1, generated_text: 'Primeiro.\n', player_instruction: 'INSTRUCAO-SECRETA-1' },
];

describe('contextBuilder', () => {
  it('concatena o corpus em ordem cronológica, sem espaços sobrando', () => {
    expect(buildCorpus(blocks)).toBe('Primeiro.\n\nSegundo.');
  });

  it('NUNCA inclui instruções passadas do jogador no payload (checklist §10 nº 1)', () => {
    const req = buildNarratorRequest({
      session: { system_rules: 'REGRAS', world_context: 'MUNDO' },
      precedingBlocks: blocks,
      playerInstruction: 'Abro a porta.',
    });
    const everything = req.systemInstruction + req.userText;
    expect(everything).not.toContain('INSTRUCAO-SECRETA');
  });

  it('segue a ordem do pipeline: regras → mundo → corpus → input atual', () => {
    const req = buildNarratorRequest({
      session: { system_rules: 'REGRAS', world_context: 'MUNDO' },
      precedingBlocks: blocks,
      playerInstruction: 'Abro a porta.',
    });
    expect(req.systemInstruction).toBe('REGRAS');
    const t = req.userText;
    const iWorld = t.indexOf('MUNDO');
    const iCorpus = t.indexOf('Primeiro.');
    const iSecond = t.indexOf('Segundo.');
    const iInput = t.indexOf('Abro a porta.');
    expect(iWorld).toBeGreaterThanOrEqual(0);
    expect(iWorld).toBeLessThan(iCorpus);
    expect(iCorpus).toBeLessThan(iSecond);
    expect(iSecond).toBeLessThan(iInput);
    expect(t.endsWith('Abro a porta.')).toBe(true);
  });

  it('lida com história vazia e contexto vazio', () => {
    const req = buildNarratorRequest({
      session: { system_rules: 'R', world_context: '  ' },
      precedingBlocks: [],
      playerInstruction: 'Começo.',
    });
    expect(req.userText).toContain('a história ainda não começou');
    expect(req.userText).toContain('sem contexto definido');
  });
});
