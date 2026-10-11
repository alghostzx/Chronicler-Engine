/**
 * Schema SQLite do Chronicler Engine (design document §5).
 *
 * Ajustes em relação ao §5 original (ver §11 do design document):
 *  - `sessions.model`: modelo Gemini escolhido para a sessão (NULL = padrão global).
 *  - `UNIQUE (session_id, order_index)` em `narrative_pages`.
 *  - `UNIQUE (session_id, volume_number)` em `chronicle_archives`.
 *  - Índice único parcial garantindo no máximo um diálogo `active` por sessão.
 *
 * Versão 2: "blocos" viraram "páginas" (`narrative_pages`, `covered_page_*`). O projeto é
 * pré-pré-alpha: não há migração entre versões — bancos antigos são recusados com uma mensagem clara.
 *
 * Versão 3: narração por voz. `page_audio` guarda o MP3 (BLOB) de cada página narrada, em tabela
 * separada para que listar páginas nunca carregue áudio; `sessions.tts_auto` liga/desliga a geração
 * automática por sessão (NULL = herda o padrão global).
 *
 * Versão 4: o diálogo executado vira uma página (`narrative_pages.kind = 'dialogue'`, com `npc_name`).
 * `dialogue_sessions.page_id` liga o diálogo concluído à sua página (some junto com ela) e guarda a
 * persona do NPC para refazer o diálogo; `redo_page_id` marca o diálogo ativo que vai substituir uma
 * página; `player_name` é o nome do protagonista na conversa (inferido pelo Narrador);
 * `sessions.tts_auto_dialogue` liga/desliga a narração automática das páginas de diálogo.
 *
 * A partir da versão 4 o projeto (alpha) migra bancos existentes: ver `migrations.ts`. Esta constante
 * descreve o schema de um banco NOVO; a ordem das colunas acrescentadas é a mesma dos `ALTER TABLE`
 * da migração (um teste confere que os dois caminhos geram o mesmo schema).
 */
export const SCHEMA_VERSION = 4;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    system_rules TEXT NOT NULL,
    world_context TEXT NOT NULL,
    active_theme TEXT DEFAULT 'medieval',
    token_limit INTEGER DEFAULT 1000000,
    model TEXT,
    tts_auto INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    tts_auto_dialogue INTEGER
);

CREATE TABLE IF NOT EXISTS narrative_pages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    order_index INTEGER NOT NULL,
    player_instruction TEXT,
    generated_text TEXT NOT NULL,
    model_identifier TEXT,
    is_archived BOOLEAN DEFAULT FALSE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    kind TEXT NOT NULL DEFAULT 'narrative' CHECK (kind IN ('narrative', 'dialogue')),
    npc_name TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    UNIQUE (session_id, order_index)
);

CREATE TABLE IF NOT EXISTS chronicle_archives (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    volume_number INTEGER NOT NULL,
    summary_text TEXT NOT NULL,
    covered_page_start_index INTEGER NOT NULL,
    covered_page_end_index INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    UNIQUE (session_id, volume_number)
);

CREATE TABLE IF NOT EXISTS dialogue_sessions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    npc_name TEXT NOT NULL,
    dynamic_system_prompt TEXT NOT NULL,
    status TEXT CHECK(status IN ('active', 'concluded')) DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    player_name TEXT,
    page_id TEXT REFERENCES narrative_pages(id) ON DELETE CASCADE,
    redo_page_id TEXT REFERENCES narrative_pages(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dialogue_messages (
    id TEXT PRIMARY KEY,
    dialogue_session_id TEXT NOT NULL,
    sender TEXT CHECK(sender IN ('player', 'npc')) NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (dialogue_session_id) REFERENCES dialogue_sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS page_audio (
    page_id TEXT PRIMARY KEY,
    text_sha256 TEXT NOT NULL,
    voice TEXT NOT NULL,
    model TEXT NOT NULL,
    style TEXT NOT NULL,
    mime TEXT NOT NULL DEFAULT 'audio/mpeg',
    duration_ms INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    audio BLOB NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (page_id) REFERENCES narrative_pages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pages_order ON narrative_pages(session_id, order_index);
CREATE INDEX IF NOT EXISTS idx_dialogue_msgs ON dialogue_messages(dialogue_session_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_dialogue
    ON dialogue_sessions(session_id) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS idx_dialogue_page
    ON dialogue_sessions(page_id) WHERE page_id IS NOT NULL;
`;
