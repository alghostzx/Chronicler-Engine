# Modo Diálogo

O Modo Diálogo é uma sub-rotina transitória: o Narrador abre uma conversa com um NPC, jogador e NPC trocam falas numa sessão isolada, e ao encerrar **a conversa vira uma página** do Tome. O NPC é uma persona que não conhece o resto da história.

## Ativação

Não existe botão para "entrar em modo diálogo". O gatilho vem **só do Narrador**, no `dialogue_trigger` do turno regular (por pedido do jogador, como *"assim que encontro Elena, iniciamos um diálogo direto"*, ou por decisão do próprio Narrador). O gatilho cria um registro em `dialogue_sessions` com status `active`.

- **No máximo um diálogo ativo por sessão** (índice único parcial no banco). Enquanto houver um, `narrative/next`, `regenerate`, ramificar e compactar respondem `409`.
- O Narrador escolhe o nome do NPC (`npc_name`) e como o jogador será chamado na cena (`player_name`; sem nome, **"Protagonista"**). `cleanSpeakerName` remove marcadores de Markdown e limita o tamanho.
- Ao recarregar a página, o cliente retoma a cena por `GET /api/sessions/:id/dialogue/active`; `GET /api/sessions/:id` também traz `active_dialogue` (sem o prompt).

## O NPC e o sigilo

O `dynamic_system_prompt`, produzido pelo Narrador, define a persona: identidade e personalidade, contexto imediato, relação com o protagonista, objetivo de curto prazo e regras estritas (primeira pessoa, sem narrar ações do jogador, respostas concisas e reativas). Ele pode conter **segredos** do NPC, então **nunca** é devolvido pela API nem enviado ao Narrador depois do gatilho. Os endpoints expõem só `{ id, session_id, npc_name, player_name, redo_page_id, status, created_at }`.

`POST /api/dialogue/:id/message` `{ message }` → `{ player_message, npc_message, npc_wants_to_end }`:

- Chamada ao Gemini com o prompt dinâmico mais as regras fixas de interpretação como `systemInstruction`, e **somente** as falas da cena como histórico multi-turno (`user` = protagonista, `model` = NPC). Nem o corpus nem as meta-instruções do Narrador entram.
- A resposta é JSON estruturado `{ reply, end_conversation }`. `end_conversation` vira `npc_wants_to_end`, que a UI usa **apenas para destacar o botão** *Encerrar diálogo*: a decisão de encerrar é sempre do autor.
- As duas falas só são gravadas juntas, depois do sucesso, mantendo o histórico sempre alternado. Uma mensagem por vez por diálogo (`409` caso contrário).

## Encerrar: a conversa vira uma página narrada

`POST /api/dialogue/:id/conclude` (SSE) é **o único ponto em que um diálogo altera `narrative_pages`**.

1. O backend monta a transcrição literal, um parágrafo por fala: `**Rótulo do jogador:** fala` / `**Nome do NPC:** fala`.
2. Pede ao Narrador ([`src/ai/dialogueProse.ts`](../src/ai/dialogueProse.ts)) uma **página em prosa** que preserva **todas** as falas, palavra por palavra e na ordem, em discurso direto com travessão (uma fala pode ser partida por uma marcação), e acrescenta só o preenchimento narrativo: gestos, olhares, ambiente, tom de voz. **Sem rótulos `Nome:`**, sem avançar a história, sem falas novas. O contexto é o mesmo pipeline do [Narrador](narrador.md#pipeline-do-payload): regras como `systemInstruction`, mundo e corpus **anterior** à página. A resposta reutiliza o JSON do Narrador (a regra 4 exige JSON); um `dialogue_trigger` eventual é ignorado.
3. Uma **verificação de fidelidade** (`checkDialogueFidelity`) confere que cada fala aparece na prosa, na ordem, com as mesmas palavras (ignora caixa, acentos e pontuação; uma fala pode ser partida por até 3 interrupções). É uma **heurística de palavras e ordem**: não confere pontuação e pode não perceber palavras *acrescentadas* dentro de uma fala.
4. Se reprovar, o Narrador tenta de novo (nova tentativa com um aviso das palavras que sumiram; JSON inválido também gasta uma tentativa; a UI recebe `retry` e limpa o texto do fantasma): até `MAX_NARRATION_ATTEMPTS = 3`.
5. Esgotadas as tentativas, grava-se a **transcrição crua** como *fallback* (`raw_dialogue = 1`, `model_identifier = null`, `narration: 'fallback'`) e a UI avisa. **Não existe "encerrar sem narrar"**.
6. Só depois de gravar a página, as `dialogue_messages` são apagadas (a página é a fonte da verdade) e o vínculo fica em `dialogue_sessions.page_id`, o que preserva a persona para *Refazer*.

Falha de API não grava nada: o diálogo continua ativo. Concluir sem nenhuma fala trocada retorna `409` sugerindo cancelar. `POST /api/dialogue/:id/cancel` descarta o diálogo e suas mensagens sem narrar (para um gatilho indesejado não "prender" a sessão).

### Por que prosa e falas literais

A versão anterior gravava a transcrição crua (`**Nome:** fala`) como página. O modelo de voz **lia os nomes dos falantes** e, como o texto é enviado em pedaços, as vozes que ele cria sozinho para cada personagem eram reiniciadas a cada pedaço. A página em prosa, com falas em travessão e sem rótulos, resolve os dois problemas, e o pedaço de texto da voz pôde voltar a **1.500 caracteres**, com cortes entre parágrafos ([Narração por voz](narracao-por-voz.md#como-o-áudio-é-feito)). A história do desenho: o original mandava o Narrador "costurar" a conversa livremente; depois a transcrição crua virou a página; a versão atual é o meio-termo, com **a conversa executada como página, escrita em prosa, com falas literais**.

## Narrar diálogo (reprocessar)

`POST /api/narrative/pages/:id/narrate-dialogue` (SSE, mesmos eventos) transforma uma página de diálogo **crua** em prosa. Vale para as que caíram no *fallback* e para as de versões anteriores ao schema v5.

- Só para páginas `kind = 'dialogue'` com `raw_dialogue = 1` (`404`/`409` nos demais casos, inclusive com diálogo ativo ou página sem falas).
- O contexto são as páginas **anteriores**; o texto atual da página é a fonte das falas (mesmo se foi editado).
- Só o texto da página é trocado (`raw_dialogue = 0`, transcrição crua em `player_instruction`) e o áudio antigo é apagado. **As páginas seguintes não são tocadas**: as falas, e portanto a história, permanecem.
- Até 3 tentativas; se falhar, a página fica como estava (`error`).
- Na UI, o ícone *Narrar diálogo* (pena) só aparece em páginas cruas e some depois de reprocessadas.

## Refazer diálogo (não destrutivo)

`POST /api/narrative/pages/:id/redo-dialogue` (`201 { dialogue, messages: [] }`) abre um novo diálogo ativo **com a mesma persona** e `redo_page_id`. Nada muda até **encerrar** o novo:

- Encerrar substitui a página, descarta as seguintes e o áudio da antiga, **só depois** que a página nova é gravada (narrada ou, no pior caso, crua). Se a chamada ao Gemini falhar, o diálogo novo segue ativo.
- **Descartar** mantém tudo como estava.
- Se houver páginas seguintes, exige `confirm_truncate` (`409 truncation_required` com `pages_to_discard`).
- Na UI, a página alvo ganha o selo "Será substituída ao encerrar o novo diálogo" e as seguintes ficam esmaecidas; durante a narração o fantasma ocupa o lugar dela.

## A página de diálogo

- `kind = 'dialogue'`, com `npc_name`; o cartão mostra o selo **Diálogo com {NPC}** e, nas cruas, os rótulos de fala em destaque.
- É **editável como qualquer outra página sem descartar as seguintes**. Na ação "editar prompt e re-gerar" entra *Refazer diálogo* (`regenerate` responde `409`).
- *Ouvir* manual vale para páginas de diálogo; as falas soltas durante a conversa nunca são narradas. A geração **automática** de áudio dessas páginas tem opção própria, desligada de fábrica ([Narração por voz](narracao-por-voz.md#geração-automática)).
