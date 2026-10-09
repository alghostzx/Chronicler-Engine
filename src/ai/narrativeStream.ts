/**
 * Extrator incremental do valor de `narrative_text` num JSON que chega em pedaços
 * (design document §11.4).
 *
 * Alimentado com fragmentos do JSON bruto devolvido pelo Gemini, devolve a cada chamada o
 * trecho recém-decodificado de `narrative_text` (já sem escapes JSON). Só considera a chave
 * no nível raiz do objeto, de modo que a mesma string dentro de outro campo não confunde o parser.
 * Não valida o JSON: o payload completo é sempre reavaliado com `JSON.parse` no fechamento.
 */
export class NarrativeTextExtractor {
  private depth = 0;
  private inString = false;
  private escaped = false;
  private unicode: string | null = null;
  private expectKey = false;
  private pendingColon = false;
  private pendingValue = false;
  private keyBuf = '';
  private keyCandidate = false;
  private lastKey: string | null = null;
  private capturing = false;
  private done = false;
  /** Unidade UTF-16 alta retida até chegar a baixa, para não partir pares substitutos entre chunks. */
  private heldHighSurrogate = '';

  private readonly targetKey: string;

  constructor(targetKey = 'narrative_text') {
    this.targetKey = targetKey;
  }

  /** `true` depois que a string de `narrative_text` foi fechada. */
  get finished(): boolean {
    return this.done;
  }

  push(chunk: string): string {
    let out = '';
    for (const c of chunk) {
      out += this.step(c);
    }
    return out;
  }

  private step(c: string): string {
    if (this.inString) return this.stepInString(c);

    if (c === '"') {
      this.inString = true;
      this.keyBuf = '';
      this.keyCandidate = false;
      if (this.depth === 1) {
        if (this.pendingValue && this.lastKey === this.targetKey && !this.done) {
          this.capturing = true;
        } else if (this.expectKey) {
          this.keyCandidate = true;
        }
        this.pendingValue = false;
        this.expectKey = false;
      }
      return '';
    }

    if (c === '{' || c === '[') {
      this.depth++;
      if (this.depth === 1 && c === '{') this.expectKey = true;
      this.pendingValue = false;
    } else if (c === '}' || c === ']') {
      this.depth--;
    } else if (this.depth === 1) {
      if (c === ',') {
        this.expectKey = true;
        this.pendingValue = false;
        this.pendingColon = false;
        this.lastKey = null;
      } else if (c === ':') {
        if (this.pendingColon) {
          this.pendingColon = false;
          this.pendingValue = true;
        }
      } else if (!/\s/.test(c)) {
        // Início de valor literal (número, true, false, null).
        this.pendingValue = false;
      }
    }
    return '';
  }

  private stepInString(c: string): string {
    if (this.capturing) return this.stepCapturing(c);

    // String ignorada ou chave candidata.
    if (this.escaped) {
      this.escaped = false;
      if (this.keyCandidate) this.keyBuf += c;
      return '';
    }
    if (c === '\\') {
      this.escaped = true;
      return '';
    }
    if (c === '"') {
      this.inString = false;
      if (this.keyCandidate) {
        this.lastKey = this.keyBuf;
        this.pendingColon = true;
        this.keyCandidate = false;
      }
      return '';
    }
    if (this.keyCandidate && this.keyBuf.length < 256) this.keyBuf += c;
    return '';
  }

  private stepCapturing(c: string): string {
    if (this.unicode !== null) {
      this.unicode += c;
      if (this.unicode.length < 4) return '';
      const code = Number.parseInt(this.unicode, 16);
      this.unicode = null;
      return this.emit(Number.isNaN(code) ? '' : String.fromCharCode(code));
    }
    if (this.escaped) {
      this.escaped = false;
      switch (c) {
        case 'n':
          return this.emit('\n');
        case 't':
          return this.emit('\t');
        case 'r':
          return this.emit('\r');
        case 'b':
          return this.emit('\b');
        case 'f':
          return this.emit('\f');
        case 'u':
          this.unicode = '';
          return '';
        default:
          return this.emit(c); // \" \\ \/
      }
    }
    if (c === '\\') {
      this.escaped = true;
      return '';
    }
    if (c === '"') {
      this.inString = false;
      this.capturing = false;
      this.done = true;
      // Uma alta solta no fim do texto é emitida como está.
      const rest = this.heldHighSurrogate;
      this.heldHighSurrogate = '';
      return rest;
    }
    return this.emit(c);
  }

  /** Emite texto decodificado, retendo uma unidade alta de par substituto até a baixa chegar. */
  private emit(text: string): string {
    let out = '';
    for (const unit of text) {
      // `for...of` já agrupa pares válidos; unidades isoladas passam individualmente.
      const code = unit.charCodeAt(0);
      if (unit.length === 1 && code >= 0xd800 && code <= 0xdbff) {
        out += this.heldHighSurrogate;
        this.heldHighSurrogate = unit;
        continue;
      }
      if (unit.length === 1 && code >= 0xdc00 && code <= 0xdfff && this.heldHighSurrogate) {
        out += this.heldHighSurrogate + unit;
        this.heldHighSurrogate = '';
        continue;
      }
      out += this.heldHighSurrogate + unit;
      this.heldHighSurrogate = '';
    }
    return out;
  }
}
