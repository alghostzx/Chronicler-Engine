# Desenvolvimento

Como rodar o projeto localmente, o que cada comando faz, como é a verificação e quais convenções valem para quem contribui (pessoa ou agente).

> [!IMPORTANT]
> O projeto é **100% gerado por IA** (código, testes e documentação), em sessões do Antigravity com o modelo Claude Sonnet 5.5 (*thinking* High), com um humano definindo o rumo, aprovando as decisões e revisando. O histórico de commits e o [`TASKS.md`](../TASKS.md) registram o processo.

## Rodando localmente

Requer **Node.js ≥ 22**.

```bash
npm install
npm run build:client   # gera public/assets (app.js e app.css)
npm run dev            # servidor com recarga em http://127.0.0.1:3000
```

`public/assets/` é gerado (e ignorado pelo git): rode `npm run build:client` depois de mexer em `client/`.

## Comandos

| Comando | O que faz |
| --- | --- |
| `npm run dev` | Servidor com recarga (`tsx watch`) |
| `npm test` | Suíte de testes (Vitest; Gemini mockado, UI em jsdom) |
| `npm run typecheck` / `typecheck:client` / `typecheck:test` | Verificação de tipos do servidor / do cliente / dos testes e scripts |
| `npm run typecheck:all` | Roda todas as verificações de tipos do projeto |
| `npm run build` | Compila o servidor (`dist/`) e o cliente (`public/assets/`) |
| `npm run build:server` / `npm run build:client` | Cada metade do build |
| `npm start` | Executa o build de produção |
| `npm run fonts` | Reempacota as fontes de `@fontsource/*` em `public/fonts/` ([`scripts/copy-fonts.mjs`](../scripts/copy-fonts.mjs)) |
| `npm run icons` | Regenera os ícones PNG do manifesto (`public/icons/`) a partir de [`public/favicon.svg`](../public/favicon.svg) |
| `npm run logo` | Regenera `public/logo.svg` e `public/logo-stacked.svg` a partir da arte ANSI em [`scripts/logo/echo-chronicler-engine-logo.sh`](../scripts/logo/echo-chronicler-engine-logo.sh) ([`scripts/make-logo.ts`](../scripts/make-logo.ts)) |
| `npm run screenshots` | Regenera `docs/screenshots/` com um Chromium headless e um Gemini simulado |
| `npm run check:docs` | Valida os links e âncoras dos documentos e a tabela de rotas de [`api.md`](api.md) (ver abaixo) |
| `npm run check:paginas` / `check:mobile` / `check:audio` / `check:inicio` | Verificações visuais em navegador headless (ver abaixo) |

## Variáveis de ambiente

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `PORT` | `3000` | Porta HTTP |
| `HOST` | `127.0.0.1` (`0.0.0.0` no contêiner) | Interface de escuta |
| `DATABASE_PATH` | `./data/chronicler.db` (`/data/chronicler.db` no contêiner) | Arquivo SQLite |
| `PUBLIC_DIR` | `./public` | Diretório do frontend estático |
| `TTS_MAX_RPM` | `10` | Chamadas por minuto à API de voz do Gemini (limite do tier; veja [Narração por voz](narracao-por-voz.md#limites-conhecidos)) |

A chave da API é configurada pela interface (e gravada no banco local). O arquivo `GEMINIKEY.txt`, usado apenas pelos scripts `scripts/live-*.ts`, está no `.gitignore`, assim como `data/`, `*.db*` e `public/assets/`.

## Testes

`npm test` roda o Vitest em `test/`. O Gemini é sempre simulado ([`test/helpers.ts`](../test/helpers.ts): `makeApp`, `withKey`, `FakeGateway`); a UI roda em **jsdom executando o bundle real do cliente contra o servidor Fastify** numa porta de loopback.

| Área | Arquivos principais (`test/<nome>.test.ts`) |
| --- | --- |
| Saúde, configurações e sessões | `health`, `settings`, `sessions` |
| Núcleo narrativo e estabilidade | `contextBuilder`, `narrative`, `narrativeStream`, `tokens`, `compaction`, `stability` (`TurnRunner.withClaim` e timeout de 30 s) |
| Diálogo | `dialogue`, `dialogueProse` |
| Páginas, volumes e exportação | `archives`, `export`, `repositories`, `pageThemes` |
| Banco | `repositories`, [`migrations.test.ts`](../test/migrations.test.ts) (usa [`test/fixtures/schemaV3.ts`](../test/fixtures/schemaV3.ts)) |
| Voz e limitador de taxa | `ttsUnits`, `rateLimiter`, `audio`, `continuousPlayback` |
| Interface | `ui`, `uiAudio`, `uiContinuous`, `clientSse`, `clientTheme`, `mobile`, `static`, `logo` |
| Documentação | `docs` (executa o `check:docs`) |

Os testes que protegem as regras inegociáveis do projeto estão listados em [Decisões](decisoes.md#invariantes-e-os-testes-que-os-protegem).

## Verificações visuais

O jsdom não calcula layout, então há scripts que abrem um **Chromium headless** (via `playwright-core`) contra o app com SQLite em memória e Gemini simulado. Eles usam o navegador do Playwright em `~/.cache/ms-playwright` ou `CHROME_PATH=…`; `BROWSER=firefox` roda no Firefox do Playwright (onde suportado). Cada um leva de 1 a 3 minutos.

| Script | O que verifica | Capturas em |
| --- | --- | --- |
| `check:paginas` | Cartão de página nos 8 temas (claro/escuro × 1280 px e 390 px): numeração, ações visíveis, clicáveis e distintas, contraste calculado no DOM, sem rolagem horizontal, sem sobreposição, tooltip, edição no cartão, leitor de volume, página de diálogo (narrada × crua) | `docs/screenshots/paginas/` |
| `check:mobile` | Layout do celular (390 px; alturas de tela cheia, com barra do navegador e com teclado) na sessão e no leitor, nos 8 temas: cabeçalho no topo, doca embaixo, só a área das páginas rola, campo visível, `theme-color`, manifesto instalável | `docs/screenshots/mobile/` |
| `check:audio` | Narração por voz nos 8 temas × desktop/celular: ícone *Ouvir*, progresso, menu *Opções do áudio*, barra do player (reprodução real do MP3, uma página e modo contínuo com anterior/próxima), tooltips, leitor de volume, aba *Voz*, cartão em *Opções*. `ONLY=medieval-light-desktop` roda só as combinações listadas | `docs/screenshots/audio/` |
| `check:inicio` | Tela inicial e *Opções* (vazio × com chave e crônicas; 320–1920 px): logo, contraste, alvos de 44 px, teclado, quadros (Esc, *Voltar*, *Fechar*, foco) e a volta ao tema da crônica | `docs/screenshots/inicio/` (não versionadas) |

> [!NOTE]
> Rodar `check:paginas` ou `check:audio` regrava dezenas de PNGs com diferenças irrelevantes. Antes de commitar, reverta o que não mudou de verdade (`git checkout -- docs/screenshots/<pasta>`) e mantenha só as capturas novas e significativas.

Scripts de verificação **com a API real** (exigem `GEMINIKEY.txt`; fora da suíte): `scripts/live-models.ts`, `live-narrative.ts`, `live-tokens.ts`, `live-compaction.ts`, `live-dialogue.ts` e `live-tts-e2e.ts` (este transcreve o MP3 com um modelo de texto para conferir a fidelidade do português).

### `check:docs`

[`scripts/check-docs.ts`](../scripts/check-docs.ts) mantém a documentação sem links mortos. Ele confere:

- todo link e imagem relativos de `README.md`, `TASKS.md`, `AGENTS.md` e `docs/*.md` aponta para um arquivo existente;
- toda âncora `#seção` existe no arquivo de destino (regras de *slug* do GitHub);
- a tabela de rotas de [`api.md`](api.md) bate exatamente com as rotas registradas em `src/routes/*.ts` e `src/server.ts`;
- não restam referências ao antigo design document (nem ao arquivo, nem ao símbolo de seção numerada) no código, nos testes e nos documentos.

Ele também roda dentro de `npm test` (`test/docs.test.ts`).

## Receitas de manutenção

### Como adicionar ou alterar uma rota

1. **Onde registrar:** coloque a rota no arquivo da área correspondente em `src/routes/<área>.ts`. Se criar um módulo novo de rotas, registre `registerXRoutes(app, ctx)` em [`src/server.ts`](../src/server.ts).
2. **Formato exigido pelo `check:docs`:** declare sempre `app.get('/api/...', ...)` (ou `post`/`put`/`delete`/`patch`, com ou sem tipo genérico `app.get<{ Params: IdParams }>('/api/...')`) usando **aspas simples** no caminho literal. A regex de [`scripts/check-docs.ts`](../scripts/check-docs.ts) extrai as rotas do código por esse padrão.
3. **Validação, guardas e erros:**
   - Em schemas de `body`, inclua sempre `additionalProperties: false` (o Fastify está configurado para rejeitar campos desconhecidos com `400`).
   - Reutilize os helpers de [`src/routes/common.ts`](../src/routes/common.ts): `idParams` (schema de `:id`), `requireSession(repos, id)`, `requirePage(repos, id)` (devolvem `404`), `assertNoActiveDialogue(repos, sessionId)`, `assertNotArchived(page, action)` e `assertNotBusy(turns, sessionId, message?)` (devolvem `409`).
   - Para erros de domínio, lance `new HttpError(statusCode, message, code?)` de [`src/context.ts`](../src/context.ts). O `setErrorHandler` de `server.ts` formata `{ error, code? }` e também traduz `MissingApiKeyError` em `409 { error, code: 'missing_api_key' }`.
   - Se a rota iniciar uma geração na sessão, envolva toda a preparação e execução em `await turns.withClaim(session.id, async () => { ... })`.
4. **Documentação e testes:**
   - Acrescente ou atualize a linha correspondente na tabela de [`docs/api.md`](api.md) (primeira coluna no formato `` `METHOD /api/...` ``).
   - Adicione testes em `test/<área>.test.ts` usando `const t = await makeApp()` (ou `await withKey(t.app)` quando precisar de chave configurada) de [`test/helpers.ts`](../test/helpers.ts) e chamadas `t.app.inject({ method, url, payload })`.
   - Rode `npm run check:docs`, `npm run typecheck:all` e `npm test`.

### Como criar uma migração de schema

Siga os 5 passos detalhados em [Modelo de dados — Como criar uma migração](modelo-de-dados.md#como-criar-uma-migração) (incluindo a atualização do array de tabelas em `test/migrations.test.ts`).

## Integração Contínua (CI)

O workflow [`.github/workflows/docker-publish.yml`](../.github/workflows/docker-publish.yml) dispara em todo *push* na branch `main` e em tags `v*.*.*`:

1. **Job `check` (gate de qualidade):** em `ubuntu-latest` com Node 22, executa `npm ci`, `npm run typecheck:all` (servidor, cliente, testes e scripts), `npm test` e `npm run check:docs`.
2. **Job `build-and-push` (`needs: check`):** só roda se `check` passar; constrói a imagem Docker multi-stage (que executa `npm run build` no estágio `builder`) e publica no GitHub Container Registry (`ghcr.io/alghostzx/chronicler-engine`).

## Convenções do projeto

- **Fluxo de trabalho:** funcionalidades novas em um ramo `feature/…` (ou de tópico), com commits parciais, e *merge* em `main` com `--no-ff`. Bugfixes e pequenos patches (ex.: ajustes pontuais ou documentação) podem ser commitados diretamente em `main`. Cada *push* em `main` passa pelo job `check` e reconstrói a imagem do GHCR.
- **Documentação:** cada assunto vive em **um** documento de `docs/` (índice no [README](../README.md#documentação)). Ao mudar o comportamento, atualize só o documento do tema e rode `npm run check:docs`; não crie um novo "diário" por funcionalidade. O [`TASKS.md`](../TASKS.md) é o diário para agentes (e [`AGENTS.md`](../AGENTS.md) é o ponto de entrada rápido).
- **Segredos:** a chave do Gemini nunca é impressa nem versionada.
- **Migrações:** mudou o schema? Veja [como criar uma migração](modelo-de-dados.md#como-criar-uma-migração).
- **Contêineres:** detalhes em [Instalação e operação](instalacao-e-operacao.md) e [Arquitetura](arquitetura.md#empacotamento-docker).

## Licença das dependências

O projeto é MIT. A narração por voz codifica MP3 com [`@breezystack/lamejs`](https://github.com/breezystack/lamejs) (porte do LAME), **LGPL-3.0**, usado como biblioteca, sem modificações e instalado pelo `npm`; quem redistribuir o pacote deve manter o aviso de licença da dependência.
