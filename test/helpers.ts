import type { FastifyInstance } from 'fastify';
import type { GeminiGateway, ModelInfo } from '../src/ai/gateway.js';
import { loadConfig } from '../src/config.js';
import { createRepositories, type Repositories } from '../src/db/index.js';
import { openDatabase } from '../src/db/connection.js';
import { buildApp } from '../src/server.js';

export const FAKE_KEY = 'chave-de-teste-1234567890';

export const SAMPLE_MODELS: ModelInfo[] = [
  { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
  { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
  { id: 'gemini-2.5-flash-lite', displayName: 'Gemini 2.5 Flash Lite' },
  { id: 'gemini-2.5-flash-image', displayName: 'Gemini 2.5 Flash Image' },
  { id: 'gemini-2.5-flash-preview-tts', displayName: 'Gemini 2.5 Flash TTS' },
];

export function mockGateway(overrides: Partial<GeminiGateway> = {}): GeminiGateway {
  return { listModels: async () => SAMPLE_MODELS, ...overrides };
}

export interface TestApp {
  app: FastifyInstance;
  repos: Repositories;
}

/** App com SQLite em memória e Gemini mockado. */
export async function makeApp(gateway: GeminiGateway = mockGateway()): Promise<TestApp> {
  const repos = createRepositories(openDatabase(':memory:'));
  const app = await buildApp(loadConfig({ PUBLIC_DIR: '/inexistente' }), {
    repos,
    gatewayFactory: () => gateway,
  });
  return { app, repos };
}
