import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig, type AppConfig } from './config.js';

export async function buildApp(config: AppConfig, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });

  app.get('/api/health', async () => ({ status: 'ok' }));

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
