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
  /** Narração automática das páginas novas (prosa e diálogo): true/false, ou null = herdar o padrão global. */
  tts_auto: boolean | null;
  created_at: string;
  updated_at: string;
}

/** Estado da narração em áudio de uma página (espelha `AudioInfo` em src/tts/service.ts). */
export interface AudioInfo {
  status: 'ready' | 'generating' | 'error';
  duration_ms?: number;
  bytes?: number;
  voice?: string;
  model?: string;
  created_at?: string;
  done?: number;
  total?: number;
  queued?: boolean;
  /** Esperando o limite de requisições por minuto da API; `wait_ms` é a espera estimada. */
  throttled?: boolean;
  wait_ms?: number;
  error?: string;
}

export interface Page {
  id: string;
  session_id: string;
  order_index: number;
  /** `dialogue`: página de um Modo Diálogo concluído (prosa com as falas literais); `narrative`: prosa do Narrador. */
  kind: 'narrative' | 'dialogue';
  /** Página de diálogo que ainda é a transcrição crua (`**Nome:** fala`): pode ser reprocessada em prosa. */
  raw_dialogue: boolean;
  /** Nome do interlocutor (somente páginas de diálogo). */
  npc_name: string | null;
  player_instruction: string | null;
  generated_text: string;
  model_identifier: string | null;
  is_archived: boolean;
  /** Narração em áudio (null = ainda não gerada). Vem do servidor; os controles de áudio a mantêm atualizada. */
  audio?: AudioInfo | null;
  created_at: string;
  updated_at: string;
}

export interface Archive {
  id: string;
  session_id: string;
  volume_number: number;
  summary_text: string;
  covered_page_start_index: number;
  covered_page_end_index: number;
  created_at: string;
}

export interface Dialogue {
  id: string;
  session_id: string;
  npc_name: string;
  /** Rótulo do jogador, inferido pelo Narrador ao abrir o diálogo (null = "Protagonista"). */
  player_name: string | null;
  /** Se definido, é um "Refazer diálogo": ao encerrar, substitui esta página. */
  redo_page_id: string | null;
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

export interface TtsSettingsInfo {
  auto_default: boolean;
  model: string;
  voice: string;
  style: string;
  defaults: { auto_default: boolean; model: string; voice: string; style: string };
  models: { id: string; label: string }[];
  voices: { id: string; trait: string }[];
  style_max: number;
  usage: { count: number; bytes: number };
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
  pages: Page[];
  archives: Archive[];
  active_dialogue: Dialogue | null;
}

export interface CompactionPreview {
  summary_text: string;
  covered_page_start_index: number;
  covered_page_end_index: number;
  pages_to_archive: number;
  pages_to_keep: number;
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
  /** `narration`: só em páginas de diálogo — `fallback` = ficou a transcrição crua (o Narrador falhou). */
  onPage?(page: Page, discarded: number, narration?: 'narrated' | 'fallback'): void;
  /** O Narrador está refazendo a página de diálogo (falas alteradas); `attempt` é a nova tentativa. */
  onRetry?(attempt: number, of: number): void;
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
      case 'page':
        handlers.onPage?.(
          d.page as Page,
          Number(d.discarded ?? 0),
          d.narration === 'fallback' || d.narration === 'narrated' ? d.narration : undefined,
        );
        break;
      case 'retry':
        handlers.onRetry?.(Number(d.attempt ?? 0), Number(d.of ?? 0));
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
