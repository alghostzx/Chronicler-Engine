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
| `npm run typecheck` / `npm run typecheck:client` | Verificação de tipos do servidor / do cliente |
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

A chave da API é configurada pela interface (e gravada no banco local). O arquivo `GEMINIKEY.txt`, usado apenas pelos scripts `scripts/live-*.ts`, está no `.gitignore`, assim como `data/`, `*.db*` e `public/assets/`.

## Testes

`npm test` roda o Vitest em `test/`. O Gemini é sempre simulado (`test/helpers.ts`); a UI roda em **jsdom executando o bundle real do cliente contra o servidor Fastify** numa porta de loopback.

| Área | Arquivos principais |
| --- | --- |
| Núcleo narrativo | `contextBuilder`, `narrative`, `narrativeStream`, `tokens`, `compaction` |
| Diálogo | `dialogue`, `dialogueProse` |
| Páginas, volumes e exportação | `archives`, `export`, `repositories`, `pageThemes` |
| Banco | `repositories`, [`migrations.test.ts`](../test/migrations.test.ts) |
| Voz | `ttsUnits`, `audio`, `continuousPlayback` |
| Interface | `ui`, `uiAudio`, `uiContinuous`, `clientSse`, `clientTheme`, `mobile`, `static`, `logo` |
| Documentação | `docs` (executa o `check:docs`) |

Os testes que protegem as regras inegociáveis do projeto estão listados em [Decisões](decisoes.md#invariantes-e-os-testes-que-os-protegem).

## Verificações visuais

O jsdom não calcula layout, então há scripts que abrem um **Chromium headless** (via `playwright-core`) contra o app com SQLite em memória e Gemini simulado. Eles usam o navegador do Playwright em `~/.cache/ms-playwright` ou `CHROME_PATH=…`; `BROWSER=firefox` roda no Firefox do Playwright (onde suportado). Cada um leva de 1 a 3 minutos.

| Script | O que verifica | Capturas em |
| --- | --- | --- |
| `check:paginas` | Cartão de página nos 8 temas (claro/escuro × 1280 px e 390 px): numeração, ações visíveis, clicáveis e distintas, contraste calculado no DOM, sem rolagem horizontal, sem sobreposição, tooltip, edição no cartão, leitor de volume, página de diálogo (narrada × crua) | `docs/screenshots/paginas/` |
| `check:mobile` | Layout do celular (390 px; alturas de tela cheia, com barra do navegador e com teclado) na sessão e no leitor, nos 8 temas: cabeçalho no topo, doca embaixo, só a área das páginas rola, campo visível, `theme-color`, manifesto instalável | `docs/screenshots/mobile/` |
| `check:audio` | Narração por voz nos 8 temas × desktop/celular: ícone *Ouvir*, progresso, player (reprodução real do MP3), tooltips, leitor de volume, aba *Voz*, cartão em *Opções* e o fluxo de reprodução contínua | `docs/screenshots/audio/` |
| `check:inicio` | Tela inicial e *Opções* (vazio × com chave e crônicas; 320–1920 px): logo, contraste, alvos de 44 px, teclado, quadros (Esc, *Voltar*, *Fechar*, foco) e a volta ao tema da crônica | `docs/screenshots/inicio/` (não versionadas) |

> [!NOTE]
> Rodar `check:paginas` ou `check:audio` regrava dezenas de PNGs com diferenças irrelevantes. Antes de commitar, reverta o que não mudou de verdade (`git checkout -- docs/screenshots/<pasta>`) e mantenha só as capturas novas e significativas.

Scripts de verificação **com a API real** (exigem `GEMINIKEY.txt`; fora da suíte): `scripts/live-models.ts`, `live-narrative.ts`, `live-tokens.ts`, `live-compaction.ts`, `live-dialogue.ts` e `live-tts-e2e.ts` (este transcreve o MP3 com um modelo de texto para conferir a fidelidade do português).

### `check:docs`

[`scripts/check-docs.ts`](../scripts/check-docs.ts) mantém a documentação sem links mortos. Ele confere:

- todo link e imagem relativos de `README.md`, `TASKS.md` e `docs/*.md` aponta para um arquivo existente;
- toda âncora `#seção` existe no arquivo de destino (regras de *slug* do GitHub);
- a tabela de rotas de [`api.md`](api.md) bate exatamente com as rotas registradas em `src/routes/*.ts` e `src/server.ts`;
- não restam referências ao antigo design document (nem ao arquivo, nem ao símbolo de seção numerada) no código, nos testes e nos documentos.

Ele também roda dentro de `npm test` (`test/docs.test.ts`).

## Convenções do projeto

- **Fluxo de trabalho:** funcionalidades novas em um ramo `feature/…` (ou de tópico), com commits parciais, e *merge* em `main` com `--no-ff`. Cada *push* em `main` reconstrói a imagem do GHCR.
- **Documentação:** cada assunto vive em **um** documento de `docs/` (índice no [README](../README.md#documentação)). Ao mudar o comportamento, atualize só o documento do tema e rode `npm run check:docs`; não crie um novo "diário" por funcionalidade. O [`TASKS.md`](../TASKS.md) é o diário para agentes.
- **Segredos:** a chave do Gemini nunca é impressa nem versionada.
- **Migrações:** mudou o schema? Veja [como criar uma migração](modelo-de-dados.md#como-criar-uma-migração).
- **Contêineres:** detalhes em [Instalação e operação](instalacao-e-operacao.md) e [Arquitetura](arquitetura.md#empacotamento-docker).

## Licença das dependências

O projeto é MIT. A narração por voz codifica MP3 com [`@breezystack/lamejs`](https://github.com/breezystack/lamejs) (porte do LAME), **LGPL-3.0**, usado como biblioteca, sem modificações e instalado pelo `npm`; quem redistribuir o pacote deve manter o aviso de licença da dependência.
