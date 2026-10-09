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
import { registerNarrativeRoutes } from './routes/narrative.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerTokenRoutes } from './routes/tokens.js';

export interface BuildAppOptions {
  logger?: boolean;
  /** Repositórios já abertos (testes). Se omitido, abre `config.databasePath`. */
  repos?: Repositories;
  /** Fábrica de gateway do Gemini (testes injetam um mock). */
  gatewayFactory?: GatewayFactory;
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
  const ctx: AppContext = {
    repos,
    gatewayProvider,
    gatewayFactory,
    models: new ModelService(gatewayProvider, repos.settings),
    tokens: new TokenCounter(gatewayProvider),
  };

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
    if (!opts.repos) repos.db.close();
  });

  app.get('/api/health', async () => ({ status: 'ok' }));
  registerSettingsRoutes(app, ctx);
  registerSessionRoutes(app, ctx);
  registerNarrativeRoutes(app, ctx);
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
}

// Executa apenas quando chamado diretamente (não ao ser importado pelos testes).
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
