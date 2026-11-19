# Prompts e chamadas de API aos LLMs

Referência completa de **todos os comandos, prompts, payloads e schemas** enviados à API do Gemini (`@google/genai`) pelo Chronicler Engine em cada momento em que o servidor realiza uma chamada externa.

Todas as chamadas passam exclusivamente pela fronteira [`GeminiGateway`](../src/ai/gateway.ts).

## Visão geral das chamadas

| # | Momento / Gatilho | Rota(s) REST/SSE | Método no SDK | Saída | Timeout | Fonte no código |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | [Gerar ou re-gerar página narrativa](#1-gerar-ou-re-gerar-página-narrativa) | `POST /api/sessions/:id/narrative/next`, `POST /api/narrative/pages/:id/regenerate` | `models.generateContentStream` | JSON (`NARRATOR_RESPONSE_SCHEMA`) | `180 s` | [`contextBuilder.ts`](../src/ai/contextBuilder.ts), [`narrator.ts`](../src/prompts/narrator.ts) |
| 2 | [Gerar cérebro de NPC (6 pilares)](#2-gerar-cérebro-de-npc-6-pilares) | Gatilho pós-página em `TurnRunner.run`, `POST /api/dialogue/:id/participants/generate-brain` | `models.generateContentStream` | JSON (`NPC_BRAIN_SCHEMA`) | `180 s` | [`dialogue.ts`](../src/ai/dialogue.ts) |
| 3 | [Fala de NPC no Modo Diálogo](#3-fala-de-npc-no-modo-diálogo) | `POST /api/dialogue/:id/message` | `models.generateContentStream` | JSON (`NPC_RESPONSE_SCHEMA`) | `180 s` | [`dialogue.ts`](../src/ai/dialogue.ts) |
| 4 | [Narrar diálogo concluído em prosa](#4-narrar-diálogo-concluído-em-prosa) | `POST /api/dialogue/:id/conclude`, `POST /api/narrative/pages/:id/narrate-dialogue` | `models.generateContentStream` | JSON (`NARRATOR_RESPONSE_SCHEMA`) | `180 s` | [`dialogueProse.ts`](../src/ai/dialogueProse.ts) |
| 5 | [Compactação: minuta da sinopse](#5-compactação-minuta-da-sinopse) | `POST /api/sessions/:id/compact/preview` | `models.generateContentStream` | Texto livre | `300 s` | [`compaction.ts`](../src/ai/compaction.ts) |
| 6 | [Compactação: auditar e refinar sinopse](#6-compactação-auditar-e-refinar-sinopse) | `POST /api/sessions/:id/compact/refine` | `models.generateContentStream` | Texto livre | `300 s` | [`compaction.ts`](../src/ai/compaction.ts) |
| 7 | [Contagem de tokens (HP do Narrador)](#7-contagem-de-tokens-hp-do-narrador) | `GET /api/sessions/:id/token-count` | `models.countTokens` | Número (`totalTokens`) | — | [`tokens.ts`](../src/ai/tokens.ts), [`gateway.ts`](../src/ai/gateway.ts) |
| 8 | [Validação de chave e listagem de modelos](#8-validação-de-chave-e-listagem-de-modelos) | `POST /api/settings/key`, `GET /api/models` | `models.list` | Lista de modelos | — | [`models.ts`](../src/ai/models.ts), [`gateway.ts`](../src/ai/gateway.ts) |
| 9 | [Narração por voz (TTS) e amostra](#9-narração-por-voz-tts-e-amostra) | `POST /api/pages/:id/audio`, lotes (`.../audio/batch`), auto-start, `POST /api/settings/tts/sample` | `interactions.create` | Áudio WAV (Base64) | `300 s` | [`gateway.ts`](../src/ai/gateway.ts), [`service.ts`](../src/tts/service.ts), [`config.ts`](../src/tts/config.ts) |

---

## 1. Gerar ou re-gerar página narrativa

- **Quando acontece:** quando o autor envia uma nova instrução (`POST /api/sessions/:id/narrative/next`) ou re-gera uma página existente (`POST /api/narrative/pages/:id/regenerate`).
- **Modelo:** modelo resolvido da sessão (`session.model ?? default_model`).
- **Regra de isolamento:** o corpus inclui apenas `generated_text` das páginas ativas anteriores (em `regenerate`, somente as páginas com `order_index < página_alvo`). Instruções antigas do jogador (`player_instruction`) e páginas arquivadas nunca entram.

### `systemInstruction`

Conteúdo de `sessions.system_rules` (editável por sessão na gaveta). O valor padrão (`DEFAULT_SYSTEM_RULES` em [`src/prompts/narrator.ts`](../src/prompts/narrator.ts)) é:

```text
Você é o Cronista e Narrador de uma história colaborativa literária.
Seu papel é expandir as ações, diálogos e esboços fornecidos pelo Usuário em prosa rica, imersiva e detalhada.

REGRAS RÍGIDAS DE CONDUTA:
1. NÃO AVANCE A HISTÓRIA ALÉM DO ESBOÇO DO JOGADOR. Se o jogador descreveu "eu entro na taverna e peço uma bebida", narre a entrada, o ambiente, a reação das pessoas e o pedido da bebida. PARE no momento em que a ação for concluída. Nunca decida o que acontece em seguida sem a entrada do jogador.
2. MANTENHA O TOM E O ESTILO definidos no Contexto do Mundo. Mantenha o texto gerado organizado em parágrafos para facilitar a leitura. Evite paredes ininterruptas de texto.
3. MODO DIÁLOGO DINÂMICO: Se a cena alcançar um confronto interpessoal intenso ou se o jogador tiver solicitado explicitamente um diálogo direto em seu comando, você deve ativar o campo `dialogue_trigger` na resposta estruturada (`activate: true`), informando em `player_name` como o protagonista deve ser chamado na conversa (o nome do personagem, ou um título curto com iniciais maiúsculas, como "O Forasteiro", se ele ainda não tiver nome) e listando em `npc_names` o nome de cada personagem (NPC) que participará da conversa, em ordem de turno. NÃO gere o briefing dos personagens; apenas identifique quem participará do diálogo. A conversa será gravada como uma página do Tome, exatamente como foi falada.
4. RESPONDA EXCLUSIVAMENTE no formato JSON estruturado especificado.
```

### `contents` (turno único `user`)

Montado por `buildNarratorRequest` ([`src/ai/contextBuilder.ts`](../src/ai/contextBuilder.ts)):

```text
# CONTEXTO DO MUNDO
<session.world_context ou "(sem contexto definido)">

# CORPUS NARRATIVO (história até aqui)
<generated_text das páginas ativas anteriores unidas por "\n\n", ou "(a história ainda não começou)">

# AÇÃO / ESBOÇO DO JOGADOR PARA A PRÓXIMA CENA
<player_instruction>
```

### `responseJsonSchema` (`NARRATOR_RESPONSE_SCHEMA`)

`responseMimeType: "application/json"`, com `propertyOrdering: ["narrative_text", "dialogue_trigger"]`:

```json
{
  "type": "object",
  "properties": {
    "narrative_text": {
      "type": "string",
      "description": "A expansão literária em prosa do turno atual."
    },
    "dialogue_trigger": {
      "type": "object",
      "properties": {
        "activate": { "type": "boolean" },
        "player_name": {
          "type": "string",
          "description": "Como o protagonista (o jogador) é chamado nesta conversa: o nome próprio do personagem, ou um título/apelido curto se ainda não tiver nome (ex.: \"Kira\", \"O Forasteiro\"). Aparece como rótulo das falas do jogador."
        },
        "npc_names": {
          "type": "array",
          "description": "Lista dos nomes dos personagens (NPCs) que participarão da conversa direta com o jogador, em ordem de turno (ex.: [\"Elena Vance\"] ou [\"Elena Vance\", \"Guarda Real\"]).",
          "items": { "type": "string" }
        }
      },
      "required": ["activate"]
    }
  },
  "required": ["narrative_text", "dialogue_trigger"],
  "propertyOrdering": ["narrative_text", "dialogue_trigger"]
}
```

---

## 2. Gerar cérebro de NPC (6 pilares)

- **Quando acontece:**
  1. Automaticamente dentro do mesmo SSE de `TurnRunner.run`, logo após o Narrador retornar `dialogue_trigger.activate: true` — uma chamada sequencial por nome em `npc_names`, já incluindo a página que acabou de ser escrita;
  2. Sob demanda, quando o autor clica em **Gerar cérebro com IA** nos modais de edição ou inclusão de personagem (`POST /api/dialogue/:id/participants/generate-brain`), incluindo eventuais falas já trocadas na cena e uma direção autoral (`hint`) opcional.
- **Montador:** `buildNpcBrainRequest` ([`src/ai/dialogue.ts`](../src/ai/dialogue.ts)).

### `systemInstruction`

```text
Você é um diretor de dramaturgia e RPG que redige o briefing psicológico e operacional ("cérebro" / dynamic_system_prompt) de um personagem (NPC) para o Modo Diálogo, respeitando estritamente o que o personagem sabe e viveu na história.
```

### `contents` (turno único `user`)

```text
# CONTEXTO DO MUNDO
<session.world_context ou "(sem contexto definido)">

# CORPUS NARRATIVO (história até aqui)
<páginas ativas anteriores (no gatilho automático, inclui a página recém-gerada)>

[Opcional — presente se já houver falas no diálogo:]
# FALAS DA CENA ATÉ AGORA
**<Nome>:** <fala>

# TAREFA
Escreva em português o "dynamic_system_prompt" para o personagem "<npcName>", que participa de uma conversa direta com "<playerLabel>"[ (junto na roda com: <outros participantes>)].
[Opcional — presente se o autor informou `hint`:]
Direção autoral / dica para o personagem: <hint>

Estruture o "dynamic_system_prompt" em segunda pessoa ("Você é...") de forma objetiva, enxuta e direta (2 a 3 frases curtas por pilar, sem floreios literários), cobrindo de maneira específica e coerente com o que faz sentido este personagem saber na história os 6 pilares abaixo:

1. Identidade e Voz: tiques verbais, vocabulário, cadência, como reage sob pressão.
2. Postura e Emoção Atual: o que está sentindo fisicamente e emocionalmente neste instante da cena.
3. Intenção ou Interesse na Cena: o que o personagem tem em mente ou gostaria de tratar agora (se houver; pode ser apenas conversar, observar ou passar o tempo), sem tratá-lo como uma obsessão rígida.
4. Segredos e Linhas Vermelhas: o que ele jamais admitirá ou o que esconde a qualquer custo.
5. Conhecimento e Opinião sobre os Presentes: o que efetivamente sabe (ou acredita) e o que pensa do protagonista e dos outros personagens na roda.
6. Conhecimento e Opinião sobre assuntos recentes do local/ambiente onde ele está inserido: o que sabe e pensa sobre os últimos acontecimentos relevantes a ele, ou sobre o que ocorreu recentemente no local.

REGRA DE OURO SOBRE CONHECIMENTO (ISOLAMENTO EPISTÊMICO): O modelo que interpretará o NPC receberá APENAS este cérebro e as falas da conversa atual (ele não tem acesso ao restante da história). Portanto, JAMAIS escreva fatos ou segredos da trama que este personagem desconhece (nunca escreva frases como "Você não sabe que X aconteceu"). Tudo o que o personagem não presenciou ou não tem como saber deve ser simplesmente OMITIDO. Se ele tiver uma suposição ou crença falsa sobre algo, escreva apenas o que ele acredita ser verdade, sem mencionar a verdade oculta.
```

### `responseJsonSchema` (`NPC_BRAIN_SCHEMA`)

```json
{
  "type": "object",
  "properties": {
    "dynamic_system_prompt": {
      "type": "string",
      "description": "Briefing objetivo e enxuto de interpretação do NPC em português (em segunda pessoa: \"Você é...\", 2 a 3 frases diretas por pilar), estruturado nos 6 pilares: 1) Identidade e Voz, 2) Postura e Emoção Atual, 3) Intenção ou Interesse na Cena, 4) Segredos e Linhas Vermelhas, 5) Conhecimento e Opinião sobre os Presentes, 6) Conhecimento e Opinião sobre Assuntos Recentes do Local/Ambiente."
    }
  },
  "required": ["dynamic_system_prompt"]
}
```

---

## 3. Fala de NPC no Modo Diálogo

- **Quando acontece:** a cada rodada de `POST /api/dialogue/:id/message` (`{ message?, pass_turn? }`), disparando uma chamada por NPC participante em ordem (`order_index`).
- **Isolamento estrito:** nem o `world_context`, nem o corpus da história, nem o `dynamic_system_prompt` dos outros NPCs são enviados.
- **Montador:** `buildNpcSystemInstruction` e `buildNpcRequest` ([`src/ai/dialogue.ts`](../src/ai/dialogue.ts)).

### `systemInstruction`

Concatenação do cérebro do NPC (`participant.dynamic_system_prompt`) com as regras fixas (`NPC_GUARD_RULES`) e complementos contextuais:

```text
<participant.dynamic_system_prompt>

REGRAS DE INTERPRETAÇÃO (sempre válidas):
- Responda sempre em primeira pessoa, como o personagem, sem sair do papel.
- Nunca narre, fale ou decida ações pelo protagonista (o jogador) nem pelos outros personagens presentes.
- Fale como uma pessoa real em conversa oral, ajustando o tamanho da fala ao momento: em bate-papo casual, trocas rápidas ou discussões, use frases curtas e diretas (1 a 3 frases, sem palestras nem monólogos); só se estenda em parágrafos quando o momento pedir naturalmente (por exemplo, ao contar uma história ou dar uma explicação longa pedida pelo interlocutor).
- Seja flexível e orgânico: acompanhe mudanças de assunto trazidas pelo interlocutor, reaja ao que acabou de ser dito e não fique insistindo roboticamente no mesmo ponto ou intenção se a conversa tomou outro rumo.
- Responda exclusivamente no formato JSON especificado. Defina "end_conversation" como true quando a conversa chegar a um fim natural (despedida, assunto resolvido ou esgotado, necessidade de ir embora, perda de paciência ou ruptura), sem forçar continuação artificial; caso contrário, false.
```

Complementos anexados conforme o contexto da cena:

- Se `player_name` estiver definido:
  `- Seu interlocutor (o jogador) é chamado de "<player_name>" nesta cena; trate-o assim quando fizer sentido.`
- Em rodadas multi-NPC ou com `allowPassTurn`:
  - `- Você interpreta exclusivamente "<npcName>".`
  - Se houver outros NPCs na roda:
    `- Outros personagens também estão presentes nesta roda de conversa: <outros>. As falas no histórico vêm identificadas pelo nome de quem falou; NÃO inclua o seu próprio nome como prefixo na sua resposta ("reply").`
  - Se `allowPassTurn === true`:
    `- Se a fala anterior foi dirigida claramente a outro personagem presente e o seu personagem não tiver nada relevante a acrescentar ou interromper agora, você pode pular sua vez definindo "pass_turn": true e "reply": "".`
  - Se `allowPassTurn === false`:
    `- Nesta rodada você deve responder (defina "pass_turn": false e preencha "reply").`

### `contents` (histórico multi-turno `user` / `model`)

- **Conversa clássica com 1 NPC e fala direta do jogador:** cada fala anterior do jogador vai como turno `user` e cada fala anterior do NPC vai como turno `model`; o turno final `user` é a mensagem atual do jogador.
- **Conversa multi-NPC ou quando o jogador usa *Passar a vez*:**
  - Falas do próprio NPC viram turnos `model` (sem prefixo).
  - Falas do jogador (`<playerLabel>: <fala>`) e de outros NPCs (`<OutroNPC>: <fala>`) viram turnos `user` (turnos consecutivos do mesmo papel são fundidos com `"\n\n"`).
  - Se o jogador clicou em **Passar a vez** (`pass_turn: true`), injeta como fala `user`:
    `[<playerLabel> permanece em silêncio e aguarda a continuação da conversa.]`

### `responseJsonSchema` (`NPC_RESPONSE_SCHEMA`)

```json
{
  "type": "object",
  "properties": {
    "pass_turn": {
      "type": "boolean",
      "description": "Em conversas com mais de um NPC, defina como true se o seu personagem preferir ficar em silêncio nesta rodada para não interromper uma troca direta entre outros personagens. Caso vá falar, defina como false."
    },
    "reply": {
      "type": "string",
      "description": "A resposta do NPC, em primeira pessoa, conforme a persona (vazio apenas se pass_turn = true)."
    },
    "end_conversation": {
      "type": "boolean",
      "description": "true quando a conversa chegar a um fim natural (despedida, assunto resolvido ou esgotado, o personagem precisa ir embora, perda de paciência ou ruptura); caso contrário, false."
    }
  },
  "required": ["reply", "end_conversation"],
  "propertyOrdering": ["pass_turn", "reply", "end_conversation"]
}
```

---

## 4. Narrar diálogo concluído em prosa

- **Quando acontece:** ao encerrar um diálogo (`POST /api/dialogue/:id/conclude`) ou ao clicar em **Narrar diálogo** numa página de transcrição crua (`POST /api/narrative/pages/:id/narrate-dialogue`).
- **Retentativas:** até `MAX_NARRATION_ATTEMPTS = 3` chamadas sequenciais caso `checkDialogueFidelity` detecte alteração ou omissão de palavras das falas originais.
- **Montador:** `buildDialoguePageRequest` ([`src/ai/dialogueProse.ts`](../src/ai/dialogueProse.ts)).

### `systemInstruction`

O mesmo `sessions.system_rules` do Narrador (veja a [seção 1](#1-gerar-ou-re-gerar-página-narrativa)).

### `contents` (turno único `user`)

```text
# CONTEXTO DO MUNDO
<session.world_context ou "(sem contexto definido)">

# CORPUS NARRATIVO (história até aqui)
<generated_text das páginas ativas anteriores à página do diálogo>

# DIÁLOGO CONCLUÍDO
A cena de diálogo abaixo acabou de acontecer. Transcrição literal (um parágrafo por fala):

**<Falante 1>:** <fala literal 1>

**<Falante 2>:** <fala literal 2>

Escreva agora a PÁGINA NARRATIVA que registra essa cena, em prosa literária no estilo definido para a história.

REGRAS DESTA PÁGINA:
1. Preserve TODAS as falas EXATAMENTE como estão, palavra por palavra e na mesma ordem, em discurso direto, introduzidas por travessão (—). Não resuma, não reescreva, não omita nem acrescente palavras dentro das falas.
2. Entre e ao redor das falas, acrescente apenas preenchimento narrativo: gestos, olhares, ambiente, tom de voz e pausas. Você pode partir uma fala ao meio para inserir uma marcação (ex.: — Lhe ofereço a cura, — disse ele, com malícia — apenas ao custo...), sem mudar as palavras dela.
3. Cada fala fica em seu próprio parágrafo (com as marcações e gestos do próprio falante); a narração solta fica em parágrafos próprios e curtos.
4. NÃO use os rótulos "Nome:" nem negrito: quem fala é identificado pela narração.
5. NÃO avance a história além do que a conversa mostra e NÃO invente falas novas.
```

Em caso de retentativa (`attempt > 1` após reprovação na checagem de fidelidade), é anexado ao final:

```text
ATENÇÃO: a tentativa anterior alterou ou omitiu palavras das falas (por exemplo: <até 8 palavras ausentes>). Copie cada fala exatamente como aparece na transcrição.
```

### `responseJsonSchema`

Reutiliza `NARRATOR_RESPONSE_SCHEMA` (um eventual `dialogue_trigger` retornado aqui é ignorado).

---

## 5. Compactação: minuta da sinopse

- **Quando acontece:** quando o autor solicita a geração da minuta de compactação (`POST /api/sessions/:id/compact/preview`). Não grava nada no banco.
- **Saída:** texto livre (sem `responseJsonSchema`), com timeout estendido de `300 s` (`COMPACTION_IDLE_TIMEOUT_MS`).
- **Montador:** `buildCompactionRequest` ([`src/ai/compaction.ts`](../src/ai/compaction.ts)).

### `systemInstruction` (`COMPACTION_SYSTEM_PROMPT`)

```text
Você é o Arquivista Editorial de uma história colaborativa literária.
Sua tarefa é condensar um trecho já narrado numa SINOPSE FACTUAL DENSA, que substituirá o texto original na memória do Narrador.

REGRAS:
1. Registre apenas fatos presentes no texto — nunca invente, interprete além do texto nem continue a história.
2. Preserve, com precisão: eventos decisivos e sua ordem; alianças, rivalidades e mudanças de relação entre personagens; itens ganhos, perdidos ou destruídos; mortes, ferimentos e condições permanentes; mudanças de cenário e de data/hora; promessas, segredos, dívidas e objetivos em aberto; nomes próprios exatamente como aparecem.
3. Escreva em terceira pessoa, no pretérito, com frases objetivas e sem floreios literários. Pode usar parágrafos curtos ou listas de tópicos.
4. Seja o mais conciso possível sem omitir nenhum fato exigido na Regra 2: elimine descrições atmosféricas, diálogos literais e repetições, mantendo apenas o registro factual completo na menor extensão necessária.
5. Responda SOMENTE com o texto da sinopse, sem títulos, comentários ou introduções.
```

### `contents` (turno único `user`)

```text
# CONTEXTO DO MUNDO (apenas referência; não resuma esta seção)
<session.world_context ou "(sem contexto definido)">

# TRECHO DA HISTÓRIA A SER CONDENSADO
<generated_text das páginas selecionadas no Corpus Passado>

Escreva agora a sinopse factual densa do trecho acima.
```

---

## 6. Compactação: auditar e refinar sinopse

- **Quando acontece:** quando o autor clica em **Revisar e enriquecer** dentro do modal de compactação (`POST /api/sessions/:id/compact/refine`).
- **Saída:** texto livre (sem `responseJsonSchema`), com timeout estendido de `300 s` (`COMPACTION_IDLE_TIMEOUT_MS`).
- **Montador:** `buildCompactionRefineRequest` ([`src/ai/compaction.ts`](../src/ai/compaction.ts)).

### `systemInstruction` (`COMPACTION_REFINE_SYSTEM_PROMPT`)

```text
Você é o Auditor Editorial de uma história colaborativa literária.
Sua tarefa é auditar e aprimorar uma SINOPSE FACTUAL preliminar contra o texto narrado original, corrigindo erros factuais e garantindo que nenhum fato relevante tenha ficado para trás.

REGRAS:
1. Registre apenas fatos presentes no texto original — nunca invente, interprete além do texto nem continue a história.
2. Identifique e corrija quaisquer ERROS FACTUAIS da sinopse preliminar: alucinações (fatos que não ocorreram no texto), distorções de causa e efeito, trocas de quem fez ou disse o quê, inversões de ordem cronológica, estados incorretos de itens/personagens e grafias erradas de nomes próprios.
3. Identifique e incorpore fatos omitidos ou incompletos conforme as prioridades: eventos decisivos e sua ordem cronológica; alianças, rivalidades e relações entre personagens; itens ganhos, perdidos ou destruídos; mortes, ferimentos e condições permanentes; mudanças de cenário e de tempo; promessas, segredos, dívidas e objetivos em aberto; nomes próprios grafados com fidelidade absoluta.
4. Preserve as informações da sinopse preliminar que já estiverem fiéis ao texto original, integrando as correções e os detalhes que faltavam.
5. Escreva em terceira pessoa, no pretérito, com frases objetivas, sem floreios literários, em parágrafos coesos ou listas de tópicos.
6. Seja rigorosamente conciso: elimine redundâncias e rodeios para manter a sinopse densa e limpa.
7. Responda SOMENTE com o texto final da sinopse corrigida, enriquecida e integrada, sem preâmbulos, comentários, notas de revisão ou títulos.
```

### `contents` (turno único `user`)

```text
# CONTEXTO DO MUNDO (apenas referência; não resuma esta seção)
<session.world_context ou "(sem contexto definido)">

# TRECHO DA HISTÓRIA ORIGINAL
<generated_text das páginas selecionadas no Corpus Passado>

# SINOPSE ATUAL (para auditar, corrigir e enriquecer)
<current_summary>

Audite o trecho original contra a sinopse atual. Corrija quaisquer erros factuais ou distorções, incorpore os fatos ou detalhes relevantes que ficaram para trás e responda apenas com a sinopse final corrigida, enriquecida e integrada.
```

---

## 7. Contagem de tokens (HP do Narrador)

- **Quando acontece:** em `GET /api/sessions/:id/token-count`, acionado por eventos da UI (abrir sessão, gerar/regenerar página, editar página ou contexto, compactar, ramificar).
- **Método:** `ai.models.countTokens` ([`src/ai/gateway.ts`](../src/ai/gateway.ts) e [`src/ai/tokens.ts`](../src/ai/tokens.ts)), com cache LRU em memória de 64 entradas indexado por SHA-256 de `[model, systemInstruction, userText]`.
- **Payload enviado:**
  Como a Gemini Developer API rejeita o parâmetro `systemInstruction` em `countTokens`, o texto é enviado concatenado em `contents`:

```text
<session.system_rules>

# CONTEXTO DO MUNDO
<session.world_context>

# CORPUS NARRATIVO (história até aqui)
<generated_text das páginas ativas>

# AÇÃO / ESBOÇO DO JOGADOR PARA A PRÓXIMA CENA
```

---

## 8. Validação de chave e listagem de modelos

- **Quando acontece:**
  - Ao salvar uma nova chave em **Opções** (`POST /api/settings/key`), antes de gravá-la no SQLite;
  - Ao listar modelos disponíveis (`GET /api/models`) e ao resolver o modelo efetivo de uma sessão (`ModelService.resolve`).
- **Método:** `ai.models.list({ config: { pageSize: 100 } })` ([`src/ai/gateway.ts`](../src/ai/gateway.ts)), com cache em memória de 10 minutos em [`src/ai/models.ts`](../src/ai/models.ts).
- **Nenhum prompt é enviado.** O servidor mantém apenas modelos cuja lista `supportedActions` contenha `"generateContent"` e cujo identificador não case com `NON_TEXT_PATTERN` (excluindo modelos de imagem, áudio/TTS, vídeo, embeddings, live, robótica, música etc.).

---

## 9. Narração por voz (TTS) e amostra

- **Quando acontece:**
  - Ao clicar em **Ouvir** numa página (`POST /api/pages/:id/audio`), em reprodução contínua (`POST /api/sessions/:id/audio/batch` e `POST /api/archives/:id/audio/batch`) ou automaticamente após uma nova página se `tts_auto` estiver ligado;
  - Ao clicar em **Ouvir amostra** em **Opções → Narração por voz** (`POST /api/settings/tts/sample`).
- **Método:** `ai.interactions.create` (Interactions API — não usa `generateContent` nem `systemInstruction`, pois o modelo TTS leria instruções em voz alta). Timeout de `300 s` (`SYNTHESIS_TIMEOUT_MS`), respeitando o limite de chamadas por minuto (`TTS_MAX_RPM`, padrão 10 RPM) e o cache incremental por trecho WAV (`page_audio_chunks`).
- **Pré-processamento do texto:** cada página passa por `cleanForSpeech` e `splitForSpeech` ([`src/tts/text.ts`](../src/tts/text.ts)), dividindo o texto em trechos de até ~1.500 caracteres sintetizados em paralelo. Na amostra, o texto fixo (`TTS_SAMPLE_TEXT` em [`src/tts/config.ts`](../src/tts/config.ts)) é:
  > `A neblina subia do porto como um sudário, engolindo os mastros um a um. Varn não acolhia ninguém; apenas tolerava.`

### Payload enviado por trecho

```json
{
  "model": "<tts_model, padrão: gemini-3.8-flash-tts>",
  "input": [
    {
      "type": "user_input",
      "content": [
        {
          "type": "text",
          "text": "<trecho literal limpo para leitura>",
          "annotations": [
            {
              "type": "speech_metadata",
              "style": "<tts_style, padrão: voz grave, rouca e pausada de um velho narrador>"
            }
          ]
        }
      ]
    }
  ],
  "response_format": { "type": "audio" },
  "generation_config": {
    "speech_config": [{ "voice": "<tts_voice, padrão: Gacrux>" }]
  }
}
```

> Se `tts_style` estiver vazio, o campo `annotations` é omitido do objeto de conteúdo.
