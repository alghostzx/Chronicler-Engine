import type { FastifyInstance } from 'fastify';
import { API_KEY_SETTING } from '../ai/gateway.js';
import { DEFAULT_MODEL_SETTING, pickEffectiveModel } from '../ai/models.js';
import { HttpError, type AppContext } from '../context.js';

export function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { repos, models } = ctx;

  app.get('/api/settings', async () => ({
    api_key_configured: repos.settings.get(API_KEY_SETTING) !== undefined,
    default_model: models.configuredDefault(),
  }));

  app.post<{ Body: { api_key: string } }>(
    '/api/settings/key',
    {
      schema: {
        body: {
          type: 'object',
          required: ['api_key'],
          additionalProperties: false,
          properties: { api_key: { type: 'string', minLength: 10, maxLength: 512 } },
        },
      },
    },
    async (req) => {
      const key = req.body.api_key.trim();
      try {
        // Valida a chave antes de gravar: se a listagem falhar, a chave é rejeitada.
        await ctx.gatewayFactory(key).listModels();
      } catch (err) {
        req.log.warn({ err }, 'Falha ao validar a chave da API Gemini');
        throw new HttpError(400, 'Não foi possível validar a chave da API Gemini. Verifique a chave e a conexão.');
      }
      repos.settings.set(API_KEY_SETTING, key);
      models.invalidate();
      return { api_key_configured: true };
    },
  );

  app.delete('/api/settings/key', async () => {
    repos.settings.delete(API_KEY_SETTING);
    models.invalidate();
    return { api_key_configured: false };
  });

  app.put<{ Body: { default_model: string } }>(
    '/api/settings/model',
    {
      schema: {
        body: {
          type: 'object',
          required: ['default_model'],
          additionalProperties: false,
          properties: { default_model: { type: 'string', minLength: 1, maxLength: 200 } },
        },
      },
    },
    async (req) => {
      repos.settings.set(DEFAULT_MODEL_SETTING, req.body.default_model);
      return { default_model: req.body.default_model };
    },
  );

  /**
   * Modelos de texto disponíveis na API do Gemini. Sem chave configurada, devolve lista vazia
   * apenas com o padrão configurado, para a UI poder renderizar o seletor.
   */
  app.get<{ Querystring: { refresh?: boolean } }>(
    '/api/models',
    { schema: { querystring: { type: 'object', properties: { refresh: { type: 'boolean' } } } } },
    async (req) => {
      const configured = models.configuredDefault();
      if (repos.settings.get(API_KEY_SETTING) === undefined) {
        try {
          ctx.gatewayProvider();
        } catch {
          return { models: [], default_model: configured, effective_default_model: configured, available: false };
        }
      }
      try {
        const list = await models.list(req.query.refresh === true);
        return {
          models: list,
          default_model: configured,
          effective_default_model: pickEffectiveModel(configured, list),
          available: true,
        };
      } catch (err) {
        req.log.warn({ err }, 'Falha ao listar modelos do Gemini');
        throw new HttpError(502, 'Não foi possível obter a lista de modelos do Gemini.');
      }
    },
  );
}
