import { createHash } from 'node:crypto';
import type { GatewayProvider, GenerateRequest } from './gateway.js';

export type HpState = 'green' | 'yellow' | 'red';

export interface Hp {
  /** Percentual de HP restante, entre 0 e 100, com uma casa decimal. */
  hp_percent: number;
  state: HpState;
}

/**
 * HP do Narrador (design document §4.1/§4.2):
 *   HP% = 100 × (1 − tokensUsados / limite)
 *   verde ≥ 50% · amarelo ≥ 20% e < 50% · vermelho < 20%
 */
export function computeHp(tokensUsed: number, tokenLimit: number): Hp {
  // 100 × (limite − usados) / limite é igual a 100 × (1 − usados/limite), mas evita a
  // imprecisão de ponto flutuante nos limiares exatos (ex.: 800.000/1.000.000 → 20%).
  const raw = tokenLimit > 0 ? (100 * (tokenLimit - tokensUsed)) / tokenLimit : 0;
  const clamped = Math.min(100, Math.max(0, raw));
  const state: HpState = clamped >= 50 ? 'green' : clamped >= 20 ? 'yellow' : 'red';
  return { hp_percent: Math.round(clamped * 10) / 10, state };
}

type CountRequest = Pick<GenerateRequest, 'model' | 'systemInstruction' | 'userText'>;

const MAX_CACHE_ENTRIES = 64;

/**
 * Contagem real de tokens via `countTokens`, com cache em memória por conteúdo.
 *
 * O HP é recalculado por eventos (abertura de sessão, bloco gerado/regenerado, edição,
 * commit de crônica — §11.7). O cache evita chamadas repetidas à API quando o payload
 * não mudou (ex.: reabrir a mesma sessão), sem nunca devolver um valor desatualizado:
 * a chave é o hash do próprio conteúdo.
 */
export class TokenCounter {
  private readonly cache = new Map<string, number>();

  constructor(private readonly gatewayProvider: GatewayProvider) {}

  async count(req: CountRequest): Promise<number> {
    const key = createHash('sha256')
      .update(JSON.stringify([req.model, req.systemInstruction ?? '', req.userText]))
      .digest('hex');
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;

    const tokens = await this.gatewayProvider().countTokens(req);
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      this.cache.delete(this.cache.keys().next().value!);
    }
    this.cache.set(key, tokens);
    return tokens;
  }
}
