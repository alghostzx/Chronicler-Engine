import type { Page, Session } from '../db/types.js';
import { buildCorpus } from './contextBuilder.js';

/** Fração (por peso em tokens) das páginas mais antigas que vira crônica (docs/narrador.md#compactação-livro-de-crônicas). */
export const PAST_RATIO = 0.75;

type WeightedPage = Pick<Page, 'order_index' | 'generated_text'>;

/**
 * Peso de uma página em tokens, aproximado pelo tamanho do texto (docs/narrador.md#compactação-livro-de-crônicas). Como a divisão é
 * proporcional, a razão caracteres/token (praticamente constante) se cancela.
 */
export function pageWeight(page: Pick<Page, 'generated_text'>): number {
  return page.generated_text.length;
}

export interface CompactionSplit<T> {
  /** Corpus Passado: candidatos a virar crônica (mais antigos). */
  past: T[];
  /** Corpus Ativo: permanece intacto em prosa literal (mais recentes). */
  keep: T[];
}

/**
 * Cisão 75/25 por peso: o Corpus Passado é o maior prefixo cronológico cujo peso acumulado
 * não excede 75% do total. Garante ao menos 1 página em cada lado; retorna `null` se houver
 * menos de 2 páginas ativas (nada a compactar).
 */
export function splitForCompaction<T extends WeightedPage>(pages: T[], ratio = PAST_RATIO): CompactionSplit<T> | null {
  const sorted = [...pages].sort((a, b) => a.order_index - b.order_index);
  if (sorted.length < 2) return null;

  const total = sorted.reduce((sum, b) => sum + pageWeight(b), 0);
  const limit = total * ratio;
  let cumulative = 0;
  let cut = 0;
  for (const page of sorted) {
    cumulative += pageWeight(page);
    if (cumulative > limit) break;
    cut++;
  }
  // Pelo menos 1 página no passado e 1 no ativo.
  cut = Math.min(Math.max(cut, 1), sorted.length - 1);
  return { past: sorted.slice(0, cut), keep: sorted.slice(cut) };
}

/**
 * Divide as páginas ativas exatamente após `coveredPageEndIndex` (escolhido pelo autor).
 * Garante ao menos 1 página em cada lado; retorna `null` se a página não existir entre as ativas
 * ou se for a última página ativa (que deve permanecer no Tome).
 */
export function splitAtPage<T extends WeightedPage>(
  pages: T[],
  coveredPageEndIndex: number,
): CompactionSplit<T> | null {
  const sorted = [...pages].sort((a, b) => a.order_index - b.order_index);
  if (sorted.length < 2) return null;
  const idx = sorted.findIndex((p) => p.order_index === coveredPageEndIndex);
  if (idx < 0 || idx >= sorted.length - 1) return null;
  const cut = idx + 1;
  return { past: sorted.slice(0, cut), keep: sorted.slice(cut) };
}

export const COMPACTION_SYSTEM_PROMPT = `Você é o Arquivista Editorial de uma história colaborativa literária.
Sua tarefa é condensar um trecho já narrado numa SINOPSE FACTUAL DENSA, que substituirá o texto original na memória do Narrador.

REGRAS:
1. Registre apenas fatos presentes no texto — nunca invente, interprete além do texto nem continue a história.
2. Preserve, com precisão: eventos decisivos e sua ordem; alianças, rivalidades e mudanças de relação entre personagens; itens ganhos, perdidos ou destruídos; mortes, ferimentos e condições permanentes; mudanças de cenário e de data/hora; promessas, segredos, dívidas e objetivos em aberto; nomes próprios exatamente como aparecem.
3. Escreva em terceira pessoa, no pretérito, com frases objetivas e sem floreios literários. Pode usar parágrafos curtos ou listas de tópicos.
4. Seja o mais conciso possível sem omitir nenhum fato exigido na Regra 2: elimine descrições atmosféricas, diálogos literais e repetições, mantendo apenas o registro factual completo na menor extensão necessária.
5. Responda SOMENTE com o texto da sinopse, sem títulos, comentários ou introduções.`;

export const COMPACTION_REFINE_SYSTEM_PROMPT = `Você é o Auditor Editorial de uma história colaborativa literária.
Sua tarefa é auditar e aprimorar uma SINOPSE FACTUAL preliminar contra o texto narrado original, corrigindo erros factuais e garantindo que nenhum fato relevante tenha ficado para trás.

REGRAS:
1. Registre apenas fatos presentes no texto original — nunca invente, interprete além do texto nem continue a história.
2. Identifique e corrija quaisquer ERROS FACTUAIS da sinopse preliminar: alucinações (fatos que não ocorreram no texto), distorções de causa e efeito, trocas de quem fez ou disse o quê, inversões de ordem cronológica, estados incorretos de itens/personagens e grafias erradas de nomes próprios.
3. Identifique e incorpore fatos omitidos ou incompletos conforme as prioridades: eventos decisivos e sua ordem cronológica; alianças, rivalidades e relações entre personagens; itens ganhos, perdidos ou destruídos; mortes, ferimentos e condições permanentes; mudanças de cenário e de tempo; promessas, segredos, dívidas e objetivos em aberto; nomes próprios grafados com fidelidade absoluta.
4. Preserve as informações da sinopse preliminar que já estiverem fiéis ao texto original, integrando as correções e os detalhes que faltavam.
5. Escreva em terceira pessoa, no pretérito, com frases objetivas, sem floreios literários, em parágrafos coesos ou listas de tópicos.
6. Seja rigorosamente conciso: elimine redundâncias e rodeios para manter a sinopse densa e limpa.
7. Responda SOMENTE com o texto final da sinopse corrigida, enriquecida e integrada, sem preâmbulos, comentários, notas de revisão ou títulos.`;

/** Mensagem do usuário para o Arquivista: contexto do mundo (para grafia dos nomes) + trecho a condensar. */
export function buildCompactionRequest(input: {
  session: Pick<Session, 'world_context'>;
  past: WeightedPage[];
}): { systemInstruction: string; userText: string } {
  const world = input.session.world_context.trim() || '(sem contexto definido)';
  return {
    systemInstruction: COMPACTION_SYSTEM_PROMPT,
    userText:
      `# CONTEXTO DO MUNDO (apenas referência; não resuma esta seção)\n${world}\n\n` +
      `# TRECHO DA HISTÓRIA A SER CONDENSADO\n${buildCorpus(input.past)}\n\n` +
      `Escreva agora a sinopse factual densa do trecho acima.`,
  };
}

/** Mensagem para auditar e enriquecer uma sinopse existente contra o trecho original. */
export function buildCompactionRefineRequest(input: {
  session: Pick<Session, 'world_context'>;
  past: WeightedPage[];
  currentSummary: string;
}): { systemInstruction: string; userText: string } {
  const world = input.session.world_context.trim() || '(sem contexto definido)';
  return {
    systemInstruction: COMPACTION_REFINE_SYSTEM_PROMPT,
    userText:
      `# CONTEXTO DO MUNDO (apenas referência; não resuma esta seção)\n${world}\n\n` +
      `# TRECHO DA HISTÓRIA ORIGINAL\n${buildCorpus(input.past)}\n\n` +
      `# SINOPSE ATUAL (para auditar, corrigir e enriquecer)\n${input.currentSummary.trim()}\n\n` +
      `Audite o trecho original contra a sinopse atual. Corrija quaisquer erros factuais ou distorções, incorpore os fatos ou detalhes relevantes que ficaram para trás e responda apenas com a sinopse final corrigida, enriquecida e integrada.`,
  };
}

/** Anexa um volume ao `world_context` sob o cabeçalho `## Crônica — Volume N` (docs/narrador.md#compactação-livro-de-crônicas). */
export function appendChronicle(worldContext: string, volumeNumber: number, summary: string): string {
  const entry = `## Crônica — Volume ${volumeNumber}\n${summary.trim()}`;
  return worldContext.trim() ? `${worldContext.trimEnd()}\n\n${entry}` : entry;
}
