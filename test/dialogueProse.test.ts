import { describe, expect, it } from 'vitest';
import {
  buildDialoguePageRequest,
  checkDialogueFidelity,
  parseDialoguePage,
  speechWords,
} from '../src/ai/dialogueProse.js';

const RAW = '**Senhor Natas:** Lhe ofereço a cura à aflição de seu pai, apenas ao custo da sua alma por 100 anos.\n\n**Johnny Blaze:** Muito bem, eu aceito, só termine logo com isso.';

describe('parseDialoguePage', () => {
  it('lê um parágrafo por fala, separando o rótulo', () => {
    expect(parseDialoguePage(RAW)).toEqual([
      { speaker: 'Senhor Natas', speech: 'Lhe ofereço a cura à aflição de seu pai, apenas ao custo da sua alma por 100 anos.' },
      { speaker: 'Johnny Blaze', speech: 'Muito bem, eu aceito, só termine logo com isso.' },
    ]);
  });

  it('parágrafo sem rótulo vira só fala; vazios são ignorados', () => {
    expect(parseDialoguePage('— Oi.\n\n\n\n**Ana:**   \n\n**Ana:** Tchau.')).toEqual([
      { speaker: null, speech: '— Oi.' },
      { speaker: 'Ana', speech: 'Tchau.' },
    ]);
  });

  it('separa trechos de fala intercalados por {ações} e ignora turnos compostos apenas por {ação}', () => {
    const withActions =
      '**Fulano:** Ah é mesmo, preciso te dar isso aqui {tira do bolso uma lata de suco e entrega a Sicrano} toma aí.\n\n' +
      '**Sicrano:** {pega a lata, abre e dá um gole} Nossa, tá azedo, não dá para beber isso. {derrama o resto do suco no chão}\n\n' +
      '**Guarda:** {observa a cena em silêncio de braços cruzados}';
    expect(parseDialoguePage(withActions)).toEqual([
      { speaker: 'Fulano', speech: 'Ah é mesmo, preciso te dar isso aqui' },
      { speaker: 'Fulano', speech: 'toma aí.' },
      { speaker: 'Sicrano', speech: 'Nossa, tá azedo, não dá para beber isso.' },
    ]);
  });
});

describe('speechWords', () => {
  it('ignora caixa, acentos e pontuação', () => {
    expect(speechWords('— Ação, SÓ isso!')).toEqual(['acao', 'so', 'isso']);
  });
});

describe('checkDialogueFidelity', () => {
  const PROSE =
    'Foi então que o Senhor Natas, com fumaça saindo de suas narinas, direcionou o olhar ao rapaz.\n\n' +
    '— Lhe ofereço a cura à aflição de seu pai, — ele diz, com malícia nos olhos, — apenas ao custo da sua alma por 100 anos.\n\n' +
    'Johnny olhou em volta, buscando uma saída.\n\n' +
    '— Muito bem, eu aceito, — disse, rendido — só termine logo com isso.';

  it('aceita falas intactas, mesmo partidas por marcações e gestos', () => {
    expect(checkDialogueFidelity(RAW, PROSE)).toEqual({ ok: true, missing: [] });
  });

  it('ignora diferenças de pontuação, caixa e acentos', () => {
    expect(checkDialogueFidelity('**A:** Ola, tudo bem?', '— OLÁ tudo bem')).toMatchObject({ ok: true });
  });

  it('reprova fala omitida', () => {
    const r = checkDialogueFidelity(RAW, PROSE.replace('— Muito bem, eu aceito, — disse, rendido — só termine logo com isso.', ''));
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('aceito');
  });

  it('reprova palavra trocada ou omitida dentro da fala', () => {
    const r = checkDialogueFidelity(RAW, PROSE.replace('à aflição de seu pai', 'à doença de seu pai'));
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(expect.arrayContaining(['aflicao']));
  });

  it('reprova falas fora de ordem', () => {
    const swapped =
      '— Muito bem, eu aceito, só termine logo com isso.\n\n' +
      '— Lhe ofereço a cura à aflição de seu pai, apenas ao custo da sua alma por 100 anos.';
    expect(checkDialogueFidelity(RAW, swapped).ok).toBe(false);
  });

  it('reprova fala picotada demais (acima do limite de interrupções)', () => {
    const shredded = '— Muito bem — ah — eu — ah — aceito — ah — só — ah — termine logo com isso.';
    expect(checkDialogueFidelity('**A:** Muito bem eu aceito só termine logo com isso.', shredded).ok).toBe(false);
  });

  it('prosa sem nenhuma fala reprova', () => {
    expect(checkDialogueFidelity(RAW, 'Os dois se encararam em silêncio.').ok).toBe(false);
  });

  it('exige fidelidade literal das falas mas permite ao Narrador reescrever as {ações} livremente em prosa literária', () => {
    const transcriptWithActions =
      '**Fulano:** Ah é mesmo, preciso te dar isso aqui {tira do bolso uma lata de suco e entrega a Sicrano} toma aí.\n\n' +
      '**Sicrano:** {pega a lata, abre e dá um gole} Nossa, tá azedo, não dá para beber isso. {derrama o resto do suco no chão}';
    const narratedProse =
      'Fulano levou a mão ao casaco como quem recorda um detalhe importante.\n\n' +
      '— Ah é mesmo, preciso te dar isso aqui — disse, sacando um recipiente metálico amassado e estendendo-o ao companheiro. — Toma aí.\n\n' +
      'Sicrano rompeu o lacre e provou um trago rápido, franzindo o rosto imediatamente.\n\n' +
      '— Nossa, tá azedo, não dá para beber isso.\n\n' +
      'Sem cerimônia, virou a lata e deixou o líquido escorrer pelas pedras do chão.';
    expect(checkDialogueFidelity(transcriptWithActions, narratedProse)).toEqual({ ok: true, missing: [] });
  });
});

describe('buildDialoguePageRequest', () => {
  const session = { system_rules: 'REGRAS', world_context: 'Reino de Aldor' };
  const base = {
    session,
    precedingPages: [{ generated_text: 'Prosa anterior.', order_index: 1 }],
    rawTranscript: RAW,
  };

  it('usa as regras como instrução de sistema e traz mundo, corpus e transcrição literal', () => {
    const req = buildDialoguePageRequest(base);
    expect(req.systemInstruction).toBe('REGRAS');
    expect(req.userText).toContain('Reino de Aldor');
    expect(req.userText).toContain('Prosa anterior.');
    expect(req.userText).toContain(RAW);
    expect(req.userText).toContain('palavra por palavra');
    expect(req.userText).not.toContain('ATENÇÃO');
  });

  it('a nova tentativa traz as palavras que sumiram', () => {
    const req = buildDialoguePageRequest({ ...base, previousMissing: ['aceito', 'alma'] });
    expect(req.userText).toContain('ATENÇÃO');
    expect(req.userText).toContain('aceito, alma');
  });
});
