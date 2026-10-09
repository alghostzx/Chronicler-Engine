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

/**
 * Fronteira com a API do Gemini. Toda a lógica de negócio depende desta interface,
 * o que permite testar sem rede (mock) e concentrar o uso do SDK em um só lugar.
 * Será ampliada nas fases seguintes (geração estruturada, contagem de tokens...).
 */
export interface GeminiGateway {
  /** Lista modelos que suportam `generateContent`, sem filtrar por tipo de saída. */
  listModels(): Promise<ModelInfo[]>;
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

