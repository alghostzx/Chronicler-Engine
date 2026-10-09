# Chronicler Engine — Tarefas

Legenda: `[x]` concluído · `[~]` em andamento · `[ ]` pendente

Plano completo: ver seção 11 do [design document](chronicler_engine_design_document.md).

## Fase 0 — Scaffold e infraestrutura
- [x] `package.json`, `tsconfig.json`, scripts (`dev`, `build`, `test`, `typecheck`)
- [x] Fastify + `@fastify/static`, `GET /api/health`
- [x] `.gitignore` com `data/`, `*.db*` e `GEMINIKEY.txt`
- [x] Teste do health check

## Fase 1 — Banco de dados e repositórios
- [ ] Schema idempotente + migração na inicialização (WAL, foreign_keys)
- [ ] Repositórios: settings, sessions, blocks, archives, dialogues
- [ ] Testes com SQLite `:memory:`

## Fase 2 — Configurações e sessões
- [ ] `GET /api/settings`, `POST /api/settings/key`
- [ ] Lista de modelos Gemini disponíveis (`models.list`) + seletor
- [ ] CRUD de sessões, `PUT /api/sessions/:id/context`

## Fase 3 — Núcleo narrativo
- [ ] `contextBuilder` (sem prompts passados)
- [ ] Geração estruturada com `responseSchema`
- [ ] SSE com parse incremental de `narrative_text`
- [ ] Edição direta de bloco
- [ ] Regeneração com truncamento atômico pós-geração

## Fase 4 — Token count e HP
- [ ] `GET /api/sessions/:id/token-count` (`countTokens`)
- [ ] Estados verde/amarelo/vermelho

## Fase 5 — Modo Diálogo
- [ ] Ativação via `dialogue_trigger`, um diálogo ativo por sessão
- [ ] Mensagens isoladas com persona do NPC
- [ ] `/conclude` com costura em prosa
- [ ] Reconexão pós-reload

## Fase 6 — Compactação
- [ ] `compact/preview` (split 75/25 por peso em tokens)
- [ ] `compact/commit` transacional (`## Crônica — Volume N`)

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
