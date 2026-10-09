import type { SettingsRepository } from '../db/repositories/settings.js';
import type { Session } from '../db/types.js';
import type { GatewayProvider, ModelInfo } from './gateway.js';

export const DEFAULT_MODEL = 'gemini-3.8-flash';
export const DEFAULT_MODEL_SETTING = 'default_model';

/** Modelos que suportam generateContent mas não geram texto narrativo. */
const NON_TEXT_PATTERN =
  /(image|tts|audio|imagen|veo|embed|live|aqa|robotics|computer-use|banana|lyria|transcribe|omni|deep-research|antigravity)/i;

export function isTextGenerationModel(model: ModelInfo): boolean {
  return !NON_TEXT_PATTERN.test(model.id);
}

/**
 * Escolhe o modelo padrão efetivo: o configurado, se disponível; senão o primeiro Flash
 * (preferindo versões que não sejam "lite"); senão o primeiro da lista.
 */
export function pickEffectiveModel(configured: string, available: ModelInfo[]): string {
  if (available.length === 0 || available.some((m) => m.id === configured)) return configured;
  const flash = available.filter((m) => /flash/i.test(m.id));
  return (flash.find((m) => !/lite/i.test(m.id)) ?? flash[0] ?? available[0]!).id;
}

const CACHE_TTL_MS = 10 * 60 * 1000;

export class ModelService {
  private cache: { at: number; models: ModelInfo[] } | undefined;

  constructor(
    private readonly gatewayProvider: GatewayProvider,
    private readonly settings: SettingsRepository,
    private readonly now: () => number = Date.now,
  ) {}

  async list(refresh = false): Promise<ModelInfo[]> {
    if (!refresh && this.cache && this.now() - this.cache.at < CACHE_TTL_MS) {
      return this.cache.models;
    }
    const all = await this.gatewayProvider().listModels();
    const models = all.filter(isTextGenerationModel).sort((a, b) => a.id.localeCompare(b.id));
    this.cache = { at: this.now(), models };
    return models;
  }

  invalidate(): void {
    this.cache = undefined;
  }

  configuredDefault(): string {
    return this.settings.get(DEFAULT_MODEL_SETTING) ?? DEFAULT_MODEL;
  }

  /**
   * Modelo a usar numa sessão: o da sessão, ou o padrão global, ambos validados contra a
   * lista de disponíveis. Se a lista não puder ser obtida, usa o valor configurado.
   */
  async resolve(session: Pick<Session, 'model'>): Promise<string> {
    const wanted = session.model ?? this.configuredDefault();
    try {
      return pickEffectiveModel(wanted, await this.list());
    } catch {
      return wanted;
    }
  }
}
