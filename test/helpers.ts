import type { FastifyInstance } from 'fastify';
import type { GeminiGateway, GenerateRequest, ModelInfo } from '../src/ai/gateway.js';
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

export interface MockGateway extends GeminiGateway {
  /** Todas as requisições de geração recebidas, em ordem. */
  requests: GenerateRequest[];
  /** Todas as requisições de contagem de tokens recebidas, em ordem. */
  countRequests: Parameters<GeminiGateway['countTokens']>[0][];
  /** Enfileira respostas (texto bruto) para as próximas chamadas de `streamGenerate`. */
  queue(...replies: string[]): void;
}

export interface MockGatewayOptions {
  listModels?: () => Promise<ModelInfo[]>;
  /** Tamanho das fatias em que o texto é "streamado". */
  chunkSize?: number;
  /** Se definido, `streamGenerate` lança este erro após emitir o primeiro fragmento. */
  failWith?: Error;
  /** Contagem de tokens fictícia (padrão: ~1 token a cada 4 caracteres). */
  countTokens?: (req: Parameters<GeminiGateway['countTokens']>[0]) => number;
  countTokensFails?: boolean;
}

export function mockGateway(opts: MockGatewayOptions = {}): MockGateway {
  const replies: string[] = [];
  const requests: GenerateRequest[] = [];
  const countRequests: MockGateway['countRequests'] = [];
  return {
    requests,
    countRequests,
    queue: (...r) => replies.push(...r),
    listModels: opts.listModels ?? (async () => SAMPLE_MODELS),
    async *streamGenerate(req) {
      requests.push(req);
      const reply = replies.shift();
      if (reply === undefined) throw new Error('mockGateway: nenhuma resposta enfileirada');
      const size = opts.chunkSize ?? 7;
      for (let i = 0; i < reply.length; i += size) {
        yield reply.slice(i, i + size);
        if (opts.failWith && i === 0) throw opts.failWith;
      }
    },
    async countTokens(req) {
      countRequests.push(req);
      if (opts.countTokensFails) throw new Error('countTokens indisponível');
      return opts.countTokens ? opts.countTokens(req) : Math.ceil(((req.systemInstruction ?? '') + req.userText).length / 4);
    },
  };
}

/** JSON de resposta do Narrador. */
export function narratorJson(
  text: string,
  trigger: { activate: boolean; npc_name?: string; dynamic_system_prompt?: string } = { activate: false },
): string {
  return JSON.stringify({ narrative_text: text, dialogue_trigger: trigger });
}

/** JSON de resposta do NPC no Modo Diálogo. */
export function npcJson(reply: string, endConversation = false): string {
  return JSON.stringify({ reply, end_conversation: endConversation });
}

export interface SseEvent {
  event: string;
  data: any;
}

/** Converte o corpo de uma resposta SSE em eventos. */
export function parseSse(body: string): SseEvent[] {
  return body
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith('event:'))
    .map((frame) => {
      const [eventLine, dataLine] = frame.split('\n');
      return { event: eventLine!.slice(6).trim(), data: JSON.parse(dataLine!.slice(5).trim()) };
    });
}

export interface TestApp {
  app: FastifyInstance;
  repos: Repositories;
  gateway: MockGateway;
}

/** App com SQLite em memória e Gemini mockado. */
export async function makeApp(gateway: MockGateway = mockGateway()): Promise<TestApp> {
  const repos = createRepositories(openDatabase(':memory:'));
  const app = await buildApp(loadConfig({ PUBLIC_DIR: '/inexistente' }), {
    repos,
    gatewayFactory: () => gateway,
  });
  return { app, repos, gateway };
}

/** Configura uma chave de API fictícia diretamente no banco. */
export function withKey(t: TestApp): TestApp {
  t.repos.settings.set('gemini_api_key', FAKE_KEY);
  return t;
}
