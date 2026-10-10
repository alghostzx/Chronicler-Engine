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
 */
export const SCHEMA_VERSION = 2;

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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

CREATE INDEX IF NOT EXISTS idx_pages_order ON narrative_pages(session_id, order_index);
CREATE INDEX IF NOT EXISTS idx_dialogue_msgs ON dialogue_messages(dialogue_session_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_dialogue
    ON dialogue_sessions(session_id) WHERE status = 'active';
`;
