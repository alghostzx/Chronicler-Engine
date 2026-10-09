import { describe, expect, it } from 'vitest';
import { NarrativeTextExtractor } from '../src/ai/narrativeStream.js';

/** Alimenta o extrator com `json` fatiado em pedaços de tamanho `size` e devolve os deltas. */
function run(json: string, size: number): string[] {
  const ex = new NarrativeTextExtractor();
  const deltas: string[] = [];
  for (let i = 0; i < json.length; i += size) {
    const d = ex.push(json.slice(i, i + size));
    if (d) deltas.push(d);
  }
  return deltas;
}

const payload = (narrative: string, rest = '"dialogue_trigger":{"activate":false}') =>
  `{"narrative_text":${JSON.stringify(narrative)},${rest}}`;

describe('NarrativeTextExtractor', () => {
  const texts = [
    'Ele entrou na taverna.',
    'Linha 1\nLinha 2\n\n"Olá", disse ela — com \\ barra e \t tab.',
    'Acentuação: ação, coração, órfão. Emoji 🐉 e 𝒳 matemático.',
    'Aspas "internas" e {chaves} [colchetes] e , vírgulas : dois-pontos',
    '',
  ];

  for (const text of texts) {
    it(`reconstrói o texto para qualquer tamanho de fatia: ${JSON.stringify(text).slice(0, 30)}`, () => {
      const json = payload(text);
      for (let size = 1; size <= json.length + 1; size++) {
        expect(run(json, size).join(''), `fatia ${size}`).toBe(text);
      }
    });
  }

  it('decodifica escapes \\u (incluindo pares substitutos divididos)', () => {
    const json = '{"narrative_text":"caf\\u00e9 \\ud83d\\udc09!","dialogue_trigger":{"activate":false}}';
    for (let size = 1; size <= 12; size++) {
      expect(run(json, size).join(''), `fatia ${size}`).toBe('café 🐉!');
    }
  });

  it('emite incrementalmente (mais de um delta quando fatiado)', () => {
    expect(run(payload('um texto bem longo para ser dividido'), 5).length).toBeGreaterThan(3);
  });

  it('ignora narrative_text que apareça dentro de outros campos', () => {
    const json =
      '{"dialogue_trigger":{"activate":true,"npc_name":"Elena","dynamic_system_prompt":"cite \\"narrative_text\\":\\"falso\\""},' +
      '"narrative_text":"verdadeiro"}';
    for (const size of [1, 3, 7, json.length]) {
      expect(run(json, size).join(''), `fatia ${size}`).toBe('verdadeiro');
    }
  });

  it('ignora a chave aninhada em objetos', () => {
    const json = '{"meta":{"narrative_text":"aninhado"},"narrative_text":"raiz"}';
    expect(run(json, 2).join('')).toBe('raiz');
  });

  it('indica o término da string e não emite mais nada depois', () => {
    const ex = new NarrativeTextExtractor();
    expect(ex.push('{"narrative_text":"abc"')).toBe('abc');
    expect(ex.finished).toBe(true);
    expect(ex.push(',"x":"narrative_text"}')).toBe('');
  });

  it('tolera espaços em branco e formatação', () => {
    expect(run('{\n  "narrative_text" :  "oi",\n  "x": 1\n}', 3).join('')).toBe('oi');
  });

  it('o texto reconstruído coincide com JSON.parse do payload completo', () => {
    const text = 'Texto\ncom "tudo" \\ misturado 🐉';
    const json = payload(text);
    expect(run(json, 4).join('')).toBe(JSON.parse(json).narrative_text);
  });
});
