# Celular e PWA

O Chronicler Engine é um **PWA instalável** (tem manifesto web e ícones): dá para adicioná-lo à tela de aplicativos do celular e abri-lo **sem a barra do navegador**, como um aplicativo (mantém a barra de status). Não é um PWA completo: **não funciona offline nem sem o servidor**.

## Instalar

- **Android (Chrome):** abra o endereço do servidor, menu ⋮ → *Instalar app* (ou *Adicionar à tela inicial*).
- **iPhone (Safari):** *Compartilhar* → *Adicionar à Tela de Início*.
- **Requer HTTPS** (ou `localhost`): o navegador só oferece a instalação em origem segura. Atrás de um proxy reverso com certificado (por exemplo `https://game.example.com`) funciona; em `http://IP-da-rede-local:3000` o Chrome apenas cria um atalho comum.

> [!WARNING]
> Para abrir o servidor de outro aparelho, ponha **autenticação** na frente (proxy reverso ou VPN): a interface não tem login e o banco guarda a chave da API. Veja [Instalação e operação](instalacao-e-operacao.md#segurança).

## Tela cheia sem instalar

O botão de ícone **Tela cheia** do cabeçalho esconde a barra do navegador (onde o navegador permite; o iPhone não tem essa API, então lá use a instalação).

## Comportamento no celular

- No Tome e no leitor de volume a interface cabe exatamente na tela: cabeçalho no topo, campo de digitação embaixo e **só a área das páginas rola**, com a barra do navegador ou o teclado abertos.
- A cor da barra de status acompanha o tema e o modo (claro/escuro) ativos.
- A tela inicial empilha o logo em duas linhas.

## Narração com a tela apagada

A [reprodução contínua](narracao-por-voz.md#reprodução-contínua) usa as teclas de mídia e a tela de bloqueio (*próxima/anterior*). Isso **não foi testado em celular real**: navegadores móveis podem suspender o JavaScript com a tela apagada, e a continuidade nesse caso depende do navegador.

Detalhes técnicos (app shell, `100dvh`, `visualViewport`): [Interface](interface.md#celular-app-shell-tela-cheia-e-pwa).
