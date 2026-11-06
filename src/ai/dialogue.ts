import type { ChatTurn, GenerateRequest } from './gateway.js';
import type { DialogueMessage, DialogueParticipant, DialogueSession, Page, Session } from '../db/types.js';
import { buildCorpus, buildStoryPrefix } from './contextBuilder.js';
import { cleanSpeakerName } from './narratorSchema.js';

/** Rótulo do jogador quando o Narrador não informou como o protagonista é chamado. */
export const DEFAULT_PLAYER_LABEL = 'Protagonista';

/** Esquema de resposta do NPC: a fala, o sinal de fim de conversa e a opção de passar a vez (docs/modo-dialogo.md). */
export const NPC_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    pass_turn: {
      type: 'boolean',
      description:
        'Em conversas com mais de um NPC, defina como true se o seu personagem preferir ficar em silêncio nesta rodada para não interromper uma troca direta entre outros personagens. Caso vá falar, defina como false.',
    },
    reply: {
      type: 'string',
      description: 'A resposta do NPC, em primeira pessoa, conforme a persona (vazio apenas se pass_turn = true).',
    },
    end_conversation: {
      type: 'boolean',
      description: 'true somente se a conversa chegou a um fim natural (despedida, interrupção, ruptura).',
    },
  },
  required: ['reply', 'end_conversation'],
  propertyOrdering: ['pass_turn', 'reply', 'end_conversation'],
} as const;

export const NPC_BRAIN_SCHEMA = {
  type: 'object',
  properties: {
    dynamic_system_prompt: {
      type: 'string',
      description:
        'Briefing completo de interpretação do NPC em português: quem é, personalidade, tom de voz, humor na cena atual, relação com o protagonista e com os outros presentes, objetivos imediatos e segredos.',
    },
  },
  required: ['dynamic_system_prompt'],
} as const;

export interface NpcReply {
  reply: string;
  end_conversation: boolean;
  pass_turn?: boolean;
}

export class NpcResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NpcResponseError';
  }
}

/** Regras fixas somadas ao prompt dinâmico produzido pelo Narrador (docs/modo-dialogo.md#o-npc-e-o-sigilo, "Regras Estritas"). */
const NPC_GUARD_RULES = `

REGRAS DE INTERPRETAÇÃO (sempre válidas):
- Responda sempre em primeira pessoa, como o personagem, sem sair do papel.
- Nunca narre, fale ou decida ações pelo protagonista (o jogador) nem pelos outros personagens presentes.
- Seja conciso e reativo: responda apenas ao que foi dito, em poucas frases.
- Responda exclusivamente no formato JSON especificado. Defina "end_conversation" como true apenas se a conversa chegou a um fim natural; caso contrário, false.`;

export function buildNpcSystemInstruction(
  dynamicSystemPrompt: string,
  playerName?: string | null,
  opts?: { npcName?: string; otherParticipants?: string[]; allowPassTurn?: boolean },
): string {
  const who = cleanSpeakerName(playerName ?? undefined);
  const interlocutor = who
    ? `\n- Seu interlocutor (o jogador) é chamado de "${who}" nesta cena; trate-o assim quando fizer sentido.`
    : '';
  const selfLine = opts?.npcName ? `\n- Você interpreta exclusivamente "${opts.npcName}".` : '';
  const others = (opts?.otherParticipants ?? []).filter((n) => n && n !== opts?.npcName);
  const othersLine =
    others.length > 0
      ? `\n- Outros personagens também estão presentes nesta roda de conversa: ${others.join(', ')}. As falas no histórico vêm identificadas pelo nome de quem falou; NÃO inclua o seu próprio nome como prefixo na sua resposta ("reply").`
      : '';
  const passLine = opts?.allowPassTurn
    ? `\n- Se a fala anterior foi dirigida claramente a outro personagem presente e o seu personagem não tiver nada relevante a acrescentar ou interromper agora, você pode pular sua vez definindo "pass_turn": true e "reply": "".`
    : `\n- Nesta rodada você deve responder (defina "pass_turn": false e preencha "reply").`;
  const extra = others.length > 0 || opts?.allowPassTurn ? selfLine + othersLine + passLine : '';
  return dynamicSystemPrompt.trim() + NPC_GUARD_RULES + interlocutor + extra;
}

/** Histórico isolado da cena (apenas as falas deste diálogo) em turnos user/model. */
export function toChatHistory(messages: Pick<DialogueMessage, 'sender' | 'content'>[]): ChatTurn[] {
  return messages.map((m) => ({ role: m.sender === 'player' ? 'user' : 'model', text: m.content }));
}

export function buildNpcRequest(input: {
  model: string;
  dialogue: Pick<DialogueSession, 'dynamic_system_prompt'> &
    Partial<Pick<DialogueSession, 'npc_name' | 'player_name'>>;
  messages: (Pick<DialogueMessage, 'sender' | 'content'> & Partial<Pick<DialogueMessage, 'speaker_name'>>)[];
  playerMessage?: string;
  passTurn?: boolean;
  participant?: Pick<DialogueParticipant, 'npc_name' | 'dynamic_system_prompt'>;
  otherParticipants?: string[];
  allowPassTurn?: boolean;
}): GenerateRequest {
  const npcName = input.participant?.npc_name ?? input.dialogue.npc_name;
  const prompt = input.participant?.dynamic_system_prompt ?? input.dialogue.dynamic_system_prompt;
  const others = (input.otherParticipants ?? []).filter((n) => n && n !== npcName);
  const hasMultipleSpeakers =
    others.length > 0 ||
    input.messages.some((m) => m.sender === 'npc' && m.speaker_name && npcName && m.speaker_name !== npcName);

  // Caminho clássico de 1 NPC com fala direta do jogador: preserva 100% do formato de history/userText.
  if (!hasMultipleSpeakers && input.playerMessage !== undefined && !input.passTurn && !input.allowPassTurn) {
    return {
      model: input.model,
      systemInstruction: buildNpcSystemInstruction(prompt, input.dialogue.player_name),
      history: toChatHistory(input.messages),
      userText: input.playerMessage,
      responseJsonSchema: NPC_RESPONSE_SCHEMA,
    };
  }

  const playerLabel = cleanSpeakerName(input.dialogue.player_name ?? undefined) ?? DEFAULT_PLAYER_LABEL;
  const rawTurns: ChatTurn[] = [];
  const pushTurn = (role: 'user' | 'model', text: string) => {
    const last = rawTurns.at(-1);
    if (last && last.role === role) {
      last.text = `${last.text}\n\n${text}`;
    } else {
      rawTurns.push({ role, text });
    }
  };

  for (const m of input.messages) {
    if (m.sender === 'player') {
      pushTurn('user', hasMultipleSpeakers ? `${playerLabel}: ${m.content}` : m.content);
    } else {
      const speaker = m.speaker_name ?? input.dialogue.npc_name ?? 'NPC';
      if (npcName && speaker === npcName) {
        pushTurn('model', m.content);
      } else {
        pushTurn('user', `${speaker}: ${m.content}`);
      }
    }
  }

  if (input.playerMessage !== undefined && input.playerMessage.trim().length > 0) {
    pushTurn('user', hasMultipleSpeakers ? `${playerLabel}: ${input.playerMessage}` : input.playerMessage);
  } else if (input.passTurn) {
    pushTurn('user', `[${playerLabel} permanece em silêncio e aguarda a continuação da conversa.]`);
  }

  let userText: string;
  if (rawTurns.length > 0 && rawTurns.at(-1)!.role === 'user') {
    userText = rawTurns.pop()!.text;
  } else {
    userText = `[${playerLabel} permanece em silêncio e aguarda a continuação da conversa.]`;
  }

  return {
    model: input.model,
    systemInstruction: buildNpcSystemInstruction(prompt, input.dialogue.player_name, {
      npcName,
      otherParticipants: others,
      allowPassTurn: input.allowPassTurn,
    }),
    history: rawTurns,
    userText,
    responseJsonSchema: NPC_RESPONSE_SCHEMA,
  };
}

export function parseNpcReply(raw: string, opts?: { allowPassTurn?: boolean }): NpcReply {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new NpcResponseError('O NPC devolveu uma resposta que não é um JSON válido.');
  }
  const obj = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  if (opts?.allowPassTurn && obj.pass_turn === true) {
    return {
      reply: '',
      end_conversation: obj.end_conversation === true,
      pass_turn: true,
    };
  }
  if (typeof obj.reply !== 'string' || obj.reply.trim().length === 0) {
    throw new NpcResponseError('O NPC não devolveu nenhuma fala.');
  }
  return {
    reply: obj.reply.trim(),
    end_conversation: obj.end_conversation === true,
    ...(obj.pass_turn === false ? { pass_turn: false } : {}),
  };
}

/** Monta a requisição ao Gemini para gerar ou sugerir o "cérebro" (`dynamic_system_prompt`) de um NPC na cena. */
export function buildNpcBrainRequest(input: {
  model: string;
  session: Pick<Session, 'system_rules' | 'world_context'>;
  precedingPages: Pick<Page, 'generated_text' | 'order_index'>[];
  dialogue: Pick<DialogueSession, 'npc_name' | 'player_name'>;
  participants: Pick<DialogueParticipant, 'npc_name' | 'dynamic_system_prompt'>[];
  messages: (Pick<DialogueMessage, 'sender' | 'content'> & Partial<Pick<DialogueMessage, 'speaker_name'>>)[];
  npcName: string;
  hint?: string;
}): GenerateRequest {
  const prefix = buildStoryPrefix(input.session, buildCorpus(input.precedingPages));
  const playerLabel = cleanSpeakerName(input.dialogue.player_name ?? undefined) ?? DEFAULT_PLAYER_LABEL;
  const others = input.participants.map((p) => p.npc_name).filter((n) => n !== input.npcName);
  const transcript =
    input.messages.length > 0
      ? `\n\n# FALAS DA CENA ATÉ AGORA\n${formatDialoguePage(input.dialogue, input.messages)}`
      : '';
  const hintBlock =
    input.hint && input.hint.trim().length > 0
      ? `\nDireção autoral / dica para o personagem: ${input.hint.trim()}`
      : '';
  return {
    model: input.model,
    systemInstruction:
      'Você é um assistente narrativo que redige o briefing de interpretação ("cérebro" / dynamic_system_prompt) de um personagem (NPC) para o Modo Diálogo.',
    history: [],
    userText:
      `${prefix}${transcript}\n\n# TAREFA\n` +
      `Escreva em português o "dynamic_system_prompt" (instruções de interpretação em segunda pessoa: "Você é...") para o personagem "${input.npcName}", que participa de uma conversa direta com "${playerLabel}"${
        others.length > 0 ? ` (junto com: ${others.join(', ')})` : ''
      }.${hintBlock}\n` +
      `Inclua: quem o personagem é, sua personalidade e modo de falar, seu estado emocional na cena atual, o que sabe sobre o protagonista e os eventos recentes, seus objetivos imediatos na conversa e o que oculta ou defende.`,
    responseJsonSchema: NPC_BRAIN_SCHEMA,
  };
}

export function parseNpcBrainResponse(raw: string): string {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new NpcResponseError('O modelo devolveu uma resposta que não é um JSON válido ao gerar o cérebro.');
  }
  const obj = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  if (typeof obj.dynamic_system_prompt !== 'string' || obj.dynamic_system_prompt.trim().length === 0) {
    throw new NpcResponseError('O modelo não devolveu o cérebro do personagem.');
  }
  return obj.dynamic_system_prompt.trim();
}

/**
 * Texto da página de diálogo: cada fala vira um parágrafo com o rótulo de quem fala em negrito
 * (`**Nome:** fala`). O jogador usa o nome que o Narrador deu ao protagonista (ou "Protagonista").
 * Depois de gravada, a página é a fonte da verdade (editável); o Narrador a lê no corpus como está.
 */
export function formatDialoguePage(
  dialogue: Pick<DialogueSession, 'npc_name' | 'player_name'>,
  messages: (Pick<DialogueMessage, 'sender' | 'content'> & Partial<Pick<DialogueMessage, 'speaker_name'>>)[],
): string {
  const player = cleanSpeakerName(dialogue.player_name ?? undefined) ?? DEFAULT_PLAYER_LABEL;
  const fallbackNpc = cleanSpeakerName(dialogue.npc_name) ?? dialogue.npc_name;
  return messages
    .map((m) => {
      if (m.sender === 'player') return `**${player}:** ${m.content.trim()}`;
      const speaker = cleanSpeakerName(m.speaker_name ?? undefined) ?? fallbackNpc;
      return `**${speaker}:** ${m.content.trim()}`;
    })
    .join('\n\n');
}
