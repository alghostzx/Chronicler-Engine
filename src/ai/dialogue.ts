import type { ChatTurn, GenerateRequest } from './gateway.js';
import type { DialogueMessage, DialogueSession } from '../db/types.js';
import { cleanSpeakerName } from './narratorSchema.js';

/** Rótulo do jogador quando o Narrador não informou como o protagonista é chamado. */
export const DEFAULT_PLAYER_LABEL = 'Protagonista';

/** Esquema de resposta do NPC: a fala e o sinal de fim de conversa (§3.1, passo 4). */
export const NPC_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    reply: {
      type: 'string',
      description: 'A resposta do NPC, em primeira pessoa, conforme a persona.',
    },
    end_conversation: {
      type: 'boolean',
      description: 'true somente se a conversa chegou a um fim natural (despedida, interrupção, ruptura).',
    },
  },
  required: ['reply', 'end_conversation'],
  propertyOrdering: ['reply', 'end_conversation'],
} as const;

export interface NpcReply {
  reply: string;
  end_conversation: boolean;
}

export class NpcResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NpcResponseError';
  }
}

/** Regras fixas somadas ao prompt dinâmico produzido pelo Narrador (§3.2, "Regras Estritas"). */
const NPC_GUARD_RULES = `

REGRAS DE INTERPRETAÇÃO (sempre válidas):
- Responda sempre em primeira pessoa, como o personagem, sem sair do papel.
- Nunca narre, fale ou decida ações pelo protagonista (o jogador).
- Seja conciso e reativo: responda apenas ao que foi dito, em poucas frases.
- Responda exclusivamente no formato JSON especificado. Defina "end_conversation" como true apenas se a conversa chegou a um fim natural; caso contrário, false.`;

export function buildNpcSystemInstruction(dynamicSystemPrompt: string, playerName?: string | null): string {
  const who = cleanSpeakerName(playerName ?? undefined);
  const interlocutor = who ? `\n- Seu interlocutor (o jogador) é chamado de "${who}" nesta cena; trate-o assim quando fizer sentido.` : '';
  return dynamicSystemPrompt.trim() + NPC_GUARD_RULES + interlocutor;
}

/** Histórico isolado da cena (apenas as falas deste diálogo) em turnos user/model. */
export function toChatHistory(messages: Pick<DialogueMessage, 'sender' | 'content'>[]): ChatTurn[] {
  return messages.map((m) => ({ role: m.sender === 'player' ? 'user' : 'model', text: m.content }));
}

export function buildNpcRequest(input: {
  model: string;
  dialogue: Pick<DialogueSession, 'dynamic_system_prompt'> & Partial<Pick<DialogueSession, 'player_name'>>;
  messages: Pick<DialogueMessage, 'sender' | 'content'>[];
  playerMessage: string;
}): GenerateRequest {
  return {
    model: input.model,
    systemInstruction: buildNpcSystemInstruction(input.dialogue.dynamic_system_prompt, input.dialogue.player_name),
    history: toChatHistory(input.messages),
    userText: input.playerMessage,
    responseJsonSchema: NPC_RESPONSE_SCHEMA,
  };
}

export function parseNpcReply(raw: string): NpcReply {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new NpcResponseError('O NPC devolveu uma resposta que não é um JSON válido.');
  }
  const obj = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  if (typeof obj.reply !== 'string' || obj.reply.trim().length === 0) {
    throw new NpcResponseError('O NPC não devolveu nenhuma fala.');
  }
  return { reply: obj.reply.trim(), end_conversation: obj.end_conversation === true };
}

/**
 * Texto da página de diálogo: cada fala vira um parágrafo com o rótulo de quem fala em negrito
 * (`**Nome:** fala`). O jogador usa o nome que o Narrador deu ao protagonista (ou "Protagonista").
 * Depois de gravada, a página é a fonte da verdade (editável); o Narrador a lê no corpus como está.
 */
export function formatDialoguePage(
  dialogue: Pick<DialogueSession, 'npc_name' | 'player_name'>,
  messages: Pick<DialogueMessage, 'sender' | 'content'>[],
): string {
  const player = cleanSpeakerName(dialogue.player_name ?? undefined) ?? DEFAULT_PLAYER_LABEL;
  const npc = cleanSpeakerName(dialogue.npc_name) ?? dialogue.npc_name;
  return messages.map((m) => `**${m.sender === 'player' ? player : npc}:** ${m.content.trim()}`).join('\n\n');
}
