# TASKS.md — diário para agentes de IA

> **Público:** agentes (LLMs) que trabalham neste repositório. Não é documentação para usuários (isso é o [README](README.md) e a pasta [`docs/`](docs)). Aqui está tudo que um agente precisa saber para continuar o projeto: o que existe, o que foi feito, o que falta, as regras de trabalho e as armadilhas conhecidas.
>
> **Mantenha este arquivo atualizado** ao final de cada fase: atualize o "Estado atual", acrescente uma linha ao histórico e mova pendências. Conteúdo técnico detalhado vai no documento do tema em `docs/`, **não aqui**.

## Resumo do projeto

**Chronicler Engine**: app web local de escrita/RPG narrativo. O jogador escreve instruções; o Gemini é o **Narrador** e responde em prosa, uma **página** por instrução, num *Tome*. Fastify + `better-sqlite3` no servidor; TypeScript puro + Tailwind 3 no cliente (bundle esbuild em `public/assets/`, ignorado pelo git); SQLite como único armazenamento (inclusive áudio). Interface em pt-BR. Repositório público (`github.com/alghostzx/Chronicler-Engine`, MIT), 100% gerado por IA; cada *push* em `main` reconstrói a imagem do GHCR. Schema atual: **v5**. Node ≥ 22.

## Mapa de documentação (fonte da verdade)

| Assunto | Documento |
| --- | --- |
| Visão geral, stack, estrutura do código, ciclo de geração, SSE, Docker | [`docs/arquitetura.md`](docs/arquitetura.md) |
| Payload do Narrador, regras, saída estruturada, páginas, HP, compactação, export | [`docs/narrador.md`](docs/narrador.md) |
| Modo Diálogo (persona, conclusão narrada, fidelidade, refazer, reprocessar) | [`docs/modo-dialogo.md`](docs/modo-dialogo.md) |
| Schema, migrações, histórico de versões | [`docs/modelo-de-dados.md`](docs/modelo-de-dados.md) |
| Rotas REST/SSE (**verificadas por `check:docs`**) | [`docs/api.md`](docs/api.md) |
| Narração por voz e reprodução contínua | [`docs/narracao-por-voz.md`](docs/narracao-por-voz.md) |
| Interface, temas, cartão de página, celular | [`docs/interface.md`](docs/interface.md), [`docs/celular-pwa.md`](docs/celular-pwa.md) |
| Instalação, segurança, backup, variáveis de ambiente | [`docs/instalacao-e-operacao.md`](docs/instalacao-e-operacao.md) |
| Comandos, testes, verificações visuais, convenções | [`docs/desenvolvimento.md`](docs/desenvolvimento.md) |
| Por quês, **invariantes e seus testes**, limites conhecidos | [`docs/decisoes.md`](docs/decisoes.md) |

O antigo *design document* (um arquivo único com especificação + diário de decisões numerado) foi **desmembrado nesses documentos e removido**; não procure por referências de seção numerada.

## Regras de trabalho (acordadas com o autor)

- **Idioma:** responder ao autor em **pt-BR**, de forma concisa, em Markdown. Código em inglês/português como já está; interface e docs em pt-BR.
- **Git:** funcionalidade nova em ramo `feature/...` (ou de tópico: `docs/...`) com **commits parciais**; depois *merge* em `main` com `--no-ff`. **`git push` e remoção de ramo só depois de perguntar ao autor e receber o aval** (ele diz "make it so" / "punch it"). Comandos de escrita do git, vitest, navegadores, npm e `tsx` com rede precisam rodar **fora do sandbox**.
- **Segredos:** nunca imprimir nem versionar a chave do Gemini. `GEMINIKEY.txt`, `data/`, `*.db*` e `public/assets/` são ignorados pelo git. Apagar artefatos temporários locais.
- **Honestidade:** declarar o que não pôde ser verificado (celular real, áudio ouvido, iOS). Ver [Limites conhecidos](docs/decisoes.md#limites-conhecidos).
- **Comentários:** preservar comentários e docstrings que não tenham relação com a mudança. Comentários de código apontam para `docs/*.md`.
- **Documentação:** cada mudança de comportamento atualiza **só o documento do tema** (e este arquivo, se mudar o estado). Rode `npm run check:docs` (também roda no `npm test`).
- **Migrações:** mudou o schema? Crie a migração ([como](docs/modelo-de-dados.md#como-criar-uma-migração)); só quebrar o banco quando migrar for muito trabalhoso.
- **Fim de cada fase:** `npm test`, `npm run typecheck`, `npm run typecheck:client`, `npm run build`; e, se mexeu na UI, as verificações visuais relevantes.

### Armadilhas conhecidas (de sessões anteriores)

- Em *shell*, crase dentro de aspas duplas é substituída por comando: para edições multilinha, use *heredocs* de Python/arquivos, não `echo "...`x`..."`.
- `npm run check:*` abrem Chromium e levam 1–3 min: rode em segundo plano e consulte depois. Eles **regravam dezenas de PNGs** com diferenças irrelevantes: reverta com `git checkout -- docs/screenshots/<pasta>` e mantenha só as capturas novas e significativas.
- A saída das ferramentas pode dobrar barras invertidas; confira o arquivo real antes de concluir que há um erro.
- Não há `GET /api/audio/usage`: o `usage` do armazenamento de áudio vem dentro de `GET`/`PUT /api/settings/tts` e de `DELETE /api/audio`.
- `countTokens` da Developer API **rejeita** `systemInstruction`: as regras são contadas como texto somado ao conteúdo.
- Podman: `up -d --build` pode manter o contêiner antigo; use `--force-recreate`.

## Estado atual (capacidades)

Tudo abaixo está **implementado e testado** (suíte Vitest; `check:*` em Chromium, alguns também em Firefox):

- **Núcleo narrativo:** payload isolado (só prosa), saída JSON estruturada com `propertyOrdering`, SSE com parse incremental, edição direta, regeneração com truncamento atômico, ramificar, trava de concorrência por sessão.
- **HP e compactação:** `countTokens` real com cache por hash; cisão 75/25 por peso; minuta de sinopse revisável; volumes (`chronicle_archives`); páginas arquivadas legíveis e exportáveis.
- **Modo Diálogo:** persona isolada e sigilosa; conclusão **narrada** (prosa com falas literais, verificação de fidelidade, até 3 tentativas, *fallback* para transcrição crua); *Narrar diálogo* (reprocessar crua sem tocar nas seguintes); *Refazer* não destrutivo.
- **Voz:** Gemini TTS pela Interactions API; MP3 48 kbps no SQLite; trechos de 1500 caracteres; geração automática (global/por crônica, com opção própria para diálogos); **reprodução contínua** com modal de faltantes, geração em segundo plano e banner.
- **Interface:** tela inicial (logo Srcery), Opções, Tome em cartões de página, gaveta de contexto, leitor de volume, 4 temas × claro/escuro, app shell no celular, tela cheia, PWA instalável (sem service worker).
- **Entrega:** imagem multi-stage (Node 22 Alpine), Docker e Podman rootless validados, encerramento gracioso, migrações automáticas com backup (v3→v4→v5).

## Pendências e riscos abertos

Nenhuma fase está em andamento. O que resta é, em geral, **validação que só o autor pode fazer** ou decisão futura:

- [ ] Confirmar no **celular real** (Android Chrome; iOS/Safari) o layout, a instalação PWA e a reprodução contínua com a tela bloqueada.
- [ ] O autor **ouvir** a narração dos diálogos narrados e avaliar a qualidade literária/efeito no TTS.
- [ ] Modelos `gemma-*` aparecem no seletor, mas `systemInstruction`/JSON não foram testados com eles.
- [ ] `npm audit`: 7 vulnerabilidades, todas em dependências de **desenvolvimento** (produção: 0).
- [ ] A verificação de fidelidade do diálogo é heurística (palavras e ordem; ignora pontuação e não vê palavras acrescentadas dentro de uma fala).
- Ideias sem compromisso: nenhuma registrada pelo autor no momento. Antes de propor algo novo, leia [Decisões](docs/decisoes.md): várias "funcionalidades óbvias" foram recusadas de propósito (ex.: reprodução contínua automática sem confirmar custo).

## Histórico por fase (todas concluídas)

| Fase | Entrega | Onde ler hoje |
| --- | --- | --- |
| 0 | Scaffold (`package.json`, `tsconfig`, Fastify, `/api/health`, `.gitignore`) | [Arquitetura](docs/arquitetura.md) |
| 1 | Banco e repositórios (schema idempotente, WAL, `user_version`) | [Modelo de dados](docs/modelo-de-dados.md) |
| 2 | Configurações e sessões; `models.list` com cache; validação estrita de corpo | [API](docs/api.md) |
| 3 | Núcleo narrativo: `contextBuilder`, JSON estruturado, SSE, regenerar/editar | [Narrador](docs/narrador.md) |
| 4 | HP: `countTokens` real, estados verde/amarelo/vermelho, cache por hash | [Narrador](docs/narrador.md#hp-do-narrador) |
| 5 | Modo Diálogo (persona isolada, `/message`, `/conclude`, `/cancel`, reconexão) | [Modo Diálogo](docs/modo-dialogo.md) |
| 6 | Compactação (75/25, preview sem efeitos, commit transacional) | [Narrador](docs/narrador.md#compactação-livro-de-crônicas) |
| 7 | Frontend (temas, gaveta, Tome com streaming, HP, diálogo, revisão da sinopse) | [Interface](docs/interface.md) |
| 8 | Docker/Podman (multi-stage, entrypoint com `su-exec`, compose) | [Arquitetura](docs/arquitetura.md#empacotamento-docker) |
| 9 | Verificação final com a API real (`scripts/live-*.ts`) | [Desenvolvimento](docs/desenvolvimento.md#verificações-visuais) |
| 10 | Favicon, claro/escuro, **Salvar .md** | [Narrador](docs/narrador.md#exportação-em-markdown) |
| 11 | Cabeçalho só com ícones, menus de tema/modo, responsividade | [Interface](docs/interface.md#controles-tooltips-e-acessibilidade) |
| 12 | README, capturas, `SIGTERM` gracioso, Docker validado | [Capturas](docs/capturas-de-tela.md) |
| 13 | **Páginas** (bloco → página, cartão por página, volumes legíveis, export por escopo, 8 temas) | [Interface](docs/interface.md#cartão-de-página) |
| 14 | Mobile: app shell (`100dvh`, `visualViewport`), tela cheia, PWA | [Celular e PWA](docs/celular-pwa.md) |
| 15 | Narração por voz (TTS, MP3 no SQLite, geração automática) | [Narração por voz](docs/narracao-por-voz.md) |
| 16 | Tela inicial de jogo (logo Srcery, quadros, Opções) | [Interface](docs/interface.md#tela-inicial) |
| 17 | Diálogo como página + **migrações reais** (schema v4) | [Modo Diálogo](docs/modo-dialogo.md), [Modelo de dados](docs/modelo-de-dados.md#migrações) |
| 18 | Diálogo narrado + reprocessar cruas (schema v5; chunk TTS volta a 1500) | [Modo Diálogo](docs/modo-dialogo.md#narrar-diálogo-reprocessar) |
| 19 | Reprodução contínua (rotas de lote, controlador, banner, Media Session) | [Narração por voz](docs/narracao-por-voz.md#reprodução-contínua) |
| 20 | Revisão geral da documentação: README enxuto, `docs/` por tema, `check:docs`, fim do design document | [Desenvolvimento](docs/desenvolvimento.md#checkdocs) |

Cada fase seguiu o mesmo ritmo: rascunho aprovado pelo autor → ramo → commits parciais → testes + verificação visual → *merge* `--no-ff` → *push* só com aval.

## Verificação (comandos)

```bash
npm test                    # Vitest (inclui test/docs.test.ts = check:docs)
npm run typecheck && npm run typecheck:client
npm run build               # servidor (dist/) + cliente (public/assets/)
npm run check:docs          # links, âncoras e rotas da documentação
npm run check:paginas       # 8 temas, cartão de página (Chromium)
npm run check:mobile        # layout 390 px, 3 alturas, 8 temas
npm run check:audio         # voz e reprodução contínua
npm run check:inicio        # tela inicial e Opções, 320–1920 px
```

Estado da suíte ao fim da Fase 20: **358 testes** (27 arquivos) passando; `check:audio` e `check:paginas` 16/16 na última execução (Fase 19).
