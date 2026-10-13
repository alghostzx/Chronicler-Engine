# Guia de uso

Do primeiro acesso à rotina de escrita. Para instalar e subir o servidor, veja [Instalação e operação](instalacao-e-operacao.md); para ouvir as páginas, [Narração por voz](narracao-por-voz.md).

## Primeiro uso

1. No menu inicial, abra **Opções** e informe a chave em *Conexão com o Gemini* (*Validar e salvar*). Enquanto não há chave, o menu avisa e o item *Opções* pulsa. A chave é testada na hora, gravada **apenas** no SQLite local e nunca devolvida ao navegador. Crie uma em [Google AI Studio](https://aistudio.google.com/apikey).
2. Ainda em *Opções*, escolha o **modelo padrão** na lista (ela é consultada na API; *Atualizar* consulta de novo). O padrão inicial é `gemini-3.8-flash`. Volte pelo ícone de seta.
3. Em **Nova Crônica**, dê um título, escolha o tema visual, o limite de tokens do contexto (padrão: 1.000.000) e, se quiser, descreva o mundo e os personagens. Para retomar uma crônica, use **Continuar**.
4. No Tome, descreva o que o seu personagem faz e envie com `Enviar` ou `Ctrl+Enter`. O Narrador responde em prosa, em tempo real.
5. Use o painel **Contexto** (ícone à direita no cabeçalho) para editar mundo e personagens e ler os volumes compactados, **Salvar em Markdown** para exportar, e acompanhe o **HP** na barra inferior: perto de zero, o botão *Compactar Crônica* pulsa.

## O Tome e as páginas

Cada instrução sua gera uma **página**: uma folha separada, numerada (`Página 1`, `Página 2`…). A numeração é absoluta e **não recomeça** depois de uma compactação (o Tome pode começar na "Página 4").

No rodapé de cada página há ícones sempre visíveis, com tooltip:

| Ícone | Ação | O que acontece |
| --- | --- | --- |
| 🔊 | Ouvir esta página | Gera (ou toca) a narração por voz |
| ⋮ | Opções do áudio | Baixar o .mp3, gerar de novo ou apagar a narração (só aparece com áudio pronto) |
| ▶ | Reproduzir a partir daqui | Reprodução contínua (ver [Narração por voz](narracao-por-voz.md#reprodução-contínua)); não aparece na última página |
| ✎ | Editar o texto | Edita dentro do cartão. As páginas seguintes **não** são afetadas |
| 💬 | Editar o prompt e re-gerar | Refaz a página e **descarta as posteriores** (com aviso e contagem) |
| ⑂ | Ramificar a partir desta página | Descarta as posteriores para você continuar dali (desabilitado na última página) |

Nas páginas de diálogo, o 💬 vira *Refazer diálogo*, e as que ainda estão como transcrição crua ganham a pena 🪶 *Narrar diálogo* (veja abaixo). A lista exata de ações e seus estados está em [Interface](interface.md#cartão-de-página).

Editar o texto de uma página apaga o áudio dela (o áudio guardado deixa de corresponder ao texto).

## Modo Diálogo

O Narrador pode abrir uma conversa com um NPC. O NPC é uma persona isolada, que **não conhece o resto da história** (nem os segredos que o Narrador não lhe contou); o Narrador escolhe o nome dele e como você será chamado na cena.

- Você conversa pela Doca, que passa a mostrar "Falando com: NPC". Recarregar a página retoma a cena.
- Quem encerra é você: **Encerrar diálogo** ou **Descartar**. O NPC apenas *sinaliza* que quer terminar, destacando o botão.
- Ao encerrar, a conversa **vira uma página** (selo *Diálogo com …*): o Narrador escreve a prosa em volta das falas, que ficam **literais**, em discurso direto e sem rótulos de falante. Se ele alterar alguma fala, tenta de novo (até 3 vezes); no pior caso a conversa é salva como transcrição crua (`**Nome:** fala`), com um aviso.
- **Narrar diálogo** (pena) transforma uma página crua (do fallback ou de versões antigas) em prosa, **sem mexer nas páginas seguintes**, porque as falas, e portanto a história, não mudam.
- **Refazer diálogo** abre uma nova conversa com o mesmo NPC **sem apagar nada**: a página antiga (e as seguintes) só são substituídas quando você encerra o novo diálogo. *Descartar* mantém tudo como estava.
- Compactar fica indisponível durante um diálogo.

Os detalhes (sigilo, verificação de fidelidade, por que prosa e não transcrição) estão em [Modo Diálogo](modo-dialogo.md).

## HP, compactação e volumes

A barra de **HP** mostra quanto do limite de tokens do contexto ainda está livre (verde, amarelo, vermelho). Quando fica baixa, o botão **Compactar Crônica** pulsa:

1. O app gera uma **minuta de sinopse** das páginas mais antigas (cerca de 75% do peso do texto, sempre preservando ao menos a última página).
2. Você **revisa e edita** a minuta e consolida.
3. As páginas consumidas viram um **volume**: saem do contexto da IA (e do HP), e a sinopse entra no mundo da crônica.

As páginas dos volumes **continuam legíveis**: o painel *Contexto → Crônica* lista cada volume, com a sinopse, o botão **Ler as N páginas** (uma tela própria, somente leitura, com navegação entre volumes) e o ícone para salvar o volume. Elas não podem ser editadas nem usadas como ponto de ramificação, mas podem ser narradas por voz e exportadas. Mais em [Narrador](narrador.md).

## Contexto e opções da crônica

No painel **Contexto** (gaveta à direita), abas para:

- **Mundo e personagens**: o texto que o Narrador recebe como contexto fixo (as sinopses dos volumes são anexadas aqui);
- **Regras do Narrador**: as instruções de sistema, com o botão *Restaurar padrão*;
- **Modelo e limite**: modelo Gemini da crônica (padrão global ou escolha própria) e o limite de tokens;
- **Crônica**: os volumes;
- **Voz**: geração automática de áudio (herdar do padrão global, ligada ou desligada).

## Temas e modo claro/escuro

São **4 temas** (Medieval, Cyberpunk, Pós-apocalíptico, Contemporâneo), cada um em variação clara e escura: 8 combinações, todas verificadas em um navegador headless. O tema é escolhido por crônica (ícone de paleta no cabeçalho); o modo (*Automático*, *Claro*, *Escuro*) é uma preferência do navegador e, por padrão, segue o sistema. Exemplos em [Capturas de tela](capturas-de-tela.md).

## Exportar em Markdown

O ícone **Salvar em Markdown** do cabeçalho exporta a crônica em `.md`, com as páginas separadas por `---`:

- **Escopo:** crônica completa, só o que está no Tome ou só as páginas já em volumes;
- **Contexto:** opção de incluir o mundo e as sinopses;
- **Volume avulso:** cada volume também pode ser salvo sozinho, com ou sem a sinopse.

Seus prompts (as instruções que você deu ao Narrador) **nunca** vão no arquivo. As rotas estão em [API](api.md).

## No celular

A interface cabe exatamente na tela (cabeçalho no topo, campo de digitação embaixo e só a área das páginas rola), tem botão **Tela cheia** e pode ser instalada como PWA. Veja [Celular e PWA](celular-pwa.md).
