import type { Page, Session } from '../db/types.js';

export interface NarratorRequestParts {
  /** Item 1 do pipeline (§2.1): regras de narração, enviadas como system instruction. */
  systemInstruction: string;
  /** Itens 2, 3 e 4: contexto do mundo, corpus narrativo e input do jogador, num único turno de usuário. */
  userText: string;
}

const WORLD_HEADER = '# CONTEXTO DO MUNDO';
const CORPUS_HEADER = '# CORPUS NARRATIVO (história até aqui)';
const INPUT_HEADER = '# AÇÃO / ESBOÇO DO JOGADOR PARA A PRÓXIMA CENA';

/**
 * Corpus narrativo: concatenação cronológica do `generated_text` das páginas informadas.
 *
 * Por desenho (§2.2), o `player_instruction` das páginas NUNCA entra aqui — o corpus é prosa
 * pura. Quem chama deve passar apenas páginas ativas e anteriores ao ponto de geração.
 */
export function buildCorpus(pages: Pick<Page, 'generated_text' | 'order_index'>[]): string {
  return [...pages]
    .sort((a, b) => a.order_index - b.order_index)
    .map((b) => b.generated_text.trim())
    .filter((t) => t.length > 0)
    .join('\n\n');
}

/** Monta o texto "estável" (mundo + corpus), prefixo comum a toda chamada da sessão. */
export function buildStoryPrefix(session: Pick<Session, 'world_context'>, corpus: string): string {
  const sections: string[] = [];
  sections.push(`${WORLD_HEADER}\n${session.world_context.trim() || '(sem contexto definido)'}`);
  sections.push(`${CORPUS_HEADER}\n${corpus || '(a história ainda não começou)'}`);
  return sections.join('\n\n');
}

/**
 * Pipeline de payload do Narrador (§2.1):
 *   1. System instruction  2. Contexto do mundo  3. Corpus consolidado  4. Input do jogador.
 *
 * Função pura e determinística: facilita testar a regra de isolamento de meta-instruções.
 */
export function buildNarratorRequest(input: {
  session: Pick<Session, 'system_rules' | 'world_context'>;
  /** Páginas ativas que precedem o ponto de geração, em qualquer ordem. */
  precedingPages: Pick<Page, 'generated_text' | 'order_index'>[];
  playerInstruction: string;
}): NarratorRequestParts {
  const prefix = buildStoryPrefix(input.session, buildCorpus(input.precedingPages));
  return {
    systemInstruction: input.session.system_rules,
    userText: `${prefix}\n\n${INPUT_HEADER}\n${input.playerInstruction.trim()}`,
  };
}
