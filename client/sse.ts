/**
 * Parser incremental de Server-Sent Events. Puro (sem DOM/fetch) para ser testável no Vitest.
 * O backend sempre envia `event:` + `data:` (JSON) separados por linha em branco; comentários
 * (`: ...`) e campos desconhecidos são ignorados.
 */
export interface SseMessage {
  event: string;
  data: unknown;
}

export class SseParser {
  private buffer = '';
  private event = 'message';
  private dataLines: string[] = [];

  /** Alimenta um pedaço de texto (que pode cortar linhas ao meio) e devolve os eventos completos. */
  feed(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const out: SseMessage[] = [];
    let idx: number;
    // Aceita \n, \r\n e \r como terminadores de linha.
    while ((idx = this.nextLineBreak()) !== -1) {
      let line = this.buffer.slice(0, idx);
      let skip = 1;
      if (this.buffer[idx] === '\r' && this.buffer[idx + 1] === '\n') skip = 2;
      this.buffer = this.buffer.slice(idx + skip);
      line = line.replace(/\r$/, '');
      const msg = this.consumeLine(line);
      if (msg) out.push(msg);
    }
    return out;
  }

  private nextLineBreak(): number {
    const n = this.buffer.indexOf('\n');
    const r = this.buffer.indexOf('\r');
    // Um \r no fim do buffer pode ser o início de \r\n: espera mais dados.
    if (r !== -1 && r === this.buffer.length - 1) return n;
    if (n === -1) return r;
    if (r === -1) return n;
    return Math.min(n, r);
  }

  private consumeLine(line: string): SseMessage | undefined {
    if (line === '') {
      if (this.dataLines.length === 0) {
        this.event = 'message';
        return undefined;
      }
      const raw = this.dataLines.join('\n');
      const event = this.event;
      this.event = 'message';
      this.dataLines = [];
      let data: unknown = raw;
      try {
        data = JSON.parse(raw);
      } catch {
        /* mantém texto cru */
      }
      return { event, data };
    }
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.dataLines.push(value);
    return undefined;
  }
}
