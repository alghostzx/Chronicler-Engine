import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createGatewayProvider,
  defaultGatewayFactory,
  MissingApiKeyError,
  type GatewayFactory,
} from './ai/gateway.js';
import { ModelService } from './ai/models.js';
import { TokenCounter } from './ai/tokens.js';
import { loadConfig, type AppConfig } from './config.js';
import { HttpError, type AppContext } from './context.js';
import { openRepositories, type Repositories } from './db/index.js';
import { registerArchiveRoutes } from './routes/archives.js';
import { registerAudioRoutes } from './routes/audio.js';
import { registerCompactionRoutes } from './routes/compaction.js';
import { registerDialogueRoutes } from './routes/dialogue.js';
import { TurnRunner } from './routes/turnRunner.js';
import { registerNarrativeRoutes } from './routes/narrative.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerTokenRoutes } from './routes/tokens.js';
import { AudioService, type AudioServiceOptions } from './tts/service.js';

export interface BuildAppOptions {
  logger?: boolean;
  /** Repositórios já abertos (testes). Se omitido, abre `config.databasePath`. */
  repos?: Repositories;
  /** Fábrica de gateway do Gemini (testes injetam um mock). */
  gatewayFactory?: GatewayFactory;
  /** Ajustes do serviço de narração (testes: sem espera entre tentativas). */
  audio?: AudioServiceOptions;
}

export async function buildApp(config: AppConfig, opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    // Campos desconhecidos geram erro 400 em vez de serem descartados em silêncio.
    ajv: { customOptions: { removeAdditional: false } },
  });

  const repos = opts.repos ?? openRepositories(config.databasePath);
  const gatewayFactory = opts.gatewayFactory ?? defaultGatewayFactory;
  const gatewayProvider = createGatewayProvider(repos.settings, undefined, gatewayFactory);
  const ctx = {
    repos,
    gatewayProvider,
    gatewayFactory,
    models: new ModelService(gatewayProvider, repos.settings),
    tokens: new TokenCounter(gatewayProvider),
    audio: new AudioService(repos, gatewayProvider, opts.audio),
  } as AppContext;
  ctx.turns = new TurnRunner(ctx);

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    if (err instanceof MissingApiKeyError) {
      return reply.code(409).send({ error: err.message, code: 'missing_api_key' });
    }
    if (err.validation) {
      return reply.code(400).send({ error: `Requisição inválida: ${err.message}` });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    req.log.error({ err }, 'Erro interno');
    return reply.code(500).send({ error: 'Erro interno do servidor.' });
  });

  app.addHook('onClose', async () => {
    ctx.audio.cancelAll();
    if (!opts.repos) repos.db.close();
  });

  app.get('/api/health', async () => ({ status: 'ok' }));
  registerSettingsRoutes(app, ctx);
  registerSessionRoutes(app, ctx);
  registerNarrativeRoutes(app, ctx);
  registerDialogueRoutes(app, ctx);
  registerCompactionRoutes(app, ctx);
  registerArchiveRoutes(app, ctx);
  registerAudioRoutes(app, ctx);
  registerTokenRoutes(app, ctx);

  if (fs.existsSync(config.publicDir)) {
    await app.register(fastifyStatic, { root: config.publicDir });
  }

  return app;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp(config, { logger: true });
  await app.listen({ port: config.port, host: config.host });

  // Como PID 1 de um contêiner, o Node ignora SIGTERM/SIGINT sem handler: encerra de forma graciosa.
  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    app.log.info(`${signal} recebido; encerrando…`);
    // Conexões SSE abertas podem segurar o close(): garante a saída em poucos segundos.
    const force = setTimeout(() => process.exit(0), 3000);
    force.unref();
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Executa apenas quando chamado diretamente (não ao ser importado pelos testes).
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
