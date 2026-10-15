import path from 'node:path';
import { DEFAULT_MAX_RPM } from './tts/config.js';

export interface AppConfig {
  port: number;
  host: string;
  databasePath: string;
  publicDir: string;
  /** Chamadas por minuto à API de voz (limite do tier do Gemini). */
  ttsMaxRpm: number;
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
    ttsMaxRpm: positiveInt(env.TTS_MAX_RPM, DEFAULT_MAX_RPM),
  };
}

/** Inteiro positivo da variável de ambiente; valor ausente ou inválido cai no padrão. */
function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
