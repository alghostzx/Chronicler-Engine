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

1. [ ] **Nunca enviar prompts de jogador passados** no payload de geração de novos blocos narrativos.
2. [ ] Garantir que o endpoint de geração force o modelo a responder com o `responseSchema` JSON exigido.
3. [ ] Confirmar truncamento via `DELETE ... WHERE order_index > ?` quando o usuário re-gerar um bloco passado.
4. [ ] Implementar a chamada de contagem de tokens (`ai.models.countTokens`) para cálculo real da barra de HP.
5. [ ] Garantir que a sub-sessão de diálogo não altere os blocos da história até que o endpoint de conclusão (`/conclude`) sintetize as falas em prosa pelo Narrador.

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