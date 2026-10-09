# Chronicler Engine — Design Document & Technical Specification

> **Status:** Pronto para Implementação  
> **Target:** Antigravity / Coding Agent  
> **Stack Principal:** Node.js (TypeScript), Fastify, SQLite (`better-sqlite3`), Tailwind CSS, Gemini API SDK (`@google/genai`)  
> **Deployment:** Contêiner Docker único (Single-User, Local Server)

---

## 1. Visão Geral do Produto

### 1.1 Proposta de Valor
O **Chronicler Engine** é uma plataforma web de escrita e RPG narrativo colaborativo entre um usuário humano (que atua como Diretor/Coautor) e a IA (Gemini, atuando como Narrador e Cronista). O objetivo central é gerar prosa literária imersiva, controlada e contínua, onde o jogador define as ações e rumos do enredo, enquanto a IA expande essas diretrizes em texto descritivo e diálogos, **sem nunca avançar a trama além da intenção expressa pelo usuário**.

### 1.2 Princípios Fundamentais
1. **Soberania do Autor:** A IA é uma ferramenta de prosa; ela não toma decisões executivas sobre o destino dos personagens a menos que explicitamente instruída a fazê-lo.
2. **Contexto sem Ruído (Clean Corpus):** As meta-instruções do jogador (*"deixe mais sombrio"*, *"descreva o quarto"*) são usadas exclusivamente para gerar o bloco da vez e **nunca** são reinjetadas no histórico global, preservando a pureza literária da história.
3. **Curadoria e Plasticidade:** Todo o texto gerado, o contexto base e as regras de narração são editáveis na unha ou via novas instruções. Editar um ponto do passado descarta o futuro subsequente para criar uma nova linha temporal contínua.
4. **Visibilidade de Recursos (HP do Narrador):** O consumo da janela de contexto é exposto como um elemento gamificado (Barra de Vida/Mana do Narrador), com um fluxo nativo de compactação editorial assistida.
5. **Autonomia Local:** Operação em servidor próprio via Docker, sem telas de login/senhas, com persistência direta em banco local SQLite montado em volume.

---

## 2. Arquitetura de Contexto & Integração com Gemini

### 2.1 Estrutura do Payload de Contexto
A cada turno em que o Narrador é invocado, o payload enviado à API do Gemini deve ser construído estritamente segundo o pipeline abaixo:

```
┌─────────────────────────────────────────────────────────────┐
│ 1. SYSTEM INSTRUCTION (Regras Imutáveis de Narração)        │
├─────────────────────────────────────────────────────────────┤
│ 2. WORLD CONTEXT (Cenário, Personagens, Sinopse Base)       │
├─────────────────────────────────────────────────────────────┤
│ 3. CORPUS NARRATIVO CONSOLIDADO                             │
│    (Concatenação em ordem cronológica de todos os blocos    │
│     ativos como um texto contínuo de prosa)                 │
├─────────────────────────────────────────────────────────────┤
│ 4. INPUT DO JOGADOR (Ação / Esboço da Próxima Cena)         │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Isolamento de Meta-Instruções Passadas
* Cada bloco narrativo no banco de dados armazena o `player_instruction` que lhe deu origem para fins de auditoria e re-geração.
* Contudo, ao solicitar a geração do Bloco $N+1$, **apenas o `generated_text` dos blocos $1 \dots N$ é enviado no item 3**. Os prompts anteriores do jogador são omitidos da chamada.

### 2.3 System Prompt do Narrador (Base Canônica)
```markdown
Você é o Cronista e Narrador de uma história colaborativa literária.
Seu papel é expandir as ações, diálogos e esboços fornecidos pelo Usuário em prosa rica, imersiva e detalhada.

REGRAS RÍGIDAS DE CONDUTA:
1. NÃO AVANCE A HISTÓRIA ALÉM DO ESBOÇO DO JOGADOR. Se o jogador descreveu "eu entro na taverna e peço uma bebida", narre a entrada, o ambiente, a reação das pessoas e o pedido da bebida. PARE no momento em que a ação for concluída. Nunca decida o que acontece em seguida sem a entrada do jogador.
2. MANTENHA O TOM E O ESTILO definidos no Contexto do Mundo.
3. MODO DIÁLOGO DINÂMICO: Se a cena alcançar um confronto interpessoal intenso ou se o jogador tiver solicitado explicitamente um diálogo direto em seu comando, você deve preencher o campo `dialogue_trigger` na resposta estruturada, gerando o briefing operacional completo para que o NPC possa ser interpretado.
4. RESPONDA EXCLUSIVAMENTE no formato JSON estruturado especificado.
```

### 2.4 Esquema de Saída Estruturada do Narrador (JSON Schema)
A API do Gemini deve ser chamada com `responseSchema` ativado:

```json
{
  "type": "object",
  "properties": {
    "narrative_text": {
      "type": "string",
      "description": "A expansão literária em prosa do turno atual."
    },
    "dialogue_trigger": {
      "type": "object",
      "properties": {
        "activate": { "type": "boolean" },
        "npc_name": { "type": "string" },
        "dynamic_system_prompt": {
          "type": "string",
          "description": "Prompt completo de interpretação do NPC com persona, segredos, humor, relação com o jogador e objetivo de conversa."
        }
      },
      "required": ["activate"]
    }
  },
  "required": ["narrative_text", "dialogue_trigger"]
}
```

---

## 3. Modo Diálogo Dinâmico (Persona Split)

### 3.1 Conceito e Desacoplamento
O Modo Diálogo é uma sub-rotina transitória. Não existe um botão na interface para "entrar em modo diálogo": o gatilho decorre exclusivamente do texto do jogador (ex: *"assim que encontro Elena, iniciamos um diálogo direto"*) ou de uma decisão autônoma do Narrador.

```
                  [Turno Regular do Narrador]
                              │
               `dialogue_trigger.activate == true`
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    SUB-ROTINA DE DIÁLOGO                    │
│                                                             │
│ 1. Backend recebe o `dynamic_system_prompt` do NPC          │
│ 2. Frontend ajusta campo de entrada para falar com o NPC    │
│ 3. Trocas rápidas Jogador <-> NPC em sessão isolada de chat │
│    (Histórico = apenas falas da cena atual)                 │
│ 4. Jogador (ou NPC) sinaliza conclusão da conversa          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                  [Turno de Costura do Narrador]
 (Narrador consome o histórico da conversa e transcreve em prosa)
```

### 3.2 O Prompt Dinâmico do NPC (`dynamic_system_prompt`)
Produzido pelo próprio Narrador durante a ativação, contendo:
* **Identidade & Personalidade:** Nome, traços, trejeitos, tom de voz.
* **Contexto Imediato:** O que estava fazendo no segundo antes de o jogador falar.
* **Relação com o Protagonista:** Sentimento atual (confiança, rancor, medo).
* **Objetivo de Curto Prazo:** O que deseja obter ou esconder nesta conversa.
* **Regras Estritas:** Responder em 1ª pessoa; não narrar ações do jogador; respostas concisas e reativas.

### 3.3 Fechamento e Incorporação
Quando a conversa termina, o backend submete ao Gemini (com a persona do Narrador):
> *"A cena de diálogo entre o protagonista e [Nome do NPC] se encerrou. A transcrição literal da conversa segue abaixo:*  
> *[Mensagens trocadas]*  
> *Escreva agora o bloco narrativo subsequente em prosa, incorporando os acontecimentos, a linguagem corporal dos interlocutores, o ambiente ao redor e a resolução dramática da conversa."*

O texto gerado torna-se o próximo `NarrativeBlock` padrão, e a sub-sessão é encerrada.

---

## 4. O Sistema de "HP do Narrador" & Compactação

### 4.1 Cálculo da Barra de Vida
A barra de HP reflete a fração de tokens consumidos em relação ao teto operacional da sessão (ex: $1.000.000$ tokens no Gemini 1.5 Pro / Flash).

$$\text{Tokens Usados} = \text{countTokens}(\text{Regras} + \text{Contexto Base} + \text{Corpus Narrativo} + \text{Input Atual})$$
$$\text{HP Restante (\%)} = 100 \times \left(1 - \frac{\text{Tokens Usados}}{\text{Limite Máximo de Tokens}}\right)$$

### 4.2 Estados da Interface
* **HP $\ge 50\%$ (Verde / Foco Pleno):** Indicador estável, capacidade plena de evocação detalhada.
* **$20\% \le \text{HP} < 50\%$ (Amarelo / Fatigado):** Aviso sutil de saturação de contexto.
* **$\text{HP} < 20\%$ (Vermelho / Exaustão):** O botão de **"Compactar Crônica"** entra em estado de pulsação e destaque na interface.

### 4.3 Fluxo de Compactação ("O Livro de Crônicas")
Quando o jogador aciona a compactação:
1. **Cisão de Blocos:** O sistema separa os blocos narrativos da sessão em:
   * **Corpus Passado (75% mais antigos):** Candidatos a virarem crônica histórica.
   * **Corpus Ativo (25% mais recentes):** Mantidos intactos em prosa literal detalhada.
2. **Geração de Sinopse Editorial:** O Gemini recebe o Corpus Passado com uma instrução de sumarização factual densa (eventos decisivos, alianças, itens ganhos/perdidos, mortes, mudanças de cenário).
3. **Revisão Humana Obrigatória:** Um modal exibe a sinopse gerada. O usuário pode editar o texto diretamente na unha, garantindo que nenhum detalhe vital seja perdido ou alucinado.
4. **Consolidação:**
   * A sinopse validada é salva na tabela `chronicle_archives` e anexada ao campo `world_context` como "Crônica do Volume Anterior".
   * Os blocos do Corpus Passado são marcados como `archived = true` (não são mais injetados nas chamadas de geração subsequentes).
   * O HP do Narrador recupera o espaço ocupado por esses blocos antigos.

---

## 5. Esquema de Banco de Dados (SQLite)

O SQLite rodará localmente em `/data/chronicler.db` usando o driver síncrono de alto desempenho `better-sqlite3`.

```sql
-- Configurações globais e chave de API
CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Sessões de jogo
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    system_rules TEXT NOT NULL,
    world_context TEXT NOT NULL,
    active_theme TEXT DEFAULT 'medieval',
    token_limit INTEGER DEFAULT 1000000,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Blocos Narrativos
CREATE TABLE IF NOT EXISTS narrative_blocks (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    order_index INTEGER NOT NULL,
    player_instruction TEXT,          -- Prompt fornecido pelo jogador
    generated_text TEXT NOT NULL,      -- Prosa literária consolidada (ou editada)
    model_identifier TEXT,
    is_archived BOOLEAN DEFAULT FALSE, -- True após compactação
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Histórico de Compactações (Crônicas Arquivadas)
CREATE TABLE IF NOT EXISTS chronicle_archives (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    volume_number INTEGER NOT NULL,
    summary_text TEXT NOT NULL,
    covered_block_start_index INTEGER NOT NULL,
    covered_block_end_index INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Sub-Sessões de Diálogo Ativo
CREATE TABLE IF NOT EXISTS dialogue_sessions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    npc_name TEXT NOT NULL,
    dynamic_system_prompt TEXT NOT NULL,
    status TEXT CHECK(status IN ('active', 'concluded')) DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Mensagens do Modo Diálogo
CREATE TABLE IF NOT EXISTS dialogue_messages (
    id TEXT PRIMARY KEY,
    dialogue_session_id TEXT NOT NULL,
    sender TEXT CHECK(sender IN ('player', 'npc')) NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (dialogue_session_id) REFERENCES dialogue_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_narrative_order ON narrative_blocks(session_id, order_index);
CREATE INDEX IF NOT EXISTS idx_dialogue_msgs ON dialogue_messages(dialogue_session_id, created_at);
```

---

## 6. Regras de Edição, Truncamento e Re-geração

### 6.1 Edição Direta ("Na Unha")
* O usuário pode clicar sobre qualquer bloco de narrativa e editar diretamente o `generated_text`.
* O salvamento atualiza o registro no banco de dados imediatamente.
* Não há impacto destrutivo nos blocos subsequentes se a edição for apenas textual e mantiver a linha temporal coerente.

### 6.2 Edição do Prompt & Re-geração com Truncamento
* Se o usuário desejar alterar a `player_instruction` de um bloco $K$ e re-gerá-lo via IA:
  1. Se $K$ for o **último bloco**, o texto gerado anterior é substituído pelo novo retorno da API.
  2. Se $K$ for um **bloco intermediário** ($K < \text{total}$):
     * A interface exibe aviso de ramificação: *"Alterar este bloco descartará todos os blocos posteriores ($K+1 \dots N$). Deseja continuar?"*
     * Ao confirmar, a API executa:
       ```sql
       DELETE FROM narrative_blocks 
       WHERE session_id = ? AND order_index > ?;
       ```
     * O bloco $K$ é regenerado com o novo prompt, tornando-se o novo nó ativo final da história.

---

## 7. Design de Interface (UI/UX) & Sistema de Temas

### 7.1 Layout Estrutural
O layout é dividido em três áreas principais:
1. **Context Drawer (Gaveta Lateral Retrátil):**
   * Painel sempre acessível onde o jogador pode consultar e editar a qualquer instante: Fichas de personagens, Cenário, Regras do Narrador e Chave da API.
   * Visualizador da Crônica (resumos consolidados de volumes passados).
2. **Interactive Tome (Área Central de Leitura):**
   * Renderizado como uma página contínua de livro/documento, evitando o formato "balões de chat".
   * Cada bloco possui botões de utilidade discretos revelados ao passar o mouse (*hover*):
     * `[Editar Texto]`
     * `[Ver Prompt de Origem / Re-gerar]`
     * `[Ramificar a partir daqui]`
3. **Action Dock (Barra Inferior de Comando):**
   * **Barra de HP do Narrador:** Localizada no topo da barra de comando, com medidor percentual e indicação visual de saturação.
   * **Campo de Entrada Principal:** Área expansível para digitar o esboço da próxima cena ou ação.
   * **Indicador de Modo:** Se o Modo Diálogo estiver ativo, a barra se transforma visualmente com destaque para a persona do interlocutor (*"Falando com: Elena Vance"*), incluindo um botão `[Encerrar Diálogo e Narrar]`.

### 7.2 Motor de Temas CSS
Os temas são implementados via classes de escopo raiz no elemento `<html>` ou `<body>` utilizando variáveis CSS customizadas:

| Variável | Tema Medieval (Pergaminho) | Tema Cyberpunk (Terminal) | Tema Pós-Apocalíptico | Tema Contemporâneo |
| :--- | :--- | :--- | :--- | :--- |
| `--bg-main` | `#f4ecd8` (pergaminho) | `#0d1117` (preto profundo) | `#1c1a17` (cinza terra) | `#ffffff` / `#f9fafb` |
| `--text-main` | `#2c221e` (tinta sépia) | `#00ffcc` / `#e6edf3` | `#d4c5b9` (desbotado) | `#111827` (cinza escuro) |
| `--font-reading` | `Cinzel`, `Merriweather`, serif | `JetBrains Mono`, monospace | `Special Elite`, monospace | `Inter`, `Lora`, sans/serif |
| `--accent` | `#8b4513` (couro envelhecido) | `#ff0055` (neon magenta) | `#c86432` (ferrugem) | `#2563eb` (azul cobalto) |
| `--hp-bar-color` | `#2e7d32` / `#c62828` | `#00e5ff` / `#ff1744` | `#558b2f` / `#bf360c` | `#10b981` / `#ef4444` |

---

## 8. Arquitetura da API Backend (Endpoints REST & SSE)

### 8.1 Gerenciamento de Sessão e Configurações
* `GET /api/settings` — Retorna status da API Key configurada.
* `POST /api/settings/key` — Salva ou atualiza a chave da API Gemini no banco local.
* `GET /api/sessions` — Lista todas as histórias salvas.
* `POST /api/sessions` — Cria uma nova sessão com regras e contexto inicial.
* `GET /api/sessions/:id` — Retorna metadados da sessão, contexto e os blocos ativos.
* `PUT /api/sessions/:id/context` — Atualiza o contexto base ou as regras de narração da sessão.

### 8.2 Ciclo Narrativo e Streaming
* `POST /api/sessions/:id/narrative/next`  
  * Recebe: `{ "player_instruction": string }`
  * Processamento: Coleta o corpus ativo, chama o Gemini com o esquema estruturado e faz stream de texto via Server-Sent Events (SSE).
  * Retorno: Gravação do novo bloco no banco de dados e notificação de eventual `dialogue_trigger`.
* `PUT /api/narrative/blocks/:id`  
  * Recebe: `{ "generated_text": string }` (Edição direta na unha).
* `POST /api/narrative/blocks/:id/regenerate`  
  * Recebe: `{ "player_instruction": string }` (Regenera e trunca blocos posteriores se necessário).
* `GET /api/sessions/:id/token-count`  
  * Retorna contagem precisa de tokens do contexto atual e percentual de HP restante.

### 8.3 Operações de Modo Diálogo
* `POST /api/dialogue/:dialogueId/message`  
  * Recebe: `{ "message": string }`
  * Processamento: Executa chamada rápida ao Gemini com a persona do NPC e retorna a resposta imediata em primeira pessoa.
* `POST /api/dialogue/:dialogueId/conclude`  
  * Processamento: Aciona o Narrador para transcrever o diálogo acumulado em um novo bloco narrativo e encerra a sub-sessão.

### 8.4 Compactação de Memória
* `POST /api/sessions/:id/compact/preview`  
  * Gera a minuta de sinopse dos primeiros 75% dos blocos para aprovação do jogador.
* `POST /api/sessions/:id/compact/commit`  
  * Recebe a sinopse editada/aprovada pelo jogador, arquiva os blocos antigos e atualiza o contexto consolidado da sessão.

---

## 9. Especificação Docker & Deployment Local

### 9.1 Dockerfile Multi-Stage Unificado
O projeto deve ser encapsulado em uma imagem leve única baseada em `node:20-alpine`:

```dockerfile
# Estágio de Build
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY . .
RUN npm run build

# Estágio de Produção
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache sqlite-libs

COPY package*.json ./
RUN npm ci --only=production
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public

# Volume de dados persistentes
VOLUME ["/data"]
ENV DATABASE_PATH="/data/chronicler.db"
ENV PORT=3000

EXPOSE 3000
CMD ["node", "dist/server.js"]
```

### 9.2 Docker Compose (`docker-compose.yml`)
```yaml
version: '3.8'

services:
  chronicler:
    build: .
    container_name: chronicler-engine
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - ./data:/data
    environment:
      - DATABASE_PATH=/data/chronicler.db
      - PORT=3000
```

---

## 10. Checklist de Validação para o Antigravity

Ao alimentar este documento no Antigravity, garanta que as seguintes premissas sejam implementadas estritamente:

1. [x] **Nunca enviar prompts de jogador passados** no payload de geração de novos blocos narrativos. *(`test/contextBuilder.test.ts`, `test/narrative.test.ts`)*
2. [x] Garantir que o endpoint de geração force o modelo a responder com o `responseSchema` JSON exigido. *(`responseJsonSchema` em `src/ai/narrator.ts`; `test/narrative.test.ts`; verificado ao vivo)*
3. [x] Confirmar truncamento via `DELETE ... WHERE order_index > ?` quando o usuário re-gerar um bloco passado. *(`src/db/repositories/blocks.ts`; `test/narrative.test.ts`, `test/ui.test.ts`)*
4. [x] Implementar a chamada de contagem de tokens (`ai.models.countTokens`) para cálculo real da barra de HP. *(`src/ai/gateway.ts`, `src/ai/tokens.ts`; verificado ao vivo)*
5. [x] Garantir que a sub-sessão de diálogo não altere os blocos da história até que o endpoint de conclusão (`/conclude`) sintetize as falas em prosa pelo Narrador. *(`test/dialogue.test.ts`)*

---

## 11. Decisões de Implementação (homologadas)

Esta seção registra decisões tomadas durante o planejamento e a implementação que complementam ou ajustam as seções anteriores. Em caso de conflito, **esta seção prevalece**. O acompanhamento por fase está em [`TASKS.md`](TASKS.md).

### 11.1 Stack e estrutura
* Frontend em **Vanilla TypeScript + Tailwind CSS 3** (sem framework), compilado por `esbuild` e Tailwind CLI para `public/assets/` e servido por `@fastify/static`.
* Backend ESM (`"type": "module"`, `module: NodeNext`), testes com `vitest`, desenvolvimento com `tsx`.
* Interface em **pt-BR fixo**.
* Fontes dos temas **empacotadas localmente** em `public/fonts/` (sem CDN).

### 11.2 Modelos e limites
* Modelo padrão: `gemini-3.8-flash`. O app consulta `models.list` da API do Gemini e oferece, num seletor, todos os modelos com suporte a `generateContent`. Se o padrão não estiver disponível, a UI cai para o primeiro modelo Flash listado e avisa o usuário.
* `token_limit` é configurável por sessão (padrão 1.000.000).

### 11.3 Nomenclatura
* O campo do prompt do jogador é sempre `player_instruction` (a menção a `player_prompt` na §2.2 foi corrigida).

### 11.4 Streaming (§8.2)
* O SSE de `narrative/next` faz **parse incremental** do JSON estruturado: os trechos de `narrative_text` são emitidos em tempo real como eventos `chunk`; `block` e `dialogue_trigger` são emitidos apenas no fechamento do payload.

### 11.5 Regeneração e edição (§6)
* A regeneração só altera o banco **depois** que a IA responde com sucesso. O `DELETE ... WHERE order_index > ?` e a atualização do bloco ocorrem numa **única transação** SQLite.
* Edição manual de texto **preserva** os blocos seguintes; apenas regeneração via IA trunca.

### 11.6 Modo Diálogo (§3)
* Existe **no máximo um diálogo ativo por sessão**. Após recarregar a página, o frontend retoma o diálogo via `GET /api/sessions/:id/dialogue/active`.

### 11.7 HP do Narrador (§4)
* O HP é recalculado por **eventos** (abertura de sessão, geração/regeneração de bloco, edição de texto ou contexto, commit de crônica), sem polling e sem recálculo a cada tecla.

### 11.8 Compactação (§4.3)
* A divisão 75/25 é calculada pelo **peso em tokens** (aproximado pelo tamanho do texto), não pela contagem de blocos.
* Cada volume é anexado ao `world_context` sob o cabeçalho `## Crônica — Volume N`.

### 11.9 Segurança e deploy (§9)
* O compose publica a porta apenas em loopback: `127.0.0.1:3000:3000`. Não há autenticação; a chave da API fica em texto plano no SQLite (uso local, usuário único).
* O Dockerfile compila dependências nativas (`better-sqlite3`) no estágio de build e o runtime usa `npm ci --omit=dev`. O campo `version:` do compose é omitido por estar obsoleto.
* `data/`, `*.db*` e `GEMINIKEY.txt` são ignorados pelo git.

### 11.10 Ajustes no schema SQL (§5)
O schema implementado em [`src/db/schema.ts`](src/db/schema.ts) acrescenta ao §5:
* `sessions.model TEXT` — modelo Gemini da sessão (`NULL` = padrão global).
* `UNIQUE (session_id, order_index)` em `narrative_blocks` e `UNIQUE (session_id, volume_number)` em `chronicle_archives`.
* Índice único parcial `idx_one_active_dialogue` em `dialogue_sessions(session_id) WHERE status = 'active'`, que impõe no banco a regra de um diálogo ativo por sessão.
* O `order_index` considera blocos arquivados e nunca é reutilizado após uma compactação.
* O controle de versão do schema usa `PRAGMA user_version`.

### 11.11 API de configurações e modelos (§8.1)
Endpoints adicionados/ajustados em relação ao §8.1:
* `POST /api/settings/key` **valida a chave** chamando `models.list` antes de gravar; chave inválida → 400 e nada é salvo. A chave nunca é devolvida por nenhum endpoint.
* `DELETE /api/settings/key` remove a chave; `PUT /api/settings/model` define o modelo padrão global.
* `GET /api/models` devolve `{ models, default_model, effective_default_model, available }`. A lista vem de `models.list` (apenas modelos com `generateContent`), filtrada para **texto** (excluindo imagem, TTS, música, transcrição, agentes e modelos multimodais de saída) e em cache por 10 minutos (`?refresh=true` força atualização). O `effective_default_model` aplica o fallback do §11.2.
* `GET /api/sessions/:id` retorna também `archives` e `active_dialogue` (para a reconexão pós-reload).
* `DELETE /api/sessions/:id` exclui a sessão (cascata nas tabelas filhas).
* Temas válidos de `active_theme`: `medieval`, `cyberpunk`, `pos-apocaliptico`, `contemporaneo`.
* Campos desconhecidos no corpo das requisições geram 400 (o Ajv não descarta em silêncio).

### 11.12 Ciclo narrativo implementado (§2, §6, §8.2)
* **Payload:** `system instruction` = `sessions.system_rules`; um único turno de usuário com as seções `# CONTEXTO DO MUNDO`, `# CORPUS NARRATIVO` e `# AÇÃO / ESBOÇO DO JOGADOR PARA A PRÓXIMA CENA`, nessa ordem (função pura em [`src/ai/contextBuilder.ts`](src/ai/contextBuilder.ts)). O corpus contém **apenas** `generated_text`; nenhum `player_instruction` passado é enviado.
* **Saída estruturada:** usa `responseMimeType: application/json` + `responseJsonSchema` com o esquema do §2.4, acrescido de `propertyOrdering: ["narrative_text", "dialogue_trigger"]` para que a prosa chegue primeiro e o streaming comece imediatamente. Um `dialogue_trigger` com `activate: true` mas sem `npc_name` ou `dynamic_system_prompt` é tratado como inativo.
* **SSE** (`POST /api/sessions/:id/narrative/next` e `POST /api/narrative/blocks/:id/regenerate`): eventos `start {model}`, `chunk {text}` (parse incremental de `narrative_text`), `block {block, discarded}` e, se houver, `dialogue_trigger {dialogue_id, npc_name}` (ambos só no fechamento do payload, **após** persistir), `error {message}` e `done`. O `dynamic_system_prompt` não é enviado ao cliente. Erros anteriores ao início do stream (sem chave, sessão inexistente, diálogo ativo, geração concorrente) retornam JSON com status HTTP normal (`409 missing_api_key`, por exemplo).
* **Falhas e desconexão:** se o JSON final for inválido, a API falhar ou o cliente desconectar, **nada é gravado**.
* **Concorrência:** uma geração por sessão por vez (`409` se houver outra em andamento). Narrar ou regenerar é recusado (`409`) enquanto houver diálogo ativo.
* **Edição direta** (`PUT /api/narrative/blocks/:id`): altera só `generated_text`; blocos arquivados não são editáveis (`409`).
* **Regeneração** (`POST /api/narrative/blocks/:id/regenerate`, corpo `{player_instruction, confirm_truncate?}`): o corpus enviado contém apenas os blocos ativos **anteriores** ao bloco K. Se existirem blocos posteriores e `confirm_truncate` não for `true`, a API responde `409 {code: "truncation_required", blocks_to_discard}` sem tocar em nada. Com a confirmação, o `DELETE ... WHERE order_index > K` e a atualização do bloco K ocorrem numa única transação **após** a geração bem-sucedida.
* **Modelo usado:** `sessions.model` → padrão global → fallback (§11.2); gravado em `narrative_blocks.model_identifier`.

### 11.13 HP do Narrador implementado (§4, §8.2)
* `GET /api/sessions/:id/token-count` → `{ tokens_used, token_limit, model, hp_percent, state }`, com `state` em `green` (≥ 50%), `yellow` (≥ 20% e < 50%) ou `red` (< 20%). `hp_percent` é limitado a [0, 100], com uma casa decimal, e calculado como `100 × (limite − usados) / limite` (equivalente à fórmula do §4.1, sem imprecisão de ponto flutuante nos limiares).
* Mede o payload real que seria enviado ao Narrador: regras + contexto do mundo + corpus ativo (blocos arquivados ficam de fora), sem input pendente do jogador.
* **Limitação da API:** a Gemini Developer API **rejeita `systemInstruction` em `countTokens`**. As regras de narração são, portanto, contadas como texto somado ao conteúdo; a diferença é de poucos tokens de moldura.
* **Cache:** a contagem é guardada em memória por hash (modelo + regras + conteúdo). Reabrir uma sessão sem alterações não chama a API; qualquer alteração de bloco, contexto ou regras muda o hash e força nova contagem. Não há polling nem recálculo por tecla (§11.7) — o frontend consulta o endpoint nos eventos definidos.
* Erros: `404` (sessão), `409 missing_api_key` (sem chave), `502` (falha da API de contagem).

### 11.14 Modo Diálogo implementado (§3, §8.3)
* **Ativação:** só pelo `dialogue_trigger` do Narrador (§11.12). Cria `dialogue_sessions` com status `active`; o índice único parcial garante um diálogo ativo por sessão. Enquanto houver diálogo ativo, `narrative/next` e `regenerate` respondem `409`.
* **Sigilo do NPC:** o `dynamic_system_prompt` (que pode conter segredos do NPC) **nunca** é devolvido pela API e **não** é enviado ao Narrador na costura. Os endpoints expõem apenas `{id, session_id, npc_name, status, created_at}`.
* `POST /api/dialogue/:id/message` `{message}` → `{player_message, npc_message, npc_wants_to_end}`. Chamada ao Gemini com o prompt dinâmico + regras fixas de interpretação como `systemInstruction` e **somente** as falas da cena como histórico multi-turno (`user` = protagonista, `model` = NPC); nem o corpus nem meta-instruções do Narrador entram. A resposta usa JSON estruturado `{reply, end_conversation}`; `end_conversation` vira o sinal `npc_wants_to_end`, que a UI usa apenas para destacar o botão `[Encerrar Diálogo e Narrar]` (a decisão continua sendo do autor). As duas falas só são gravadas juntas, após sucesso, mantendo o histórico sempre alternado. Uma mensagem por vez por diálogo (`409` caso contrário).
* `POST /api/dialogue/:id/conclude` (SSE, mesmos eventos do §11.12): envia ao Narrador regras + mundo + corpus ativo + o texto do §3.3 com a transcrição literal (`Protagonista: …` / `<NPC>: …`). Numa única transação, grava o bloco de costura e marca o diálogo como `concluded` — **este é o único ponto em que o diálogo altera `narrative_blocks`** (checklist §10 nº 5). O `player_instruction` do bloco guarda `[Diálogo com <NPC>]` + transcrição, preservando a origem para auditoria. Se a costura falhar, nada é gravado e o diálogo continua ativo. O Narrador pode encadear um novo diálogo no mesmo turno.
* `POST /api/dialogue/:id/cancel` *(extensão do design)*: descarta o diálogo e suas mensagens sem narrar, para o caso de um gatilho indesejado deixar a sessão "presa". Concluir sem nenhuma fala trocada retorna `409` sugerindo o cancelamento.
* `GET /api/sessions/:id/dialogue/active` → `{dialogue, messages}` para reconexão após reload (§11.6); `GET /api/sessions/:id` também inclui `active_dialogue` (sem o prompt).

### 11.15 Compactação implementada (§4.3, §8.4)
* **Cisão 75/25 por peso** ([`src/ai/compaction.ts`](src/ai/compaction.ts)): o Corpus Passado é o maior prefixo cronológico dos blocos ativos cujo peso acumulado (tamanho do texto) não excede 75% do total; o restante é o Corpus Ativo. Sempre fica ao menos 1 bloco de cada lado; com menos de 2 blocos ativos a API responde `409`.
* `POST /api/sessions/:id/compact/preview` → `{summary_text, covered_block_start_index, covered_block_end_index, blocks_to_archive, blocks_to_keep, next_volume_number, model}`. Envia ao modelo (texto livre, sem JSON) apenas o Corpus Passado + o contexto do mundo (como referência de grafia) sob o prompt do "Arquivista Editorial" (sinopse factual densa, ~1/8 do original). **Não grava nada.** Meta-instruções do jogador não são enviadas.
* `POST /api/sessions/:id/compact/commit` `{summary_text, covered_block_start_index, covered_block_end_index}` (a sinopse já revisada/editada pelo usuário): valida que a faixa é exatamente um prefixo dos blocos ativos e que o último bloco é preservado (senão `409`: "gere uma nova minuta"). Numa única transação: cria o volume em `chronicle_archives`, marca os blocos como `is_archived` e anexa ao `world_context` o trecho `## Crônica — Volume N` + sinopse. Qualquer falha desfaz tudo.
* Preview e commit exigem a trava da sessão (sem geração concorrente) e ausência de diálogo ativo.
* O HP volta a subir porque os blocos arquivados saem do corpus e a sinopse (bem menor) entra no `world_context`; o frontend reconsulta `token-count` após o commit (§11.7).

### 11.16 Ramificação implementada (§6.2)
* `POST /api/narrative/blocks/:id/branch` `{confirm_truncate?}` *(extensão do design)*: "Ramificar a partir daqui" — descarta os blocos ativos posteriores ao bloco `:id` (sem gerar nada) para o autor continuar a história a partir dele. Se houver blocos posteriores e `confirm_truncate` não for `true`, responde `409 {code: "truncation_required", blocks_to_discard}`. Retorna `{discarded, last_block_id}`. Recusado com diálogo ativo ou geração concorrente.
* `GET /api/settings` passou a incluir `default_system_rules` (texto padrão das regras do Narrador) para o botão "Restaurar padrão" da gaveta.

### 11.17 Frontend implementado (§7)
* **Código** em [`client/`](client/) (TypeScript sem framework, bundle esbuild → `public/assets/app.js`; Tailwind 3 → `public/assets/app.css`; `npm run build:client`). Roteamento por hash: `#/` (biblioteca) e `#/s/<id>` (sessão). Módulos: `api.ts` (tipos, `fetch`, `streamTurn` para POST+SSE), `sse.ts` (parser incremental puro), `dom.ts` (helper `h()`, toasts, modais), `theme.ts`, `views/{home,session,drawer,compaction}.ts`.
* **Tema:** as variáveis CSS do §7.2 vivem em classes `theme-*` na raiz `<html>`; a escolha é gravada na sessão (`active_theme`) e em `localStorage` (usada na tela inicial). Cores semânticas do Tailwind (`main`, `panel`, `ink`, `accent`, `hp-*`…) apontam para essas variáveis.
* **Fontes** empacotadas por [`scripts/copy-fonts.mjs`](scripts/copy-fonts.mjs) (subconjunto latino, `woff2` + licenças OFL em `public/fonts/`); nenhuma requisição a CDN.
* **Tome:** prosa contínua (parágrafos recuados; capitular só no primeiro bloco). Durante o streaming um "bloco fantasma" recebe os `chunk` (texto + cursor piscante); no evento `block`/`done` a sessão é recarregada do servidor (única fonte da verdade, inclusive após truncamento). Em re-geração o fantasma ocupa o lugar do bloco e os posteriores aparecem esmaecidos. Se a geração falhar, o texto digitado na Doca é preservado.
* **Ações de bloco** (visíveis no hover em telas largas e sempre em telas estreitas): `[Editar Texto]` (preserva os blocos seguintes), `[Ver Prompt de Origem / Re-gerar]` (modal pré-preenchido com `player_instruction`; avisa quantos blocos serão descartados e envia `confirm_truncate`), `[Ramificar a partir daqui]` (§11.16).
* **HP:** a Doca consulta `token-count` apenas nos eventos de §11.7 (abrir sessão, bloco gerado/regenerado, edição, contexto salvo, compactação, ramificação). "Compactar Crônica" pulsa quando `state = red`.
* **Modo Diálogo:** a Doca troca para "Falando com: NPC"; a transcrição aparece num cartão no fim do Tome; `[Encerrar Diálogo e Narrar]` ganha destaque quando `npc_wants_to_end`; `[Descartar]` chama `cancel`. Ao recarregar, `dialogue/active` restaura a cena. Compactar fica desabilitado durante o diálogo.
* **Testes:** `test/clientSse.test.ts` (parser), `test/static.test.ts` (index/fontes/sem CDN) e `test/ui.test.ts` (jsdom executa o bundle real do cliente contra o servidor Fastify numa porta de loopback com Gemini mockado: chave → sessão → narrar → editar → re-gerar com descarte → diálogo → reconexão → compactação → ramificação → erro do Narrador).

### 11.18 Docker implementado (§9)
* **Node 22, não 20:** o `better-sqlite3` 13 exige Node ≥ 22; imagens `node:22-alpine` e `engines: ">=22"`.
* **Estágios:** `base` (Alpine + `python3 make g++`), `deps` (`npm ci --omit=dev`), `builder` (`npm ci` + `npm run build` = `tsc` + esbuild + Tailwind) e `runner` (sem toolchain nem devDependencies: copia só `node_modules` de produção, `dist/` e `public/`).
* **better-sqlite3 no Alpine:** o pacote já inclui binários pré-compilados `linuxmusl-*`; `deps` instala com `--ignore-scripts`, valida o carregamento do módulo e só recompila do código-fonte (`npm rebuild --build-from-source`) se a validação falhar — a toolchain da `base` cobre esse fallback.
* **Runtime:** `HOST=0.0.0.0` é definido no container (o padrão do app é `127.0.0.1`). `docker-entrypoint.sh` (via `su-exec`) corrige a posse do volume `/data` — bind mounts são criados como root pelo Docker — e executa o servidor como o usuário `node`. `HEALTHCHECK` consulta `/api/health`.
* **`docker-compose.yml`:** sem a chave obsoleta `version:`; `ports: "127.0.0.1:3000:3000"` (§11.9); volume `./data:/data`.
* **`.dockerignore`:** exclui `GEMINIKEY.txt`, `data/`, `*.db*`, `node_modules/`, `.git/`, testes e `public/assets` (recompilado no build), para que a chave e o banco nunca entrem no contexto/imagem.
* **Validação feita:** o Docker não está disponível no ambiente de desenvolvimento; foram validados `npm run build`, a instalação isolada `npm ci --omit=dev --ignore-scripts` (0 vulnerabilidades) e a inicialização de `node dist/server.js` com apenas as dependências de produção (`/api/health`, `/`, `/assets/*`, `/fonts/*` e `/api/settings` respondem 200).
* **Podman rootless (validado):** `podman build` e `podman-compose up -d --build` funcionam com o mesmo Dockerfile (o `HEALTHCHECK` é ignorado no formato OCI, só gera aviso). Em rootless, o root do contêiner é o usuário do host, então o `chown` do entrypoint rebaixaria a posse de `./data` para um subuid; por isso existe o override [`docker-compose.podman.yml`](docker-compose.podman.yml) (`userns_mode: keep-id` + `user: "1000:1000"`), e o entrypoint só faz `chown`/`su-exec` quando roda como root. O volume usa `:Z` para o rótulo SELinux (inofensivo onde não há SELinux). Verificado: contêiner publicado em `127.0.0.1:3000`, endpoints respondendo 200 e `./data` pertencendo ao usuário.

### 11.19 Favicon, modo claro/escuro e exportação em Markdown (§7)
* **Favicon:** [`public/favicon.svg`](public/favicon.svg) (tome aberto com uma centelha), mais `favicon.ico` (16/32/48) e `apple-touch-icon.png` (180), todos locais; referenciados no `index.html`.
* **Claro/escuro:** cada um dos 4 temas tem as duas variações (`.theme-<tema>.mode-light|mode-dark` em [`client/styles.css`](client/styles.css)). `<html>` recebe sempre uma classe de tema **e** uma de modo. A preferência de modo (`Automático (sistema)` — padrão —, `Claro`, `Escuro`) é global do navegador (`localStorage: chronicler.mode`), independente do tema da sessão (`active_theme`, inalterado no banco). No modo automático a UI acompanha `prefers-color-scheme`, inclusive mudanças em tempo real. Um script inline no `<head>` aplica tema e modo antes da primeira pintura (sem "flash"). O seletor de modo fica na tela inicial e no cabeçalho da sessão. Nota: no modo automático, um sistema claro mostra o Cyberpunk em sua variação clara; para ver a aparência neon original, escolha `Escuro`.
* **Exportação `.md`:** `GET /api/sessions/:id/export[?include_context=true]` devolve `text/markdown` como anexo (`Content-Disposition` com `filename` ASCII e `filename*` UTF-8). Conteúdo ([`src/export.ts`](src/export.ts)): `# Título`, linha de metadados (data e nº de blocos), a prosa de **todos** os blocos em ordem — inclusive os arquivados na compactação, com o texto original — e, com `include_context`, a seção `## Mundo e personagens` (que já carrega as sinopses `## Crônica — Volume N`) seguida de `## Narrativa`. Instruções do jogador (`player_instruction`) **nunca** são exportadas. Na UI, o botão **Salvar .md** do cabeçalho abre uma janela com a opção de incluir o contexto e dispara o download via `fetch` + `Blob`.

### 11.20 Cabeçalho com ícones e tela inicial responsiva (§7)
* **Botões só com ícone:** no cabeçalho da sessão, *Biblioteca*, *Tema visual*, *Modo claro/escuro*, *Salvar .md* e *Contexto* viram botões quadrados (36 px) com SVG inline local ([`client/icons.ts`](client/icons.ts), sem CDN nem fonte de ícones). O cabeçalho deixou de quebrar linha: o título é a única parte flexível e trunca com reticências.
* **Tooltips:** CSS puro via `data-tip` + `::after` (classe `.tip`), exibidos ao passar o mouse **e** ao focar com o teclado (`:focus-visible`), com alinhamento `start`/`end` para não vazar da tela. O rótulo acessível é o `aria-label` (estável: `Voltar à biblioteca`, `Tema visual`, `Modo claro ou escuro`, `Salvar em Markdown`, `Contexto da sessão`); o tooltip dos menus informa o valor atual (ex.: `Tema visual: Cyberpunk (Neon)`). Em telas de toque não há hover; o `aria-label` permanece.
* **Seletores viraram menus:** tema e modo são botões de ícone que abrem um pequeno menu `role=menu` com itens `menuitemradio` (o atual marcado com ✓). Fecha com Esc, clique fora, perda de foco ou ao escolher; ↑/↓ navegam. O ícone do modo reflete a preferência (monitor = automático, sol, lua). Implementação em [`client/controls.ts`](client/controls.ts) (`iconButton`, `createMenuControl`, `createThemeControl`, `createModeControl`). O campo **Tema** do formulário *Nova crônica* continua sendo um `<select>` (é um campo de formulário com rótulo, não um controle de cabeçalho).
* **Correção do corte no celular:** a causa era a coluna implícita `auto` das grades (`grid` sem `grid-cols-*` abaixo do breakpoint), que crescia até a largura da `<option>` mais longa dos seletores de modelo e empurrava o cartão para fora da tela. Correções: `grid-cols-1` (`minmax(0,1fr)`) + `min-w-0` nos filhos das grades, `main` e cartões; `.input` passou a ter `min-w-0 max-w-full`; linhas de *Suas crônicas* com título truncado e data em linha própria; botões auxiliares com `shrink-0`. Coberto por teste de regressão da marcação (jsdom não calcula layout, então a checagem visual em um celular real continua sendo recomendada).
