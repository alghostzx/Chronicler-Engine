import type { GatewayFactory, GatewayProvider } from './ai/gateway.js';
import type { ModelService } from './ai/models.js';
import type { Repositories } from './db/index.js';

/** Dependências compartilhadas pelas rotas. */
export interface AppContext {
  repos: Repositories;
  gatewayProvider: GatewayProvider;
  /** Cria um gateway para uma chave arbitrária (usado para validar uma chave nova). */
  gatewayFactory: GatewayFactory;
  models: ModelService;
}

/** Erro de domínio com status HTTP associado. */
export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
