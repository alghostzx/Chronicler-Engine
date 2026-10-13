# API REST e SSE

Todas as rotas ficam sob `/api` e falam JSON, exceto as de SSE (geração de texto), áudio (MP3) e exportação (Markdown). Não há autenticação (veja [Segurança](arquitetura.md#segurança-e-privacidade)). Erros voltam como `{ error }` com a mensagem em pt-BR (mais `code`, como `missing_api_key` ou `truncation_required`, quando a interface precisa distinguir o caso); corpos inválidos ou com campos desconhecidos geram `400`.

> [!NOTE]
> A lista de rotas deste documento é conferida contra o código por `npm run check:docs`: uma rota nova (ou removida) sem entrada aqui faz a verificação falhar.

Eventos SSE e o ciclo de geração: [Arquitetura](arquitetura.md#ciclo-de-uma-geração). Códigos de erro recorrentes: `404` (recurso inexistente), `409` (conflito de estado: geração concorrente, diálogo ativo, `missing_api_key`, `truncation_required`), `502` (falha da API do Gemini).

## Saúde e configurações

| Rota | Descrição |
| --- | --- |
| `GET /api/health` | `{ status: "ok" }` (usado pelo `HEALTHCHECK`) |
| `GET /api/settings` | `{ api_key_configured, default_model, default_system_rules }` (o texto padrão das regras serve ao *Restaurar padrão*) |
| `POST /api/settings/key` | `{ api_key }`: **valida** chamando `models.list` antes de gravar; chave inválida → `400` e nada é salvo. A chave nunca é devolvida |
| `DELETE /api/settings/key` | Remove a chave |
| `PUT /api/settings/model` | `{ default_model }`: modelo padrão global |
| `GET /api/models` | `{ models, default_model, effective_default_model, available }`. Lista de `models.list` com suporte a `generateContent`, filtrada para **texto** (sem imagem, TTS, música, transcrição, agentes e multimodais de saída) e em cache por 10 min (`?refresh=true` força). `effective_default_model` aplica o *fallback* (primeiro Flash listado) |

## Sessões

| Rota | Descrição |
| --- | --- |
| `GET /api/sessions` | `{ sessions }`: as crônicas salvas |
| `POST /api/sessions` | Cria (`201 { session }`). `title` obrigatório; `system_rules`, `world_context`, `active_theme`, `token_limit` (1.000–10.000.000), `model`, `tts_auto` opcionais |
| `GET /api/sessions/:id` | `{ session, pages, archives, active_dialogue }`: páginas ativas já com `audio` (só metadados) e o diálogo ativo **sem** o prompt |
| `PUT /api/sessions/:id/context` | Atualiza os mesmos campos de `POST` (ao menos um) |
| `DELETE /api/sessions/:id` | Exclui (cascata) e cancela os jobs de áudio |
| `GET /api/sessions/:id/export` | Markdown da crônica: `?scope=all\|active\|archived` e `?include_context=true` ([Narrador](narrador.md#exportação-em-markdown)) |
| `GET /api/sessions/:id/token-count` | `{ tokens_used, token_limit, model, hp_percent, state }` ([HP](narrador.md#hp-do-narrador)) |

## Ciclo narrativo (SSE)

| Rota | Descrição |
| --- | --- |
| `POST /api/sessions/:id/narrative/next` | `{ player_instruction }`: gera a próxima página por SSE (`start`, `chunk`, `page`, `dialogue_trigger`, `error`, `done`) |
| `PUT /api/narrative/pages/:id` | `{ generated_text }`: edição direta; preserva as seguintes; descarta o áudio da página |
| `POST /api/narrative/pages/:id/regenerate` | `{ player_instruction, confirm_truncate? }` (SSE): refaz a página; `409 truncation_required` com `pages_to_discard` se houver seguintes e faltar a confirmação |
| `POST /api/narrative/pages/:id/branch` | `{ confirm_truncate? }`: descarta as seguintes (sem gerar); `{ discarded, last_page_id }` |

## Diálogo

| Rota | Descrição |
| --- | --- |
| `GET /api/sessions/:id/dialogue/active` | `{ dialogue, messages }` (reconexão após recarregar) |
| `POST /api/dialogue/:id/message` | `{ message }` → `{ player_message, npc_message, npc_wants_to_end }` |
| `POST /api/dialogue/:id/conclude` | SSE: o Narrador escreve a página em prosa (até 3 tentativas; *fallback* cru); eventos `start`, `chunk`, `retry`, `page { page, discarded, narration }`, `error`, `done` |
| `POST /api/dialogue/:id/cancel` | Descarta o diálogo e as mensagens, sem narrar |
| `POST /api/narrative/pages/:id/narrate-dialogue` | SSE: reprocessa uma página de diálogo **crua** em prosa; não toca nas seguintes |
| `POST /api/narrative/pages/:id/redo-dialogue` | `{ confirm_truncate? }` → `201 { dialogue, messages: [] }`: abre um novo diálogo com a mesma persona; a página só muda ao encerrar |

Detalhes: [Modo Diálogo](modo-dialogo.md).

## Compactação e volumes

| Rota | Descrição |
| --- | --- |
| `POST /api/sessions/:id/compact/preview` | Minuta da sinopse (não grava nada) |
| `POST /api/sessions/:id/compact/commit` | `{ summary_text, covered_page_start_index, covered_page_end_index }`: cria o volume e arquiva as páginas, numa transação |
| `GET /api/archives/:id/pages` | `{ archive, pages }`: as páginas de um volume, sob demanda |
| `GET /api/archives/:id/export` | Markdown de um volume (`?include_summary=false` omite a sinopse) |

## Narração por voz

Funcionamento em [Narração por voz](narracao-por-voz.md).

| Rota | Descrição |
| --- | --- |
| `POST /api/narrative/pages/:id/audio` | `202`: gera (ou gera de novo) o áudio da página em segundo plano; `409 missing_api_key` sem chave |
| `GET /api/narrative/pages/:id/audio/status` | Estado do job/áudio da página (`generating` com `done`/`total`, `ready`, `error`) |
| `POST /api/narrative/pages/:id/audio/cancel` | Cancela a geração da página |
| `GET /api/narrative/pages/:id/audio` | O MP3, com `Range` (`206`/`416`), `ETag`, `Cache-Control: private, no-cache`; `?download=true` baixa como anexo |
| `DELETE /api/narrative/pages/:id/audio` | Apaga o áudio da página |
| `GET /api/sessions/:id/audio` | `{ pages: [{ page_id, order_index, kind, audio }] }`: estado do áudio de todas as páginas ativas, sem bytes (reprodução contínua) |
| `POST /api/sessions/:id/audio/batch` | `{ from_page_id }`: agenda, em ordem, as páginas dali até a última que não têm áudio válido nem job (retenta as com erro); `{ started, pages }`; `409 missing_api_key` antes de agendar; idempotente |
| `POST /api/sessions/:id/audio/cancel` | `{ page_ids }`: cancela jobs só de páginas dessa sessão; `{ cancelled, pages }` |
| `GET /api/settings/tts` | Configuração (`auto_default`, `model`, `voice`, `style`) mais `defaults`, `models`, `voices`, `style_max` e `usage` |
| `PUT /api/settings/tts` | Atualiza a configuração (ao menos um campo) |
| `POST /api/settings/tts/sample` | Gera uma amostra de voz (MP3) com a configuração atual ou a informada; não é guardada |
| `DELETE /api/audio` | Apaga **todos** os áudios; `{ deleted, usage }` |

As listagens de páginas e o evento SSE `page` já trazem `audio` (metadados; os blobs nunca vão em listagens). `tts_auto` entra no `PUT /api/sessions/:id/context`.
