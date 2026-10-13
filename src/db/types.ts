export interface Session {
  id: string;
  title: string;
  system_rules: string;
  world_context: string;
  active_theme: string;
  token_limit: number;
  /** Modelo Gemini da sessão; null = usar o padrão global. */
  model: string | null;
  /** Narração automática das páginas novas: true/false, ou null = usar o padrão global. */
  tts_auto: boolean | null;
  /** Narração automática das páginas de diálogo: true/false, ou null = usar o padrão global (desligado de fábrica). */
  tts_auto_dialogue: boolean | null;
  created_at: string;
  updated_at: string;
}

/** `narrative`: prosa do Narrador; `dialogue`: a transcrição de uma conversa com um NPC, gravada como está. */
export type PageKind = 'narrative' | 'dialogue';

export interface Page {
  id: string;
  session_id: string;
  order_index: number;
  player_instruction: string | null;
  generated_text: string;
  model_identifier: string | null;
  is_archived: boolean;
  kind: PageKind;
  /** Nome do NPC (somente `kind = 'dialogue'`). A persona secreta do NPC nunca está na página. */
  npc_name: string | null;
  /** Página de diálogo que ainda guarda a transcrição crua (`**Nome:** fala`): pode ser narrada depois. */
  raw_dialogue: boolean;
  created_at: string;
  updated_at: string;
}

export interface ChronicleArchive {
  id: string;
  session_id: string;
  volume_number: number;
  summary_text: string;
  covered_page_start_index: number;
  covered_page_end_index: number;
  created_at: string;
}

export type DialogueStatus = 'active' | 'concluded';

export interface DialogueSession {
  id: string;
  session_id: string;
  npc_name: string;
  dynamic_system_prompt: string;
  status: DialogueStatus;
  created_at: string;
  /** Como o protagonista é chamado na conversa (inferido pelo Narrador); null = "Protagonista". */
  player_name: string | null;
  /** Página gerada por este diálogo (preenchida ao encerrar; o diálogo some junto com a página). */
  page_id: string | null;
  /** Página de diálogo que este diálogo ativo vai substituir ao ser encerrado ("refazer diálogo"). */
  redo_page_id: string | null;
}

export interface DialogueMessage {
  id: string;
  dialogue_session_id: string;
  sender: 'player' | 'npc';
  content: string;
  created_at: string;
}
