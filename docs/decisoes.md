# Decisões, invariantes e limites

Por que o projeto é do jeito que é. Este documento guarda o **raciocínio** por trás das escolhas (o "como" está nos documentos de cada tema), as regras que os testes protegem e o que **não foi possível verificar**. Ele substitui o antigo *design document*.

## Decisões de produto e de projeto

| Decisão | Por quê |
| --- | --- |
| **Tome em páginas, não balões de chat** | O objetivo é escrever uma história, não conversar. Cada instrução do jogador gera uma folha de prosa que pode ser editada, refeita, ramificada, narrada e exportada isoladamente. A palavra "bloco" foi aposentada por "página" ([Interface](interface.md#cartão-de-página)) |
| **Numeração absoluta de páginas** | `Página N` = `order_index`, nunca reaproveitado. Após compactar, o total da crônica não se perde |
| **Só a prosa vai ao Narrador** | Os prompts passados do jogador nunca entram no contexto: o corpus é feito apenas do texto gerado, sem metadados. Evita que "esboços" antigos contaminem a cena ([Narrador](narrador.md)) |
| **Páginas consumidas continuam legíveis** | A compactação tira as páginas do contexto da IA, não do banco: você pode relê-las, ouvi-las e exportá-las |
| **Compactação com revisão humana** | A sinopse é uma *minuta* que o jogador edita antes de consolidar; nada é gravado no preview |
| **Cisão 75/25 por peso, não por contagem** | Páginas têm tamanhos muito diferentes; o que importa é o peso em tokens |
| **HP por eventos, sem polling** | A contagem de tokens é uma chamada de API: só roda quando algo muda, com cache por hash do conteúdo |
| **Uma geração por sessão por vez** | Simplicidade e consistência do banco; concorrência devolve `409` |
| **Gravar só depois do sucesso** | Falha de geração ou desconexão do cliente nunca altera páginas; truncamento + substituição ocorrem numa única transação |
| **Edição manual preserva as páginas seguintes** | Só regenerar via IA descarta o futuro (e avisa). Corrigir uma vírgula não deve custar a história |
| **Sem autenticação, porta só em loopback** | Uso local, usuário único; a chave fica em texto plano no SQLite. Para acesso remoto, proxy reverso com autenticação ([Instalação e operação](instalacao-e-operacao.md#segurança)) |
| **Interface em pt-BR fixo, sem CDN** | Fontes e ícones empacotados localmente: o app funciona sem requisições a terceiros (além do Gemini) |
| **TypeScript puro + Tailwind, sem framework** | Superfície pequena, bundle simples (esbuild), nenhuma dependência de runtime no cliente |
| **Node ≥ 22** | O `better-sqlite3` 13 exige; a imagem usa `node:22-alpine` |
| **SQLite como único armazenamento** | Inclusive o áudio (BLOB): backup é copiar `./data` |
| **Sem service worker** | O Chromium não exige um para a instalabilidade (verificado via CDP). O app não funciona offline, então um SW só traria risco de cache velho |
| **Tela inicial em Srcery fixo** | O logo ASCII usa cores brilhantes que ficam lavadas em fundo claro; cada crônica volta ao seu tema |
| **Alpha: migrar enquanto for barato** | A partir do schema v4 há migrações automáticas com backup; o banco só é quebrado quando migrar for muito trabalhoso ou inchar o programa ([Modelo de dados](modelo-de-dados.md#migrações)) |

### Modo Diálogo

| Decisão | Por quê |
| --- | --- |
| **Persona isolada do NPC** | O NPC só conhece o próprio prompt e as falas da cena: não há vazamento do corpus nem de meta-instruções. O `dynamic_system_prompt` nunca é devolvido pela API |
| **Quem encerra é o jogador** | O NPC apenas sinaliza (`npc_wants_to_end`); a decisão de terminar a cena é do autor |
| **Diálogo vira página** | Em vez de o Narrador "reinterpretar" a conversa e perder o texto, o diálogo executado permanece como página |
| **Prosa com falas literais, não transcrição crua** | A transcrição `**Nome:** fala` fazia a voz *ler os nomes dos falantes* e quebrava a narrativa; o Narrador escreve só o tecido conectivo e as falas ficam intactas e verificadas ([Modo Diálogo](modo-dialogo.md#por-que-prosa-e-falas-literais)) |
| **3 tentativas, depois transcrição crua** | Equilíbrio entre qualidade e custo. Não existe "encerrar sem narrar": o pior caso é um fallback com aviso |
| **Refazer é não destrutivo** | A página antiga e as seguintes só mudam quando o novo diálogo é encerrado e gravado |
| **Reprocessar não toca nas páginas seguintes** | As falas, e portanto a história, permanecem; só o tecido conectivo muda |

### Voz

| Decisão | Por quê |
| --- | --- |
| **Interactions API para o TTS** | Os modelos `*-tts` só funcionam bem por ela: em `generateContent` o estilo escrito no texto é lido em voz alta e `systemInstruction` é rejeitado |
| **Voz pré-definida (Gacrux), não Voice Library/Voice Design** | As vozes testadas antes tinham sotaque carioca indesejado; o Voice Design criaria recursos persistentes na conta do usuário |
| **MP3 48 kbps mono no SQLite** | ≈ 6 KB/s, 8× menor que o WAV; ouvir de novo é grátis. `auto_vacuum = INCREMENTAL` devolve o espaço de áudios descartados |
| **Áudio vinculado ao hash do texto** | Editar o texto invalida o áudio; um job que termina depois de a página mudar é descartado |
| **Trechos de 1500 caracteres, cortados entre parágrafos** | Cada trecho é uma chamada independente; como o diálogo agora é prosa sem rótulos, o corte não faz o modelo ler nomes. 1500 é o valor original, restaurado depois da fase do diálogo cru |
| **Geração automática desligada por padrão** | Gerar áudio custa tokens; só acontece a pedido (ou pela opção, que é por crônica, com padrão global; uma só, que vale para prosa e diálogo) |
| **Reprodução contínua: sempre com pergunta** | Faltando áudio, o app pergunta antes de gerar (com aviso de custo reforçado acima de 10 páginas). A ideia de "ler daqui até o fim" automática foi recusada no início justamente pelo risco de gasto; voltou como botão explícito |
| **Interromper só para a reprodução** | As gerações já iniciadas seguem no servidor: o dinheiro já foi gasto e o áudio fica pronto para depois |
| **Um único `<audio>` global** | Tocar uma página pausa a outra; o modo contínuo reaproveita o player da própria página e as teclas de mídia ganham próxima/anterior |

## Invariantes e os testes que os protegem

Regras que não podem regredir. Cada uma tem testes que falham se ela for quebrada.

| # | Invariante | Testes |
| --- | --- | --- |
| 1 | **Nunca** enviar prompts de jogador passados no payload de geração de novas páginas | [`test/contextBuilder.test.ts`](../test/contextBuilder.test.ts), [`test/narrative.test.ts`](../test/narrative.test.ts) |
| 2 | A geração **força** o `responseSchema` JSON e envia as regras como `systemInstruction` (`responseJsonSchema` em `src/ai/narrator.ts`) | [`test/narrative.test.ts`](../test/narrative.test.ts) |
| 3 | Regenerar uma página passada trunca via `DELETE … WHERE order_index > ?`, só depois da resposta da IA, numa transação, e só com `confirm_truncate` | [`test/narrative.test.ts`](../test/narrative.test.ts), [`test/ui.test.ts`](../test/ui.test.ts) |
| 4 | O HP vem da contagem **real** de tokens (`ai.models.countTokens`), nos limiares exatos de verde/amarelo/vermelho | [`test/tokens.test.ts`](../test/tokens.test.ts) |
| 5 | A sub-sessão de diálogo **não altera as páginas** até o `/conclude` gravar a página narrada (falas literais verificadas); "refazer" só substitui a página antiga ao encerrar | [`test/dialogue.test.ts`](../test/dialogue.test.ts), [`test/dialogueProse.test.ts`](../test/dialogueProse.test.ts) |
| 6 | O `dynamic_system_prompt` do NPC nunca sai pela API | [`test/dialogue.test.ts`](../test/dialogue.test.ts) |
| 7 | Páginas arquivadas ficam **fora** do contexto da IA, do HP e da compactação, mas **dentro** do que o jogador lê e exporta | [`test/archives.test.ts`](../test/archives.test.ts) |
| 8 | Prompts do jogador **nunca** são exportados | [`test/export.test.ts`](../test/export.test.ts) |
| 9 | Contraste WCAG nos 8 temas (texto ≥ 4,5:1; ícones e acento ≥ 3:1) | [`test/pageThemes.test.ts`](../test/pageThemes.test.ts), `npm run check:paginas` |
| 10 | O schema migrado é idêntico ao schema novo, os dados são preservados e há rollback e backup | [`test/migrations.test.ts`](../test/migrations.test.ts) |
| 11 | Áudio de texto que mudou é tratado como inexistente; descartes devolvem espaço ao arquivo | [`test/audio.test.ts`](../test/audio.test.ts) |
| 12 | A chave da API nunca é devolvida por nenhum endpoint | [`test/settings.test.ts`](../test/settings.test.ts) |

## Limites conhecidos

O que **não** foi (ou não pôde ser) verificado, e riscos aceitos:

- **Sem aparelho real.** O layout do celular foi verificado só em Chromium e Firefox headless, emulando altura e teclado. A diferença `100vh` × `100dvh` e o teclado de verdade só existem em navegador móvel real (por isso há um teste estático contra `h-screen`); a confirmação final no Android/iOS cabe ao autor. O mesmo vale para a reprodução contínua com a tela bloqueada: navegadores móveis podem suspender o JavaScript.
- **Ninguém "ouviu" o áudio durante o desenvolvimento.** A fidelidade foi conferida por transcrição do MP3 e a qualidade da voz é julgada pelo autor. Nomes inventados podem sair com pronúncia criativa (ex.: "Varn" foi transcrito como "Warnak"/"Varne"). Custo estimado: ≈ 1,5 mil tokens de saída por minuto de áudio. O encadeamento entre páginas pode ter um intervalo curto (carregar o próximo MP3).
- **Qualidade literária do diálogo narrado.** A verificação ao vivo mostrou o fluxo funcionando (9 s na primeira tentativa, fidelidade `ok`), mas o resultado estético e o efeito no TTS não foram ouvidos.
- **Fidelidade é uma heurística.** `checkDialogueFidelity` confere palavras e ordem (ignora caixa, acentos e pontuação); não vê pontuação e pode não perceber palavras *acrescentadas* dentro de uma fala.
- **Modelos `gemma-*`** aparecem no seletor, mas `systemInstruction` e modo JSON não foram testados com eles.
- **`countTokens` não aceita `systemInstruction`** na Gemini Developer API: as regras são contadas como texto somado ao conteúdo (diferença de poucos tokens de moldura).
- **`npm audit`** acusa 7 vulnerabilidades, todas em dependências de **desenvolvimento** (a instalação de produção tem 0).
- **Sem autenticação.** É uma decisão, não um descuido; veja a seção de segurança.
- **Alpha:** uma versão futura pode voltar a exigir apagar `./data` se migrar for inviável; a mensagem de erro da inicialização avisa.
