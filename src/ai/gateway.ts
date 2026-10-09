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

export interface GenerateRequest {
  model: string;
  systemInstruction?: string;
  /** Turno único do usuário (texto). */
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
      contents: req.userText,
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

