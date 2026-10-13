# Narração por voz

Cada página pode ser **lida em voz alta** por um narrador de voz grave e pausada (padrão: voz *Gacrux* do Gemini TTS, em português do Brasil). É opcional e **desligada por padrão**. Este documento cobre o uso, a reprodução contínua e o funcionamento interno.

## Como ouvir

Clique no ícone de alto-falante (**Ouvir esta página**) no rodapé de qualquer página, do Tome ou do leitor de volume (páginas já coletadas em crônicas também). O áudio é gerado com progresso (*gerando n/m*) e botão de cancelar; depois aparece o **player**: tocar/pausar, barra de posição e tempo, velocidade 0,75×–1,5× (lembrada no navegador), **gerar de novo**, apagar e **baixar .mp3**. O áudio fica guardado.

- **Gerar de novo:** se a voz não ficou boa, *Gerar o áudio de novo* (com confirmação) substitui o anterior; o antigo só é descartado quando o novo fica pronto.
- **Cache:** o MP3 (48 kbps, mono; ≈ 6 KB por segundo, ~360 KB por minuto) fica no SQLite, então ouvir de novo não gasta nada. É **descartado automaticamente** quando a página é editada, re-gerada ou removida por ramificação, e o espaço volta ao arquivo do banco.
- Páginas de **diálogo** também podem ser ouvidas. As falas soltas durante a conversa em andamento nunca são narradas.

## Geração automática

Opcional e desligada por padrão: a opção global **Narrar automaticamente cada página nova** fica no cartão *Narração por voz* da página **Opções**; cada crônica pode **herdar** esse padrão ou forçar *ligada*/*desligada* na aba **Voz** da gaveta de contexto. As páginas criadas ao encerrar um diálogo têm uma opção **própria** (global e por crônica, também desligada de fábrica), separada da narrativa.

## Configuração

Na página **Opções**: voz (30 vozes pré-definidas do Gemini, com o traço de cada uma), modelo (`gemini-3.8-flash-tts` padrão ou `gemini-3.8-flash-lite-tts`, mais barato), **estilo** (ritmo e tom; padrão `voz grave, rouca e pausada de um velho narrador`; a idade e o sotaque vêm da escolha da voz, não do estilo), **Ouvir amostra**, *Restaurar padrão*, uso de armazenamento e *Apagar todos os áudios*. Os valores globais ficam em `app_settings` (`tts_auto_default`, `tts_auto_dialogue_default`, `tts_model`, `tts_voice`, `tts_style`).

## Reprodução contínua

O botão **Reproduzir a partir daqui** (em cada página do Tome, menos a última; não existe no leitor de volume) toca em sequência, no mesmo reprodutor, da página clicada (inclusive) até a última página ativa. A lista é **fixada ao iniciar**: páginas novas criadas durante a reprodução não entram.

**Nunca é automático.** Se alguma página da faixa não tem áudio (ou a geração falhou), o app pergunta antes, listando as páginas ("Páginas 4 a 9 ainda não têm áudio") e avisando do custo em tokens (aviso em destaque acima de 10 páginas):

| Opção | O que faz |
| --- | --- |
| **Gerar e reproduzir** | Gera as faltantes em segundo plano, em ordem, e toca a página clicada assim que ficar pronta; cada página seguinte toca quando a anterior termina, esperando a geração se for preciso. A geração é cerca de 4× mais rápida que a reprodução, então costuma ficar à frente de quem ouve |
| **Só reproduzir as que já têm** | Toca as páginas consecutivas que já têm áudio e **para na primeira sem áudio, sem pular nenhuma**. Se a própria página clicada não tem áudio, avisa que não há o que tocar |
| **Cancelar** | Não faz nada |

Se nada falta, começa direto (esperando só o que ainda estiver sendo gerado).

Enquanto roda:

- Um **banner** acima da Doca mostra *Reproduzindo «crônica» em modo contínuo*, a página atual (*Página N · i de M*) e o estado: tocando, pausado, aguardando a narração da Página N, gerando K páginas em segundo plano ou "para na Página X, que não tem áudio".
- O botão **Interromper** do banner só para a reprodução. **As gerações já iniciadas seguem em segundo plano** (não há pergunta de cancelar).
- O player aberto é o **da própria página que está tocando**: a cada troca ele abre (o modo fecha o que ele mesmo abriu) e o Tome rola até o cartão.
- As **teclas de mídia e a tela de bloqueio** ganham *próxima/anterior* (Media Session) enquanto o modo roda; *anterior* volta ao início da página se já passaram 3 s.
- Tocar **outra página** pelo botão *Ouvir* dela encerra o modo; clicar *Reproduzir a partir daqui* durante o modo reinicia a partir da nova página; sair da tela encerra em silêncio.
- Se a geração de uma página falhar, a reprodução segue até chegar nela, para e avisa o erro.
- Durante o lote de geração não aparece um aviso "ficou pronta" por página.

> [!NOTE]
> **Custo e privacidade.** O texto da página é enviado ao Google (Gemini TTS) e o áudio é cobrado como tokens de saída da sua chave (cerca de 1,5 mil tokens por minuto de áudio; veja a tabela de preços do modelo). Gerar dezenas de páginas custa de verdade, por isso a reprodução contínua sempre pergunta. Nomes inventados podem sair com pronúncia criativa: a IA lê, não conhece o seu mundo.

## Como o áudio é feito

### API do Gemini

Os modelos `gemini-3.8-flash-tts` e `gemini-3.8-flash-lite-tts` só funcionam bem pela **Interactions API** (`ai.interactions.create`, `response_format: { type: 'audio' }`, voz em `generation_config.speech_config`, estilo como anotação `speech_metadata` no texto). Em `generateContent` o estilo escrito no texto é lido em voz alta e `systemInstruction` é rejeitado. A resposta unária é WAV 24 kHz mono 16 bits. `GeminiGateway.synthesize` ([`src/ai/gateway.ts`](../src/ai/gateway.ts)) normaliza os erros (`SynthesisError`, com `retryable` para 429/5xx/rede) em mensagens pt-BR; o *timeout* de cada síntese é de 3 min. As vozes da *Voice Library* e do *Voice Design* foram experimentadas e **não** são usadas (o Voice Design criaria recursos persistentes na conta do usuário).

### Pipeline ([`src/tts/`](../src/tts))

1. `cleanForSpeech` remove Markdown e símbolos (o modelo trata o texto como transcrição literal), preservando os parágrafos (viram pausas).
2. `splitForSpeech` quebra o texto em pedaços de ≈ **1.500 caracteres** (`DEFAULT_CHUNK_CHARS`), por parágrafos/sentenças, **sempre entre parágrafos**. Cada pedaço é uma chamada independente (o modelo recomeça a prosódia a cada um). Como as páginas de diálogo são prosa com falas em travessão, sem `**Nome:**`, o corte não faz mais o modelo ler nomes ([Modo Diálogo](modo-dialogo.md#por-que-prosa-e-falas-literais)).
3. Cada pedaço é sintetizado, o WAV decodificado ([`pcm.ts`](../src/tts/pcm.ts)), os pedaços são unidos com ≈ 250 ms de silêncio e codificados em **MP3 48 kbps mono** ([`mp3.ts`](../src/tts/mp3.ts), `@breezystack/lamejs`, cedendo o laço de eventos entre blocos): ≈ 6 KB/s, 8× menor que o WAV.

### `AudioService` ([`src/tts/service.ts`](../src/tts/service.ts))

Um job por página, com progresso n/m e cancelamento; fila FIFO com **no máximo 2 sínteses simultâneas**; retentativas (2 s, 6 s, 15 s) em 429/5xx/rede; o áudio antigo só é substituído quando o novo fica pronto; e o resultado de um job é descartado se a página mudou ou sumiu enquanto ele rodava (conferido pelo hash do texto).

### Armazenamento e descarte

A tabela `page_audio` ([modelo de dados](modelo-de-dados.md)) guarda o MP3; os blobs **nunca** vão nas listagens (o JSON traz só metadados em `page.audio`). O áudio é descartado ao editar o texto, re-gerar (apaga o da página e cancela jobs dela e das seguintes, na mesma transação do descarte), ramificar (cancela os jobs das páginas removidas), excluir a sessão (cascata + cancelamento) e *Narrar diálogo*. Páginas de volumes continuam narráveis.

### Cliente

Há **um único `<audio>`** no app ([`client/audioPlayer.ts`](../client/audioPlayer.ts)): tocar uma página pausa a outra; integra com a Media Session; a reprodução para ao sair da tela ou quando a página perde o áudio. Os controles de cada página ([`client/audioUi.ts`](../client/audioUi.ts)) só refletem esse estado. A reprodução contínua é uma máquina de estados sem DOM ([`client/continuousPlayback.ts`](../client/continuousPlayback.ts)) sobre o mesmo `<audio>`: encadeia no evento `ended` carregando a próxima faixa direto no evento; se a próxima ainda está em geração, **espera** (consulta `GET /api/sessions/:id/audio` a cada 1,5 s, só enquanto necessário) e toca quando ficar pronta. Termina por: conclusão, interrupção, *takeover* (o usuário tocou outra página), parada externa (página editada ou apagada), geração com erro, áudio ausente ao chegar, falha de reprodução ou saída da tela. O banner e o modal vivem em [`client/continuousUi.ts`](../client/continuousUi.ts).

## Limites conhecidos

- Não foi possível *ouvir* o áudio no ambiente de desenvolvimento: a qualidade da voz é julgada pelo autor (a transcrição do MP3 confirma o texto, e um modelo descreveu a voz como masculina, grave, em português brasileiro neutro). Nomes inventados podem ser pronunciados de modo criativo.
- A reprodução contínua não foi testada em celular real (tela bloqueada, iOS). Navegadores móveis podem suspender o JavaScript com a tela apagada, e a continuidade nesse caso depende do navegador. Pode haver uma pausa curta entre páginas, enquanto o próximo MP3 carrega.
- ≈ 25 s de áudio levam 10–12 s para gerar.
