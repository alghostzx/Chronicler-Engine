import type { FastifyInstance } from 'fastify';
import { HttpError, type AppContext } from '../context.js';
import { buildVolumeMarkdown, contentDisposition, volumeTitle } from '../export.js';

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1 } },
};

/**
 * Volumes da crônica. As páginas consumidas por um volume saem do contexto da IA, mas continuam
 * no banco: estas rotas as devolvem (sob demanda) para leitura e exportação pelo jogador.
 */
export function registerArchiveRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { repos } = ctx;

  const requireArchive = (id: string) => {
    const archive = repos.archives.get(id);
    if (!archive) throw new HttpError(404, 'Volume não encontrado.');
    const session = repos.sessions.get(archive.session_id);
    if (!session) throw new HttpError(404, 'Sessão não encontrada.');
    const pages = repos.pages.listArchivedRange(session.id, archive.covered_page_start_index, archive.covered_page_end_index);
    return { archive, session, pages };
  };

  // Páginas que este volume consumiu (somente leitura).
  app.get<{ Params: { id: string } }>('/api/archives/:id/pages', { schema: { params: idParams } }, async (req) => {
    const { archive, pages } = requireArchive(req.params.id);
    return { archive, pages };
  });

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
