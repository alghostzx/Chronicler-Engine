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

## Fase 7 — Frontend (Vanilla TS + Tailwind, pt-BR) ✅
- [x] `POST /api/narrative/blocks/:id/branch` (ramificar) + testes
- [x] Fontes locais empacotadas (`npm run fonts` → `public/fonts/`), sem CDN
- [x] Temas (4) via variáveis CSS + classe na raiz, persistidos em `localStorage` e na sessão
- [x] Tela inicial: chave da API (validada), modelo padrão (lista real da API), criar/listar/excluir sessões
- [x] Layout: Gaveta de Contexto (Mundo/Regras/Modelo+limite/Crônica), Tome Interativo, Doca de Ação
- [x] Tome com streaming (bloco fantasma), editar, ver prompt/re-gerar com aviso de descarte, ramificar
- [x] Barra de HP (verde/amarelo/vermelho) recalculada só por eventos + botão Compactar Crônica pulsante
- [x] UI do Modo Diálogo (transcrição, encerrar/descartar, reconexão pós-reload)
- [x] Modal de revisão da sinopse (minuta editável → consolidar)
- [x] Testes: parser SSE do cliente, serviço estático, e integração da UI em jsdom contra o servidor real (7 cenários)

## Fase 8 — Docker ✅
- [x] Dockerfile multi-stage (Node 22, deps de produção isoladas, runtime enxuto) + `.dockerignore`
- [x] `docker-compose.yml` com bind `127.0.0.1:3000`, volume `./data`, entrypoint com `su-exec`
- [x] README em pt-BR
- [x] Validado sem Docker: build, `npm ci --omit=dev` isolado e servidor de produção respondendo (Docker indisponível no ambiente)
- [x] Subida real com **Podman rootless** (`podman-compose` + `docker-compose.podman.yml`): build da imagem OK, contêiner responde em `127.0.0.1:3000` (`/api/health`, `/`, `/assets/*`, `/fonts/*` = 200) e `./data` permanece do usuário
- [ ] Teste com Docker propriamente dito — não disponível no ambiente (o Dockerfile é o mesmo)

## Fase 9 — Verificação final ✅
- [x] Checklist da seção 10 do design document (5/5, com evidências no próprio documento)
- [x] Suíte completa: 128 testes passando; `typecheck` do servidor e do cliente limpos
- [x] Teste ponta a ponta com chave real (`scripts/live-*.ts`, modelo `gemini-3.8-flash`)

### Pendências conhecidas / riscos
- A imagem foi construída e executada com Podman rootless; `docker compose up --build` com Docker propriamente dito não foi testado (Docker ausente no ambiente).
- A UI foi validada em jsdom (sem navegador real): vale uma passada visual nos 4 temas.
- Modelos `gemma-*` aparecem no seletor, mas `systemInstruction`/modo JSON não foram testados com eles.
- `npm audit` acusa 7 vulnerabilidades, todas em dependências de desenvolvimento (a instalação de produção tem 0).

## Fase 10 — Melhorias pós-entrega ✅
- [x] Favicon (SVG + ICO + apple-touch-icon), servidos localmente
- [x] Variações clara/escura para os 4 temas (Automático/Claro/Escuro, sem "flash" na carga)
- [x] Botão **Salvar .md**: `GET /api/sessions/:id/export` (inclui blocos arquivados; contexto opcional; sem prompts do jogador)
- [x] Testes: exportação (módulo + rota), temas/modo (jsdom) e UI (download + alternância de modo); 142 testes passando
- [x] Imagem reconstruída e contêiner Podman atualizado com estas mudanças (favicon, assets e API respondendo 200)

## Fase 11 — Interface: ícones e responsividade ✅
- [x] Cabeçalho da sessão só com ícones (Biblioteca, Tema, Modo, Salvar .md, Contexto) com tooltip no hover/foco e `aria-label`
- [x] Tema e modo claro/escuro como menus de ícone (Esc, clique fora, setas), também na tela inicial
- [x] Tela inicial sem corte/rolagem horizontal no celular (`grid-cols-1`, `min-w-0`, `.input` com `max-w-full`, lista de crônicas com truncamento)
- [x] Testes: cabeçalho (rótulos/tooltips), menus de tema/modo e regressão da marcação responsiva; 145 testes passando
- [ ] Conferência visual em um celular real (não há navegador no ambiente de desenvolvimento)

## Fase 12 — README e capturas de tela ✅
- [x] README: subir com Docker, Podman+compose e Podman puro (testado), primeiro uso, atualização, backup, solução de problemas, arquitetura
- [x] `npm run screenshots` (Chromium headless + Gemini simulado) gera 8 capturas em `docs/screenshots/` (desktop e celular; 0 px de rolagem horizontal)
- [x] Correção encontrada nas capturas: barra de HP no celular
- [x] Encerramento gracioso (`SIGTERM`/`SIGINT`) — `stop`/`down` não esperam mais 10 s
- [ ] Caminho Docker (não Podman) segue sem teste no ambiente de desenvolvimento
