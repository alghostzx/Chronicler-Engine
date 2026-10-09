import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { buildNarratorRequest } from '../ai/contextBuilder.js';
import { GenerationError } from '../ai/gateway.js';
import { streamNarratorTurn } from '../ai/narrator.js';
import { NarratorResponseError, type NarratorResult } from '../ai/narratorSchema.js';
import { HttpError, type AppContext } from '../context.js';
import type { DialogueSession, NarrativeBlock, Session } from '../db/types.js';
import { openSse } from './sse.js';

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

interface PersistOutcome {
  block: NarrativeBlock;
  /** Blocos posteriores descartados (apenas em regeneração intermediária). */
  discarded: number;
  dialogue?: DialogueSession;
}

function friendlyError(err: unknown): string {
  if (err instanceof GenerationError || err instanceof NarratorResponseError) return err.message;
  const message = err instanceof Error ? err.message : String(err);
  return `Falha ao gerar a narrativa: ${message.slice(0, 300)}`;
}

export function registerNarrativeRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { repos } = ctx;

  /** Sessões com geração em andamento: evita dois turnos concorrentes embaralharem a história. */
  const busy = new Set<string>();

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

  /**
   * Executa um turno do Narrador via SSE. Eventos:
   *  - `start`  {model}
   *  - `chunk`  {text}              (parse incremental de narrative_text)
   *  - `block`  {block, discarded}  (no fechamento do payload, após persistir)
   *  - `dialogue_trigger` {dialogue_id, npc_name}   (somente se o Narrador ativou diálogo)
   *  - `error`  {message}
   *  - `done`   {}
   * Nada é gravado se a geração falhar ou o cliente desconectar.
   */
  async function runTurn(
    req: FastifyRequest,
    reply: FastifyReply,
    opts: {
      session: Session;
      precedingBlocks: NarrativeBlock[];
      instruction: string;
      persist: (result: NarratorResult, model: string) => PersistOutcome;
    },
  ): Promise<void> {
    const { session } = opts;
    // A sessão já foi reservada por `claim`. Falhas antes de abrir o SSE (ex.: sem chave)
    // ainda retornam JSON normal e precisam liberar a reserva.
    let gateway;
    let model: string;
    try {
      gateway = ctx.gatewayProvider();
      model = await ctx.models.resolve(session);
    } catch (err) {
      busy.delete(session.id);
      throw err;
    }

    const sse = openSse(req, reply);
    try {
      sse.send('start', { model });
      const request = buildNarratorRequest({
        session,
        precedingBlocks: opts.precedingBlocks,
        playerInstruction: opts.instruction,
      });

      let result: NarratorResult | undefined;
      for await (const ev of streamNarratorTurn(gateway, { model, request, signal: sse.signal })) {
        if (ev.type === 'chunk') sse.send('chunk', { text: ev.text });
        else result = ev.result;
      }
      if (sse.signal.aborted || !result) return;

      const outcome = opts.persist(result, model);
      sse.send('block', { block: outcome.block, discarded: outcome.discarded });
      if (outcome.dialogue) {
        sse.send('dialogue_trigger', {
          dialogue_id: outcome.dialogue.id,
          npc_name: outcome.dialogue.npc_name,
        });
      }
      sse.send('done', {});
    } catch (err) {
      if (!sse.signal.aborted) {
        req.log.error({ err }, 'Falha na geração do turno narrativo');
        sse.send('error', { message: friendlyError(err) });
      }
    } finally {
      busy.delete(session.id);
      sse.end();
    }
  }

  /** Reserva a sessão para uma geração; falha com 409 se já houver uma em andamento. */
  const claim = (sessionId: string) => {
    if (busy.has(sessionId)) {
      throw new HttpError(409, 'Já existe uma geração em andamento nesta sessão.');
    }
    busy.add(sessionId);
  };

  const maybeCreateDialogue = (sessionId: string, result: NarratorResult): DialogueSession | undefined => {
    const t = result.dialogue_trigger;
    if (!t.activate) return undefined;
    return repos.dialogues.create(sessionId, t.npc_name!, t.dynamic_system_prompt!);
  };

  // --- Próximo bloco -------------------------------------------------------------------
  app.post<{ Params: { id: string }; Body: { player_instruction: string } }>(
    '/api/sessions/:id/narrative/next',
    { schema: { params: idParams, body: instructionBody } },
    async (req, reply) => {
      const session = requireSession(req.params.id);
      assertNoActiveDialogue(session.id);
      claim(session.id);
      const instruction = req.body.player_instruction;

      await runTurn(req, reply, {
        session,
        precedingBlocks: repos.blocks.listActive(session.id),
        instruction,
        persist: (result, model) =>
          repos.transaction(() => {
            const block = repos.blocks.append(session.id, {
              player_instruction: instruction,
              generated_text: result.narrative_text,
              model_identifier: model,
            });
            const dialogue = maybeCreateDialogue(session.id, result);
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
      if (busy.has(block.session_id)) {
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
      claim(session.id);
      const instruction = req.body.player_instruction;

      await runTurn(req, reply, {
        session,
        // O corpus de regeneração contém apenas os blocos ativos ANTERIORES a K.
        precedingBlocks: active.filter((b) => b.order_index < block.order_index),
        instruction,
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
            const dialogue = maybeCreateDialogue(session.id, result);
            repos.sessions.touch(session.id);
            return { block: updated, discarded, dialogue };
          }),
      });
    },
  );
}
