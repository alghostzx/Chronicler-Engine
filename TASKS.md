# Chronicler Engine — Tarefas

Legenda: `[x]` concluído · `[~]` em andamento · `[ ]` pendente

Plano completo: ver seção 11 do [design document](chronicler_engine_design_document.md).

## Fase 0 — Scaffold e infraestrutura ✅
- [x] `package.json`, `tsconfig.json`, scripts (`dev`, `build`, `test`, `typecheck`)
- [x] Fastify + `@fastify/static`, `GET /api/health`
- [x] `.gitignore` com `data/`, `*.db*` e `GEMINIKEY.txt`
- [x] Teste do health check

## Fase 1 — Banco de dados e repositórios ✅
- [x] Schema idempotente + migração na inicialização (WAL, foreign_keys, `user_version`)
- [x] Repositórios: settings, sessions, blocks, archives, dialogues
- [x] Testes com SQLite `:memory:` (12 testes)

## Fase 2 — Configurações e sessões ✅
- [x] `GET /api/settings`, `POST /api/settings/key` (valida a chave via `models.list` antes de gravar), `DELETE /api/settings/key`, `PUT /api/settings/model`
- [x] `GET /api/models`: lista real de modelos de texto (`models.list`), cache de 10 min, fallback para o primeiro Flash
- [x] CRUD de sessões, `PUT /api/sessions/:id/context` (regras, contexto, tema, modelo, `token_limit`)
- [x] Validação estrita do corpo (campos desconhecidos → 400)
- [x] Verificado contra a API real (`scripts/live-models.ts`): `gemini-3.8-flash` existe

## Fase 3 — Núcleo narrativo ✅
- [x] `contextBuilder` puro (sem prompts passados), testado
- [x] Geração estruturada com `responseJsonSchema` (`narrative_text` primeiro, `propertyOrdering`)
- [x] SSE com parse incremental de `narrative_text` (`NarrativeTextExtractor`, testado com todas as fatias)
- [x] `POST /api/sessions/:id/narrative/next` (eventos `start`/`chunk`/`block`/`dialogue_trigger`/`error`/`done`)
- [x] Edição direta de bloco (`PUT /api/narrative/blocks/:id`)
- [x] Regeneração com truncamento atômico pós-geração e `confirm_truncate`
- [x] Trava de concorrência por sessão e bloqueio durante diálogo ativo
- [x] Verificado contra a API real (`scripts/live-narrative.ts`, `gemini-3.8-flash`): streaming e `dialogue_trigger` OK

## Fase 4 — Token count e HP ✅
- [x] `GET /api/sessions/:id/token-count` com `countTokens` real sobre o payload (regras + mundo + corpus ativo)
- [x] `computeHp` com estados verde/amarelo/vermelho (limiares exatos testados)
- [x] Cache por hash do conteúdo (sem polling, sem valores obsoletos)
- [x] Verificado contra a API real (`scripts/live-tokens.ts`); descoberta: `systemInstruction` não é aceito em `countTokens` na Developer API → regras contadas junto ao conteúdo

## Fase 5 — Modo Diálogo ✅
- [x] Ativação via `dialogue_trigger` (Fase 3), um diálogo ativo por sessão (índice único no banco)
- [x] `POST /api/dialogue/:id/message`: persona do NPC, histórico isolado multi-turno, sinal `npc_wants_to_end`
- [x] `POST /api/dialogue/:id/conclude`: costura em prosa via SSE, único ponto em que o diálogo altera a história
- [x] `POST /api/dialogue/:id/cancel` (extensão) e `GET /api/sessions/:id/dialogue/active` (reconexão pós-reload)
- [x] `dynamic_system_prompt` nunca é exposto pela API
- [x] Refatoração: `TurnRunner` compartilhado (travas de concorrência e SSE)
- [x] Verificado contra a API real (`scripts/live-dialogue.ts`)

## Fase 6 — Compactação ✅
- [x] `splitForCompaction`: 75/25 por peso (tamanho do texto), ≥ 1 bloco de cada lado
- [x] `POST /api/sessions/:id/compact/preview`: sinopse factual do Corpus Passado, sem efeitos colaterais
- [x] `POST /api/sessions/:id/compact/commit` transacional: volume em `chronicle_archives`, `## Crônica — Volume N` no `world_context`, blocos `is_archived`
- [x] Validação da faixa no commit (prefixo dos ativos, preserva o último bloco) e rollback atômico
- [x] Verificado contra a API real (`scripts/live-compaction.ts`): HP 62,6% → 79,3%

## Fase 7 — Frontend (Vanilla TS + Tailwind, pt-BR)
- [ ] Layout: Context Drawer, Interactive Tome, Action Dock
- [ ] Sessões e configuração de API key / modelo
- [ ] Tome com streaming e ações de bloco
- [ ] Barra de HP + botão Compactar Crônica
- [ ] UI do Modo Diálogo
- [ ] Modal de revisão da sinopse
- [ ] Temas (4) com fontes locais em `public/fonts/`

## Fase 8 — Docker
- [ ] Dockerfile multi-stage + `.dockerignore`
- [ ] `docker-compose.yml` com bind `127.0.0.1:3000`
- [ ] README

## Fase 9 — Verificação final
- [ ] Checklist da seção 10 do design document
- [ ] Teste ponta a ponta com chave real
