# Capturas de tela

Galeria completa da interface. As imagens são geradas por script (veja [Verificações visuais](desenvolvimento.md#verificações-visuais)) com um Gemini simulado e uma história de exemplo: nenhuma chave real é usada.

## Visão geral

| | |
| --- | --- |
| ![Tela inicial com o logo e o menu](screenshots/01-tela-inicial.png) | ![Tema Cyberpunk escuro](screenshots/03-tome-cyberpunk.png) |
| **Tela inicial**: logo Srcery, legenda e menu | **Cyberpunk (escuro)** com a barra de HP |
| ![Painel de contexto no tema Contemporâneo claro](screenshots/04-contexto-contemporaneo.png) | ![Menu de temas](screenshots/05-tema-menu.png) |
| **Contemporâneo (claro)** com o painel de Contexto aberto | **Menu de tema** (o de modo claro/escuro funciona igual) |
| ![Tooltip de um botão de ícone](screenshots/06-tooltip.png) | ![Gaveta com um volume, e o Tome continuando na página 4](screenshots/paginas/volumes-gaveta.png) |
| **Tooltips** em todos os botões de ícone | **Volumes**: a numeração das páginas continua (aqui, Página 4 e 5) e o volume pode ser lido ou salvo |
| ![Quadro Continuar sobre o menu](screenshots/09-continuar.png) | ![Quadro Nova Crônica sobre o menu](screenshots/10-nova-cronica.png) |
| **Continuar**: lista de crônicas em um quadro sobre o menu | **Nova Crônica**: formulário em um quadro sobre o menu |
| ![Página de Opções](screenshots/11-opcoes.png) | ![Tome no tema Medieval escuro, com um diálogo em andamento](screenshots/02-tome-medieval.png) |
| **Opções**: conexão com o Gemini e narração por voz | **Medieval (escuro)** com um diálogo com a NPC Elena em andamento |

## Diálogos

| | |
| --- | --- |
| ![Página de diálogo, com o selo e as falas em destaque](screenshots/paginas/dialogo-medieval-light.png) | ![Refazendo um diálogo: página alvo marcada, seguintes esmaecidas](screenshots/paginas/dialogo-refazendo-desktop.png) |
| **Página de diálogo**: o Narrador escreve a prosa em volta das falas, que ficam literais (selo, ícone *Refazer diálogo*) | **Refazer diálogo**: nada é apagado até encerrar o novo diálogo |
| ![Página de diálogo crua, com o ícone Narrar diálogo](screenshots/paginas/dialogo-cru-desktop.png) | |
| **Transcrição crua** (fallback ou página antiga): a pena *Narrar diálogo* a reescreve em prosa | |

Veja [Modo Diálogo](modo-dialogo.md).

## As páginas nos 8 temas

4 temas × claro e escuro (gerado por `npm run check:paginas`):

| | Claro | Escuro |
| --- | --- | --- |
| **Medieval** | ![Medieval claro](screenshots/paginas/medieval-light.png) | ![Medieval escuro](screenshots/paginas/medieval-dark.png) |
| **Cyberpunk** | ![Cyberpunk claro](screenshots/paginas/cyberpunk-light.png) | ![Cyberpunk escuro](screenshots/paginas/cyberpunk-dark.png) |
| **Pós-apocalíptico** | ![Pós-apocalíptico claro](screenshots/paginas/pos-apocaliptico-light.png) | ![Pós-apocalíptico escuro](screenshots/paginas/pos-apocaliptico-dark.png) |
| **Contemporâneo** | ![Contemporâneo claro](screenshots/paginas/contemporaneo-light.png) | ![Contemporâneo escuro](screenshots/paginas/contemporaneo-dark.png) |

## Leitor de volume

Páginas já consumidas pela crônica, somente leitura:

<p>
  <img src="screenshots/paginas/volume-cyberpunk-dark.png" alt="Leitor de volume no tema Cyberpunk escuro" width="560">
  &nbsp;
  <img src="screenshots/paginas/volume-medieval-light-celular.png" alt="Leitor de volume no celular, tema Medieval claro" width="170">
</p>

## Narração por voz

Gerado por `npm run check:audio`:

| | |
| --- | --- |
| ![Geração do áudio em andamento (Medieval claro)](screenshots/audio/medieval-light-desktop-gerando.png) | ![Player de áudio (Cyberpunk escuro)](screenshots/audio/cyberpunk-dark-desktop-player.png) |
| **Gerando** o áudio da página (progresso n/m, cancelar) | **Barra do player** (fixa, acima da Doca): tocar/pausar, posição, velocidade e fechar |
| ![Reprodução contínua (Medieval claro)](screenshots/audio/medieval-light-desktop-continuo.png) | ![Reprodução contínua no celular (Cyberpunk escuro)](screenshots/audio/cyberpunk-dark-celular-continuo.png) |
| **Reprodução contínua**: a mesma barra com anterior/próxima, a página atual e *Interromper* | A mesma tela no celular |
| ![Menu Opções do áudio (Medieval escuro)](screenshots/audio/medieval-dark-desktop-menu.png) | ![Leitor de volume com a barra do player (Cyberpunk escuro, celular)](screenshots/audio/cyberpunk-dark-celular-volume.png) |
| **Opções do áudio** no rodapé da página: baixar, gerar de novo, apagar | **Leitor de volume**: a barra fica fixa no fim da tela |
| ![Cartão de configurações de voz (Medieval claro)](screenshots/audio/medieval-light-desktop-config-voz.png) | ![Aba Voz da gaveta (Medieval escuro)](screenshots/audio/medieval-dark-desktop-gaveta-voz.png) |
| **Opções → Narração por voz**: voz, modelo, estilo, amostra e armazenamento | **Aba Voz** da gaveta: geração automática por crônica |

Veja [Narração por voz](narracao-por-voz.md).

## No celular

Sem rolagem horizontal:

<p>
  <img src="screenshots/07-celular-tela-inicial.png" alt="Tela inicial no celular" width="260">
  &nbsp;
  <img src="screenshots/08-celular-tome.png" alt="Tome com diálogo no celular, tema Medieval claro" width="260">
</p>

Veja [Celular e PWA](celular-pwa.md) e [Interface](interface.md#celular-app-shell-tela-cheia-e-pwa).
