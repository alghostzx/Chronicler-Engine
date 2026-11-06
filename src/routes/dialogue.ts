import type { FastifyInstance } from 'fastify';
import {
  buildNpcBrainRequest,
  buildNpcRequest,
  formatDialoguePage,
  parseNpcBrainResponse,
  parseNpcReply,
} from '../ai/dialogue.js';
import { cleanSpeakerName } from '../ai/narratorSchema.js';
import { HttpError, type AppContext } from '../context.js';
import type { DialogueMessage, DialogueParticipant, DialogueSession } from '../db/types.js';
import { idParams, requireSession } from './common.js';
import { friendlyError } from './turnRunner.js';

/** Visão pública do diálogo, incluindo a lista ordenada de NPCs participantes e seus cérebros (`dynamic_system_prompt`). */
export function publicDialogue(d: DialogueSession, participants: DialogueParticipant[] = []) {
  return {
    id: d.id,
    session_id: d.session_id,
    npc_name: d.npc_name,
    player_name: d.player_name,
    status: d.status,
    redo_page_id: d.redo_page_id,
    created_at: d.created_at,
    participants,
  };
}

export function registerDialogueRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { repos, turns } = ctx;

  const requireActiveDialogue = (id: string): DialogueSession => {
    const dialogue = repos.dialogues.get(id);
    if (!dialogue) throw new HttpError(404, 'Diálogo não encontrado.');
    if (dialogue.status !== 'active') throw new HttpError(409, 'Este diálogo já foi encerrado.');
    return dialogue;
  };

  // --- Reconexão pós-reload (docs/modo-dialogo.md#ativação) ---------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/api/sessions/:id/dialogue/active',
    { schema: { params: idParams } },
    async (req) => {
      requireSession(repos, req.params.id);
      const dialogue = repos.dialogues.getActive(req.params.id);
      return {
        dialogue: dialogue ? publicDialogue(dialogue, repos.dialogues.listParticipants(dialogue.id)) : null,
        messages: dialogue ? repos.dialogues.listMessages(dialogue.id) : [],
      };
    },
  );

  // --- Troca de mensagens e rodada de turnos (docs/api.md#diálogo) --------------------------------------------------
  app.post<{ Params: { id: string }; Body: { message?: string; pass_turn?: boolean } }>(
    '/api/dialogue/:id/message',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            message: { type: 'string', maxLength: 10000 },
            pass_turn: { type: 'boolean' },
          },
        },
      },
    },
    async (req) => {
      const dialogue = requireActiveDialogue(req.params.id);
      const session = requireSession(repos, dialogue.session_id);
      const lockKey = `d:${dialogue.id}`;
      return turns.withClaim(lockKey, async () => {
        if (turns.isBusy(session.id)) {
          throw new HttpError(409, 'O diálogo está sendo encerrado.');
        }
        const gateway = ctx.gatewayProvider();
        const model = await ctx.models.resolve(session);
        const passTurn = req.body.pass_turn === true;
        const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
        if (!passTurn && message.length === 0) {
          throw new HttpError(400, 'A mensagem não pode ser vazia.');
        }

        // Histórico isolado: apenas as falas desta cena (sem corpus nem prompts do Narrador).
        const history = repos.dialogues.listMessages(dialogue.id);
        const participants = repos.dialogues.listParticipants(dialogue.id);
        const effectiveParticipants =
          participants.length > 0
            ? participants
            : [
                {
                  id: `${dialogue.id}-p1`,
                  dialogue_session_id: dialogue.id,
                  order_index: 1,
                  npc_name: dialogue.npc_name,
                  dynamic_system_prompt: dialogue.dynamic_system_prompt,
                  created_at: dialogue.created_at,
                },
              ];

        try {
          if (effectiveParticipants.length === 1 && !passTurn) {
            const p = effectiveParticipants[0]!;
            const generateReq = buildNpcRequest({
              model,
              dialogue: {
                npc_name: p.npc_name,
                dynamic_system_prompt: p.dynamic_system_prompt,
                player_name: dialogue.player_name,
              },
              messages: history,
              playerMessage: message,
            });
            let raw = '';
            for await (const fragment of gateway.streamGenerate(generateReq)) raw += fragment;
            const npc = parseNpcReply(raw);
            const saved = repos.transaction(() => {
              const playerMsg = repos.dialogues.addMessage(dialogue.id, 'player', message);
              const npcMsg = repos.dialogues.addMessage(dialogue.id, 'npc', npc.reply, p.npc_name);
              return {
                player_message: playerMsg,
                npc_message: npcMsg,
                npc_messages: [npcMsg],
              };
            });
            return { ...saved, npc_wants_to_end: npc.end_conversation };
          }

          // Rodada sequencial (multi-NPC ou quando o jogador passa a vez).
          const allNames = effectiveParticipants.map((p) => p.npc_name);
          const roundMessages: (Pick<DialogueMessage, 'sender' | 'content'> &
            Partial<Pick<DialogueMessage, 'speaker_name'>>)[] = [...history];
          if (!passTurn) {
            roundMessages.push({ sender: 'player', content: message, speaker_name: null });
          }

          const pendingReplies: { speaker_name: string; content: string; end_conversation: boolean }[] = [];
          for (let i = 0; i < effectiveParticipants.length; i++) {
            const p = effectiveParticipants[i]!;
            const isLast = i === effectiveParticipants.length - 1;
            // Garante que ao menos um NPC fale na rodada: o último só pode pular se alguém já falou.
            const allowPassTurn = effectiveParticipants.length > 1 && !(isLast && pendingReplies.length === 0);
            const generateReq = buildNpcRequest({
              model,
              dialogue,
              messages: roundMessages,
              passTurn: passTurn && pendingReplies.length === 0,
              participant: p,
              otherParticipants: allNames,
              allowPassTurn,
            });
            let raw = '';
            for await (const fragment of gateway.streamGenerate(generateReq)) raw += fragment;
            const npc = parseNpcReply(raw, { allowPassTurn });
            if (npc.pass_turn) continue;
            pendingReplies.push({
              speaker_name: p.npc_name,
              content: npc.reply,
              end_conversation: npc.end_conversation,
            });
            roundMessages.push({
              sender: 'npc',
              content: npc.reply,
              speaker_name: p.npc_name,
            });
          }

          const saved = repos.transaction(() => {
            const playerMsg = passTurn ? null : repos.dialogues.addMessage(dialogue.id, 'player', message);
            const npcMsgs = pendingReplies.map((r) =>
              repos.dialogues.addMessage(dialogue.id, 'npc', r.content, r.speaker_name),
            );
            return {
              player_message: playerMsg,
              npc_message: npcMsgs[0] ?? null,
              npc_messages: npcMsgs,
            };
          });
          return {
            ...saved,
            npc_wants_to_end: pendingReplies.some((r) => r.end_conversation),
          };
        } catch (err) {
          if (err instanceof HttpError) throw err;
          req.log.error({ err }, 'Falha na resposta do NPC');
          throw new HttpError(
            502,
            friendlyError(err).replace(
              'narrativa',
              effectiveParticipants.length > 1 ? 'resposta dos personagens' : 'resposta do NPC',
            ),
          );
        }
      }, repos.dialogues.listParticipants(dialogue.id).length > 1 ? 'Aguarde a resposta anterior dos personagens.' : 'Aguarde a resposta anterior do NPC.');
    },
  );

  // --- Gerenciamento de participantes e cérebros no diálogo ativo ---------------------------------------------------
  app.post<{ Params: { id: string }; Body: { npc_name: string; dynamic_system_prompt: string } }>(
    '/api/dialogue/:id/participants',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['npc_name', 'dynamic_system_prompt'],
          additionalProperties: false,
          properties: {
            npc_name: { type: 'string', minLength: 1, maxLength: 120 },
            dynamic_system_prompt: { type: 'string', minLength: 1, maxLength: 20000 },
          },
        },
      },
    },
    async (req, reply) => {
      const dialogue = requireActiveDialogue(req.params.id);
      if (turns.isBusy(dialogue.session_id) || turns.isBusy(`d:${dialogue.id}`)) {
        throw new HttpError(409, 'Aguarde a resposta em andamento antes de alterar os participantes.');
      }
      const npcName = cleanSpeakerName(req.body.npc_name);
      const prompt = req.body.dynamic_system_prompt.trim();
      if (!npcName || prompt.length === 0) {
        throw new HttpError(400, 'Informe o nome e o cérebro (persona) do personagem.');
      }
      const participant = repos.dialogues.addParticipant(dialogue.id, npcName, prompt);
      const updated = repos.dialogues.get(dialogue.id)!;
      return reply.code(201).send({
        participant,
        dialogue: publicDialogue(updated, repos.dialogues.listParticipants(dialogue.id)),
      });
    },
  );

  app.put<{
    Params: { id: string; participantId: string };
    Body: { npc_name?: string; dynamic_system_prompt?: string };
  }>(
    '/api/dialogue/:id/participants/:participantId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id', 'participantId'],
          properties: {
            id: { type: 'string', minLength: 1 },
            participantId: { type: 'string', minLength: 1 },
          },
        },
        body: {
          type: 'object',
          minProperties: 1,
          additionalProperties: false,
          properties: {
            npc_name: { type: 'string', minLength: 1, maxLength: 120 },
            dynamic_system_prompt: { type: 'string', minLength: 1, maxLength: 20000 },
          },
        },
      },
    },
    async (req) => {
      const dialogue = requireActiveDialogue(req.params.id);
      if (turns.isBusy(dialogue.session_id) || turns.isBusy(`d:${dialogue.id}`)) {
        throw new HttpError(409, 'Aguarde a resposta em andamento antes de alterar o personagem.');
      }
      const existing = repos.dialogues.getParticipant(req.params.participantId);
      if (!existing || existing.dialogue_session_id !== dialogue.id) {
        throw new HttpError(404, 'Participante não encontrado neste diálogo.');
      }
      const patch: { npc_name?: string; dynamic_system_prompt?: string } = {};
      if (req.body.npc_name !== undefined) {
        const cleaned = cleanSpeakerName(req.body.npc_name);
        if (!cleaned) throw new HttpError(400, 'O nome do personagem não pode ser vazio.');
        patch.npc_name = cleaned;
      }
      if (req.body.dynamic_system_prompt !== undefined) {
        const trimmed = req.body.dynamic_system_prompt.trim();
        if (trimmed.length === 0) throw new HttpError(400, 'O cérebro do personagem não pode ser vazio.');
        patch.dynamic_system_prompt = trimmed;
      }
      const participant = repos.dialogues.updateParticipant(existing.id, patch)!;
      const updated = repos.dialogues.get(dialogue.id)!;
      return {
        participant,
        dialogue: publicDialogue(updated, repos.dialogues.listParticipants(dialogue.id)),
        messages: repos.dialogues.listMessages(dialogue.id),
      };
    },
  );

  app.delete<{ Params: { id: string; participantId: string } }>(
    '/api/dialogue/:id/participants/:participantId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id', 'participantId'],
          properties: {
            id: { type: 'string', minLength: 1 },
            participantId: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (req) => {
      const dialogue = requireActiveDialogue(req.params.id);
      if (turns.isBusy(dialogue.session_id) || turns.isBusy(`d:${dialogue.id}`)) {
        throw new HttpError(409, 'Aguarde a resposta em andamento antes de remover um participante.');
      }
      const existing = repos.dialogues.getParticipant(req.params.participantId);
      if (!existing || existing.dialogue_session_id !== dialogue.id) {
        throw new HttpError(404, 'Participante não encontrado neste diálogo.');
      }
      const all = repos.dialogues.listParticipants(dialogue.id);
      if (all.length <= 1) {
        throw new HttpError(409, 'O diálogo precisa manter ao menos um personagem participante.');
      }
      repos.dialogues.removeParticipant(existing.id);
      const updated = repos.dialogues.get(dialogue.id)!;
      return {
        dialogue: publicDialogue(updated, repos.dialogues.listParticipants(dialogue.id)),
      };
    },
  );

  app.post<{ Params: { id: string }; Body: { npc_name: string; hint?: string } }>(
    '/api/dialogue/:id/participants/generate-brain',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['npc_name'],
          additionalProperties: false,
          properties: {
            npc_name: { type: 'string', minLength: 1, maxLength: 120 },
            hint: { type: 'string', maxLength: 4000 },
          },
        },
      },
    },
    async (req) => {
      const dialogue = requireActiveDialogue(req.params.id);
      const session = requireSession(repos, dialogue.session_id);
      const npcName = cleanSpeakerName(req.body.npc_name);
      if (!npcName) throw new HttpError(400, 'Informe o nome do personagem para gerar o cérebro.');
      const gateway = ctx.gatewayProvider();
      const model = await ctx.models.resolve(session);
      const activePages = repos.pages.listActive(session.id);
      const redo = dialogue.redo_page_id ? repos.pages.get(dialogue.redo_page_id) : undefined;
      const precedingPages = redo ? activePages.filter((p) => p.order_index < redo.order_index) : activePages;
      const generateReq = buildNpcBrainRequest({
        model,
        session,
        precedingPages,
        dialogue,
        participants: repos.dialogues.listParticipants(dialogue.id),
        messages: repos.dialogues.listMessages(dialogue.id),
        npcName,
        hint: req.body.hint,
      });
      let raw = '';
      try {
        for await (const fragment of gateway.streamGenerate(generateReq)) raw += fragment;
        const dynamic_system_prompt = parseNpcBrainResponse(raw);
        return { dynamic_system_prompt };
      } catch (err) {
        if (err instanceof HttpError) throw err;
        req.log.error({ err }, 'Falha ao gerar o cérebro do NPC');
        throw new HttpError(502, friendlyError(err).replace('narrativa', 'persona do NPC'));
      }
    },
  );

  // --- Encerramento: a conversa vira uma página narrada (docs/modo-dialogo.md#encerrar-a-conversa-vira-uma-página-narrada) ----------------------------
  // SSE (mesmos eventos de docs/arquitetura.md#eventos-sse, mais `retry`). O Narrador escreve a prosa em volta das falas, que
  // voltam literais; reprovado 3 vezes, grava a transcrição crua (`raw_dialogue`). Se este diálogo
  // estava refazendo uma página, ela é substituída e as seguintes são descartadas (só agora, não ao
  // abrir). Erro da API: nada é gravado e o diálogo continua ativo.
  app.post<{ Params: { id: string } }>(
    '/api/dialogue/:id/conclude',
    { schema: { params: idParams } },
    async (req, reply) => {
      const dialogue = requireActiveDialogue(req.params.id);
      const session = requireSession(repos, dialogue.session_id);
      const messages = repos.dialogues.listMessages(dialogue.id);
      if (messages.length === 0) {
        throw new HttpError(409, 'Nenhuma fala foi trocada. Cancele o diálogo em vez de encerrá-lo.');
      }
      if (turns.isBusy(`d:${dialogue.id}`)) {
        const multi = repos.dialogues.listParticipants(dialogue.id).length > 1;
        throw new HttpError(
          409,
          multi
            ? 'Aguarde a resposta dos personagens antes de encerrar o diálogo.'
            : 'Aguarde a resposta do NPC antes de encerrar o diálogo.',
        );
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
      await turns.withClaim(session.id, async () => {
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
                page = repos.pages.replaceGeneration(redo.id, {
                  player_instruction: rawTranscript,
                  generated_text: text,
                  model_identifier: model,
                  raw_dialogue: raw,
                  npc_name: dialogue.npc_name,
                })!;
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
