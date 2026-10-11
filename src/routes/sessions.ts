import type { FastifyInstance } from 'fastify';
import { HttpError, type AppContext } from '../context.js';
import { buildStoryMarkdown, contentDisposition, type ExportScope } from '../export.js';
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
  tts_auto: { type: ['boolean', 'null'] },
  tts_auto_dialogue: { type: ['boolean', 'null'] },
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
      tts_auto?: boolean | null;
      tts_auto_dialogue?: boolean | null;
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
        tts_auto: b.tts_auto,
        tts_auto_dialogue: b.tts_auto_dialogue,
      });
      return reply.code(201).send({ session });
    },
  );

  app.get<{ Params: { id: string } }>('/api/sessions/:id', { schema: { params: idParams } }, async (req) => {
    const session = requireSession(req.params.id);
    const active = repos.dialogues.getActive(session.id);
    return {
      session,
      pages: ctx.audio.decorate(repos.pages.listActive(session.id)),
      archives: repos.archives.list(session.id),
      active_dialogue: active ? publicDialogue(active) : null,
    };
  });

  // Exporta a história como arquivo Markdown (download). Por padrão (`scope=all`) inclui também as
  // páginas já consumidas por volumes; `active` = só o que está no Tome; `archived` = só as dos volumes.
  const SCOPE_SUFFIX: Record<ExportScope, string> = { all: '', active: ' — no Tome', archived: ' — volumes' };
  app.get<{ Params: { id: string }; Querystring: { include_context?: boolean; scope?: ExportScope } }>(
    '/api/sessions/:id/export',
    {
      schema: {
        params: idParams,
        querystring: {
          type: 'object',
          properties: {
            include_context: { type: 'boolean' },
            scope: { type: 'string', enum: ['all', 'active', 'archived'] },
          },
        },
      },
    },
    async (req, reply) => {
      const session = requireSession(req.params.id);
      const scope = req.query.scope ?? 'all';
      const all = repos.pages.listAll(session.id);
      const pages = scope === 'all' ? all : all.filter((p) => p.is_archived === (scope === 'archived'));
      if (scope === 'archived' && pages.length === 0) {
        throw new HttpError(409, 'Nenhuma página foi consumida por um volume ainda.');
      }
      const markdown = buildStoryMarkdown({
        session,
        pages,
        exportedAt: new Date(),
        includeContext: req.query.include_context === true,
      });
      return reply
        .header('Content-Type', 'text/markdown; charset=utf-8')
        .header('Content-Disposition', contentDisposition(session.title + SCOPE_SUFFIX[scope]))
        .header('Cache-Control', 'no-store')
        .send(markdown);
    },
  );

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
    ctx.audio.cancelMany(repos.pages.listAll(req.params.id).map((p) => p.id));
    repos.sessions.delete(req.params.id);
    repos.audio.reclaim();
    return reply.code(204).send();
  });
}
