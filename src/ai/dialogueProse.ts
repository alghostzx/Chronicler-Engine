import type { NarratorRequestParts } from './contextBuilder.js';
import { buildCorpus, buildStoryPrefix } from './contextBuilder.js';
import type { Page, Session } from '../db/types.js';

/**
 * Diálogo narrado: o Narrador escreve a página em prosa em volta das falas, que ficam **literais**.
 * Este módulo tem a leitura da transcrição crua (`**Nome:** fala`), o pedido ao Narrador e a
 * verificação de fidelidade que decide se o texto devolvido pode ser gravado.
 */

/** Tentativas ao Narrador antes de desistir (encerrar grava a transcrição crua; narrar depois só avisa). */
export const MAX_NARRATION_ATTEMPTS = 3;

export interface DialogueLine {
  /** Quem fala (`**Nome:**`); null se o parágrafo não tem rótulo (texto editado à mão). */
  speaker: string | null;
  speech: string;
}

const LABEL = /^\*\*(.{1,80}?):\*\*\s*([\s\S]*)$/;

/** Lê a transcrição crua: um parágrafo por fala, com o rótulo em negrito. Parágrafo sem rótulo = só fala. */
export function parseDialoguePage(text: string): DialogueLine[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => {
      const m = LABEL.exec(p);
      return m ? { speaker: m[1]!.trim(), speech: m[2]!.trim() } : { speaker: null, speech: p };
    })
    .filter((l) => l.speech.length > 0);
}

/** Palavras comparáveis: sem caixa, acentos nem pontuação (travessões e vírgulas das marcações não contam). */
export function speechWords(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);
}

/** Quantas vezes uma fala pode ser interrompida por marcações/gestos (cada interrupção é um "salto"). */
const MAX_JUMPS_PER_LINE = 3;

export interface FidelityResult {
  ok: boolean;
  /** Palavras de fala que não foram encontradas, na ordem (para orientar a próxima tentativa). */
  missing: string[];
}

/**
 * Confere que cada fala da transcrição aparece na prosa com as mesmas palavras, na mesma ordem. A prosa
 * pode partir uma fala ao meio (até `MAX_JUMPS_PER_LINE` interrupções) e acrescentar narração entre elas;
 * trocar, omitir ou reordenar palavras de uma fala reprova. Pontuação, caixa e acentos são ignorados.
 */
export function checkDialogueFidelity(rawTranscript: string, prose: string): FidelityResult {
  const hay = speechWords(prose);
  const missing: string[] = [];
  let from = 0; // posição inicial da busca: as falas aparecem na ordem da conversa
  for (const line of parseDialoguePage(rawTranscript)) {
    const words = speechWords(line.speech);
    let prev = -1;
    let jumps = 0;
    for (let i = 0; i < words.length; i++) {
      const w = words[i]!;
      if (prev >= 0 && hay[prev + 1] === w) {
        prev++;
        continue;
      }
      // Salto: prefere a ocorrência seguida da próxima palavra da fala (evita casar com a marcação).
      const start = prev >= 0 ? prev + 1 : from;
      const next = words[i + 1];
      let found = -1;
      let fallback = -1;
      for (let j = start; j < hay.length; j++) {
        if (hay[j] !== w) continue;
        if (fallback < 0) fallback = j;
        if (next === undefined || hay[j + 1] === next) {
          found = j;
          break;
        }
      }
      if (found < 0) found = fallback;
      if (found < 0 || (prev >= 0 && ++jumps > MAX_JUMPS_PER_LINE)) {
        missing.push(w);
        continue;
      }
      prev = found;
    }
    if (prev >= 0) from = prev + 1;
  }
  return { ok: missing.length === 0, missing };
}

const INSTRUCTION = `Escreva agora a PÁGINA NARRATIVA que registra essa cena, em prosa literária no estilo definido para a história.

REGRAS DESTA PÁGINA:
1. Preserve TODAS as falas EXATAMENTE como estão, palavra por palavra e na mesma ordem, em discurso direto, introduzidas por travessão (—). Não resuma, não reescreva, não omita nem acrescente palavras dentro das falas.
2. Entre e ao redor das falas, acrescente apenas preenchimento narrativo: gestos, olhares, ambiente, tom de voz e pausas. Você pode partir uma fala ao meio para inserir uma marcação (ex.: — Lhe ofereço a cura, — disse ele, com malícia — apenas ao custo...), sem mudar as palavras dela.
3. Cada fala fica em seu próprio parágrafo (com as marcações e gestos do próprio falante); a narração solta fica em parágrafos próprios e curtos.
4. NÃO use os rótulos "Nome:" nem negrito: quem fala é identificado pela narração.
5. NÃO avance a história além do que a conversa mostra e NÃO invente falas novas.`;

/**
 * Pedido de narração de um diálogo: mesmo pipeline do §2.1 (regras, mundo, corpus anterior), com a
 * transcrição no lugar da ação do jogador. `previousMissing` (de uma tentativa reprovada) vira um aviso.
 */
export function buildDialoguePageRequest(input: {
  session: Pick<Session, 'system_rules' | 'world_context'>;
  /** Páginas ativas ANTERIORES à página do diálogo (as seguintes não entram no contexto). */
  precedingPages: Pick<Page, 'generated_text' | 'order_index'>[];
  rawTranscript: string;
  previousMissing?: string[];
}): NarratorRequestParts {
  const prefix = buildStoryPrefix(input.session, buildCorpus(input.precedingPages));
  const retry =
    input.previousMissing && input.previousMissing.length > 0
      ? `\n\nATENÇÃO: a tentativa anterior alterou ou omitiu palavras das falas (por exemplo: ${input.previousMissing
          .slice(0, 8)
          .join(', ')}). Copie cada fala exatamente como aparece na transcrição.`
      : '';
  return {
    systemInstruction: input.session.system_rules,
    userText:
      `${prefix}\n\n# DIÁLOGO CONCLUÍDO\n` +
      `A cena de diálogo abaixo acabou de acontecer. Transcrição literal (um parágrafo por fala):\n\n${input.rawTranscript.trim()}\n\n` +
      `${INSTRUCTION}${retry}`,
  };
}
