# O Narrador: contexto, páginas, HP e compactação

Como o Chronicler Engine fala com o Gemini e o que acontece com o texto gerado: o payload de contexto, as regras, a edição e a regeneração (que descartam o futuro), o HP, a compactação em volumes e a exportação. O Modo Diálogo tem [documento próprio](modo-dialogo.md).

## Pipeline do payload

A cada turno, o payload enviado ao Gemini segue esta ordem (função pura em [`src/ai/contextBuilder.ts`](../src/ai/contextBuilder.ts)):

```
┌─────────────────────────────────────────────────────────────┐
│ 1. SYSTEM INSTRUCTION  = sessions.system_rules              │
├─────────────────────────────────────────────────────────────┤
│ 2. # CONTEXTO DO MUNDO     (world_context + volumes)        │
│ 3. # CORPUS NARRATIVO      (generated_text das páginas      │
│                             ativas, em ordem)               │
│ 4. # AÇÃO / ESBOÇO DO JOGADOR PARA A PRÓXIMA CENA           │
└─────────────────────────────────────────────────────────────┘
   (2, 3 e 4 formam um único turno de usuário, nessa ordem)
```

- O modelo usado é `sessions.model` → padrão global → *fallback* (o primeiro Flash listado, com aviso na UI). O identificador fica em `narrative_pages.model_identifier`.
- O `token_limit` é configurável por sessão (padrão 1.000.000).

### Isolamento das meta-instruções

Cada página guarda o `player_instruction` que a originou, para auditoria e re-geração. Mas ao gerar a página N+1, **só o `generated_text` das páginas 1…N entra no corpus**: os prompts anteriores do jogador são omitidos. Páginas arquivadas em volumes também ficam fora (a sinopse delas está no mundo). Isso é um invariante testado (ver [Decisões](decisoes.md#invariantes-e-os-testes-que-os-protegem)).

## Regras do Narrador

As regras padrão ([`src/prompts/narrator.ts`](../src/prompts/narrator.ts)) ficam em `sessions.system_rules` e são editáveis por sessão na Gaveta de Contexto (com *Restaurar padrão*). Em essência:

1. **Não avançar a história além do esboço do jogador.** Narrar a ação e parar quando ela terminar.
2. Manter o tom e o estilo do Contexto do Mundo, em parágrafos curtos, sem paredes de texto.
3. **Modo Diálogo:** se a cena chegar a um confronto interpessoal intenso, ou se o jogador pedir um diálogo direto, preencher o `dialogue_trigger` com o briefing do NPC.
4. **Responder exclusivamente no JSON estruturado.**

### Saída estruturada

A chamada usa `responseMimeType: application/json` + `responseJsonSchema` ([`src/ai/narratorSchema.ts`](../src/ai/narratorSchema.ts)) e `propertyOrdering: ["narrative_text", "dialogue_trigger"]`, para a prosa chegar primeiro e o *streaming* começar logo:

```json
{
  "narrative_text": "A expansão literária em prosa do turno atual.",
  "dialogue_trigger": {
    "activate": true,
    "npc_name": "…",
    "player_name": "…",
    "dynamic_system_prompt": "Prompt completo de interpretação do NPC…"
  }
}
```

`dialogue_trigger` com `activate: true` mas sem `npc_name` ou `dynamic_system_prompt` é tratado como inativo.

## Páginas

O texto gerado por cada prompt é uma **página** do Tome. O título do cartão é `Página N`, com `N = order_index`: começa em 1, é **absoluto e nunca reaproveitado**. Depois de compactar, o Tome pode começar na "Página 4".

### Edição direta ("na unha")

`PUT /api/narrative/pages/:id` altera só o `generated_text` e **preserva as páginas seguintes** (a história permanece coerente se a edição for textual). O áudio da página é descartado. Páginas arquivadas não são editáveis (`409`).

### Regeneração com truncamento

`POST /api/narrative/pages/:id/regenerate` refaz a página com um novo `player_instruction`. O corpus enviado contém só as páginas ativas **anteriores** à página K.

- Se K é a **última página**, o texto é substituído.
- Se K é **intermediária**, a API responde `409 { code: "truncation_required", pages_to_discard }` sem tocar em nada, até receber `confirm_truncate: true`. Com a confirmação, o `DELETE … WHERE order_index > K` e a atualização da página K ocorrem numa **única transação, depois** da geração bem-sucedida: uma falha nunca apaga dados.
- Páginas de diálogo respondem `409` (use *Refazer diálogo*).

### Ramificar

`POST /api/narrative/pages/:id/branch` descarta as páginas ativas posteriores (sem gerar nada) para o autor continuar dali. Exige `confirm_truncate` se houver posteriores (`409 truncation_required`) e responde `{ discarded, last_page_id }`. É recusado com diálogo ativo ou geração concorrente. Na UI, fica desabilitado na última página.

## HP do Narrador

A barra de HP mostra quanto do `token_limit` já foi consumido pelo payload real que seria enviado (regras + mundo + corpus ativo, **sem** o input pendente do jogador):

```
HP (%) = 100 × (limite − usados) / limite      (limitado a [0, 100], uma casa decimal)
```

`GET /api/sessions/:id/token-count` responde `{ tokens_used, token_limit, model, hp_percent, state }`:

| `state` | HP | Efeito na interface |
| --- | --- | --- |
| `green` | ≥ 50% | Indicador estável |
| `yellow` | ≥ 20% e < 50% | Aviso sutil de saturação |
| `red` | < 20% | O botão **Compactar Crônica** pulsa |

- **Limitação da API:** a Developer API do Gemini **rejeita `systemInstruction` em `countTokens`**; as regras são contadas como texto somado ao conteúdo (diferença de poucos tokens).
- **Cache em memória** por hash (modelo + regras + conteúdo): reabrir uma sessão sem alterações não chama a API.
- **Sem polling, sem recálculo por tecla.** O cliente consulta só em eventos: abrir a sessão, página gerada/regenerada, edição de texto ou contexto, compactação e ramificação.
- Erros: `404` (sessão), `409 missing_api_key`, `502` (falha da API de contagem).

## Compactação (Livro de Crônicas)

Quando o HP está baixo, a compactação transforma as páginas antigas em um **volume**, sem perdê-las.

1. **Cisão 75/25 por peso** ([`src/ai/compaction.ts`](../src/ai/compaction.ts)). O *Corpus Passado* é o maior prefixo cronológico das páginas ativas cujo peso (tamanho do texto, aproximando tokens) não passa de 75% do total; o resto é o *Corpus Ativo*. Sempre sobra ao menos 1 página de cada lado; com menos de 2 páginas ativas a API responde `409`.
2. **Minuta.** `POST /api/sessions/:id/compact/preview` envia ao modelo (texto livre, sem JSON) só o Corpus Passado e o mundo (como referência de grafia), sob o prompt do "Arquivista Editorial" (sinopse factual densa, ≈ 1/8 do original). Responde `{ summary_text, covered_page_start_index, covered_page_end_index, pages_to_archive, pages_to_keep, next_volume_number, model }`. **Não grava nada.**
3. **Revisão humana obrigatória.** Um modal mostra a sinopse editável.
4. **Consolidação.** `POST /api/sessions/:id/compact/commit` recebe a sinopse editada e a faixa; valida que é exatamente um prefixo das páginas ativas e que a última página é preservada (senão `409`: gere nova minuta). Numa única transação: cria o volume em `chronicle_archives`, marca as páginas como `is_archived` e anexa ao `world_context` o trecho `## Crônica — Volume N` + sinopse. Qualquer falha desfaz tudo.

Preview e commit exigem a trava da sessão e ausência de diálogo ativo. O HP volta a subir porque as páginas arquivadas saem do corpus e a sinopse (bem menor) entra no mundo.

### Páginas consumidas continuam legíveis

Páginas arquivadas **permanecem no banco**: saem do contexto da IA, do HP e da próxima compactação, mas o jogador pode relê-las e exportá-las. `GET /api/archives/:id/pages` devolve `{ archive, pages }` sob demanda. Elas não são editáveis nem pontos de ramificação (`409`), mas **continuam narráveis** em voz. A interface de leitura está em [Interface](interface.md#leitor-de-volume).

## Exportação em Markdown

[`src/export.ts`](../src/export.ts) gera `text/markdown` como anexo (`Content-Disposition` com `filename` ASCII e `filename*` UTF-8):

- `GET /api/sessions/:id/export?scope=all|active|archived&include_context=` — `all` (padrão) é a crônica completa, `active` só o que está no Tome, `archived` só as páginas já em volumes (`409` se não houver; o nome ganha o sufixo "no Tome" ou "volumes"). Saída: `# Título`, metadados (data e "N páginas"), as páginas separadas por `---` e, com `include_context`, a seção `## Mundo e personagens` (que já carrega as sinopses) seguida de `## Narrativa`.
- `GET /api/archives/:id/export?include_summary=` — um volume: `# Título — Volume N`, faixa de páginas, `## Sinopse` (padrão; `false` a omite) e as páginas.

Os `player_instruction` **nunca** são exportados. Na UI, o download usa `fetch` + `Blob`.
