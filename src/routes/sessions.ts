import type { FastifyInstance } from 'fastify';
import { HttpError, type AppContext } from '../context.js';
import { DEFAULT_SYSTEM_RULES } from '../prompts/narrator.js';
import { publicDialogue } from './dialogue.js';

export const THEMES = ['medieval', 'cyberpunk', 'pos-apocaliptico', 'contemporaneo'] as const;

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1 } },
};

const sessionFields = {
  title: { type: 'string', minLength: 1, maxLength: 200 },
  system_rules: { type: 'string', minLength: 1 },
  world_context: { type: 'string' },
  active_theme: { type: 'string', enum: THEMES },
  token_limit: { type: 'integer', minimum: 1000, maximum: 10_000_000 },
  model: { type: ['string', 'null'], maxLength: 200 },
};

export function registerSessionRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { repos } = ctx;

  const requireSession = (id: string) => {
    const session = repos.sessions.get(id);
    if (!session) throw new HttpError(404, 'Sessão não encontrada.');
    return session;
  };

  app.get('/api/sessions', async () => ({ sessions: repos.sessions.list() }));

  app.post<{
    Body: {
      title: string;
      system_rules?: string;
      world_context?: string;
      active_theme?: string;
      token_limit?: number;
      model?: string | null;
    };
  }>(
    '/api/sessions',
    {
      schema: {
        body: { type: 'object', required: ['title'], additionalProperties: false, properties: sessionFields },
      },
    },
    async (req, reply) => {
      const b = req.body;
      const session = repos.sessions.create({
        title: b.title.trim(),
        system_rules: b.system_rules ?? DEFAULT_SYSTEM_RULES,
        world_context: b.world_context ?? '',
        active_theme: b.active_theme,
        token_limit: b.token_limit,
        model: b.model,
      });
      return reply.code(201).send({ session });
    },
  );

  app.get<{ Params: { id: string } }>('/api/sessions/:id', { schema: { params: idParams } }, async (req) => {
    const session = requireSession(req.params.id);
    const active = repos.dialogues.getActive(session.id);
    return {
      session,
      blocks: repos.blocks.listActive(session.id),
      archives: repos.archives.list(session.id),
      active_dialogue: active ? publicDialogue(active) : null,
    };
  });

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/sessions/:id/context',
    {
      schema: {
        params: idParams,
        body: { type: 'object', additionalProperties: false, minProperties: 1, properties: sessionFields },
      },
    },
    async (req) => {
      requireSession(req.params.id);
      const session = repos.sessions.update(req.params.id, req.body);
      return { session };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/sessions/:id', { schema: { params: idParams } }, async (req, reply) => {
    requireSession(req.params.id);
    repos.sessions.delete(req.params.id);
    return reply.code(204).send();
  });
}
