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
2. **Contexto sem Ruído (Clean Corpus):** As meta-instruções do jogador (*"deixe mais sombrio"*, *"descreva o quarto"*) são usadas exclusivamente para gerar a página da vez e **nunca** são reinjetadas no histórico global, preservando a pureza literária da história.
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
│    (Concatenação em ordem cronológica de todas as páginas    │
│     ativos como um texto contínuo de prosa)                 │
├─────────────────────────────────────────────────────────────┤
│ 4. INPUT DO JOGADOR (Ação / Esboço da Próxima Cena)         │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Isolamento de Meta-Instruções Passadas
* Cada página narrativa no banco de dados armazena o `player_instruction` que lhe deu origem para fins de auditoria e re-geração.
* Contudo, ao solicitar a geração da Página $N+1$, **apenas o `generated_text` das páginas $1 \dots N$ é enviado no item 3**. Os prompts anteriores do jogador são omitidos da chamada.

### 2.3 System Prompt do Narrador (Base Canônica)
```markdown
Você é o Cronista e Narrador de uma história colaborativa literária.
Seu papel é expandir as ações, diálogos e esboços fornecidos pelo Usuário em prosa rica, imersiva e detalhada.

REGRAS RÍGIDAS DE CONDUTA:
1. NÃO AVANCE A HISTÓRIA ALÉM DO ESBOÇO DO JOGADOR. Se o jogador descreveu "eu entro na taverna e peço uma bebida", narre a entrada, o ambiente, a reação das pessoas e o pedido da bebida. PARE no momento em que a ação for concluída. Nunca decida o que acontece em seguida sem a entrada do jogador.
2. MANTENHA O TOM E O ESTILO definidos no Contexto do Mundo. Mantenha o texto gerado organizado em parágrafos para facilitar a leitura. Evite paredes ininterruptas de texto.
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
> *Escreva agora a página narrativa subsequente em prosa, incorporando os acontecimentos, a linguagem corporal dos interlocutores, o ambiente ao redor e a resolução dramática da conversa."*

O texto gerado torna-se a próxima `Page` padrão, e a sub-sessão é encerrada.

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
1. **Cisão de Páginas:** O sistema separa as páginas narrativas da sessão em:
   * **Corpus Passado (75% mais antigos):** Candidatos a virarem crônica histórica.
   * **Corpus Ativo (25% mais recentes):** Mantidos intactos em prosa literal detalhada.
2. **Geração de Sinopse Editorial:** O Gemini recebe o Corpus Passado com uma instrução de sumarização factual densa (eventos decisivos, alianças, itens ganhos/perdidos, mortes, mudanças de cenário).
3. **Revisão Humana Obrigatória:** Um modal exibe a sinopse gerada. O usuário pode editar o texto diretamente na unha, garantindo que nenhum detalhe vital seja perdido ou alucinado.
4. **Consolidação:**
   * A sinopse validada é salva na tabela `chronicle_archives` e anexada ao campo `world_context` como "Crônica do Volume Anterior".
   * As páginas do Corpus Passado são marcadas como `archived = true` (não são mais injetadas nas chamadas de geração subsequentes).
   * O HP do Narrador recupera o espaço ocupado por essas páginas antigas.

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

-- Páginas Narrativas
CREATE TABLE IF NOT EXISTS narrative_pages (
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
    covered_page_start_index INTEGER NOT NULL,
    covered_page_end_index INTEGER NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_pages_order ON narrative_pages(session_id, order_index);
CREATE INDEX IF NOT EXISTS idx_dialogue_msgs ON dialogue_messages(dialogue_session_id, created_at);
```

---

## 6. Regras de Edição, Truncamento e Re-geração

### 6.1 Edição Direta ("Na Unha")
* O usuário pode clicar sobre qualquer página de narrativa e editar diretamente o `generated_text`.
* O salvamento atualiza o registro no banco de dados imediatamente.
* Não há impacto destrutivo nas páginas subsequentes se a edição for apenas textual e mantiver a linha temporal coerente.

### 6.2 Edição do Prompt & Re-geração com Truncamento
* Se o usuário desejar alterar a `player_instruction` de uma página $K$ e re-gerá-la via IA:
  1. Se $K$ for a **última página**, o texto gerado anterior é substituído pelo novo retorno da API.
  2. Se $K$ for uma **página intermediária** ($K < \text{total}$):
     * A interface exibe aviso de ramificação: *"Alterar esta página descartará todas as páginas posteriores ($K+1 \dots N$). Deseja continuar?"*
     * Ao confirmar, a API executa:
       ```sql
       DELETE FROM narrative_pages 
       WHERE session_id = ? AND order_index > ?;
       ```
     * A página $K$ é regenerada com o novo prompt, tornando-se o novo nó ativo final da história.

---

## 7. Design de Interface (UI/UX) & Sistema de Temas

### 7.1 Layout Estrutural
O layout é dividido em três áreas principais:
1. **Context Drawer (Gaveta Lateral Retrátil):**
   * Painel sempre acessível onde o jogador pode consultar e editar a qualquer instante: Fichas de personagens, Cenário, Regras do Narrador e Chave da API.
   * Visualizador da Crônica (resumos consolidados de volumes passados).
2. **Interactive Tome (Área Central de Leitura):**
   * Renderizado como uma página contínua de livro/documento, evitando o formato "balões de chat".
   * Cada página possui botões de utilidade discretos revelados ao passar o mouse (*hover*) — *substituído pelo §11.22: cartão separado por página, com três ações em ícones sempre visíveis*:
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
* `GET /api/sessions/:id` — Retorna metadados da sessão, contexto e as páginas ativas.
* `PUT /api/sessions/:id/context` — Atualiza o contexto base ou as regras de narração da sessão.

### 8.2 Ciclo Narrativo e Streaming
* `POST /api/sessions/:id/narrative/next`  
  * Recebe: `{ "player_instruction": string }`
  * Processamento: Coleta o corpus ativo, chama o Gemini com o esquema estruturado e faz stream de texto via Server-Sent Events (SSE).
  * Retorno: Gravação da nova página no banco de dados e notificação de eventual `dialogue_trigger`.
* `PUT /api/narrative/pages/:id`  
  * Recebe: `{ "generated_text": string }` (Edição direta na unha).
* `POST /api/narrative/pages/:id/regenerate`  
  * Recebe: `{ "player_instruction": string }` (Regenera e trunca páginas posteriores se necessário).
* `GET /api/sessions/:id/token-count`  
  * Retorna contagem precisa de tokens do contexto atual e percentual de HP restante.

### 8.3 Operações de Modo Diálogo
* `POST /api/dialogue/:dialogueId/message`  
  * Recebe: `{ "message": string }`
  * Processamento: Executa chamada rápida ao Gemini com a persona do NPC e retorna a resposta imediata em primeira pessoa.
* `POST /api/dialogue/:dialogueId/conclude`  
  * Processamento: Aciona o Narrador para transcrever o diálogo acumulado em uma nova página narrativa e encerra a sub-sessão.

### 8.4 Compactação de Memória
* `POST /api/sessions/:id/compact/preview`  
  * Gera a minuta de sinopse dos primeiros 75% das páginas para aprovação do jogador.
* `POST /api/sessions/:id/compact/commit`  
  * Recebe a sinopse editada/aprovada pelo jogador, arquiva as páginas antigas e atualiza o contexto consolidado da sessão.

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

1. [x] **Nunca enviar prompts de jogador passados** no payload de geração de novas páginas narrativas. *(`test/contextBuilder.test.ts`, `test/narrative.test.ts`)*
2. [x] Garantir que o endpoint de geração force o modelo a responder com o `responseSchema` JSON exigido. *(`responseJsonSchema` em `src/ai/narrator.ts`; `test/narrative.test.ts`; verificado ao vivo)*
3. [x] Confirmar truncamento via `DELETE ... WHERE order_index > ?` quando o usuário re-gerar uma página passada. *(`src/db/repositories/pages.ts`; `test/narrative.test.ts`, `test/ui.test.ts`)*
4. [x] Implementar a chamada de contagem de tokens (`ai.models.countTokens`) para cálculo real da barra de HP. *(`src/ai/gateway.ts`, `src/ai/tokens.ts`; verificado ao vivo)*
5. [x] Garantir que a sub-sessão de diálogo não altere as páginas da história até que o endpoint de conclusão (`/conclude`) sintetize as falas em prosa pelo Narrador. *(`test/dialogue.test.ts`)*

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
* O texto gerado por cada prompt chama-se **página** (antes "bloco"): tabela `narrative_pages`, campos `covered_page_*`, rotas `/api/narrative/pages/…` e evento SSE `page`. Ver §11.22.

### 11.4 Streaming (§8.2)
* O SSE de `narrative/next` faz **parse incremental** do JSON estruturado: os trechos de `narrative_text` são emitidos em tempo real como eventos `chunk`; `page` e `dialogue_trigger` são emitidos apenas no fechamento do payload.

### 11.5 Regeneração e edição (§6)
* A regeneração só altera o banco **depois** que a IA responde com sucesso. O `DELETE ... WHERE order_index > ?` e a atualização da página ocorrem numa **única transação** SQLite.
* Edição manual de texto **preserva** as páginas seguintes; apenas regeneração via IA trunca.

### 11.6 Modo Diálogo (§3)
* Existe **no máximo um diálogo ativo por sessão**. Após recarregar a página, o frontend retoma o diálogo via `GET /api/sessions/:id/dialogue/active`.

### 11.7 HP do Narrador (§4)
* O HP é recalculado por **eventos** (abertura de sessão, geração/regeneração de página, edição de texto ou contexto, commit de crônica), sem polling e sem recálculo a cada tecla.

### 11.8 Compactação (§4.3)
* A divisão 75/25 é calculada pelo **peso em tokens** (aproximado pelo tamanho do texto), não pela contagem de páginas.
* Cada volume é anexado ao `world_context` sob o cabeçalho `## Crônica — Volume N`.

### 11.9 Segurança e deploy (§9)
* O compose publica a porta apenas em loopback: `127.0.0.1:3000:3000`. Não há autenticação; a chave da API fica em texto plano no SQLite (uso local, usuário único).
* O Dockerfile compila dependências nativas (`better-sqlite3`) no estágio de build e o runtime usa `npm ci --omit=dev`. O campo `version:` do compose é omitido por estar obsoleto.
* `data/`, `*.db*` e `GEMINIKEY.txt` são ignorados pelo git.

### 11.10 Ajustes no schema SQL (§5)
O schema implementado em [`src/db/schema.ts`](src/db/schema.ts) acrescenta ao §5:
* `sessions.model TEXT` — modelo Gemini da sessão (`NULL` = padrão global).
* `UNIQUE (session_id, order_index)` em `narrative_pages` e `UNIQUE (session_id, volume_number)` em `chronicle_archives`.
* Índice único parcial `idx_one_active_dialogue` em `dialogue_sessions(session_id) WHERE status = 'active'`, que impõe no banco a regra de um diálogo ativo por sessão.
* O `order_index` considera páginas arquivadas e nunca é reutilizado após uma compactação.
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
* **SSE** (`POST /api/sessions/:id/narrative/next` e `POST /api/narrative/pages/:id/regenerate`): eventos `start {model}`, `chunk {text}` (parse incremental de `narrative_text`), `page {page, discarded}` e, se houver, `dialogue_trigger {dialogue_id, npc_name}` (ambos só no fechamento do payload, **após** persistir), `error {message}` e `done`. O `dynamic_system_prompt` não é enviado ao cliente. Erros anteriores ao início do stream (sem chave, sessão inexistente, diálogo ativo, geração concorrente) retornam JSON com status HTTP normal (`409 missing_api_key`, por exemplo).
* **Falhas e desconexão:** se o JSON final for inválido, a API falhar ou o cliente desconectar, **nada é gravado**.
* **Concorrência:** uma geração por sessão por vez (`409` se houver outra em andamento). Narrar ou regenerar é recusado (`409`) enquanto houver diálogo ativo.
* **Edição direta** (`PUT /api/narrative/pages/:id`): altera só `generated_text`; páginas arquivadas não são editáveis (`409`).
* **Regeneração** (`POST /api/narrative/pages/:id/regenerate`, corpo `{player_instruction, confirm_truncate?}`): o corpus enviado contém apenas as páginas ativas **anteriores** à página K. Se existirem páginas posteriores e `confirm_truncate` não for `true`, a API responde `409 {code: "truncation_required", pages_to_discard}` sem tocar em nada. Com a confirmação, o `DELETE ... WHERE order_index > K` e a atualização da página K ocorrem numa única transação **após** a geração bem-sucedida.
* **Modelo usado:** `sessions.model` → padrão global → fallback (§11.2); gravado em `narrative_pages.model_identifier`.

### 11.13 HP do Narrador implementado (§4, §8.2)
* `GET /api/sessions/:id/token-count` → `{ tokens_used, token_limit, model, hp_percent, state }`, com `state` em `green` (≥ 50%), `yellow` (≥ 20% e < 50%) ou `red` (< 20%). `hp_percent` é limitado a [0, 100], com uma casa decimal, e calculado como `100 × (limite − usados) / limite` (equivalente à fórmula do §4.1, sem imprecisão de ponto flutuante nos limiares).
* Mede o payload real que seria enviado ao Narrador: regras + contexto do mundo + corpus ativo (páginas arquivadas ficam de fora), sem input pendente do jogador.
* **Limitação da API:** a Gemini Developer API **rejeita `systemInstruction` em `countTokens`**. As regras de narração são, portanto, contadas como texto somado ao conteúdo; a diferença é de poucos tokens de moldura.
* **Cache:** a contagem é guardada em memória por hash (modelo + regras + conteúdo). Reabrir uma sessão sem alterações não chama a API; qualquer alteração de página, contexto ou regras muda o hash e força nova contagem. Não há polling nem recálculo por tecla (§11.7) — o frontend consulta o endpoint nos eventos definidos.
* Erros: `404` (sessão), `409 missing_api_key` (sem chave), `502` (falha da API de contagem).

### 11.14 Modo Diálogo implementado (§3, §8.3)
* **Ativação:** só pelo `dialogue_trigger` do Narrador (§11.12). Cria `dialogue_sessions` com status `active`; o índice único parcial garante um diálogo ativo por sessão. Enquanto houver diálogo ativo, `narrative/next` e `regenerate` respondem `409`.
* **Sigilo do NPC:** o `dynamic_system_prompt` (que pode conter segredos do NPC) **nunca** é devolvido pela API e **não** é enviado ao Narrador na costura. Os endpoints expõem apenas `{id, session_id, npc_name, status, created_at}`.
* `POST /api/dialogue/:id/message` `{message}` → `{player_message, npc_message, npc_wants_to_end}`. Chamada ao Gemini com o prompt dinâmico + regras fixas de interpretação como `systemInstruction` e **somente** as falas da cena como histórico multi-turno (`user` = protagonista, `model` = NPC); nem o corpus nem meta-instruções do Narrador entram. A resposta usa JSON estruturado `{reply, end_conversation}`; `end_conversation` vira o sinal `npc_wants_to_end`, que a UI usa apenas para destacar o botão `[Encerrar Diálogo e Narrar]` (a decisão continua sendo do autor). As duas falas só são gravadas juntas, após sucesso, mantendo o histórico sempre alternado. Uma mensagem por vez por diálogo (`409` caso contrário).
* `POST /api/dialogue/:id/conclude` (SSE, mesmos eventos do §11.12): envia ao Narrador regras + mundo + corpus ativo + o texto do §3.3 com a transcrição literal (`Protagonista: …` / `<NPC>: …`). Numa única transação, grava a página de costura e marca o diálogo como `concluded` — **este é o único ponto em que o diálogo altera `narrative_pages`** (checklist §10 nº 5). O `player_instruction` da página guarda `[Diálogo com <NPC>]` + transcrição, preservando a origem para auditoria. Se a costura falhar, nada é gravado e o diálogo continua ativo. O Narrador pode encadear um novo diálogo no mesmo turno.
* `POST /api/dialogue/:id/cancel` *(extensão do design)*: descarta o diálogo e suas mensagens sem narrar, para o caso de um gatilho indesejado deixar a sessão "presa". Concluir sem nenhuma fala trocada retorna `409` sugerindo o cancelamento.
* `GET /api/sessions/:id/dialogue/active` → `{dialogue, messages}` para reconexão após reload (§11.6); `GET /api/sessions/:id` também inclui `active_dialogue` (sem o prompt).

### 11.15 Compactação implementada (§4.3, §8.4)
* **Cisão 75/25 por peso** ([`src/ai/compaction.ts`](src/ai/compaction.ts)): o Corpus Passado é o maior prefixo cronológico das páginas ativas cujo peso acumulado (tamanho do texto) não excede 75% do total; o restante é o Corpus Ativo. Sempre fica ao menos 1 página de cada lado; com menos de 2 páginas ativas a API responde `409`.
* `POST /api/sessions/:id/compact/preview` → `{summary_text, covered_page_start_index, covered_page_end_index, pages_to_archive, pages_to_keep, next_volume_number, model}`. Envia ao modelo (texto livre, sem JSON) apenas o Corpus Passado + o contexto do mundo (como referência de grafia) sob o prompt do "Arquivista Editorial" (sinopse factual densa, ~1/8 do original). **Não grava nada.** Meta-instruções do jogador não são enviadas.
* `POST /api/sessions/:id/compact/commit` `{summary_text, covered_page_start_index, covered_page_end_index}` (a sinopse já revisada/editada pelo usuário): valida que a faixa é exatamente um prefixo das páginas ativas e que a última página é preservada (senão `409`: "gere uma nova minuta"). Numa única transação: cria o volume em `chronicle_archives`, marca as páginas como `is_archived` e anexa ao `world_context` o trecho `## Crônica — Volume N` + sinopse. Qualquer falha desfaz tudo.
* Preview e commit exigem a trava da sessão (sem geração concorrente) e ausência de diálogo ativo.
* O HP volta a subir porque as páginas arquivadas saem do corpus e a sinopse (bem menor) entra no `world_context`; o frontend reconsulta `token-count` após o commit (§11.7).

### 11.16 Ramificação implementada (§6.2)
* `POST /api/narrative/pages/:id/branch` `{confirm_truncate?}` *(extensão do design)*: "Ramificar a partir daqui" — descarta as páginas ativas posteriores à página `:id` (sem gerar nada) para o autor continuar a história a partir dela. Se houver páginas posteriores e `confirm_truncate` não for `true`, responde `409 {code: "truncation_required", pages_to_discard}`. Retorna `{discarded, last_page_id}`. Recusado com diálogo ativo ou geração concorrente.
* `GET /api/settings` passou a incluir `default_system_rules` (texto padrão das regras do Narrador) para o botão "Restaurar padrão" da gaveta.

### 11.17 Frontend implementado (§7)
* **Código** em [`client/`](client/) (TypeScript sem framework, bundle esbuild → `public/assets/app.js`; Tailwind 3 → `public/assets/app.css`; `npm run build:client`). Roteamento por hash: `#/` (biblioteca) e `#/s/<id>` (sessão). Módulos: `api.ts` (tipos, `fetch`, `streamTurn` para POST+SSE), `sse.ts` (parser incremental puro), `dom.ts` (helper `h()`, toasts, modais), `theme.ts`, `views/{home,session,drawer,compaction}.ts`.
* **Tema:** as variáveis CSS do §7.2 vivem em classes `theme-*` na raiz `<html>`; a escolha é gravada na sessão (`active_theme`) e em `localStorage` (usada na tela inicial). Cores semânticas do Tailwind (`main`, `panel`, `ink`, `accent`, `hp-*`…) apontam para essas variáveis.
* **Fontes** empacotadas por [`scripts/copy-fonts.mjs`](scripts/copy-fonts.mjs) (subconjunto latino, `woff2` + licenças OFL em `public/fonts/`); nenhuma requisição a CDN.
* **Tome:** *(layout substituído pelo §11.22: uma folha por página)* prosa em parágrafos recuados; capitular só na primeira página. Durante o streaming uma "página fantasma" recebe os `chunk` (texto + cursor piscante); no evento `page`/`done` a sessão é recarregada do servidor (única fonte da verdade, inclusive após truncamento). Em re-geração o fantasma ocupa o lugar da página e as posteriores aparecem esmaecidas. Se a geração falhar, o texto digitado na Doca é preservado.
* **Ações de página** *(hoje ícones sempre visíveis, §11.22; descrição original:)* visíveis no hover em telas largas e sempre em telas estreitas: `[Editar Texto]` (preserva as páginas seguintes), `[Ver Prompt de Origem / Re-gerar]` (modal pré-preenchido com `player_instruction`; avisa quantas páginas serão descartadas e envia `confirm_truncate`), `[Ramificar a partir daqui]` (§11.16).
* **HP:** a Doca consulta `token-count` apenas nos eventos de §11.7 (abrir sessão, página gerada/regenerada, edição, contexto salvo, compactação, ramificação). "Compactar Crônica" pulsa quando `state = red`.
* **Modo Diálogo:** a Doca troca para "Falando com: NPC"; a transcrição aparece num cartão no fim do Tome; `[Encerrar Diálogo e Narrar]` ganha destaque quando `npc_wants_to_end`; `[Descartar]` chama `cancel`. Ao recarregar, `dialogue/active` restaura a cena. Compactar fica desabilitado durante o diálogo.
* **Testes:** `test/clientSse.test.ts` (parser), `test/static.test.ts` (index/fontes/sem CDN) e `test/ui.test.ts` (jsdom executa o bundle real do cliente contra o servidor Fastify numa porta de loopback com Gemini mockado: chave → sessão → narrar → editar → re-gerar com descarte → diálogo → reconexão → compactação → ramificação → erro do Narrador).

### 11.18 Docker implementado (§9)
* **Node 22, não 20:** o `better-sqlite3` 13 exige Node ≥ 22; imagens `node:22-alpine` e `engines: ">=22"`.
* **Estágios:** `base` (Alpine + `python3 make g++`), `deps` (`npm ci --omit=dev`), `builder` (`npm ci` + `npm run build` = `tsc` + esbuild + Tailwind) e `runner` (sem toolchain nem devDependencies: copia só `node_modules` de produção, `dist/` e `public/`).
* **better-sqlite3 no Alpine:** o pacote já inclui binários pré-compilados `linuxmusl-*`; `deps` instala com `--ignore-scripts`, valida o carregamento do módulo e só recompila do código-fonte (`npm rebuild --build-from-source`) se a validação falhar — a toolchain da `base` cobre esse fallback.
* **Runtime:** `HOST=0.0.0.0` é definido no container (o padrão do app é `127.0.0.1`). `docker-entrypoint.sh` (via `su-exec`) corrige a posse do volume `/data` — bind mounts são criados como root pelo Docker — e executa o servidor como o usuário `node`. `HEALTHCHECK` consulta `/api/health`.
* **`docker-compose.yml`:** sem a chave obsoleta `version:`; `ports: "127.0.0.1:3000:3000"` (§11.9); volume `./data:/data`.
* **`.dockerignore`:** exclui `GEMINIKEY.txt`, `data/`, `*.db*`, `node_modules/`, `.git/`, testes e `public/assets` (recompilado no build), para que a chave e o banco nunca entrem no contexto/imagem.
* **Validação feita (histórico):** o Docker não estava disponível no ambiente quando o item foi escrito (testado depois; veja §11.21); foram validados `npm run build`, a instalação isolada `npm ci --omit=dev --ignore-scripts` (0 vulnerabilidades) e a inicialização de `node dist/server.js` com apenas as dependências de produção (`/api/health`, `/`, `/assets/*`, `/fonts/*` e `/api/settings` respondem 200).
* **Podman rootless (validado):** `podman build` e `podman-compose up -d --build` funcionam com o mesmo Dockerfile (o `HEALTHCHECK` é ignorado no formato OCI, só gera aviso). Em rootless, o root do contêiner é o usuário do host, então o `chown` do entrypoint rebaixaria a posse de `./data` para um subuid; por isso existe o override [`docker-compose.podman.yml`](docker-compose.podman.yml) (`userns_mode: keep-id` + `user: "1000:1000"`), e o entrypoint só faz `chown`/`su-exec` quando roda como root. O volume usa `:Z` para o rótulo SELinux (inofensivo onde não há SELinux). Verificado: contêiner publicado em `127.0.0.1:3000`, endpoints respondendo 200 e `./data` pertencendo ao usuário.

### 11.19 Favicon, modo claro/escuro e exportação em Markdown (§7)
* **Favicon:** [`public/favicon.svg`](public/favicon.svg) (tome aberto com uma centelha), mais `favicon.ico` (16/32/48) e `apple-touch-icon.png` (180), todos locais; referenciados no `index.html`.
* **Claro/escuro:** cada um dos 4 temas tem as duas variações (`.theme-<tema>.mode-light|mode-dark` em [`client/styles.css`](client/styles.css)). `<html>` recebe sempre uma classe de tema **e** uma de modo. A preferência de modo (`Automático (sistema)` — padrão —, `Claro`, `Escuro`) é global do navegador (`localStorage: chronicler.mode`), independente do tema da sessão (`active_theme`, inalterado no banco). No modo automático a UI acompanha `prefers-color-scheme`, inclusive mudanças em tempo real. Um script inline no `<head>` aplica tema e modo antes da primeira pintura (sem "flash"). O seletor de modo fica na tela inicial e no cabeçalho da sessão. Nota: no modo automático, um sistema claro mostra o Cyberpunk em sua variação clara; para ver a aparência neon original, escolha `Escuro`.
* **Exportação `.md`** *(estendida no §11.22: escopos, separador `---` e exportação por volume)*: `GET /api/sessions/:id/export[?include_context=true]` devolve `text/markdown` como anexo (`Content-Disposition` com `filename` ASCII e `filename*` UTF-8). Conteúdo ([`src/export.ts`](src/export.ts)): `# Título`, linha de metadados (data e nº de páginas), a prosa de **todas** as páginas em ordem — inclusive as arquivadas na compactação, com o texto original — e, com `include_context`, a seção `## Mundo e personagens` (que já carrega as sinopses `## Crônica — Volume N`) seguida de `## Narrativa`. Instruções do jogador (`player_instruction`) **nunca** são exportadas. Na UI, o botão **Salvar .md** do cabeçalho abre uma janela com a opção de incluir o contexto e dispara o download via `fetch` + `Blob`.

### 11.20 Cabeçalho com ícones e tela inicial responsiva (§7)
* **Botões só com ícone:** no cabeçalho da sessão, *Biblioteca*, *Tema visual*, *Modo claro/escuro*, *Salvar .md* e *Contexto* viram botões quadrados (36 px) com SVG inline local ([`client/icons.ts`](client/icons.ts), sem CDN nem fonte de ícones). O cabeçalho deixou de quebrar linha: o título é a única parte flexível e trunca com reticências.
* **Tooltips:** CSS puro via `data-tip` + `::after` (classe `.tip`), exibidos ao passar o mouse **e** ao focar com o teclado (`:focus-visible`), com alinhamento `start`/`end` para não vazar da tela. O rótulo acessível é o `aria-label` (estável: `Voltar à biblioteca`, `Tema visual`, `Modo claro ou escuro`, `Salvar em Markdown`, `Contexto da sessão`); o tooltip dos menus informa o valor atual (ex.: `Tema visual: Cyberpunk (Neon)`). Em telas de toque não há hover; o `aria-label` permanece.
* **Seletores viraram menus:** tema e modo são botões de ícone que abrem um pequeno menu `role=menu` com itens `menuitemradio` (o atual marcado com ✓). Fecha com Esc, clique fora, perda de foco ou ao escolher; ↑/↓ navegam. O ícone do modo reflete a preferência (monitor = automático, sol, lua). Implementação em [`client/controls.ts`](client/controls.ts) (`iconButton`, `createMenuControl`, `createThemeControl`, `createModeControl`). O campo **Tema** do formulário *Nova crônica* continua sendo um `<select>` (é um campo de formulário com rótulo, não um controle de cabeçalho).
* **Correção do corte no celular:** a causa era a coluna implícita `auto` das grades (`grid` sem `grid-cols-*` abaixo do breakpoint), que crescia até a largura da `<option>` mais longa dos seletores de modelo e empurrava o cartão para fora da tela. Correções: `grid-cols-1` (`minmax(0,1fr)`) + `min-w-0` nos filhos das grades, `main` e cartões; `.input` passou a ter `min-w-0 max-w-full`; linhas de *Suas crônicas* com título truncado e data em linha própria; botões auxiliares com `shrink-0`. Coberto por teste de regressão da marcação (jsdom não calcula layout, então a checagem visual em um celular real continua sendo recomendada).

### 11.21 README, capturas de tela e encerramento gracioso
* **README:** reescrito com requisitos, passo a passo para subir com **Docker**, **Podman + podman-compose** e **Podman puro** (`podman build` + `podman run`, validado), primeiro uso, atualização/backup, solução de problemas, galeria de capturas e visão técnica. Registra a pegadinha do Podman: `up -d --build` pode manter o contêiner antigo; use `--force-recreate`.
* **Capturas:** [`scripts/screenshots.ts`](scripts/screenshots.ts) (`npm run screenshots`) sobe o app com SQLite em memória e Gemini simulado, popula 3 crônicas de exemplo (inclusive um diálogo ativo) e fotografa com Chromium headless via `playwright-core` (devDependency; usa o navegador do Playwright em `~/.cache/ms-playwright` ou `CHROME_PATH`). As imagens ficam em `docs/screenshots/` e **não** entram no contexto de build da imagem (`.dockerignore`). O script também mede a rolagem horizontal das telas móveis (0 px).
* **Ajuste de layout achado nas capturas:** na doca, a barra de HP ficava reduzida a um fio no celular por dividir a linha com o botão *Compactar Crônica*; a linha agora quebra (`flex-wrap`, barra com largura mínima de 16rem).
* **Encerramento gracioso:** como PID 1 do contêiner, o Node ignorava `SIGTERM` e `stop`/`down` esperavam 10 s até o `SIGKILL`. O servidor agora trata `SIGTERM`/`SIGINT` (`app.close()` com limite de 3 s para conexões SSE abertas).
* **Docker validado (Docker 29.7.2 + Compose 5.5.1, Fedora 44):** `docker compose up -d --build` (override temporário com `ports: !override` na 3100 e volume em `/tmp`, para não colidir com o Podman), build em ~100 s sem cache, contêiner `healthy`, `/api/health`, `/`, `/assets/*`, `/favicon.svg` e `/api/settings` = 200, criação de sessão via API, volume inexistente criado como root pelo Docker e corrigido pelo *entrypoint* (arquivos do SQLite pertencem ao usuário), processo do servidor sem root (`docker top`), dados mantidos após `docker restart` (0,5 s, graças ao tratamento de `SIGTERM`) e `down` limpo. Pré-requisito observado: usuário no grupo `docker` (`sudo usermod -aG docker $USER`), documentado no README.

### 11.22 Páginas: cartão por página, volumes legíveis e exportação por escopo (§2, §4.3, §6, §7)
* **Conceito e nomenclatura:** o texto gerado por cada prompt é uma **página** do Tome (antes "bloco"). A renomeação é completa e **sem migração**: tabela `narrative_pages`, índice `idx_pages_order`, campos `covered_page_start_index`/`covered_page_end_index`, rotas `/api/narrative/pages/:id[/regenerate|/branch]` (sem alias das antigas), JSON `pages`, `pages_to_archive`/`pages_to_keep`/`pages_to_discard`, evento SSE `page`, tipo `Page`, repositório `repos.pages`. O projeto é um "pré-pré-alpha": **atualizações não são suportadas**. `SCHEMA_VERSION` passou a 2 e um banco de versão anterior falha na abertura com mensagem clara (apague `./data`), em vez de `no such table`.
* **Numeração absoluta:** o título do cartão é `Página N`, com `N = order_index` (começa em 1 e nunca é reaproveitado). Após uma compactação o Tome pode começar na "Página 4"; o total de páginas da crônica não se perde. A letra capitular aparece só na página 1 (visível no leitor de volume).
* **Cartão de página** ([`client/pageCard.ts`](client/pageCard.ts)): cada página é uma folha separada (`.page-card`: cabeçalho "Página N", corpo em prosa e rodapé de ações), com os tokens por tema `--page-bg`, `--page-border` e `--page-shadow` em [`client/styles.css`](client/styles.css). O rodapé tem **três botões só de ícone SVG, um símbolo por ação, sempre visíveis** (nunca dependem de hover), com `aria-label` e tooltip: **lápis** = *Editar texto da página* (edita dentro do cartão; preserva as seguintes); **balão com linhas de texto** = *Editar prompt e re-gerar* (modal com o prompt de origem; se houver páginas posteriores, o aviso destrutivo continua e o envio manda `confirm_truncate`); **bifurcação** = *Ramificar a partir desta página* (desabilitado na última página; descarta as posteriores, com confirmação). Estados: edição no cartão (`.is-editing`), página fantasma durante o streaming (cabeçalho com o número que a página terá), páginas esmaecidas (`.is-dimmed`) quando uma re-geração descartará as posteriores. O mesmo componente roda em modo `readonly` (sem rodapé) no leitor de volume. Os tooltips do rodapé ancoram na borda direita do botão e têm largura máxima de 60 vw (tooltips invisíveis também contam para o `scrollWidth`; sem isso o celular ganhava rolagem horizontal).
* **Páginas consumidas continuam legíveis:** a compactação segue marcando as páginas como `is_archived` (saem do contexto da IA, do HP e da próxima compactação), mas elas **permanecem no banco** e o jogador pode relê-las e exportá-las. `GET /api/archives/:id/pages` devolve `{archive, pages}` (somente as páginas arquivadas entre `covered_page_start_index` e `covered_page_end_index`, sob demanda). Páginas arquivadas não são editáveis nem pontos de ramificação (`409`).
* **Leitor de volume = página própria** (rota `#/s/<id>/v/<n>`, [`client/views/volume.ts`](client/views/volume.ts)): cabeçalho com voltar, modo claro/escuro e exportar; cartão de sinopse; páginas em `readonly`; navegação para o volume anterior/seguinte e de volta ao Tome. O Tome mostra, acima das páginas ativas, uma linha com links "Volume N · páginas X a Y"; a aba *Crônica* da gaveta lista cada volume com a sinopse, o botão **Ler as N páginas** e o ícone de salvar o volume.
* **Exportação** ([`src/export.ts`](src/export.ts)): as páginas são separadas por `---` (linhas em branco ao redor); a linha de metadados diz "N páginas"; prompts do jogador **nunca** são exportados. `GET /api/sessions/:id/export?scope=all|active|archived&include_context=` (padrão `all`; `active` = só o que está no Tome; `archived` = só as páginas já em volumes, `409` se não houver nenhuma; o nome do arquivo ganha o sufixo "no Tome" ou "volumes"). `GET /api/archives/:id/export?include_summary=` gera `# Título — Volume N`, metadados (faixa de páginas), `## Sinopse` (incluída por padrão; `include_summary=false` a omite) e as páginas do volume. Na UI, o modal "Salvar em Markdown" ganhou o escopo (Crônica completa · Só o que está no Tome · Só as páginas já em volumes) e cada volume tem o seu ícone de download (com a caixa "Incluir a sinopse").
* **Os 8 temas:** o cartão é validado nas 8 combinações (4 temas × claro/escuro). [`test/pageThemes.test.ts`](test/pageThemes.test.ts) lê as variáveis reais do CSS e exige contraste WCAG ≥ 4,5:1 para texto, texto forte e texto esmaecido sobre a folha, ≥ 3:1 para ícones e acento, e borda da folha ≥ 1,3:1 contra o fundo do Tome (o texto esmaecido do Pós-apocalíptico escuro foi clareado de `#948677` para `#a09282` por causa disso). `npm run check:paginas` ([`scripts/check-pages.ts`](scripts/check-pages.ts)) roda um Chromium headless nas 8 combinações em 1280 px e 390 px e verifica no DOM renderizado: numeração, ações com opacidade 1, alvo ≥ 32 px, dentro do cartão e clicáveis, um único ícone por ação, glifos distintos, ícones na mesma linha, contraste calculado, ausência de rolagem horizontal, cartões sem sobreposição, tooltip no hover, edição dentro do cartão, aviso de volumes e leitor somente leitura; gera capturas em `docs/screenshots/paginas/`.
* **Testes:** `test/archives.test.ts` (leitura/exportação de volumes e prova de que as páginas arquivadas ficam fora do contexto da IA, do HP e do Tome mas dentro da leitura e da exportação), `test/export.test.ts` (separador, escopos, volume), `test/repositories.test.ts` (guarda de banco antigo) e `test/ui.test.ts` (cartões, ícones, leitor, exportação por escopo).

### 11.23 Mobile: app shell, tela cheia e instalável (§7)
* **Problema (Android/Chrome):** as telas da sessão e do leitor usavam `h-screen` (`100vh` = a maior altura possível, como se a barra do navegador estivesse recolhida), então com a barra visível a doca de digitação ficava fora da tela; e, por padrão, o Chrome Android **não** redimensiona o layout quando o teclado abre (`interactive-widget=resizes-visual`): a página rola e o cabeçalho some.
* **App shell** ([`client/viewport.ts`](client/viewport.ts), `.app-screen` e `html.app-shell` em [`client/styles.css`](client/styles.css)): nas rotas `#/s/<id>` e `#/s/<id>/v/<n>` o roteador liga `app-shell` no `<html>` (documento sem rolagem, `overscroll-behavior: none`) e a tela ocupa exatamente a área visível — cabeçalho no topo, doca embaixo, e **só a região das páginas rola** (`#tome-scroll`, `#volume-scroll`). A biblioteca continua com rolagem normal e o `app-shell` é desligado ao sair das rotas.
* **Altura útil:** a meta `viewport` agora é `width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content` (o teclado encolhe o layout) e a altura da tela é `100dvh` (`100vh` onde a unidade não existe). Como plano B (iOS/Safari, que só encolhe a *janela visual* e rola o documento), `client/viewport.ts` copia `visualViewport.height` para `--app-height`, devolve o documento ao topo e não interfere durante zoom por pinça. `env(safe-area-inset-*)` protege entalhes/barras de gesto. Em altura ≤ 520 px (teclado aberto, celular deitado) a linha de HP/“Compactar Crônica” da doca (`.dock-meta`) é ocultada para sobrar espaço às páginas.
* **Tela cheia:** [`fullscreenButton()`](client/controls.ts) — botão de ícone (padrão `iconButton`: um ícone, `aria-label` e tooltip em pt-BR, alterna “Tela cheia” / “Sair da tela cheia”) no cabeçalho da biblioteca, da sessão e do leitor; usa a Fullscreen API e **não aparece** onde ela não existe (iPhone). Ícones `fullscreen`/`fullscreenExit` em [`client/icons.ts`](client/icons.ts).
* **Instalável (PWA mínimo):** [`public/manifest.webmanifest`](public/manifest.webmanifest) com `display: standalone` (sem barra do navegador, **com** barra de status; sem modo imersivo), `start_url`/`scope` `/`, `lang pt-BR`, ícones PNG 192/512 e *maskable* 512 em `public/icons/` (gerados de `public/favicon.svg` por `npm run icons`, [`scripts/make-icons.ts`](scripts/make-icons.ts)) e metas Android/iOS em `index.html`. `<meta name="theme-color">` acompanha o `--bg-panel` do tema/modo ativo (`client/theme.ts`). **Sem service worker:** o Chromium reporta zero erros de instalabilidade sem ele (verificado via CDP); não há offline nem cache. Não há botão/convite de instalação na UI — apenas o manifesto, e a instalação é documentada no README. Exige HTTPS (ou `localhost`).
* **Testes:** [`test/mobile.test.ts`](test/mobile.test.ts) (meta viewport, metas de app, ausência de `h-screen` nas telas, manifesto com MIME correto e ícones existentes com o tamanho declarado, `viewport.ts` com `visualViewport` simulado, botão de tela cheia, `theme-color`) e `npm run check:mobile` ([`scripts/check-mobile.ts`](scripts/check-mobile.ts)): navegador headless emulando 390 px de largura em três alturas (844 tela cheia, 760 com barra do navegador, 480 com teclado), sessão e leitor, 8 temas — cabeçalho no topo, doca colada ao fim, sem rolagem do documento, só a área das páginas rola, campo visível ao focar, sem overflow horizontal, botões do cabeçalho sem sobreposição, `theme-color` igual ao painel do tema, instalabilidade sem erros (CDP) e biblioteca com rolagem normal. Roda no Chromium e no Firefox (`BROWSER=firefox`); capturas em `docs/screenshots/mobile/` e `mobile-firefox/`.
* **Limites da verificação:** não há celular real nem iOS no ambiente: o teclado é emulado reduzindo a altura do viewport, e a barra do navegador idem; a diferença `100vh` × `100dvh` só existe em navegador móvel real (por isso há um teste estático contra `h-screen`). A confirmação final é no aparelho.

### 11.24 Narração por voz (TTS Gemini 3.8) (§2, §5, §6, §7)
* **Escopo e decisões do autor:** cada página pode ser lida em voz alta (pt-BR) por um narrador velho de voz grossa. Voz padrão **Gacrux** (pré-definida, "Mature": as vozes testadas antes tinham sotaque carioca indesejado), estilo editável (`voz grave, rouca e pausada de um velho narrador`). **Geração automática por sessão**, herdando um padrão global **desligado**. **Sem reprodução contínua** ("ler daqui até o fim"): um clique em "ler tudo" poderia gerar centenas de páginas e gastar tokens sem o usuário perceber; cada geração é um pedido explícito (ou automático, se ligado). **O Modo Diálogo nunca é narrado**: só páginas (inclusive a página em prosa criada ao encerrar um diálogo, que segue a regra automática).
* **API do Gemini:** os modelos `gemini-3.8-flash-tts` (padrão) e `gemini-3.8-flash-lite-tts` só funcionam bem pela **Interactions API** (`ai.interactions.create`, `response_format: {type:'audio'}`, voz em `generation_config.speech_config`, estilo como anotação `speech_metadata` no texto). Em `generateContent` o estilo escrito no texto é lido em voz alta e `systemInstruction` é rejeitado. A resposta unária é WAV 24 kHz mono 16 bits. `GeminiGateway.synthesize` ([`src/ai/gateway.ts`](src/ai/gateway.ts)) normaliza erros (`SynthesisError`, com `retryable` para 429/5xx/rede) em mensagens pt-BR. As vozes da *Voice Library* e do *Voice Design* foram experimentadas e **não** são usadas (o Voice Design criaria recursos persistentes na conta do usuário).
* **Armazenamento (schema v3, sem migração):** tabela `page_audio` (`page_id` PK → `narrative_pages` `ON DELETE CASCADE`, `text_sha256`, `voice`, `model`, `style`, `mime`, `duration_ms`, `bytes`, `audio` BLOB, `created_at`) e `sessions.tts_auto` (`NULL` = herda o padrão global). Os blobs **nunca** vão nas listagens de páginas (o JSON traz só metadados em `page.audio`). Para o arquivo do banco realmente encolher após descartes, o banco novo é criado com `auto_vacuum = INCREMENTAL` (definido em `openDatabase` antes do pragma WAL, só quando `user_version = 0`) e o `AudioRepository.reclaim()` roda `incremental_vacuum` fora de transações. A leitura confere o `text_sha256`: áudio de um texto que já mudou é tratado como inexistente.
* **Descarte (sem inflar o banco):** editar o texto (`audio.discard`), re-gerar (apaga o da página e cancela jobs dela e das seguintes, na mesma transação do descarte das páginas), ramificar (cancela os jobs das páginas removidas) e excluir a sessão (CASCADE + cancelamento). Páginas de volumes continuam narráveis.
* **Pipeline** ([`src/tts/`](src/tts)): `cleanForSpeech` remove markdown/símbolos; `splitForSpeech` quebra por parágrafos/sentenças em trechos de ≈1.500 caracteres; cada trecho é sintetizado, o WAV decodificado ([`pcm.ts`](src/tts/pcm.ts)), os trechos são unidos com ≈250 ms de silêncio e codificados em **MP3 48 kbps mono** ([`mp3.ts`](src/tts/mp3.ts), `@breezystack/lamejs`, **LGPL-3.0**, cedendo o laço de eventos entre blocos): ≈ 6 KB/s, 8× menor que o WAV. [`AudioService`](src/tts/service.ts): um job por página com progresso n/m, cancelamento, no máximo 2 sínteses simultâneas, retentativas (2 s, 6 s, 15 s) em 429/5xx/rede, o áudio antigo só é substituído quando o novo fica pronto, e o resultado de um job é descartado se a página mudou ou sumiu enquanto ele rodava (hash).
* **Rotas** ([`src/routes/audio.ts`](src/routes/audio.ts)): `POST /api/narrative/pages/:id/audio` (202; gera ou gera de novo), `GET …/audio/status`, `POST …/audio/cancel`, `GET …/audio` (MP3 com `Range` 206/416, `?download=true`, `ETag`, `Cache-Control: private, no-cache`), `DELETE …/audio`; `GET/PUT /api/settings/tts` (auto padrão, modelo, voz — 30 vozes pré-definidas —, estilo; guardados em `app_settings`), `POST /api/settings/tts/sample` (amostra, não grava), `DELETE /api/audio` (apaga todos). `tts_auto` entra no `PUT /api/sessions/:id/context`. A página enviada por SSE (`page`) e as listagens já trazem `audio`.
* **Interface:** quarto ícone **Ouvir esta página** (alto-falante) sempre visível no rodapé do cartão (à esquerda; os outros três continuam à direita), um ícone SVG por ação; no leitor de volume o rodapé tem só esse ícone. O painel acima do rodapé mostra *gerando n/m* (com cancelar), erro (com tentar de novo) ou o player (tocar/pausar, barra, tempo, velocidade 0,75–1,5× lembrada no `localStorage`, gerar de novo com confirmação, apagar com confirmação, baixar `.mp3`). Há **um único `<audio>`** global ([`client/audioPlayer.ts`](client/audioPlayer.ts)): tocar uma página pausa a outra; integra com Media Session; a reprodução para ao sair da tela ou quando a página perde o áudio. Gaveta da sessão: aba **Voz** (herdar/ligada/desligada). Tela inicial: cartão **Narração por voz** (padrão global, voz, modelo, estilo, *Ouvir amostra*, *Restaurar padrão*, uso de armazenamento, *Apagar todos os áudios*).
* **Testes:** [`test/ttsUnits.test.ts`](test/ttsUnits.test.ts) (limpeza, quebra, PCM/WAV/MP3), [`test/audio.test.ts`](test/audio.test.ts) (geração, cache sem nova chamada à API, `Range`, trechos, retentativas e erros, cancelamento, concorrência, descarte por edição/regeneração/ramificação/exclusão, hash de segurança, corridas, geração automática global/por sessão/diálogo, configurações, encolhimento do arquivo com `auto_vacuum`, CASCADE), [`test/uiAudio.test.ts`](test/uiAudio.test.ts) (jsdom) e `npm run check:audio` ([`scripts/check-audio.ts`](scripts/check-audio.ts)): 8 temas × desktop 1280 / celular 390 em Chromium **e** Firefox — ícones únicos, alvos ≥ 32 px, contraste, painel dentro do cartão, tooltips, reprodução real do MP3 (estado "tocando"), leitor de volume, gaveta e configurações; capturas em `docs/screenshots/audio/`. [`scripts/live-tts-e2e.ts`](scripts/live-tts-e2e.ts) faz o fluxo ponta a ponta com a API real e **transcreve** o MP3 gerado com um modelo de texto para verificar a fidelidade do português.
* **Limites da verificação:** não é possível *ouvir* o áudio no ambiente; a qualidade da voz é julgada pelo autor (a transcrição confirma o texto, e um modelo descreveu a voz como masculina, grave, em português brasileiro neutro). Nomes inventados podem ser pronunciados de modo criativo (ex.: "Varn" foi transcrito como "Warnak"/"Varne"). Custo ≈ 1,5 mil tokens de saída por minuto de áudio (≈ 25 s de áudio levaram 10–12 s para gerar).
