import { Mp3Encoder } from '@breezystack/lamejs';
import type { Pcm } from './pcm.js';

/** MP3 mono a 48 kbps: ~8× menor que o WAV e inteligível para voz (ver design document §11.24). */
export const MP3_KBPS = 48;
const FRAME = 1152;

/**
 * Codifica PCM mono em MP3 com lamejs (JS puro, sem binários nativos). Cede o laço de eventos a
 * cada ~200 quadros, para que codificar uma página longa (alguns segundos) não trave o servidor.
 * 48 kbps: 7 min de áudio levam ~5 s; taxas menores ficam muito mais lentas.
 */
export async function encodeMp3(pcm: Pcm, kbps = MP3_KBPS, signal?: AbortSignal): Promise<Buffer> {
  const encoder = new Mp3Encoder(1, pcm.sampleRate, kbps);
  const out: Buffer[] = [];
  let frames = 0;
  for (let i = 0; i < pcm.samples.length; i += FRAME) {
    const bytes = encoder.encodeBuffer(pcm.samples.subarray(i, i + FRAME));
    if (bytes.length > 0) out.push(Buffer.from(bytes));
    if (++frames % 200 === 0) {
      signal?.throwIfAborted();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  const tail = encoder.flush();
  if (tail.length > 0) out.push(Buffer.from(tail));
  return Buffer.concat(out);
}
