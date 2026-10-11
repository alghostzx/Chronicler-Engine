import { GoogleGenAI } from '@google/genai';
import type { SettingsRepository } from '../db/repositories/settings.js';

export const API_KEY_SETTING = 'gemini_api_key';

export interface ModelInfo {
  /** Identificador sem o prefixo `models/` (ex.: `gemini-2.5-flash`). */
  id: string;
  displayName: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
}

export interface ChatTurn {
  role: 'user' | 'model';
  text: string;
}

export interface GenerateRequest {
  model: string;
  systemInstruction?: string;
  /** Turnos anteriores da conversa (usado no Modo Diálogo), em ordem cronológica. */
  history?: ChatTurn[];
  /** Último turno do usuário (texto). */
  userText: string;
  /** Se informado, força resposta JSON aderente a este JSON Schema. */
  responseJsonSchema?: unknown;
  signal?: AbortSignal;
}

/** Falha na geração (bloqueio de segurança, limite de tokens de saída, erro da API...). */
export class GenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GenerationError';
  }
}

export interface SynthesizeRequest {
  /** Modelo de TTS (ex.: `gemini-3.8-flash-tts`). */
  model: string;
  /** Texto lido literalmente (o modelo não interpreta instruções contidas nele). */
  text: string;
  /** Voz pré-definida (ex.: `Gacrux`) ou id de voz da biblioteca. */
  voice: string;
  /** Ritmo/tom sustentado da leitura (`speech_metadata.style`). Opcional. */
  style?: string;
  signal?: AbortSignal;
}

/** Áudio devolvido pela API: WAV com cabeçalho (padrão) ou PCM cru `audio/l16;rate=…`. */
export interface SynthesizedAudio {
  data: Buffer;
  mimeType: string;
}

/**
 * Falha na síntese de voz. `retryable` indica falha transitória (limite de cota, 5xx, rede):
 * o serviço tenta de novo com espera crescente antes de desistir.
 */
export class SynthesisError extends GenerationError {
  constructor(
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'SynthesisError';
  }
}

/**
 * Fronteira com a API do Gemini. Toda a lógica de negócio depende desta interface,
 * o que permite testar sem rede (mock) e concentrar o uso do SDK em um só lugar.
 * Será ampliada nas fases seguintes (contagem de tokens...).
 */
export interface GeminiGateway {
  /** Lista modelos que suportam `generateContent`, sem filtrar por tipo de saída. */
  listModels(): Promise<ModelInfo[]>;
  /**
   * Gera conteúdo em streaming, devolvendo os fragmentos de texto na ordem em que chegam.
   * Lança `GenerationError` se a geração terminar de forma anormal.
   */
  streamGenerate(req: GenerateRequest): AsyncIterable<string>;
  /** Conta com precisão os tokens do payload (`ai.models.countTokens`). */
  countTokens(req: Pick<GenerateRequest, 'model' | 'systemInstruction' | 'userText'>): Promise<number>;
  /**
   * Sintetiza voz (Gemini TTS, via Interactions API) e devolve o áudio bruto da API.
   * Lança `SynthesisError` (com `retryable` para falhas transitórias).
   */
  synthesize(req: SynthesizeRequest): Promise<SynthesizedAudio>;
}

export type GatewayProvider = () => GeminiGateway;

export class MissingApiKeyError extends Error {
  constructor() {
    super('Nenhuma chave da API Gemini configurada. Defina a chave nas configurações.');
    this.name = 'MissingApiKeyError';
  }
}

export class GeminiGatewayImpl implements GeminiGateway {
  private readonly ai: GoogleGenAI;

  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async listModels(): Promise<ModelInfo[]> {
    const result: ModelInfo[] = [];
    const pager = await this.ai.models.list({ config: { pageSize: 100 } });
    for await (const model of pager) {
      if (!model.name || !model.supportedActions?.includes('generateContent')) continue;
      result.push({
        id: model.name.replace(/^models\//, ''),
        displayName: model.displayName ?? model.name,
        description: model.description,
        inputTokenLimit: model.inputTokenLimit,
        outputTokenLimit: model.outputTokenLimit,
      });
    }
    return result;
  }

  async *streamGenerate(req: GenerateRequest): AsyncIterable<string> {
    const stream = await this.ai.models.generateContentStream({
      model: req.model,
      contents: [
        ...(req.history ?? []).map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
        { role: 'user', parts: [{ text: req.userText }] },
      ],
      config: {
        systemInstruction: req.systemInstruction,
        abortSignal: req.signal,
        ...(req.responseJsonSchema !== undefined
          ? { responseMimeType: 'application/json', responseJsonSchema: req.responseJsonSchema }
          : {}),
      },
    });

    let finishReason: string | undefined;
    let blockReason: string | undefined;
    for await (const chunk of stream) {
      blockReason = chunk.promptFeedback?.blockReason ?? blockReason;
      finishReason = chunk.candidates?.[0]?.finishReason ?? finishReason;
      const text = chunk.text;
      if (text) yield text;
    }
    if (blockReason) {
      throw new GenerationError(`A solicitação foi bloqueada pela API (${blockReason}).`);
    }
    if (finishReason && finishReason !== 'STOP') {
      throw new GenerationError(`A geração terminou de forma anormal (${finishReason}).`);
    }
  }

  /**
   * A Gemini Developer API rejeita `systemInstruction` em `countTokens` (só existe no modo
   * Vertex/Enterprise). Como o texto das regras entra no prompt de qualquer forma, ele é
   * contado junto com o conteúdo — a diferença para a contagem interna é de poucos tokens
   * de moldura, irrelevante para uma barra de HP em escala de centenas de milhares.
   */
  async countTokens(req: Pick<GenerateRequest, 'model' | 'systemInstruction' | 'userText'>): Promise<number> {
    const text = req.systemInstruction ? `${req.systemInstruction}\n\n${req.userText}` : req.userText;
    const res = await this.ai.models.countTokens({ model: req.model, contents: text });
    if (typeof res.totalTokens !== 'number') {
      throw new GenerationError('A API não retornou a contagem de tokens.');
    }
    return res.totalTokens;
  }

  /**
   * O Gemini 3.8 TTS só aceita estilo/voz pela Interactions API: em `generateContent` ele lê em
   * voz alta qualquer instrução escrita no texto e rejeita `systemInstruction`. O estilo vai em
   * `speech_metadata.style` (ritmo e tom; idade/sotaque vêm da escolha da voz). A resposta
   * unária é um WAV 24 kHz mono 16 bits em `output_audio`. Os tipos do SDK ainda não cobrem
   * `speech_metadata`, daí os casts.
   */
  async synthesize(req: SynthesizeRequest): Promise<SynthesizedAudio> {
    const style = req.style?.trim();
    let interaction: {
      status?: string;
      output_audio?: { data?: string; mime_type?: string };
    };
    try {
      interaction = (await this.ai.interactions.create(
        {
          model: req.model,
          input: [
            {
              type: 'user_input',
              content: [
                {
                  type: 'text',
                  text: req.text,
                  ...(style ? { annotations: [{ type: 'speech_metadata', style }] } : {}),
                },
              ],
            },
          ],
          response_format: { type: 'audio' },
          generation_config: { speech_config: [{ voice: req.voice }] },
        } as never,
        { signal: req.signal, timeout_ms: SYNTHESIS_TIMEOUT_MS },
      )) as never;
    } catch (err) {
      if (req.signal?.aborted) throw err;
      throw toSynthesisError(err);
    }
    const data = interaction.output_audio?.data;
    if (!data) {
      throw new SynthesisError(
        `A API não devolveu áudio${interaction.status ? ` (${interaction.status})` : ''}. O texto pode ter sido bloqueado pelos filtros de segurança.`,
      );
    }
    return { data: Buffer.from(data, 'base64'), mimeType: interaction.output_audio?.mime_type ?? 'audio/wav' };
  }
}

/**
 * Tempo máximo de uma única chamada de síntese. Um trecho de ~6000 caracteres rende vários minutos de áudio
 * e leva minutos para gerar (≈0,45 s por segundo de áudio), então o limite é folgado.
 */
const SYNTHESIS_TIMEOUT_MS = 480_000;

/** Traduz erros do SDK/rede para mensagens em pt-BR e decide se vale tentar de novo. */
export function toSynthesisError(err: unknown): SynthesisError {
  if (err instanceof SynthesisError) return err;
  const e = err as { status?: number; statusCode?: number; message?: string; name?: string };
  const message = typeof e?.message === 'string' ? e.message : String(err);
  const status = e?.status ?? e?.statusCode ?? Number(/\b([45]\d\d)\b/.exec(message)?.[1] ?? NaN);
  if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(message)) {
    return new SynthesisError('O limite de uso da API do Gemini foi atingido. Tente de novo em instantes.', true);
  }
  if (status === 401 || status === 403) {
    return new SynthesisError('A chave da API não tem permissão para usar o modelo de voz.');
  }
  if (status === 400 || status === 404) {
    return new SynthesisError(`A API recusou o pedido de áudio: ${message.slice(0, 200)}`);
  }
  if (status >= 500 || /timeout|timed out|fetch failed|ECONN|ENOTFOUND|socket|network/i.test(message) || e?.name === 'RequestTimeoutError') {
    return new SynthesisError('A API de voz está indisponível ou não respondeu a tempo.', true);
  }
  return new SynthesisError(`Falha ao gerar o áudio: ${message.slice(0, 200)}`);
}


export type GatewayFactory = (apiKey: string) => GeminiGateway;

export const defaultGatewayFactory: GatewayFactory = (apiKey) => new GeminiGatewayImpl(apiKey);

/**
 * Cria um provider que lê a chave a cada chamada (ela pode ser trocada em tempo de execução)
 * e reaproveita o cliente enquanto a chave não mudar.
 */
export function createGatewayProvider(
  settings: SettingsRepository,
  envKey?: string,
  factory: GatewayFactory = defaultGatewayFactory,
): GatewayProvider {
  let cached: { key: string; gateway: GeminiGateway } | undefined;
  return () => {
    const key = settings.get(API_KEY_SETTING) ?? envKey;
    if (!key) throw new MissingApiKeyError();
    if (!cached || cached.key !== key) {
      cached = { key, gateway: factory(key) };
    }
    return cached.gateway;
  };
}

