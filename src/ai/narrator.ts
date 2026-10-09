import type { GeminiGateway, GenerateRequest } from './gateway.js';
import type { NarratorRequestParts } from './contextBuilder.js';
import { NarrativeTextExtractor } from './narrativeStream.js';
import { NARRATOR_RESPONSE_SCHEMA, parseNarratorResult, type NarratorResult } from './narratorSchema.js';

export type NarratorEvent =
  | { type: 'chunk'; text: string }
  | { type: 'result'; result: NarratorResult };

/**
 * Executa um turno do Narrador com saída estruturada (`responseSchema` forçado).
 *
 * Emite `chunk` conforme o `narrative_text` é decodificado do JSON em streaming e, ao
 * fechamento do payload, um único `result` já validado (inclusive `dialogue_trigger`).
 * Se o payload final for inválido, lança `NarratorResponseError` — nada deve ser persistido.
 */
export async function* streamNarratorTurn(
  gateway: GeminiGateway,
  params: { model: string; request: NarratorRequestParts; signal?: AbortSignal },
): AsyncGenerator<NarratorEvent> {
  const req: GenerateRequest = {
    model: params.model,
    systemInstruction: params.request.systemInstruction,
    userText: params.request.userText,
    responseJsonSchema: NARRATOR_RESPONSE_SCHEMA,
    signal: params.signal,
  };

  const extractor = new NarrativeTextExtractor();
  let raw = '';
  for await (const fragment of gateway.streamGenerate(req)) {
    raw += fragment;
    const text = extractor.push(fragment);
    if (text) yield { type: 'chunk', text };
  }
  yield { type: 'result', result: parseNarratorResult(raw) };
}
