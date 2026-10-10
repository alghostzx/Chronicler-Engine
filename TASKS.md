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
- [x] Teste com Docker propriamente dito (Docker 29.7 + Compose 5.5, Fedora 44) — ver Fase 12

## Fase 9 — Verificação final ✅
- [x] Checklist da seção 10 do design document (5/5, com evidências no próprio documento)
- [x] Suíte completa: 128 testes passando; `typecheck` do servidor e do cliente limpos
- [x] Teste ponta a ponta com chave real (`scripts/live-*.ts`, modelo `gemini-3.8-flash`)

### Pendências conhecidas / riscos
- A imagem foi construída e executada com Podman rootless **e** com Docker (Fase 12).
- A UI foi validada visualmente nos 4 temas e em viewport mobile via Chromium headless (`scripts/screenshots.ts`).
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
- [x] Conferência visual em viewport mobile via Chromium headless (`npm run screenshots`, 0 px de rolagem horizontal)

## Fase 12 — README e capturas de tela ✅
- [x] README: subir com Docker, Podman+compose e Podman puro (testado), primeiro uso, atualização, backup, solução de problemas, arquitetura
- [x] `npm run screenshots` (Chromium headless + Gemini simulado) gera 8 capturas em `docs/screenshots/` (desktop e celular; 0 px de rolagem horizontal)
- [x] Correção encontrada nas capturas: barra de HP no celular
- [x] Encerramento gracioso (`SIGTERM`/`SIGINT`) — `stop`/`down` não esperam mais 10 s
- [x] Caminho Docker testado: `docker compose up -d --build` (porta 3100 e dados em `/tmp` para não colidir), todos os endpoints 200, `healthcheck` healthy, processo rodando como usuário sem privilégios, dados persistem após `restart` (0,5 s), `down` limpo

## Fase 13 — Páginas (branch `feature/paginas`) 🚧
Conceito: cada texto gerado por prompt é uma **página** do Tome (antes "bloco"). Draft v2 revisado com as decisões do autor: renomeação completa **sem migração** (pré-pré-alpha, atualizações não suportadas), numeração absoluta (`Página N` = `order_index`), `---` entre páginas no export, páginas arquivadas legíveis e exportáveis, "Editar prompt" mantém o aviso destrutivo.

### 13.1 Renomeação bloco → página (código, API, banco; sem migração)
- [x] Schema: `narrative_blocks` → `narrative_pages`, `covered_block_*` → `covered_page_*`, índice `idx_pages_order`; `SCHEMA_VERSION` 2
- [x] Banco de versão antiga (v1) falha com mensagem clara (apague `./data`) em vez de `no such table`; teste cobrindo
- [x] Repositório `blocks` → `pages`; tipos `NarrativeBlock`/`Block` → `Page`
- [x] Rotas `/api/narrative/blocks/:id…` → `/api/narrative/pages/:id…` (sem alias); JSON (`blocks` → `pages`, `pages_to_archive/keep`, `pages_to_discard`, `covered_page_*`) e evento SSE `block` → `page`
- [x] Mensagens de erro, prompts de compactação e textos da UI: "bloco(s)" → "página(s)"
- [x] Testes e scripts (`live-*`, `screenshots`) atualizados; suíte verde

### 13.2 Interface — cartão de página
- [x] Ícones novos em `client/icons.ts`: lápis (editar texto), prompt editável, ramificar
- [x] Componente `pageCard` (cartão separado por página, cabeçalho "Página N" absoluto, folha com borda/sombra, espaçamento) no lugar da prosa contínua; modo `readonly` reutilizável
- [x] Ações no rodapé do cartão, **sempre visíveis**, só ícones com tooltip/`aria-label`: Editar texto, Editar prompt (re-gera, **com aviso de descarte**), Ramificar (desabilitado na última página)
- [x] Estados: edição dentro do cartão, página fantasma (streaming), esmaecidas na re-geração, drop-cap só na 1ª, cartão de diálogo distinto
- [x] Mobile (390 px): sem rolagem horizontal, ícones sem quebra de linha

### 13.3 Páginas consumidas continuam legíveis e exportáveis
- [ ] `GET /api/archives/:id/pages` (sob demanda; faixa `covered_page_*`, só arquivadas) + testes
- [ ] Painel Contexto → Crônica: "Volume N — páginas X a Y", sinopse, botão **Ler as N páginas** e ícone **Salvar volume em .md**
- [ ] Leitor de volume como **página separada** (rota `#/s/<id>/v/<n>`, não modal) com `pageCard` somente leitura, link de volta e ícone de exportar; arquivadas não são editáveis nem ponto de ramificação na UI
- [ ] Teste: páginas arquivadas ficam **fora** do contexto da IA/HP/compactação e **dentro** do que o jogador lê e exporta
- [ ] Exportador: `---` entre páginas (linhas em branco ao redor), metadados "N páginas"; prompts do jogador continuam fora
- [ ] `GET /api/sessions/:id/export?scope=all|active|archived&include_context=` (padrão `all`)
- [ ] `GET /api/archives/:id/export?include_summary=` (volume: `# Título — Volume N`, sinopse opcional, páginas)
- [ ] Modal "Salvar em Markdown" com escopo (completa · só no Tome · só em volumes) + checkbox de contexto

### 13.4 Os 8 temas (4 temas × claro/escuro)
- [ ] Tokens de "folha" por tema/modo em `client/styles.css`
- [ ] `test/pageThemes.test.ts` (vitest): contraste WCAG de texto, texto esmaecido e ícones, e distinção folha × fundo nas 8 combinações
- [ ] `npm run check:paginas` (Chromium headless): 8 combinações × 1280 px e 390 px — ações visíveis e clicáveis, sem overflow horizontal, páginas sem sobreposição, contraste no DOM renderizado, leitor de volume
- [ ] Capturas das 8 combinações em `docs/screenshots/paginas/` inspecionadas uma a uma
- [ ] Testes de UI (jsdom): rótulos novos, ícones sempre visíveis (sem `opacity-0`), número da página, leitor, modal de exportação

### 13.5 Documentação e entrega
- [ ] Design document: nova §11.22 (conceito, mapa de renomeação, leitor de volumes, formato do export, sem migração) + notas remissivas nas seções antigas
- [ ] README: vocabulário novo, aviso "pré-pré-alpha: atualizações não suportadas, apague `./data`", galeria dos 8 temas
- [ ] Suíte completa + typecheck (servidor e cliente) + rebuild da imagem e verificação
- [ ] Merge de `feature/paginas` em `main` (publica a imagem no GHCR)
