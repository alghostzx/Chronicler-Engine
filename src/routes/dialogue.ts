import type { FastifyInstance } from 'fastify';
import { buildBridgeRequest, bridgeInstruction, buildNpcRequest, parseNpcReply } from '../ai/dialogue.js';
import { HttpError, type AppContext } from '../context.js';
import type { DialogueSession } from '../db/types.js';
import { friendlyError } from './turnRunner.js';

/** Visão pública do diálogo: o `dynamic_system_prompt` do NPC (segredos do NPC) nunca sai do servidor. */
export function publicDialogue(d: DialogueSession) {
  return { id: d.id, session_id: d.session_id, npc_name: d.npc_name, status: d.status, created_at: d.created_at };
}

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1 } },
};

export function registerDialogueRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { repos, turns } = ctx;

  const requireActiveDialogue = (id: string): DialogueSession => {
    const dialogue = repos.dialogues.get(id);
    if (!dialogue) throw new HttpError(404, 'Diálogo não encontrado.');
    if (dialogue.status !== 'active') throw new HttpError(409, 'Este diálogo já foi encerrado.');
    return dialogue;
  };

  // --- Reconexão pós-reload (§11.6) ---------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/api/sessions/:id/dialogue/active',
    { schema: { params: idParams } },
    async (req) => {
      if (!repos.sessions.get(req.params.id)) throw new HttpError(404, 'Sessão não encontrada.');
      const dialogue = repos.dialogues.getActive(req.params.id);
      return {
        dialogue: dialogue ? publicDialogue(dialogue) : null,
        messages: dialogue ? repos.dialogues.listMessages(dialogue.id) : [],
      };
    },
  );

  // --- Troca de mensagens (§8.3) ----------------------------------------------------------------
  app.post<{ Params: { id: string }; Body: { message: string } }>(
    '/api/dialogue/:id/message',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['message'],
          additionalProperties: false,
          properties: { message: { type: 'string', minLength: 1, maxLength: 10000 } },
        },
      },
    },
    async (req) => {
      const dialogue = requireActiveDialogue(req.params.id);
      const session = repos.sessions.get(dialogue.session_id)!;
      const lockKey = `d:${dialogue.id}`;
      turns.claim(lockKey, 'Aguarde a resposta anterior do NPC.');
      try {
        if (turns.isBusy(session.id)) {
          throw new HttpError(409, 'O diálogo está sendo encerrado.');
        }
        const gateway = ctx.gatewayProvider();
        const model = await ctx.models.resolve(session);
        const message = req.body.message.trim();
        if (message.length === 0) throw new HttpError(400, 'A mensagem não pode ser vazia.');

        // Histórico isolado: apenas as falas desta cena (sem corpus nem prompts do Narrador).
        const history = repos.dialogues.listMessages(dialogue.id);
        const generateReq = buildNpcRequest({ model, dialogue, messages: history, playerMessage: message });

        let raw = '';
        try {
          for await (const fragment of gateway.streamGenerate(generateReq)) raw += fragment;
          const npc = parseNpcReply(raw);
          // Jogador e NPC só são gravados juntos, após o sucesso: o histórico sempre alterna.
          const saved = repos.transaction(() => ({
            player_message: repos.dialogues.addMessage(dialogue.id, 'player', message),
            npc_message: repos.dialogues.addMessage(dialogue.id, 'npc', npc.reply),
          }));
          return { ...saved, npc_wants_to_end: npc.end_conversation };
        } catch (err) {
          if (err instanceof HttpError) throw err;
          req.log.error({ err }, 'Falha na resposta do NPC');
          throw new HttpError(502, friendlyError(err).replace('narrativa', 'resposta do NPC'));
        }
      } finally {
        turns.release(lockKey);
      }
    },
  );

  // --- Fechamento e costura em prosa (§3.3, §8.3) ---------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/api/dialogue/:id/conclude',
    { schema: { params: idParams } },
    async (req, reply) => {
      const dialogue = requireActiveDialogue(req.params.id);
      const session = repos.sessions.get(dialogue.session_id)!;
      const messages = repos.dialogues.listMessages(dialogue.id);
      if (messages.length === 0) {
        throw new HttpError(409, 'Nenhuma fala foi trocada. Cancele o diálogo em vez de narrá-lo.');
      }
      if (turns.isBusy(`d:${dialogue.id}`)) {
        throw new HttpError(409, 'Aguarde a resposta do NPC antes de encerrar o diálogo.');
      }
      turns.claim(session.id);

      await turns.run(req, reply, {
        session,
        request: buildBridgeRequest({
          session,
          precedingBlocks: repos.blocks.listActive(session.id),
          npcName: dialogue.npc_name,
          messages,
        }),
        // O bloco de costura é o ÚNICO ponto em que o diálogo altera a história (checklist §10 nº 5).
        persist: (result, model) =>
          repos.transaction(() => {
            const block = repos.blocks.append(session.id, {
              player_instruction: bridgeInstruction(dialogue.npc_name, messages),
              generated_text: result.narrative_text,
              model_identifier: model,
            });
            repos.dialogues.conclude(dialogue.id);
            // O Narrador pode encadear outro diálogo; a sub-sessão anterior já está concluída.
            const next = turns.maybeCreateDialogue(session.id, result);
            repos.sessions.touch(session.id);
            return { block, discarded: 0, dialogue: next };
          }),
      });
    },
  );

  // --- Cancelamento (extensão do design: evita diálogo "preso" por gatilho indesejado) ----------
  app.post<{ Params: { id: string } }>(
    '/api/dialogue/:id/cancel',
    { schema: { params: idParams } },
    async (req, reply) => {
      const dialogue = requireActiveDialogue(req.params.id);
      if (turns.isBusy(dialogue.session_id) || turns.isBusy(`d:${dialogue.id}`)) {
        throw new HttpError(409, 'Há uma operação em andamento neste diálogo.');
      }
      repos.dialogues.delete(dialogue.id);
      return reply.code(204).send();
    },
  );
}
