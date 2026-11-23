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

/**
 * Divide o conteúdo de um turno de diálogo em trechos de fala (fora de `{...}`) e ações físicas (dentro de `{...}`).
 */
export function extractSpeechSegments(text: string): string[] {
  const segments: string[] = [];
  const re = /\{([^{}]*)\}/g;
  let lastIndex = 0;
  let hasAction = false;
  for (const m of text.matchAll(re)) {
    hasAction = true;
    const before = text.slice(lastIndex, m.index).trim();
    if (before.length > 0) segments.push(before);
    lastIndex = (m.index ?? 0) + m[0].length;
  }
  if (!hasAction) {
    const trimmed = text.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }
  const rest = text.slice(lastIndex).trim();
  if (rest.length > 0) segments.push(rest);
  return segments;
}

/**
 * Lê a transcrição crua: um parágrafo por turno (`**Nome:** fala e/ou {ação}`).
 * Extrai apenas os segmentos de FALA (`speech`, fora de `{...}`) para verificação literal de fidelidade;
 * as ações `{...}` são transformadas livremente em prosa narrativa pelo Narrador.
 */
export function parseDialoguePage(text: string): DialogueLine[] {
  const lines: DialogueLine[] = [];
  for (const rawParagraph of text.split(/\n{2,}/)) {
    const p = rawParagraph.trim();
    if (p.length === 0) continue;
    const m = LABEL.exec(p);
    const speaker = m ? m[1]!.trim() : null;
    const body = m ? m[2]!.trim() : p;
    for (const seg of extractSpeechSegments(body)) {
      lines.push({ speaker, speech: seg });
    }
  }
  return lines;
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
1. Tudo o que está FORA de chaves {…} são FALAS ditas em voz alta: preserve TODAS as falas EXATAMENTE como estão, palavra por palavra e na mesma ordem, em discurso direto, introduzidas por travessão (—). Não resuma, não reescreva, não omita nem acrescente palavras dentro das falas.
2. Tudo o que está DENTRO de chaves {…} são AÇÕES FÍSICAS e gestos realizados na cena: transforme cada ação {…} em prosa narrativa literária na ordem exata em que aconteceu (sem copiar as chaves "{}" para o texto final). Você tem liberdade literária para redigir a ação em prosa, mas não deve omitir nenhuma ação realizada.
3. Entre e ao redor das falas e ações, acrescente o preenchimento narrativo necessário: gestos, olhares, ambiente, tom de voz e pausas. Você pode partir uma fala ao meio para inserir uma marcação ou a ação correspondente (ex.: — Lhe ofereço a cura, — disse ele, com malícia — apenas ao custo...), sem mudar as palavras da fala.
4. Cada fala fica em seu próprio parágrafo (com as marcações e gestos do próprio falante); a narração solta e as ações ficam em parágrafos próprios e curtos.
5. NÃO use os rótulos "Nome:", negrito nem chaves "{}" no texto final: quem fala e quem age é identificado pela própria narração.
6. NÃO avance a história além do que a conversa e as ações mostram e NÃO invente falas novas.`;

/**
 * Pedido de narração de um diálogo: mesmo pipeline de docs/narrador.md#pipeline-do-payload (regras, mundo, corpus anterior), com a
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
