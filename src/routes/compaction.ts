import type { FastifyInstance } from 'fastify';
import { appendChronicle, buildCompactionRequest, splitAtPage, splitForCompaction } from '../ai/compaction.js';
import { COMPACTION_IDLE_TIMEOUT_MS } from '../ai/gateway.js';
import { HttpError, type AppContext } from '../context.js';
import type { Session } from '../db/types.js';
import { assertNoActiveDialogue, idParams, requireSession } from './common.js';
import { friendlyError } from './turnRunner.js';

export function registerCompactionRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { repos, turns } = ctx;

  const requireCompactable = (id: string): Session => {
    const session = requireSession(repos, id);
    assertNoActiveDialogue(repos, id, 'Há um diálogo ativo nesta sessão. Encerre-o antes de compactar.');
    return session;
  };

  // --- Minuta da sinopse (não grava nada) ------------------------------------------------------
  app.post<{
    Params: { id: string };
    Body?: { covered_page_end_index?: number } | null;
  }>(
    '/api/sessions/:id/compact/preview',
    {
      schema: {
        params: idParams,
        body: {
          type: ['object', 'null'],
          additionalProperties: false,
          properties: {
            covered_page_end_index: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (req) => {
      const session = requireCompactable(req.params.id);
      const active = repos.pages.listActive(session.id);
      if (active.length < 2) {
        throw new HttpError(409, 'É preciso ao menos 2 páginas ativas para compactar a crônica.');
      }
      const requestedEnd = req.body?.covered_page_end_index;
      const split =
        requestedEnd !== undefined
          ? splitAtPage(active, requestedEnd)
          : splitForCompaction(active);
      if (!split) {
        throw new HttpError(
          409,
          'A página limite escolhida é inválida. Escolha uma página ativa que preserve ao menos a última página no Tome.',
        );
      }

      return turns.withClaim(session.id, async () => {
        const gateway = ctx.gatewayProvider();
        const model = await ctx.models.resolve(session);
        const { systemInstruction, userText } = buildCompactionRequest({ session, past: split.past });

        let summary = '';
        try {
          for await (const fragment of gateway.streamGenerate({
            model,
            systemInstruction,
            userText,
            idleTimeoutMs: COMPACTION_IDLE_TIMEOUT_MS,
          })) {
            summary += fragment;
          }
        } catch (err) {
          req.log.error({ err }, 'Falha ao gerar a sinopse');
          throw new HttpError(502, friendlyError(err).replace('narrativa', 'sinopse'));
        }
        summary = summary.trim();
        if (summary.length === 0) throw new HttpError(502, 'O modelo não devolveu nenhuma sinopse.');

        return {
          summary_text: summary,
          covered_page_start_index: split.past[0]!.order_index,
          covered_page_end_index: split.past.at(-1)!.order_index,
          pages_to_archive: split.past.length,
          pages_to_keep: split.keep.length,
          next_volume_number: repos.archives.list(session.id).length + 1,
          model,
        };
      });
    },
  );

  // --- Consolidação (revisão humana já feita) ---------------------------------------------------
  app.post<{
    Params: { id: string };
    Body: { summary_text: string; covered_page_start_index: number; covered_page_end_index: number };
  }>(
    '/api/sessions/:id/compact/commit',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['summary_text', 'covered_page_start_index', 'covered_page_end_index'],
          additionalProperties: false,
          properties: {
            summary_text: { type: 'string', minLength: 1, maxLength: 200_000 },
            covered_page_start_index: { type: 'integer', minimum: 1 },
            covered_page_end_index: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (req) => {
      const session = requireCompactable(req.params.id);
      const { covered_page_start_index: start, covered_page_end_index: end } = req.body;
      const summary = req.body.summary_text.trim();
      if (summary.length === 0) throw new HttpError(400, 'A sinopse não pode ser vazia.');

      return turns.withClaim(session.id, async () => {
        const active = repos.pages.listActive(session.id);
        // A faixa precisa ser exatamente um prefixo das páginas ativas, preservando ao menos o último.
        const valid =
          active.length >= 2 &&
          active[0]!.order_index === start &&
          end >= start &&
          end < active.at(-1)!.order_index &&
          active.some((b) => b.order_index === end);
        if (!valid) {
          throw new HttpError(409, 'A faixa de páginas mudou desde a minuta. Gere uma nova minuta da sinopse.');
        }

        const archivedIds = active
          .filter((b) => b.order_index >= start && b.order_index <= end)
          .map((b) => b.id);

        const result = repos.transaction(() => {
          const archive = repos.archives.create(session.id, {
            summary_text: summary,
            covered_page_start_index: start,
            covered_page_end_index: end,
          });
          const archived = repos.pages.archiveRange(session.id, start, end);
          const updated = repos.sessions.update(session.id, {
            world_context: appendChronicle(session.world_context, archive.volume_number, summary),
          })!;
          return { archive, session: updated, archived_pages: archived };
        });

        // Libera os trechos WAV em cache das páginas arquivadas (preserva o MP3 consolidado)
        repos.audio.deleteChunksForPages(archivedIds);

        return result;
      });
    },
  );
}
