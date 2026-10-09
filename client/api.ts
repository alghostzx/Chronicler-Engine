import { SseParser } from './sse';

// ---------------------------------------------------------------------------------------------
// Tipos espelhados do backend (src/db/types.ts e rotas).
// ---------------------------------------------------------------------------------------------
export type ThemeId = 'medieval' | 'cyberpunk' | 'pos-apocaliptico' | 'contemporaneo';

export const THEMES: { id: ThemeId; label: string }[] = [
  { id: 'medieval', label: 'Medieval (Pergaminho)' },
  { id: 'cyberpunk', label: 'Cyberpunk (Neon)' },
  { id: 'pos-apocaliptico', label: 'Pós-apocalíptico (Ferrugem)' },
  { id: 'contemporaneo', label: 'Contemporâneo (Minimalista)' },
];

export interface Session {
  id: string;
  title: string;
  system_rules: string;
  world_context: string;
  active_theme: ThemeId;
  token_limit: number;
  model: string | null;
  created_at: string;
  updated_at: string;
}

export interface Block {
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

export interface Archive {
  id: string;
  session_id: string;
  volume_number: number;
  summary_text: string;
  covered_block_start_index: number;
  covered_block_end_index: number;
  created_at: string;
}

export interface Dialogue {
  id: string;
  session_id: string;
  npc_name: string;
  status: 'active' | 'concluded';
  created_at: string;
}

export interface DialogueMessage {
  id: string;
  dialogue_session_id: string;
  sender: 'player' | 'npc';
  content: string;
  created_at: string;
}

export interface ModelInfo {
  id: string;
  displayName: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
}

export interface SettingsInfo {
  api_key_configured: boolean;
  default_model: string;
  default_system_rules: string;
}

export interface ModelsInfo {
  models: ModelInfo[];
  default_model: string;
  effective_default_model: string;
  available: boolean;
}

export type HpState = 'green' | 'yellow' | 'red';

export interface TokenInfo {
  tokens_used: number;
  token_limit: number;
  model: string;
  hp_percent: number;
  state: HpState;
}

export interface SessionDetail {
  session: Session;
  blocks: Block[];
  archives: Archive[];
  active_dialogue: Dialogue | null;
}

export interface CompactionPreview {
  summary_text: string;
  covered_block_start_index: number;
  covered_block_end_index: number;
  blocks_to_archive: number;
  blocks_to_keep: number;
  next_volume_number: number;
  model: string;
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* corpo não-JSON */
  }
  const message = typeof body.error === 'string' ? body.error : `Erro HTTP ${res.status}`;
  return new ApiError(message, res.status, typeof body.code === 'string' ? body.code : undefined, body);
}

export async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Não foi possível contatar o servidor.', 0);
  }
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------------------------
// Eventos SSE emitidos por turnos narrativos (turnRunner.ts)
// ---------------------------------------------------------------------------------------------
export interface TurnHandlers {
  onStart?(model: string): void;
  onChunk?(text: string): void;
  onBlock?(block: Block, discarded: number): void;
  onDialogueTrigger?(dialogue: { dialogue_id: string; npc_name: string }): void;
  onError?(message: string): void;
}

/**
 * POST com resposta SSE. Resolve ao encerrar o stream; erros HTTP anteriores à abertura do stream
 * viram `ApiError` (ex.: 409 `missing_api_key`, `truncation_required`).
 */
export async function streamTurn(
  url: string,
  body: unknown,
  handlers: TurnHandlers,
  signal?: AbortSignal,
): Promise<{ ok: boolean }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body ?? {}),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) return { ok: false };
    throw new ApiError('Não foi possível contatar o servidor.', 0);
  }
  if (!res.ok) throw await toApiError(res);
  if (!res.body) throw new ApiError('Resposta sem corpo.', res.status);

  const parser = new SseParser();
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let ok = false;
  let sawError = false;

  const dispatch = (event: string, data: unknown) => {
    const d = (data ?? {}) as Record<string, unknown>;
    switch (event) {
      case 'start':
        handlers.onStart?.(String(d.model ?? ''));
        break;
      case 'chunk':
        handlers.onChunk?.(String(d.text ?? ''));
        break;
      case 'block':
        handlers.onBlock?.(d.block as Block, Number(d.discarded ?? 0));
        break;
      case 'dialogue_trigger':
        handlers.onDialogueTrigger?.({ dialogue_id: String(d.dialogue_id), npc_name: String(d.npc_name) });
        break;
      case 'error':
        sawError = true;
        handlers.onError?.(String(d.message ?? 'Falha na geração.'));
        break;
      case 'done':
        ok = !sawError;
        break;
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const m of parser.feed(decoder.decode(value, { stream: true }))) dispatch(m.event, m.data);
    }
  } catch (err) {
    if (!signal?.aborted && !sawError) handlers.onError?.('A conexão com o servidor foi interrompida.');
    return { ok: false };
  }
  if (!ok && !sawError && !signal?.aborted) handlers.onError?.('A geração terminou sem resposta.');
  return { ok };
}
