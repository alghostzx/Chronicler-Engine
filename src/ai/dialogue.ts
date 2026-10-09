import type { NarratorRequestParts } from './contextBuilder.js';
import { buildCorpus, buildStoryPrefix } from './contextBuilder.js';
import type { ChatTurn, GenerateRequest } from './gateway.js';
import type { DialogueMessage, DialogueSession, NarrativeBlock, Session } from '../db/types.js';

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

export function buildNpcSystemInstruction(dynamicSystemPrompt: string): string {
  return dynamicSystemPrompt.trim() + NPC_GUARD_RULES;
}

/** Histórico isolado da cena (apenas as falas deste diálogo) em turnos user/model. */
export function toChatHistory(messages: Pick<DialogueMessage, 'sender' | 'content'>[]): ChatTurn[] {
  return messages.map((m) => ({ role: m.sender === 'player' ? 'user' : 'model', text: m.content }));
}

export function buildNpcRequest(input: {
  model: string;
  dialogue: Pick<DialogueSession, 'dynamic_system_prompt'>;
  messages: Pick<DialogueMessage, 'sender' | 'content'>[];
  playerMessage: string;
}): GenerateRequest {
  return {
    model: input.model,
    systemInstruction: buildNpcSystemInstruction(input.dialogue.dynamic_system_prompt),
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

/** Transcrição literal da conversa ("Protagonista: ..." / "<NPC>: ..."). */
export function formatTranscript(npcName: string, messages: Pick<DialogueMessage, 'sender' | 'content'>[]): string {
  return messages.map((m) => `${m.sender === 'player' ? 'Protagonista' : npcName}: ${m.content}`).join('\n');
}

/**
 * Turno de Costura (§3.3): o Narrador consome o corpus + a transcrição do diálogo e a
 * transforma em prosa. Usa o mesmo pipeline do §2.1 (regras, mundo, corpus), com a
 * transcrição no lugar do input do jogador.
 */
export function buildBridgeRequest(input: {
  session: Pick<Session, 'system_rules' | 'world_context'>;
  precedingBlocks: Pick<NarrativeBlock, 'generated_text' | 'order_index'>[];
  npcName: string;
  messages: Pick<DialogueMessage, 'sender' | 'content'>[];
}): NarratorRequestParts {
  const prefix = buildStoryPrefix(input.session, buildCorpus(input.precedingBlocks));
  const transcript = formatTranscript(input.npcName, input.messages);
  return {
    systemInstruction: input.session.system_rules,
    userText:
      `${prefix}\n\n# DIÁLOGO CONCLUÍDO\n` +
      `A cena de diálogo entre o protagonista e ${input.npcName} se encerrou. ` +
      `A transcrição literal da conversa segue abaixo:\n\n${transcript}\n\n` +
      `Escreva agora o bloco narrativo subsequente em prosa, incorporando os acontecimentos, ` +
      `a linguagem corporal dos interlocutores, o ambiente ao redor e a resolução dramática da conversa.`,
  };
}

/**
 * Texto guardado em `player_instruction` do bloco de costura: a "origem" do bloco é a
 * própria conversa (útil para auditoria e para regenerar a cena).
 */
export function bridgeInstruction(npcName: string, messages: Pick<DialogueMessage, 'sender' | 'content'>[]): string {
  return `[Diálogo com ${npcName}]\n${formatTranscript(npcName, messages)}`;
}
