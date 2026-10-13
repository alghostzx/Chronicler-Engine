# Chronicler Engine

> [!IMPORTANT]
> **Projeto 100% gerado por IA.** Todo o código, testes e documentação foram produzidos por um agente de IA no **Antigravity**, com o modelo **Claude Sonnet 5.5 (*thinking* High)**; o papel humano foi definir o rumo, aprovar as decisões e revisar o andamento. Trate o código como qualquer código gerado por IA: revise antes de usar em produção.

Plataforma de escrita e RPG narrativo colaborativo: você conduz a história e o Gemini atua como **Narrador**, escrevendo a prosa em um *Tome* (sem balões de chat). Cada instrução sua gera uma **página**, uma folha separada do livro. Tudo roda localmente, com SQLite: só a geração de texto (e de voz) sai da sua máquina, rumo à API do Gemini.

> [!WARNING]
> **Alpha.** O formato do banco ainda pode mudar. As atualizações costumam ser migradas automaticamente (com cópia `.bak`), mas uma versão futura pode exigir apagar `./data`; salve o que importa com *Salvar em Markdown*. Detalhes em [Instalação e operação](docs/instalacao-e-operacao.md#atualizar-e-migrar-o-banco).

<p align="center">
  <img src="docs/screenshots/02-tome-medieval.png" alt="Tome no tema Medieval escuro, com um diálogo com a NPC Elena em andamento" width="780">
</p>

## Recursos

- **Tome em páginas**: editar, re-gerar, ramificar e ler cada página isoladamente, com streaming em tempo real.
- **Modo Diálogo**: o Narrador abre uma conversa com um NPC de persona isolada; a conversa vira uma página em prosa, com as falas literais.
- **HP do Narrador e compactação**: barra de contexto em tokens reais e sinopses revisáveis; as páginas antigas saem do contexto da IA, mas continuam legíveis e exportáveis.
- **Narração por voz** (opcional): um narrador de voz grave lê as páginas em pt-BR, inclusive em **reprodução contínua**; o áudio fica guardado no SQLite.
- **4 temas × claro/escuro** (8 combinações), fontes empacotadas, sem CDN.
- **Feito para o celular**: a interface cabe na tela, tem **Tela cheia** e é instalável como PWA.
- **Salvar em Markdown**: a crônica inteira, só o Tome ou só os volumes; seus prompts nunca vão no arquivo.

<p align="center">
  <img src="docs/screenshots/03-tome-cyberpunk.png" alt="Tema Cyberpunk escuro, com a barra de HP" width="520">
  &nbsp;
  <img src="docs/screenshots/08-celular-tome.png" alt="Tome no celular, tema Medieval claro" width="180">
</p>

Mais imagens (os 8 temas, diálogos, voz, celular) em [Capturas de tela](docs/capturas-de-tela.md).

## Começando

Você precisa de **Docker** (Compose v2) ou **Podman**, e de uma **chave da API do Gemini** ([Google AI Studio](https://aistudio.google.com/apikey)); ela é informada pela interface, não por arquivo.

```bash
docker run -d --name chronicler-engine --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -v ./data:/data \
  ghcr.io/alghostzx/chronicler-engine:latest
```

Abra <http://localhost:3000>, entre em **Opções**, informe a chave (*Validar e salvar*) e escolha o modelo padrão. Depois, **Nova Crônica** e escreva.

> [!WARNING]
> A interface **não tem autenticação** e o banco guarda a chave da API: por isso a porta é publicada só em `127.0.0.1`. Para acessar de outra máquina, use um proxy reverso com autenticação ou uma VPN.

Docker Compose, Podman, atualização, backup e solução de problemas: [Instalação e operação](docs/instalacao-e-operacao.md). Passo a passo de uso: [Guia de uso](docs/guia-de-uso.md).

## Documentação

| Documento | Conteúdo |
| --- | --- |
| [Guia de uso](docs/guia-de-uso.md) | Primeiro uso, Tome, diálogo, HP, volumes, exportação |
| [Instalação e operação](docs/instalacao-e-operacao.md) | Docker, Podman, segurança, atualização, backup, variáveis, problemas |
| [Narração por voz](docs/narracao-por-voz.md) | Ouvir, geração automática, reprodução contínua, como o áudio é feito |
| [Celular e PWA](docs/celular-pwa.md) | Instalar no celular, tela cheia |
| [Capturas de tela](docs/capturas-de-tela.md) | Galeria completa |
| [Arquitetura](docs/arquitetura.md) | Visão geral, stack, estrutura do código, ciclo de geração, SSE |
| [Narrador](docs/narrador.md) | Payload e isolamento, regras, saída estruturada, HP, compactação |
| [Modo Diálogo](docs/modo-dialogo.md) | Persona do NPC, conclusão narrada, fidelidade, refazer e reprocessar |
| [Interface](docs/interface.md) | Rotas, tela inicial, Tome, cartão de página, temas, acessibilidade |
| [Modelo de dados](docs/modelo-de-dados.md) | Schema SQLite, migrações |
| [API](docs/api.md) | Todas as rotas REST e SSE |
| [Desenvolvimento](docs/desenvolvimento.md) | Rodar localmente, comandos, testes, verificações visuais, convenções |
| [Decisões](docs/decisoes.md) | Por que é assim, invariantes e testes, limites conhecidos |
| [TASKS.md](TASKS.md) | Diário de trabalho para agentes de IA (estado, histórico, pendências) |

## Licença

Distribuído sob a licença **MIT** (veja [`LICENSE`](LICENSE)), com isenção total de garantia e responsabilidade. A narração por voz usa [`@breezystack/lamejs`](https://github.com/breezystack/lamejs), sob **LGPL-3.0**, como biblioteca sem modificações; veja [Desenvolvimento](docs/desenvolvimento.md#licença-das-dependências).
