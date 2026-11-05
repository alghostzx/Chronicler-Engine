import type { FastifyInstance } from 'fastify';
import { HttpError, type AppContext } from '../context.js';
import { buildVolumeMarkdown, contentDisposition, volumeTitle } from '../export.js';
import { idParams, requireSession } from './common.js';

/**
 * Volumes da crônica. As páginas consumidas por um volume saem do contexto da IA, mas continuam
 * no banco: estas rotas as devolvem (sob demanda) para leitura e exportação pelo jogador.
 */
export function registerArchiveRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { repos } = ctx;

  const requireArchive = (id: string) => {
    const archive = repos.archives.get(id);
    if (!archive) throw new HttpError(404, 'Volume não encontrado.');
    const session = requireSession(repos, archive.session_id);
    const pages = repos.pages.listArchivedRange(session.id, archive.covered_page_start_index, archive.covered_page_end_index);
    return { archive, session, pages };
  };

  // Páginas que este volume consumiu (somente leitura).
  app.get<{ Params: { id: string } }>('/api/archives/:id/pages', { schema: { params: idParams } }, async (req) => {
    const { archive, pages } = requireArchive(req.params.id);
    return { archive, pages: ctx.audio.decorate(pages) };
  });

  // Agenda, EM ORDEM, o áudio das páginas deste volume de `from_page_id` até a última do volume
  // que ainda não têm áudio válido nem geração em andamento (as que falharam tentam de novo).
  app.post<{ Params: { id: string }; Body: { from_page_id: string } }>(
    '/api/archives/:id/audio/batch',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['from_page_id'],
          additionalProperties: false,
          properties: { from_page_id: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (req) => {
      const { pages } = requireArchive(req.params.id);
      const from = pages.find((p) => p.id === req.body.from_page_id);
      if (!from) throw new HttpError(404, 'Página não encontrada neste volume.');
      const started: string[] = [];
      for (const page of pages.filter((p) => p.order_index >= from.order_index)) {
        const status = ctx.audio.info(page)?.status;
        if (status === 'ready' || status === 'generating') continue;
        try {
          ctx.audio.start(page);
          started.push(page.id);
        } catch (err) {
          if (err instanceof HttpError && err.statusCode === 409) continue; // página sem texto para narrar
          throw err; // sem chave de API (nada foi agendado antes dela) ou erro inesperado
        }
      }
      const decorated = ctx.audio.decorate(pages);
      return {
        started,
        pages: decorated.map((p) => ({ page_id: p.id, order_index: p.order_index, kind: p.kind, audio: p.audio })),
      };
    },
  );

  // Exporta um volume como Markdown: título, sinopse (opcional) e as páginas separadas por `---`.
  app.get<{ Params: { id: string }; Querystring: { include_summary?: boolean } }>(
    '/api/archives/:id/export',
    {
      schema: {
        params: idParams,
        querystring: { type: 'object', properties: { include_summary: { type: 'boolean' } } },
      },
    },
    async (req, reply) => {
      const { archive, session, pages } = requireArchive(req.params.id);
      const markdown = buildVolumeMarkdown({
        session,
        archive,
        pages,
        exportedAt: new Date(),
        includeSummary: req.query.include_summary !== false,
      });
      return reply
        .header('Content-Type', 'text/markdown; charset=utf-8')
        .header('Content-Disposition', contentDisposition(volumeTitle(session.title, archive.volume_number)))
        .header('Cache-Control', 'no-store')
        .send(markdown);
    },
  );
}
