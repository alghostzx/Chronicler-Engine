import { describe, expect, it } from 'vitest';
import { SseParser } from '../client/sse';

describe('SseParser (cliente)', () => {
  it('interpreta eventos completos', () => {
    const p = new SseParser();
    const out = p.feed('event: chunk\ndata: {"text":"Olá"}\n\nevent: done\ndata: {}\n\n');
    expect(out).toEqual([
      { event: 'chunk', data: { text: 'Olá' } },
      { event: 'done', data: {} },
    ]);
  });

  it('junta eventos cortados em vários pedaços (inclusive no meio de uma linha)', () => {
    const p = new SseParser();
    expect(p.feed('event: chu')).toEqual([]);
    expect(p.feed('nk\ndata: {"text":"a')).toEqual([]);
    expect(p.feed('b"}\n')).toEqual([]);
    expect(p.feed('\n')).toEqual([{ event: 'chunk', data: { text: 'ab' } }]);
  });

  it('ignora comentários e aceita CRLF', () => {
    const p = new SseParser();
    const out = p.feed(': stream aberto\r\n\r\nevent: start\r\ndata: {"model":"m"}\r\n\r\n');
    expect(out).toEqual([{ event: 'start', data: { model: 'm' } }]);
  });

  it('CRLF dividido entre pedaços não gera linha em branco falsa', () => {
    const p = new SseParser();
    expect(p.feed('event: a\r')).toEqual([]);
    expect(p.feed('\ndata: 1\r\n\r\n')).toEqual([{ event: 'a', data: 1 }]);
  });

  it('mantém texto cru quando data não é JSON e junta múltiplas linhas data', () => {
    const p = new SseParser();
    expect(p.feed('data: um\ndata: dois\n\n')).toEqual([{ event: 'message', data: 'um\ndois' }]);
  });

  it('preserva acentos e escapes de nova linha dentro do JSON', () => {
    const p = new SseParser();
    const payload = JSON.stringify({ text: 'ação\n"citação"' });
    expect(p.feed(`event: chunk\ndata: ${payload}\n\n`)[0]!.data).toEqual({ text: 'ação\n"citação"' });
  });
});
