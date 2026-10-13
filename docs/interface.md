# Interface

Como a interface é organizada e por quê: rotas, tela inicial, Tome e cartões de página, gaveta, temas, controles, comportamento no celular. O cliente é TypeScript puro com Tailwind (sem framework), em [`client/`](../client).

## Rotas (hash)

| Rota | Tela |
| --- | --- |
| `#/` | Tela inicial (menu) |
| `#/continuar`, `#/nova` | Quadros sobrepostos ao menu: lista de crônicas e formulário de nova crônica |
| `#/opcoes` | Opções: conexão com o Gemini, modelo padrão e narração por voz |
| `#/s/<id>` | Sessão (Tome, Gaveta, Doca) |
| `#/s/<id>/v/<n>` | Leitor do volume *n* (páginas consumidas, somente leitura) |

Módulos principais: `api.ts` (tipos, `fetch`, `streamTurn` para POST + SSE), `sse.ts` (*parser* incremental puro), `dom.ts` (helper `h()`, toasts, modais), `theme.ts`, `viewport.ts`, `controls.ts` (botões de ícone, menus), `icons.ts`, `pageCard.ts` e `views/{title,options,session,drawer,compaction,volume,volumeExport,ttsSettings}.ts`.

## Tela inicial

A rota `#/` é uma **tela de título**: logo em arte ASCII, a legenda "Escreva a sua crônica com um Narrador de IA." e o menu **Continuar** / **Nova Crônica** / **Opções**.

- **Logo:** a arte-fonte é o script do autor ([`scripts/logo/echo-chronicler-engine-logo.sh`](../scripts/logo/echo-chronicler-engine-logo.sh)). `npm run logo` ([`scripts/make-logo.ts`](../scripts/make-logo.ts), conversor puro em `scripts/logo/convert.ts`) lê as linhas `echo -e`, mapeia os códigos SGR para a paleta **Srcery**, `█ ▀ ▄` e sombras `░ ▒ ▓` para opacidade 25/50/75 %, e gera SVG de células 1×2 com **um `<path>` por cor** e `shape-rendering: crispEdges` (≈ 8 KB): `public/logo.svg` (faixa única) e `public/logo-stacked.svg` (CHRONICLER sobre ENGINE, para o celular). Os SVGs são versionados e um teste confere que coincidem com a saída do conversor. A tela usa `<h1><picture>` (`max-width: 767px` → empilhado) com `alt`; a imagem ocupa a largura disponível com `max-height` (9 rem; 11 rem no celular), então cabe em qualquer largura.
- **Cores:** fundo escuro fixo na paleta Srcery (sem alternância claro/escuro: as cores brilhantes do logo ficam lavadas em fundo claro). `applyTitleScreen()` liga `theme-srcery mode-dark` no `<html>` **sem gravar** a preferência do usuário; `applyTheme()` (sessão e volume) remove o escopo, então cada crônica volta ao seu tema e modo.
- **Quadros com rotas:** *Continuar* (lista de crônicas, com exclusão confirmada; `aria-disabled` com tooltip quando não há crônicas) e *Nova Crônica* abrem via `openModal` sobre o menu, com fundo escurecido e desfocado. Abrir/fechar é guiado pela rota: o clique empilha uma entrada de histórico e o *voltar* do navegador/Android a desfaz; Esc, clique fora ou *Fechar* fecham pelo histórico. A tela de título é reaproveitada entre `#/`, `#/continuar` e `#/nova`. [`openModal`](../client/dom.ts) tem pilha de modais (Esc fecha só o do topo) e fechamento idempotente.
- **Menu:** botões grandes (≥ 44 px), marcador ▶ no item em foco, setas ↑/↓/Home/End, foco inicial no primeiro item só com ponteiro fino (para não abrir o teclado virtual no toque), `prefers-reduced-motion` desliga o pulso. Enquanto não há chave do Gemini, o menu avisa e o item *Opções* pulsa.
- **Opções** (`#/opcoes`): *Conexão com o Gemini* (chave e modelo padrão) e o cartão *Narração por voz*, com seta de voltar e Tela cheia.

## O Tome e a Doca

Layout da sessão, em três áreas:

1. **Gaveta de Contexto** (painel lateral retrátil): mundo, regras do Narrador (com *Restaurar padrão*), modelo e limite de tokens, aba **Crônica** (volumes) e aba **Voz** (narração automática da crônica).
2. **Tome** (centro): uma folha por página, sem balões de chat.
3. **Doca de Ação** (inferior): barra de **HP**, o botão *Compactar Crônica* (pulsa com HP < 20%) e o campo de entrada (`Enviar` ou `Ctrl+Enter`). Com um diálogo ativo, a Doca vira "Falando com: {NPC}" com *Encerrar diálogo* (destacado quando o NPC sinaliza que quer terminar) e *Descartar*. Entre o Tome e a Doca aparece o banner da [reprodução contínua](narracao-por-voz.md#reprodução-contínua).

**Streaming:** durante a geração uma "página fantasma" recebe os `chunk` (texto + cursor piscante); em `page`/`done` a sessão é recarregada do servidor (fonte única da verdade, inclusive após truncamento). Em re-geração o fantasma ocupa o lugar da página e as posteriores ficam esmaecidas. Se a geração falha, o texto digitado na Doca é preservado.

### Cartão de página

[`client/pageCard.ts`](../client/pageCard.ts): cada página é uma folha separada (`.page-card`: cabeçalho "Página N", corpo em prosa, rodapé de ações), com os tokens por tema `--page-bg`, `--page-border` e `--page-shadow`. A letra capitular aparece só na página 1.

O rodapé tem **uma ação por ícone SVG, sempre visíveis** (nunca dependem de hover), cada uma com `aria-label` e tooltip:

| Ação (aria-label) | Ícone | Efeito |
| --- | --- | --- |
| *Ouvir esta página* | alto-falante | Gera/abre o player da [narração](narracao-por-voz.md) |
| *Reproduzir a partir daqui* | lista com seta de tocar | [Reprodução contínua](narracao-por-voz.md#reprodução-contínua); desabilitado na última página |
| *Editar texto da página* | lápis | Edita dentro do cartão; preserva as seguintes |
| *Editar prompt e re-gerar* | balão com linhas | Modal com o prompt de origem; avisa quantas páginas serão descartadas e envia `confirm_truncate` |
| *Refazer diálogo* | (no lugar de *Editar prompt*, em páginas de diálogo) | [Refazer](modo-dialogo.md#refazer-diálogo-não-destrutivo) |
| *Narrar diálogo* | pena | Só em páginas de diálogo cruas ([Narrar](modo-dialogo.md#narrar-diálogo-reprocessar)) |
| *Ramificar a partir desta página* | bifurcação | Descarta as posteriores, com confirmação; desabilitado na última página |

Ouvir e Reproduzir ficam à esquerda; as demais, à direita. O leitor de volume usa o mesmo componente em modo `readonly`: o rodapé tem só *Ouvir*.

Estados do cartão: edição no próprio cartão (`.is-editing`), página fantasma, páginas esmaecidas (`.is-dimmed`) quando uma re-geração descartará as posteriores, selo "Diálogo com {NPC}" e selo "Será substituída ao encerrar o novo diálogo". Os tooltips do rodapé ancoram na borda e têm largura máxima de 60 vw (tooltips invisíveis também contam para o `scrollWidth`; sem isso o celular ganhava rolagem horizontal).

### Leitor de volume

Página própria (`#/s/<id>/v/<n>`, [`client/views/volume.ts`](../client/views/volume.ts)): cabeçalho com voltar, modo claro/escuro e exportar; cartão de sinopse; páginas em `readonly`; navegação para o volume anterior/seguinte e de volta ao Tome. O Tome mostra, acima das páginas ativas, uma linha com links "Volume N · páginas X a Y"; a aba *Crônica* da gaveta lista cada volume com a sinopse, o botão **Ler as N páginas** e o ícone de salvar o volume (com a caixa *Incluir a sinopse*). O modal *Salvar em Markdown* da sessão tem o escopo: Crônica completa · Só o que está no Tome · Só as páginas já em volumes.

## Temas e modo claro/escuro

Quatro temas, cada um com variação **clara e escura** (8 combinações): Medieval (Pergaminho), Cyberpunk (Neon/Terminal), Pós-apocalíptico (Ferrugem) e Contemporâneo (Minimalista).

- Implementados por **variáveis CSS** em classes do `<html>`: sempre uma de tema (`theme-<tema>`) **e** uma de modo (`mode-light`/`mode-dark`), definidas em [`client/styles.css`](../client/styles.css). As cores semânticas do Tailwind (`main`, `panel`, `ink`, `accent`, `hp-*`…) apontam para essas variáveis.
- O tema é gravado na sessão (`active_theme`) e em `localStorage` (usado na tela inicial). O **modo** é global do navegador (`localStorage: chronicler.mode`): *Automático (sistema)* (padrão; acompanha `prefers-color-scheme`, inclusive em tempo real), *Claro* ou *Escuro*. No modo automático, um sistema claro mostra o Cyberpunk em sua variação clara; para o neon original, escolha *Escuro*.
- Um script inline no `<head>` aplica tema e modo **antes da primeira pintura** (sem *flash*). O `<meta name="theme-color">` acompanha o `--bg-panel` do tema/modo ativo.
- **Fontes** empacotadas por [`scripts/copy-fonts.mjs`](../scripts/copy-fonts.mjs) (subconjunto latino, `woff2` + licenças OFL em `public/fonts/`): nenhuma requisição a CDN.
- Contraste: [`test/pageThemes.test.ts`](../test/pageThemes.test.ts) lê as variáveis reais do CSS e exige WCAG ≥ 4,5:1 para texto, texto forte e texto esmaecido sobre a folha, ≥ 3:1 para ícones e acento e ≥ 1,3:1 para a borda da folha contra o fundo do Tome.

## Controles, tooltips e acessibilidade

- **Botões só com ícone** (cabeçalho, rodapé dos cartões): SVG inline local ([`client/icons.ts`](../client/icons.ts), sem CDN nem fonte de ícones), **um ícone por ação**, glifos distintos, alvo ≥ 32 px (≥ 44 px no menu inicial), sempre visíveis.
- **Tooltips** em CSS puro via `data-tip` + `::after` (classe `.tip`), exibidos ao passar o mouse **e** ao focar com o teclado (`:focus-visible`), com alinhamento `start`/`end` para não vazar da tela. O rótulo acessível é o `aria-label` (estável: *Voltar ao menu inicial*, *Tema visual*, *Modo claro ou escuro*, *Salvar em Markdown*, *Contexto da sessão*…); o tooltip dos menus informa o valor atual. Em telas de toque não há hover, e o `aria-label` permanece.
- **Menus** de tema e modo: botão de ícone que abre um `role=menu` com itens `menuitemradio` (o atual marcado com ✓); fecham com Esc, clique fora, perda de foco ou ao escolher; ↑/↓ navegam. Implementação em [`client/controls.ts`](../client/controls.ts) (`iconButton`, `createMenuControl`, `createThemeControl`, `createModeControl`).
- O cabeçalho da sessão nunca quebra linha: o título é a única parte flexível e trunca com reticências.
- Grades: `grid-cols-1` (`minmax(0,1fr)`) + `min-w-0` nos filhos, para que uma `<option>` longa nunca empurre o cartão para fora da tela no celular; `.input` tem `min-w-0 max-w-full`.

## Celular: app shell, tela cheia e PWA

**Problema (Android/Chrome):** as telas usavam `h-screen` (`100vh` = a maior altura possível, como se a barra do navegador estivesse recolhida), então com a barra visível a Doca ficava fora da tela; e, por padrão, o Chrome Android **não** redimensiona o layout quando o teclado abre: a página rola e o cabeçalho some.

- **App shell** ([`client/viewport.ts`](../client/viewport.ts), `.app-screen` e `html.app-shell` em `styles.css`): nas rotas de sessão e de volume o roteador liga `app-shell` no `<html>` (documento sem rolagem, `overscroll-behavior: none`) e a tela ocupa exatamente a área visível: cabeçalho no topo, Doca embaixo e **só a região das páginas rola** (`#tome-scroll`, `#volume-scroll`). A tela inicial continua com rolagem normal.
- **Altura útil:** a meta `viewport` é `width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content` (o teclado encolhe o layout) e a altura é `100dvh` (`100vh` onde a unidade não existe). Plano B (iOS/Safari, que só encolhe a *janela visual*): `viewport.ts` copia `visualViewport.height` para `--app-height`, devolve o documento ao topo e não interfere durante zoom por pinça. `env(safe-area-inset-*)` protege entalhes e barras de gesto. Com altura ≤ 520 px (teclado aberto, celular deitado), a linha de HP/Compactar da Doca é ocultada.
- **Tela cheia:** [`fullscreenButton()`](../client/controls.ts) no cabeçalho da biblioteca, da sessão e do leitor; usa a Fullscreen API e **não aparece** onde ela não existe (iPhone).
- **PWA mínimo:** [`public/manifest.webmanifest`](../public/manifest.webmanifest) com `display: standalone`, `start_url`/`scope` `/`, `lang pt-BR`, ícones PNG 192/512 e *maskable* 512 em `public/icons/` (gerados de `public/favicon.svg` por `npm run icons`) e metas Android/iOS no `index.html`. **Sem service worker**: o Chromium reporta zero erros de instalabilidade sem ele; não há offline nem cache, nem botão de instalação na UI. Exige HTTPS (ou `localhost`). Guia do usuário: [Celular e PWA](celular-pwa.md).

O favicon ([`public/favicon.svg`](../public/favicon.svg), um tome aberto com uma centelha, mais `favicon.ico` e `apple-touch-icon.png`) é local.

## Verificação

Testes (jsdom executa o bundle real do cliente contra o servidor Fastify numa porta de loopback com Gemini simulado) e verificações visuais em navegador headless estão em [Desenvolvimento](desenvolvimento.md#verificações-visuais). A diferença `100vh` × `100dvh` só existe em navegador móvel real; por isso há um teste estático contra `h-screen`, e a confirmação final é no aparelho.
