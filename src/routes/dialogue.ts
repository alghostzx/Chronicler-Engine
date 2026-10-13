import type { FastifyInstance } from 'fastify';
import { buildNpcRequest, formatDialoguePage, parseNpcReply } from '../ai/dialogue.js';
import { HttpError, type AppContext } from '../context.js';
import type { DialogueSession } from '../db/types.js';
import { friendlyError } from './turnRunner.js';

/** Visão pública do diálogo: o `dynamic_system_prompt` do NPC (segredos do NPC) nunca sai do servidor. */
export function publicDialogue(d: DialogueSession) {
  return {
    id: d.id,
    session_id: d.session_id,
    npc_name: d.npc_name,
    player_name: d.player_name,
    status: d.status,
    redo_page_id: d.redo_page_id,
    created_at: d.created_at,
  };
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

  // --- Encerramento: a conversa vira uma página narrada (§3.3, §8.3) ----------------------------
  // SSE (mesmos eventos do §11.12, mais `retry`). O Narrador escreve a prosa em volta das falas, que
  // voltam literais; reprovado 3 vezes, grava a transcrição crua (`raw_dialogue`). Se este diálogo
  // estava refazendo uma página, ela é substituída e as seguintes são descartadas (só agora, não ao
  // abrir). Erro da API: nada é gravado e o diálogo continua ativo.
  app.post<{ Params: { id: string } }>(
    '/api/dialogue/:id/conclude',
    { schema: { params: idParams } },
    async (req, reply) => {
      const dialogue = requireActiveDialogue(req.params.id);
      const session = repos.sessions.get(dialogue.session_id)!;
      const messages = repos.dialogues.listMessages(dialogue.id);
      if (messages.length === 0) {
        throw new HttpError(409, 'Nenhuma fala foi trocada. Cancele o diálogo em vez de encerrá-lo.');
      }
      if (turns.isBusy(`d:${dialogue.id}`)) {
        throw new HttpError(409, 'Aguarde a resposta do NPC antes de encerrar o diálogo.');
      }
      if (turns.isBusy(session.id)) {
        throw new HttpError(409, 'Há uma operação em andamento nesta sessão.');
      }

      const rawTranscript = formatDialoguePage(dialogue, messages);
      const redo = dialogue.redo_page_id ? repos.pages.get(dialogue.redo_page_id) : undefined;
      if (dialogue.redo_page_id && (!redo || redo.is_archived || redo.kind !== 'dialogue')) {
        throw new HttpError(409, 'A página que este diálogo substituiria já não está disponível. Descarte o diálogo.');
      }
      const active = repos.pages.listActive(session.id);
      const following = redo ? active.filter((p) => p.order_index > redo.order_index) : [];
      turns.claim(session.id);

      await turns.runDialoguePage(req, reply, {
        session,
        rawTranscript,
        // No refazer, o contexto é a história antes da página que será substituída.
        precedingPages: redo ? active.filter((p) => p.order_index < redo.order_index) : active,
        fallbackToRaw: true,
        persist: (text, model, narration) => {
          const raw = narration === 'fallback';
          const outcome = repos.transaction(() => {
            let page;
            let discarded = 0;
            if (redo) {
              discarded = repos.pages.deleteAfter(session.id, redo.order_index);
              repos.dialogues.deleteByPage(redo.id);
              page = repos.pages.replaceGeneration(redo.id, { player_instruction: rawTranscript, generated_text: text, model_identifier: model, raw_dialogue: raw })!;
              repos.audio.delete(redo.id); // o áudio narrava a conversa antiga
            } else {
              page = repos.pages.append(session.id, {
                player_instruction: rawTranscript,
                generated_text: text,
                model_identifier: model,
                kind: 'dialogue',
                npc_name: dialogue.npc_name,
                raw_dialogue: raw,
              });
            }
            repos.dialogues.conclude(dialogue.id, page.id);
            repos.sessions.touch(session.id);
            return { page, discarded, narration };
          });
          if (redo) {
            ctx.audio.cancelMany([redo.id, ...following.map((p) => p.id)]);
            repos.audio.reclaim();
          }
          return outcome;
        },
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
