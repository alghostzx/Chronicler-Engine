import { formatParticipantsNames } from '../db/repositories/dialogues.js';

/** Esquema de saída estruturada do Narrador (docs/narrador.md#saída-estruturada). */
export const NARRATOR_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    narrative_text: {
      type: 'string',
      description: 'A expansão literária em prosa do turno atual.',
    },
    dialogue_trigger: {
      type: 'object',
      properties: {
        activate: { type: 'boolean' },
        npc_name: { type: 'string' },
        player_name: {
          type: 'string',
          description:
            'Como o protagonista (o jogador) é chamado nesta conversa: o nome próprio do personagem, ou um título/apelido curto se ainda não tiver nome (ex.: "Kira", "o forasteiro"). Aparece como rótulo das falas do jogador.',
        },
        dynamic_system_prompt: {
          type: 'string',
          description:
            'Prompt completo de interpretação do NPC com persona, segredos, humor, relação com o jogador e objetivo de conversa.',
        },
        participants: {
          type: 'array',
          description:
            'Se mais de um NPC participar da conversa na cena, liste todos os personagens participantes em ordem de turno com seu npc_name e dynamic_system_prompt individual.',
          items: {
            type: 'object',
            properties: {
              npc_name: { type: 'string' },
              dynamic_system_prompt: {
                type: 'string',
                description:
                  'Prompt completo de interpretação deste NPC com persona, segredos, humor, relação com o jogador e com os demais presentes.',
              },
            },
            required: ['npc_name', 'dynamic_system_prompt'],
          },
        },
      },
      required: ['activate'],
    },
  },
  required: ['narrative_text', 'dialogue_trigger'],
  // O texto narrativo precisa vir primeiro para o streaming incremental começar de imediato.
  propertyOrdering: ['narrative_text', 'dialogue_trigger'],
} as const;

export interface DialogueParticipantBrief {
  npc_name: string;
  dynamic_system_prompt: string;
}

export interface DialogueTrigger {
  activate: boolean;
  npc_name?: string;
  /** Nome do protagonista na conversa (opcional: sem ele, o rótulo é "Protagonista"). */
  player_name?: string;
  dynamic_system_prompt?: string;
  /** Lista de NPCs participantes quando informada pelo Narrador. */
  participants?: DialogueParticipantBrief[];
}

export interface NarratorResult {
  narrative_text: string;
  /** Sempre normalizado: `activate: true` só se `npc_name` e `dynamic_system_prompt` vierem preenchidos. */
  dialogue_trigger: DialogueTrigger;
}

export class NarratorResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NarratorResponseError';
  }
}

/** Valida e normaliza o JSON final devolvido pelo Narrador. */
export function parseNarratorResult(raw: string): NarratorResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new NarratorResponseError('O Narrador devolveu uma resposta que não é um JSON válido.');
  }
  if (typeof data !== 'object' || data === null) {
    throw new NarratorResponseError('A resposta do Narrador não é um objeto JSON.');
  }
  const obj = data as Record<string, unknown>;
  const narrative = obj.narrative_text;
  if (typeof narrative !== 'string' || narrative.trim().length === 0) {
    throw new NarratorResponseError('O Narrador não devolveu texto narrativo.');
  }

  const trigger = obj.dialogue_trigger as Record<string, unknown> | undefined;
  const parsedParticipants: DialogueParticipantBrief[] = [];
  if (Array.isArray(trigger?.participants)) {
    for (const item of trigger.participants) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const pName = cleanSpeakerName(rec.npc_name);
      const pPrompt = typeof rec.dynamic_system_prompt === 'string' ? rec.dynamic_system_prompt.trim() : '';
      if (pName && pPrompt.length > 0) {
        parsedParticipants.push({ npc_name: pName, dynamic_system_prompt: pPrompt });
      }
    }
  }
  const singleName = typeof trigger?.npc_name === 'string' ? trigger.npc_name.trim() : '';
  const singlePrompt = typeof trigger?.dynamic_system_prompt === 'string' ? trigger.dynamic_system_prompt.trim() : '';
  const hasParticipants = parsedParticipants.length > 0;
  const name = hasParticipants ? formatParticipantsNames(parsedParticipants.map((p) => p.npc_name)) : singleName;
  const prompt = hasParticipants ? parsedParticipants[0]!.dynamic_system_prompt : singlePrompt;
  const activate = trigger?.activate === true && name.length > 0 && prompt.length > 0;
  const playerName = cleanSpeakerName(trigger?.player_name);

  return {
    narrative_text: narrative,
    dialogue_trigger: activate
      ? {
          activate: true,
          npc_name: name,
          ...(playerName ? { player_name: playerName } : {}),
          dynamic_system_prompt: prompt,
          ...(hasParticipants ? { participants: parsedParticipants } : {}),
        }
      : { activate: false },
  };
}

/** Rótulo de quem fala: uma linha, sem marcações de Markdown nem `:`, com no máximo 60 caracteres. */
export function cleanSpeakerName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.replace(/[*_`#>:\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60).trim();
  return name.length > 0 ? name : undefined;
}
