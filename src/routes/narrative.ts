import type { FastifyInstance } from 'fastify';
import { buildNarratorRequest } from '../ai/contextBuilder.js';
import { HttpError, type AppContext } from '../context.js';
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
  const { repos, turns } = ctx;

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

  // --- Próximo bloco -------------------------------------------------------------------
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
          precedingBlocks: repos.blocks.listActive(session.id),
          playerInstruction: instruction,
        }),
        persist: (result, model) =>
          repos.transaction(() => {
            const block = repos.blocks.append(session.id, {
              player_instruction: instruction,
              generated_text: result.narrative_text,
              model_identifier: model,
            });
            const dialogue = turns.maybeCreateDialogue(session.id, result);
            repos.sessions.touch(session.id);
            return { block, discarded: 0, dialogue };
          }),
      });
    },
  );

  // --- Edição direta (§6.1) --------------------------------------------------------------
  app.put<{ Params: { id: string }; Body: { generated_text: string } }>(
    '/api/narrative/blocks/:id',
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
      const block = repos.blocks.get(req.params.id);
      if (!block) throw new HttpError(404, 'Bloco não encontrado.');
      if (block.is_archived) throw new HttpError(409, 'Blocos arquivados não podem ser editados.');
      if (turns.isBusy(block.session_id)) {
        throw new HttpError(409, 'Já existe uma geração em andamento nesta sessão.');
      }
      const updated = repos.blocks.updateText(block.id, req.body.generated_text);
      repos.sessions.touch(block.session_id);
      return { block: updated };
    },
  );

  // --- Regeneração com truncamento (§6.2) ------------------------------------------------
  app.post<{
    Params: { id: string };
    Body: { player_instruction: string; confirm_truncate?: boolean };
  }>(
    '/api/narrative/blocks/:id/regenerate',
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
      const block = repos.blocks.get(req.params.id);
      if (!block) throw new HttpError(404, 'Bloco não encontrado.');
      if (block.is_archived) throw new HttpError(409, 'Blocos arquivados não podem ser regenerados.');
      const session = requireSession(block.session_id);
      assertNoActiveDialogue(session.id);

      const active = repos.blocks.listActive(session.id);
      const following = active.filter((b) => b.order_index > block.order_index);
      if (following.length > 0 && req.body.confirm_truncate !== true) {
        // Regra de ramificação (§6.2): a API só descarta o futuro com confirmação explícita.
        return reply.code(409).send({
          error: `Alterar este bloco descartará ${following.length} bloco(s) posterior(es). Confirme para continuar.`,
          code: 'truncation_required',
          blocks_to_discard: following.length,
        });
      }
      turns.claim(session.id);
      const instruction = req.body.player_instruction;

      await turns.run(req, reply, {
        session,
        // O corpus de regeneração contém apenas os blocos ativos ANTERIORES a K.
        request: buildNarratorRequest({
          session,
          precedingBlocks: active.filter((b) => b.order_index < block.order_index),
          playerInstruction: instruction,
        }),
        // Só chega aqui depois de a IA responder com sucesso: o DELETE e o UPDATE ocorrem
        // numa única transação, então uma falha de geração nunca apaga dados (§11.5).
        persist: (result, model) =>
          repos.transaction(() => {
            const discarded = repos.blocks.deleteAfter(session.id, block.order_index);
            const updated = repos.blocks.replaceGeneration(block.id, {
              player_instruction: instruction,
              generated_text: result.narrative_text,
              model_identifier: model,
            })!;
            const dialogue = turns.maybeCreateDialogue(session.id, result);
            repos.sessions.touch(session.id);
            return { block: updated, discarded, dialogue };
          }),
      });
    },
  );

  // --- Ramificar a partir daqui (§7.1) -------------------------------------------------------
  // Mantém o bloco K como ponto final da história, descartando K+1…N, sem chamar a IA.
  app.post<{ Params: { id: string }; Body: { confirm_truncate?: boolean } }>(
    '/api/narrative/blocks/:id/branch',
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
      const block = repos.blocks.get(req.params.id);
      if (!block) throw new HttpError(404, 'Bloco não encontrado.');
      if (block.is_archived) throw new HttpError(409, 'Blocos arquivados não podem ser ponto de ramificação.');
      const session = requireSession(block.session_id);
      assertNoActiveDialogue(session.id);
      if (turns.isBusy(session.id)) {
        throw new HttpError(409, 'Já existe uma geração em andamento nesta sessão.');
      }

      const following = repos.blocks.listActive(session.id).filter((b) => b.order_index > block.order_index);
      if (following.length > 0 && req.body?.confirm_truncate !== true) {
        return reply.code(409).send({
          error: `Ramificar a partir daqui descartará ${following.length} bloco(s) posterior(es). Confirme para continuar.`,
          code: 'truncation_required',
          blocks_to_discard: following.length,
        });
      }
      const discarded = repos.transaction(() => {
        const n = repos.blocks.deleteAfter(session.id, block.order_index);
        repos.sessions.touch(session.id);
        return n;
      });
      return { discarded, last_block_id: block.id };
    },
  );
}

