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
- [x] `POST /api/sessions/:id/narrative/next` (eventos `start`/`chunk`/`page`/`dialogue_trigger`/`error`/`done`)
- [x] Edição direta de página (`PUT /api/narrative/pages/:id`)
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
- [x] `splitForCompaction`: 75/25 por peso (tamanho do texto), ≥ 1 página de cada lado
- [x] `POST /api/sessions/:id/compact/preview`: sinopse factual do Corpus Passado, sem efeitos colaterais
- [x] `POST /api/sessions/:id/compact/commit` transacional: volume em `chronicle_archives`, `## Crônica — Volume N` no `world_context`, páginas `is_archived`
- [x] Validação da faixa no commit (prefixo dos ativos, preserva o última página) e rollback atômico
- [x] Verificado contra a API real (`scripts/live-compaction.ts`): HP 62,6% → 79,3%

## Fase 7 — Frontend (Vanilla TS + Tailwind, pt-BR) ✅
- [x] `POST /api/narrative/pages/:id/branch` (ramificar) + testes
- [x] Fontes locais empacotadas (`npm run fonts` → `public/fonts/`), sem CDN
- [x] Temas (4) via variáveis CSS + classe na raiz, persistidos em `localStorage` e na sessão
- [x] Tela inicial: chave da API (validada), modelo padrão (lista real da API), criar/listar/excluir sessões
- [x] Layout: Gaveta de Contexto (Mundo/Regras/Modelo+limite/Crônica), Tome Interativo, Doca de Ação
- [x] Tome com streaming (página fantasma), editar, ver prompt/re-gerar com aviso de descarte, ramificar
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
- [x] Botão **Salvar .md**: `GET /api/sessions/:id/export` (inclui páginas arquivadas; contexto opcional; sem prompts do jogador)
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

## Fase 13 — Páginas (branch `feature/paginas`, mesclada em `main`) ✅
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
- [x] `GET /api/archives/:id/pages` (sob demanda; faixa `covered_page_*`, só arquivadas) + testes
- [x] Painel Contexto → Crônica: "Volume N — páginas X a Y", sinopse, botão **Ler as N páginas** e ícone **Salvar volume em .md**
- [x] Leitor de volume como **página separada** (rota `#/s/<id>/v/<n>`, não modal) com `pageCard` somente leitura, link de volta e ícone de exportar; arquivadas não são editáveis nem ponto de ramificação na UI
- [x] Teste: páginas arquivadas ficam **fora** do contexto da IA/HP/compactação e **dentro** do que o jogador lê e exporta
- [x] Exportador: `---` entre páginas (linhas em branco ao redor), metadados "N páginas"; prompts do jogador continuam fora
- [x] `GET /api/sessions/:id/export?scope=all|active|archived&include_context=` (padrão `all`)
- [x] `GET /api/archives/:id/export?include_summary=` (volume: `# Título — Volume N`, sinopse opcional, páginas)
- [x] Modal "Salvar em Markdown" com escopo (completa · só no Tome · só em volumes) + checkbox de contexto

### 13.4 Os 8 temas (4 temas × claro/escuro)
- [x] Tokens de "folha" por tema/modo em `client/styles.css`
- [x] `test/pageThemes.test.ts` (vitest): contraste WCAG de texto, texto esmaecido e ícones, e distinção folha × fundo nas 8 combinações
- [x] `npm run check:paginas` (Chromium headless): 8 combinações × 1280 px e 390 px — ações visíveis e clicáveis, sem overflow horizontal, páginas sem sobreposição, contraste no DOM renderizado, leitor de volume
- [x] Capturas das 8 combinações (desktop e celular, mais leitor de volume e gaveta) em `docs/screenshots/paginas/` inspecionadas uma a uma
- [x] Testes de UI (jsdom): rótulos novos, ícones sempre visíveis (sem `opacity-0`), número da página, leitor, modal de exportação

### 13.5 Documentação e entrega
- [x] Design document: nova §11.22 (conceito, mapa de renomeação, leitor de volumes, formato do export, sem migração) + notas remissivas nas seções antigas
- [x] README: vocabulário novo, aviso "pré-pré-alpha: atualizações não suportadas, apague `./data`", galeria dos 8 temas
- [x] Suíte completa (198 testes) + typecheck (servidor e cliente) + `npm run build` + imagem Docker reconstruída e testada (build, subida, endpoints, limpeza)
- [x] Merge de `feature/paginas` em `main` (a imagem no GHCR é publicada no push)

## Fase 14 — Mobile: layout, tela cheia e instalável (branch `feature/mobile-app`)
Problemas relatados (Android Chrome): com a barra do navegador visível o campo de digitação fica fora da tela; com o teclado aberto o cabeçalho some e a interface sai de alcance. Decisões do autor: `display: standalone` (mantém a barra de status, sem modo imersivo), botão "Tela cheia" no cabeçalho seguindo o padrão de ícones, alvo Android (testar também com Firefox headless se possível), **somente manifesto** (sem convite/botão de instalação; documentar como instalável "PWA").

### 14.1 Layout que cabe na tela (cabeçalho + digitação sempre visíveis)
- [x] `viewport`: `viewport-fit=cover, interactive-widget=resizes-content`
- [x] `100dvh` (fallback `100vh`) no lugar de `h-screen` nas telas de sessão e leitor de volume; "app shell" (sem rolagem do documento; só a área das páginas rola)
- [x] `client/viewport.ts`: fallback com `visualViewport` (altura útil → `--app-height`) para navegadores que não redimensionam o layout com o teclado
- [x] `env(safe-area-inset-*)` no cabeçalho/dock; biblioteca/home continuam rolando normalmente

### 14.2 Botão "Tela cheia"
- [x] Ícones novos (entrar/sair da tela cheia) em `client/icons.ts`
- [x] Botão no cabeçalho da biblioteca, da sessão e do leitor (padrão `iconButton`, tooltip + `aria-label`, pt-BR), oculto onde a Fullscreen API não existe; alterna rótulo/ícone ao mudar de estado

### 14.3 Instalável (manifesto)
- [x] `public/manifest.webmanifest` (nome, `short_name`, `lang pt-BR`, `start_url`, `scope`, `display: standalone`, cores, ícones)
- [x] Ícones PNG 192/512 + maskable 512 gerados a partir de `favicon.svg` (`scripts/make-icons.ts`, `npm run icons`)
- [x] Metas em `index.html` (`manifest`, `theme-color`, `mobile-web-app-capable`, apple-*) e `theme-color` dinâmico por tema/modo
- [x] Service worker **não necessário**: o Chromium reporta 0 erros de instalabilidade sem ele (verificado via CDP)

### 14.4 Testes
- [x] Vitest: meta viewport, manifesto (campos, arquivos de ícone, Content-Type), `theme-color` por tema, botão de tela cheia
- [x] `npm run check:mobile` (Chromium, 390 px; alturas 844/760/480; 8 temas; sessão e leitor): cabeçalho no topo, dock embaixo, sem rolagem do documento, só a área das páginas rola, textarea visível, sem overflow horizontal, erros de instalabilidade = 0
- [x] Mesma verificação no Firefox headless (`BROWSER=firefox npm run check:mobile`; Firefox 157 do Playwright)
- [x] Capturas inspecionadas (folhas de contato dos 8 temas: sessão com barra, sessão com teclado, leitor com teclado)
- [x] Doca compacta em altura ≤ 520 px (oculta HP/Compactar) para sobrar espaço às páginas com o teclado aberto
- [ ] Confirmação no celular real (Android Chrome) pelo autor

### 14.5 Documentação e entrega
- [x] README (instalável como PWA, HTTPS necessário, `check:mobile`, `icons`) e design document §11.23
- [x] typecheck (servidor e cliente), suíte completa, `npm run build`
- [x] Merge de `feature/mobile-app` em `main`

## Fase 15 — Narração por voz (TTS Gemini 3.8) (branch `feature/tts-narrador`)
Decisões do autor: voz padrão **Gacrux** ("Mature", pré-definida, sem sotaque carioca) com estilo editável; **geração automática por sessão**, herdando um padrão global **desligado**; **sem** reprodução contínua ("ler daqui até o fim", risco de gasto enorme de tokens); MP3 48 kbps via `@breezystack/lamejs` (LGPL-3.0, documentado). Chave de teste validada: `gemini-3.8-flash-tts` funciona (Interactions API, não `generateContent`).

### 15.1 Banco e armazenamento (schema v3, sem migração)
- [x] `SCHEMA_VERSION` 3; tabela `page_audio` (`page_id` PK → `narrative_pages` `ON DELETE CASCADE`, `text_sha256`, `voice`, `model`, `style`, `mime`, `duration_ms`, `bytes`, `audio` BLOB); `sessions.tts_auto` (NULL = herda o padrão global)
- [x] `PRAGMA auto_vacuum = INCREMENTAL` na criação do banco + `incremental_vacuum` após apagar áudios
- [x] Repositório `audio` (get sem blob / com blob, put, delete, stats, purge); leitura valida `text_sha256` (obsoleto = inexistente e apagado)
- [x] Descarte: edição de texto, regeneração e ramificação/exclusão de sessão (CASCADE)

### 15.2 Síntese (servidor)
- [x] `GeminiGateway.synthesize` (Interactions API, `speech_metadata.style`, voz em `speech_config`), mock em `test/helpers.ts`
- [x] Limpeza do texto (markdown/símbolos) e quebra por parágrafos (~1,5 mil caracteres)
- [x] WAV → PCM, silêncio de ~250 ms entre trechos, codificação MP3 48 kbps mono
- [x] Gerenciador de jobs: progresso n/m, cancelamento, máx. 2 simultâneos, retentativas 429/5xx, mensagens pt-BR, descarte do resultado se a página mudou/sumiu durante o job

### 15.3 API
- [x] `POST /api/narrative/pages/:id/audio` (gera/gera de novo), `GET …/audio/status`, `GET …/audio` (MP3 com `Range`), `DELETE …/audio`, `POST …/audio/cancel`
- [x] `GET/PUT /api/settings/tts` (auto padrão, modelo, voz, estilo), `GET /api/audio/usage`, `DELETE /api/audio` (apagar todos), `POST /api/settings/tts/sample`
- [x] `tts_auto` por sessão no `PUT /api/sessions/:id/context`
- [x] Geração automática em segundo plano após cada página do Narrador (inclusive a de fechamento de diálogo); nunca para mensagens de diálogo; desligada por padrão
- [x] Páginas arquivadas (volumes) também podem ser narradas

### 15.4 Interface
- [x] Ícones SVG novos (ouvir, tocar, pausar, regenerar, apagar, baixar, cancelar)
- [x] 4º ícone "Ouvir" sempre visível no cartão; player embutido (tocar/pausar, barra, tempo, velocidade, gerar de novo com aviso, apagar, baixar .mp3); estados gerando n/m e erro
- [x] Um único `<audio>` global (tocar uma página pausa a outra) + Media Session
- [x] Leitor de volume com o botão de áudio
- [x] Gaveta da sessão: geração automática (herdar/ligar/desligar); Biblioteca: configurações de voz (modelo, voz, estilo, amostra, uso de armazenamento, apagar tudo)

### 15.5 Testes
- [x] Vitest (gateway simulado): geração, quebra, MP3 válido, cache (2ª leitura sem API), descarte por edição/regeneração/ramificação/sessão, hash de segurança, corrida, sem áudio em diálogo, auto só quando ligado, Range, auto_vacuum, UI jsdom
- [x] `npm run check:audio` (Chromium e Firefox; 8 temas × desktop/390 px; capturas inspecionadas)
- [x] Teste real com a chave (`scripts/live-tts-e2e.ts`), verificado por transcrição

### 15.6 Documentação e entrega
- [x] README (uso, geração automática, custo/armazenamento, privacidade, LGPL do `lamejs`), design document §11.24
- [x] typecheck (servidor e cliente), suíte completa, `npm run build`
- [x] Remover `samples-tts/`; merge de `feature/tts-narrador` em `main`
