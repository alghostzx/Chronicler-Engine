import type { FastifyInstance } from 'fastify';
import { buildNarratorRequest } from '../ai/contextBuilder.js';
import { computeHp } from '../ai/tokens.js';
import { HttpError, type AppContext } from '../context.js';

export function registerTokenRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { repos } = ctx;

  /**
   * Contagem precisa de tokens do contexto atual e HP restante do Narrador (§4, §8.2).
   * Mede regras + contexto base + corpus ativo (sem input pendente do jogador).
   */
  app.get<{ Params: { id: string } }>(
    '/api/sessions/:id/token-count',
    { schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1 } } } } },
    async (req) => {
      const session = repos.sessions.get(req.params.id);
      if (!session) throw new HttpError(404, 'Sessão não encontrada.');

      const model = await ctx.models.resolve(session);
      const payload = buildNarratorRequest({
        session,
        precedingBlocks: repos.blocks.listActive(session.id),
        playerInstruction: '',
      });

      let tokensUsed: number;
      try {
        tokensUsed = await ctx.tokens.count({ model, ...payload });
      } catch (err) {
        if ((err as Error).name === 'MissingApiKeyError') throw err;
        req.log.warn({ err }, 'Falha ao contar tokens');
        throw new HttpError(502, 'Não foi possível contar os tokens com a API do Gemini.');
      }

      return {
        tokens_used: tokensUsed,
        token_limit: session.token_limit,
        model,
        ...computeHp(tokensUsed, session.token_limit),
      };
    },
  );
}
