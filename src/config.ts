import path from 'node:path';

export interface AppConfig {
  port: number;
  host: string;
  databasePath: string;
  publicDir: string;
}

/**
 * Lê a configuração do ambiente. Os padrões servem para desenvolvimento local;
 * em produção (Docker) as variáveis são definidas pelo Dockerfile/compose.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '127.0.0.1',
    databasePath: env.DATABASE_PATH ?? path.resolve(process.cwd(), 'data', 'chronicler.db'),
    publicDir: env.PUBLIC_DIR ?? path.resolve(process.cwd(), 'public'),
  };
}
