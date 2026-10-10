/** Utilitários de PCM 16 bits mono para montar o áudio de uma página a partir dos trechos da API. */

export interface Pcm {
  samples: Int16Array;
  sampleRate: number;
}

/** Taxa de amostragem do PCM entregue pelo Gemini TTS quando o MIME não informa outra. */
export const DEFAULT_SAMPLE_RATE = 24000;

/**
 * Decodifica a resposta de áudio da API: WAV com cabeçalho RIFF (padrão da chamada unária) ou
 * PCM cru (`audio/l16;rate=24000`). Aceita somente 16 bits; estéreo é convertido para mono.
 */
export function decodeAudio(data: Buffer, mimeType = ''): Pcm {
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WAVE') {
    return decodeWav(data);
  }
  const rate = /rate=(\d+)/i.exec(mimeType)?.[1];
  return { samples: toInt16(data), sampleRate: rate ? Number(rate) : DEFAULT_SAMPLE_RATE };
}

function toInt16(bytes: Buffer): Int16Array {
  const length = bytes.length >> 1;
  const out = new Int16Array(length);
  for (let i = 0; i < length; i++) out[i] = bytes.readInt16LE(i * 2);
  return out;
}

function decodeWav(wav: Buffer): Pcm {
  let offset = 12;
  let channels = 1;
  let rate = DEFAULT_SAMPLE_RATE;
  let bits = 16;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      channels = wav.readUInt16LE(body + 2);
      rate = wav.readUInt32LE(body + 4);
      bits = wav.readUInt16LE(body + 14);
    } else if (id === 'data') {
      if (bits !== 16) throw new Error(`WAV de ${bits} bits não suportado.`);
      // Streams podem declarar tamanho 0 ou excessivo: limita ao que existe.
      const end = size === 0 || body + size > wav.length ? wav.length : body + size;
      const interleaved = toInt16(wav.subarray(body, end));
      if (channels <= 1) return { samples: interleaved, sampleRate: rate };
      const mono = new Int16Array(Math.floor(interleaved.length / channels));
      for (let i = 0; i < mono.length; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) sum += interleaved[i * channels + c]!;
        mono[i] = Math.round(sum / channels);
      }
      return { samples: mono, sampleRate: rate };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('WAV sem dados de áudio.');
}

/**
 * Concatena trechos com `gapMs` de silêncio entre eles. Todos devem ter a mesma taxa de
 * amostragem (o modelo sempre devolve 24 kHz).
 */
export function joinPcm(parts: Pcm[], gapMs = 250): Pcm {
  if (parts.length === 0) throw new Error('Nenhum trecho de áudio para juntar.');
  const sampleRate = parts[0]!.sampleRate;
  if (parts.some((p) => p.sampleRate !== sampleRate)) {
    throw new Error('Os trechos de áudio têm taxas de amostragem diferentes.');
  }
  const gap = Math.round((sampleRate * gapMs) / 1000);
  const total = parts.reduce((n, p) => n + p.samples.length, 0) + gap * (parts.length - 1);
  const samples = new Int16Array(total);
  let at = 0;
  parts.forEach((p, i) => {
    if (i > 0) at += gap; // Int16Array já começa zerado: é o silêncio.
    samples.set(p.samples, at);
    at += p.samples.length;
  });
  return { samples, sampleRate };
}

export function durationMs(pcm: Pcm): number {
  return Math.round((pcm.samples.length / pcm.sampleRate) * 1000);
}

/** WAV mono 16 bits (usado em testes e para tocar amostras). */
export function encodeWav(pcm: Pcm): Buffer {
  const dataSize = pcm.samples.length * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(pcm.sampleRate, 24);
  wav.writeUInt32LE(pcm.sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < pcm.samples.length; i++) wav.writeInt16LE(pcm.samples[i]!, 44 + i * 2);
  return wav;
}
