import { describe, expect, it } from 'vitest';
import { parseRange } from '../src/routes/audio.js';
import { encodeMp3 } from '../src/tts/mp3.js';
import { decodeAudio, durationMs, encodeWav, joinPcm } from '../src/tts/pcm.js';
import { cleanForSpeech, splitForSpeech } from '../src/tts/text.js';
import { fakeWav } from './helpers.js';

describe('cleanForSpeech', () => {
  it('remove marcas de Markdown sem perder o texto nem os parágrafos', () => {
    const raw = '# Capítulo\n\nEle disse *baixinho*: **corra** e _fuja_!\n\n---\n\n- item `um`\n> citação [link](http://x.y)';
    const out = cleanForSpeech(raw);
    expect(out).toBe('Capítulo\n\nEle disse baixinho: corra e fuja!\n\nitem um\ncitação link');
    expect(out).not.toMatch(/[*#_`>\[\]]/);
  });

  it('preserva travessões de diálogo, reticências e sublinhados dentro de palavras', () => {
    expect(cleanForSpeech('— Quem vai lá?… disse snake_case.')).toBe('— Quem vai lá?… disse snake_case.');
  });

  it('devolve vazio para texto só de símbolos', () => {
    expect(cleanForSpeech('***\n\n---\n#')).toBe('');
  });
});

describe('splitForSpeech', () => {
  const para = (n: number, c = 'a') => `${c.repeat(n)}.`;

  it('mantém texto curto em um único trecho, preservando os parágrafos', () => {
    expect(splitForSpeech('Um.\n\nDois.', 100)).toEqual(['Um.\n\nDois.']);
  });

  it('agrupa parágrafos inteiros sem ultrapassar o limite', () => {
    const chunks = splitForSpeech([para(40, 'a'), para(40, 'b'), para(40, 'c')].join('\n\n'), 100);
    expect(chunks).toEqual([`${para(40, 'a')}\n\n${para(40, 'b')}`, para(40, 'c')]);
  });

  it('divide parágrafo gigante por frases e depois por palavras, sem perder texto', () => {
    const sentence = 'Palavra '.repeat(20).trim() + '.';
    const big = Array.from({ length: 8 }, () => sentence).join(' ');
    const chunks = splitForSpeech(big, 200);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 200)).toBe(true);
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(big);

    const noPunct = 'palavra '.repeat(200).trim();
    const hard = splitForSpeech(noPunct, 120);
    expect(hard.every((c) => c.length <= 120)).toBe(true);
    expect(hard.join(' ')).toBe(noPunct);
  });

  it('não gera trechos vazios', () => {
    expect(splitForSpeech('', 100)).toEqual([]);
    expect(splitForSpeech('\n\n  \n\n', 100)).toEqual([]);
  });
});

describe('PCM e MP3', () => {
  it('decodifica WAV (mono e estéreo) e PCM cru com a taxa do MIME', () => {
    const mono = decodeAudio(fakeWav('abc').data, 'audio/wav');
    expect(mono.sampleRate).toBe(24000);
    expect(mono.samples.length).toBe(720);

    const raw = Buffer.alloc(8);
    raw.writeInt16LE(100, 0);
    raw.writeInt16LE(-200, 2);
    const pcm = decodeAudio(raw, 'audio/l16;codec=pcm;rate=16000');
    expect(pcm.sampleRate).toBe(16000);
    expect([...pcm.samples]).toEqual([100, -200, 0, 0]);

    const stereo = encodeWav({ samples: new Int16Array([100, 300, -50, 50]), sampleRate: 24000 });
    stereo.writeUInt16LE(2, 22); // marca como estéreo
    expect([...decodeAudio(stereo).samples]).toEqual([200, 0]);
  });

  it('junta trechos com silêncio entre eles', () => {
    const a = { samples: new Int16Array([1, 2, 3]), sampleRate: 1000 };
    const b = { samples: new Int16Array([4]), sampleRate: 1000 };
    const joined = joinPcm([a, b], 5); // 5 ms @ 1 kHz = 5 amostras
    expect([...joined.samples]).toEqual([1, 2, 3, 0, 0, 0, 0, 0, 4]);
    expect(durationMs(joined)).toBe(9);
    expect(() => joinPcm([a, { ...b, sampleRate: 2000 }])).toThrow();
  });

  it('codifica MP3 válido (quadros com sync), bem menor que o WAV', async () => {
    const wav = fakeWav('x'.repeat(2000)); // 20 s
    const mp3 = await encodeMp3(decodeAudio(wav.data));
    expect(mp3.length).toBeGreaterThan(1000);
    expect(mp3.length).toBeLessThan(wav.data.length / 6);
    // Primeiro quadro: sync de 11 bits (0xFFE), camada III.
    expect(mp3[0]).toBe(0xff);
    expect(mp3[1]! & 0xe0).toBe(0xe0);
    expect((mp3[1]! >> 1) & 0x3).toBe(0x1);
    // ~48 kbps → ~6 KB/s.
    const seconds = 20;
    expect(mp3.length / seconds).toBeGreaterThan(5000);
    expect(mp3.length / seconds).toBeLessThan(7500);
  });
});

describe('parseRange', () => {
  it('interpreta intervalos válidos e rejeita os inválidos', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 });
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=1000-', 1000)).toBeNull();
    expect(parseRange('bytes=5-2', 1000)).toBeNull();
    expect(parseRange('bytes=-0', 1000)).toBeNull();
    expect(parseRange('items=0-1', 1000)).toBeNull();
    expect(parseRange('bytes=-', 1000)).toBeNull();
  });
});
