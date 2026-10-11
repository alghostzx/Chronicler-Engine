/**
 * Preparação do texto de uma página para ser lido em voz alta.
 *
 * O modelo de TTS trata o texto como transcrição literal: marcas de Markdown (`*`, `#`, `---`)
 * seriam lidas ou atrapalhariam a prosódia, então são removidas. Os parágrafos são preservados
 * (viram pausas naturais) e páginas longas são quebradas em trechos por parágrafo.
 */

/**
 * Tamanho-alvo de um trecho enviado de uma vez à API (a documentação recomenda dividir textos longos).
 * Cada trecho é uma chamada independente: o modelo recomeça a prosódia e, nas páginas de diálogo, inventa
 * de novo as vozes dos personagens e volta a ler os nomes antes das falas. Por isso o corte deve ser raro;
 * 6000 caracteres (calibrado pelo autor) deixa a maioria das páginas em uma única chamada.
 */
export const DEFAULT_CHUNK_CHARS = 6000;

export function cleanForSpeech(text: string): string {
  return (
    text
      .replace(/\r\n?/g, '\n')
      // Código e links: fica só o texto visível.
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)]\([^)]*\)/g, '$1')
      // Réguas horizontais e cabeçalhos.
      .replace(/^[ \t]*([-*_]\s*){3,}$/gm, '')
      .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
      // Marcadores de lista e citação.
      .replace(/^[ \t]*[-*+][ \t]+/gm, '')
      .replace(/^[ \t]*>[ \t]?/gm, '')
      // Ênfase (**negrito**, *itálico*, _itálico_, ~~riscado~~): fica só o conteúdo.
      .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
      .replace(/(^|[\s(“"'—-])[*_]+(?=\S)/g, '$1')
      .replace(/(?<=\S)[*_]+(?=$|[\s).,;:!?”"'—-])/g, '')
      .replace(/[*#^|\\]/g, ' ')
      // Espaços.
      .replace(/[ \t\f\v]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

function splitSentences(paragraph: string): string[] {
  return paragraph.split(/(?<=[.!?…]["”')]*)\s+/).filter((s) => s.length > 0);
}

/** Quebra `text` em pedaços de no máximo `max` caracteres, em fronteiras de espaço. */
function hardSplit(text: string, max: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * Divide o texto (já limpo) em trechos de ~`max` caracteres sem cortar parágrafos: junta parágrafos
 * inteiros enquanto couberem; um parágrafo maior que `max` é dividido por frases (e, em último
 * caso, por espaços). Os trechos mantêm `\n\n` entre os parágrafos.
 */
export function splitForSpeech(text: string, max = DEFAULT_CHUNK_CHARS): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  // Unidades atômicas: parágrafos curtos ou pedaços de parágrafos longos.
  const units: { text: string; breakBefore: boolean }[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= max) {
      units.push({ text: paragraph, breakBefore: true });
      continue;
    }
    let current = '';
    let first = true;
    const flush = () => {
      if (current) units.push({ text: current, breakBefore: first });
      first = false;
      current = '';
    };
    for (const sentence of splitSentences(paragraph)) {
      for (const piece of sentence.length > max ? hardSplit(sentence, max) : [sentence]) {
        if (current && current.length + 1 + piece.length > max) flush();
        current = current ? `${current} ${piece}` : piece;
      }
    }
    flush();
  }

  const chunks: string[] = [];
  let current = '';
  for (const unit of units) {
    const sep = unit.breakBefore ? '\n\n' : ' ';
    if (current && current.length + sep.length + unit.text.length > max) {
      chunks.push(current);
      current = unit.text;
    } else {
      current = current ? current + sep + unit.text : unit.text;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
