export interface Session {
  id: string;
  title: string;
  system_rules: string;
  world_context: string;
  active_theme: string;
  token_limit: number;
  /** Modelo Gemini da sessão; null = usar o padrão global. */
  model: string | null;
  created_at: string;
  updated_at: string;
}

export interface NarrativeBlock {
  id: string;
  session_id: string;
  order_index: number;
  player_instruction: string | null;
  generated_text: string;
  model_identifier: string | null;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface ChronicleArchive {
  id: string;
  session_id: string;
  volume_number: number;
  summary_text: string;
  covered_block_start_index: number;
  covered_block_end_index: number;
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
}

export interface DialogueMessage {
  id: string;
  dialogue_session_id: string;
  sender: 'player' | 'npc';
  content: string;
  created_at: string;
}
