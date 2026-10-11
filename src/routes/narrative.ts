import type { FastifyInstance } from 'fastify';
import { buildNarratorRequest } from '../ai/contextBuilder.js';
import { HttpError, type AppContext } from '../context.js';
import { publicDialogue } from './dialogue.js';
import type { Session } from '../db/types.js';

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1 } },
};

const instructionBody = {
  type: 'object',
  required: ['player_instruction'],
  additionalProperties: false,
  properties: { player_instruction: { type: 'string', minLength: 1, maxLength: 20000 } },
};

export function registerNarrativeRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { repos, turns, audio } = ctx;

  const requireSession = (id: string): Session => {
    const session = repos.sessions.get(id);
    if (!session) throw new HttpError(404, 'Sessão não encontrada.');
    return session;
  };

  const assertNoActiveDialogue = (sessionId: string) => {
    if (repos.dialogues.getActive(sessionId)) {
      throw new HttpError(409, 'Há um diálogo ativo nesta sessão. Encerre-o antes de narrar.');
    }
  };

  // --- Próxima página -------------------------------------------------------------------
  app.post<{ Params: { id: string }; Body: { player_instruction: string } }>(
    '/api/sessions/:id/narrative/next',
    { schema: { params: idParams, body: instructionBody } },
    async (req, reply) => {
      const session = requireSession(req.params.id);
      assertNoActiveDialogue(session.id);
      turns.claim(session.id);
      const instruction = req.body.player_instruction;

      await turns.run(req, reply, {
        session,
        request: buildNarratorRequest({
          session,
          precedingPages: repos.pages.listActive(session.id),
          playerInstruction: instruction,
        }),
        persist: (result, model) =>
          repos.transaction(() => {
            const page = repos.pages.append(session.id, {
              player_instruction: instruction,
              generated_text: result.narrative_text,
              model_identifier: model,
            });
            const dialogue = turns.maybeCreateDialogue(session.id, result);
            repos.sessions.touch(session.id);
            return { page, discarded: 0, dialogue };
          }),
      });
    },
  );

  // --- Edição direta (§6.1) --------------------------------------------------------------
  app.put<{ Params: { id: string }; Body: { generated_text: string } }>(
    '/api/narrative/pages/:id',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['generated_text'],
          additionalProperties: false,
          properties: { generated_text: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (req) => {
      const page = repos.pages.get(req.params.id);
      if (!page) throw new HttpError(404, 'Página não encontrada.');
      if (page.is_archived) throw new HttpError(409, 'Páginas arquivadas não podem ser editadas.');
      if (turns.isBusy(page.session_id)) {
        throw new HttpError(409, 'Já existe uma geração em andamento nesta sessão.');
      }
      const updated = repos.pages.updateText(page.id, req.body.generated_text)!;
      repos.sessions.touch(page.session_id);
      // O áudio narrava o texto antigo: some junto com ele (a narração nova é opcional).
      audio.discard(page.id);
      return { page: audio.decorate([updated])[0] };
    },
  );

  // --- Regeneração com truncamento (§6.2) ------------------------------------------------
  app.post<{
    Params: { id: string };
    Body: { player_instruction: string; confirm_truncate?: boolean };
  }>(
    '/api/narrative/pages/:id/regenerate',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['player_instruction'],
          additionalProperties: false,
          properties: {
            player_instruction: { type: 'string', minLength: 1, maxLength: 20000 },
            confirm_truncate: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      const page = repos.pages.get(req.params.id);
      if (!page) throw new HttpError(404, 'Página não encontrada.');
      if (page.is_archived) throw new HttpError(409, 'Páginas arquivadas não podem ser regeneradas.');
      if (page.kind === 'dialogue') {
        throw new HttpError(409, 'Páginas de diálogo não têm prompt para re-gerar. Use “Refazer diálogo” ou edite o texto.');
      }
      const session = requireSession(page.session_id);
      assertNoActiveDialogue(session.id);

      const active = repos.pages.listActive(session.id);
      const following = active.filter((b) => b.order_index > page.order_index);
      if (following.length > 0 && req.body.confirm_truncate !== true) {
        // Regra de ramificação (§6.2): a API só descarta o futuro com confirmação explícita.
        return reply.code(409).send({
          error: `Alterar esta página descartará ${following.length} ${following.length === 1 ? 'página posterior' : 'páginas posteriores'}. Confirme para continuar.`,
          code: 'truncation_required',
          pages_to_discard: following.length,
        });
      }
      turns.claim(session.id);
      const instruction = req.body.player_instruction;

      await turns.run(req, reply, {
        session,
        // O corpus de regeneração contém apenas as páginas ativas ANTERIORES a K.
        request: buildNarratorRequest({
          session,
          precedingPages: active.filter((b) => b.order_index < page.order_index),
          playerInstruction: instruction,
        }),
        // Só chega aqui depois de a IA responder com sucesso: o DELETE e o UPDATE ocorrem
        // numa única transação, então uma falha de geração nunca apaga dados (§11.5).
        persist: (result, model) => {
          const outcome = repos.transaction(() => {
            const discarded = repos.pages.deleteAfter(session.id, page.order_index);
            const updated = repos.pages.replaceGeneration(page.id, {
              player_instruction: instruction,
              generated_text: result.narrative_text,
              model_identifier: model,
            })!;
            // Páginas posteriores caem por CASCADE; esta continua (mesmo id), então o áudio
            // dela é apagado explicitamente.
            repos.audio.delete(page.id);
            const dialogue = turns.maybeCreateDialogue(session.id, result);
            repos.sessions.touch(session.id);
            return { page: updated, discarded, dialogue };
          });
          audio.cancelMany([page.id, ...following.map((p) => p.id)]);
          repos.audio.reclaim();
          return outcome;
        },
      });
    },
  );

  // --- Refazer um diálogo (não destrutivo) ------------------------------------------------------
  // Abre um novo diálogo ativo com a mesma persona. A página só é substituída (e as seguintes só são
  // descartadas) quando esse diálogo for encerrado; descartá-lo não altera nada.
  app.post<{ Params: { id: string }; Body: { confirm_truncate?: boolean } }>(
    '/api/narrative/pages/:id/redo-dialogue',
    {
      schema: {
        params: idParams,
        body: { type: 'object', additionalProperties: false, properties: { confirm_truncate: { type: 'boolean' } } },
      },
    },
    async (req, reply) => {
      const page = repos.pages.get(req.params.id);
      if (!page) throw new HttpError(404, 'Página não encontrada.');
      if (page.is_archived) throw new HttpError(409, 'Páginas arquivadas não podem ser refeitas.');
      if (page.kind !== 'dialogue') throw new HttpError(409, 'Só páginas de diálogo podem ser refeitas.');
      const session = requireSession(page.session_id);
      assertNoActiveDialogue(session.id);
      if (turns.isBusy(session.id)) {
        throw new HttpError(409, 'Já existe uma geração em andamento nesta sessão.');
      }
      const previous = repos.dialogues.getByPage(page.id);
      if (!previous) throw new HttpError(409, 'Esta página não guarda a persona do NPC; não é possível refazer o diálogo.');

      const following = repos.pages.listActive(session.id).filter((p) => p.order_index > page.order_index);
      if (following.length > 0 && req.body?.confirm_truncate !== true) {
        return reply.code(409).send({
          error: `Ao encerrar o novo diálogo, ${following.length === 1 ? 'a página posterior será descartada' : `as ${following.length} páginas posteriores serão descartadas`}. Confirme para continuar.`,
          code: 'truncation_required',
          pages_to_discard: following.length,
        });
      }
      const dialogue = repos.dialogues.create(session.id, previous.npc_name, previous.dynamic_system_prompt, {
        playerName: previous.player_name,
        redoPageId: page.id,
      });
      return reply.code(201).send({ dialogue: publicDialogue(dialogue), messages: [] });
    },
  );

  // --- Ramificar a partir daqui (§7.1) -------------------------------------------------------
  // Mantém a página K como ponto final da história, descartando K+1…N, sem chamar a IA.
  app.post<{ Params: { id: string }; Body: { confirm_truncate?: boolean } }>(
    '/api/narrative/pages/:id/branch',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { confirm_truncate: { type: 'boolean' } },
        },
      },
    },
    async (req, reply) => {
      const page = repos.pages.get(req.params.id);
      if (!page) throw new HttpError(404, 'Página não encontrada.');
      if (page.is_archived) throw new HttpError(409, 'Páginas arquivadas não podem ser ponto de ramificação.');
      const session = requireSession(page.session_id);
      assertNoActiveDialogue(session.id);
      if (turns.isBusy(session.id)) {
        throw new HttpError(409, 'Já existe uma geração em andamento nesta sessão.');
      }

      const following = repos.pages.listActive(session.id).filter((b) => b.order_index > page.order_index);
      if (following.length > 0 && req.body?.confirm_truncate !== true) {
        return reply.code(409).send({
          error: `Ramificar a partir daqui descartará ${following.length} ${following.length === 1 ? 'página posterior' : 'páginas posteriores'}. Confirme para continuar.`,
          code: 'truncation_required',
          pages_to_discard: following.length,
        });
      }
      const discarded = repos.transaction(() => {
        const n = repos.pages.deleteAfter(session.id, page.order_index);
        repos.sessions.touch(session.id);
        return n;
      });
      // Os áudios das páginas descartadas já foram para o lixo (CASCADE); falta parar os jobs.
      audio.cancelMany(following.map((p) => p.id));
      repos.audio.reclaim();
      return { discarded, last_page_id: page.id };
    },
  );
}

