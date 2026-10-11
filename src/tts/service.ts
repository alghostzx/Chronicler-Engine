import { createHash } from 'node:crypto';
import { toSynthesisError, type GatewayProvider, type GeminiGateway, type SynthesizeRequest } from '../ai/gateway.js';
import { HttpError } from '../context.js';
import type { AudioMeta } from '../db/repositories/audio.js';
import type { Repositories } from '../db/index.js';
import type { Page, Session } from '../db/types.js';
import { TTS_DEFAULTS, TTS_SAMPLE_TEXT } from './config.js';
import { encodeMp3, MP3_KBPS } from './mp3.js';
import { decodeAudio, durationMs, joinPcm, type Pcm } from './pcm.js';
import { cleanForSpeech, DEFAULT_CHUNK_CHARS, splitForSpeech } from './text.js';

export interface TtsSettings {
  auto_default: boolean;
  /** Narração automática das páginas de diálogo (opção própria; desligada de fábrica). */
  auto_dialogue_default: boolean;
  model: string;
  voice: string;
  style: string;
}

const KEYS = {
  auto_default: 'tts_auto_default',
  auto_dialogue_default: 'tts_auto_dialogue_default',
  model: 'tts_model',
  voice: 'tts_voice',
  style: 'tts_style',
} as const;

/** Estado do áudio de uma página, como a API o expõe (sem os bytes). */
export interface AudioInfo {
  status: 'ready' | 'generating' | 'error';
  duration_ms?: number;
  bytes?: number;
  voice?: string;
  model?: string;
  created_at?: string;
  /** Trechos concluídos / total (somente `generating`). */
  done?: number;
  total?: number;
  /** Na fila, aguardando vaga (há no máximo `maxConcurrent` jobs rodando). */
  queued?: boolean;
  /** Falha: em `error` não há áudio; em `ready`, a última tentativa de gerar de novo falhou. */
  error?: string;
}

export interface AudioServiceOptions {
  /** Jobs de síntese simultâneos (respeita os limites da API). */
  maxConcurrent?: number;
  /** Espera antes de cada nova tentativa em falhas transitórias (429/5xx/rede). */
  retryDelaysMs?: number[];
  chunkChars?: number;
  /** Silêncio entre trechos. */
  gapMs?: number;
}

interface Job {
  pageId: string;
  hash: string;
  chunks: string[];
  settings: TtsSettings;
  controller: AbortController;
  state: 'queued' | 'running' | 'error';
  done: number;
  error?: string;
  finishedAt?: number;
  /** Resolve quando o job termina (qualquer desfecho). */
  finished: Promise<void>;
  markFinished: () => void;
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

const ERROR_RETENTION_MS = 60 * 60 * 1000;

/**
 * Narração das páginas: gera o áudio em segundo plano (um job por página, com fila), guarda o MP3
 * no SQLite e invalida o que ficou obsoleto. Nunca bloqueia uma requisição nem um turno narrativo.
 */
export class AudioService {
  private readonly jobs = new Map<string, Job>();
  private readonly queue: Job[] = [];
  private running = 0;
  private readonly maxConcurrent: number;
  private readonly retryDelaysMs: number[];
  private readonly chunkChars: number;
  private readonly gapMs: number;

  constructor(
    private readonly repos: Repositories,
    private readonly gatewayProvider: GatewayProvider,
    opts: AudioServiceOptions = {},
  ) {
    this.maxConcurrent = opts.maxConcurrent ?? 2;
    this.retryDelaysMs = opts.retryDelaysMs ?? [2000, 6000, 15000];
    this.chunkChars = opts.chunkChars ?? DEFAULT_CHUNK_CHARS;
    this.gapMs = opts.gapMs ?? 250;
  }

  // --- Configuração ----------------------------------------------------------------------------
  getSettings(): TtsSettings {
    const s = this.repos.settings;
    return {
      auto_default: s.get(KEYS.auto_default) === '1',
      auto_dialogue_default: s.get(KEYS.auto_dialogue_default) === '1',
      model: s.get(KEYS.model) ?? TTS_DEFAULTS.model,
      voice: s.get(KEYS.voice) ?? TTS_DEFAULTS.voice,
      style: s.get(KEYS.style) ?? TTS_DEFAULTS.style,
    };
  }

  updateSettings(patch: Partial<TtsSettings>): TtsSettings {
    const s = this.repos.settings;
    if (patch.auto_default !== undefined) s.set(KEYS.auto_default, patch.auto_default ? '1' : '0');
    if (patch.auto_dialogue_default !== undefined) s.set(KEYS.auto_dialogue_default, patch.auto_dialogue_default ? '1' : '0');
    if (patch.model !== undefined) s.set(KEYS.model, patch.model);
    if (patch.voice !== undefined) s.set(KEYS.voice, patch.voice);
    if (patch.style !== undefined) s.set(KEYS.style, patch.style.trim());
    return this.getSettings();
  }

  /** A sessão usa o próprio valor; sem ele (`null`), vale o padrão global (desligado de fábrica). */
  autoEnabled(session: Pick<Session, 'tts_auto'>): boolean {
    return session.tts_auto ?? this.getSettings().auto_default;
  }

  /** Igual a `autoEnabled`, mas para páginas de diálogo (opção independente da narração das páginas de prosa). */
  autoDialogueEnabled(session: Pick<Session, 'tts_auto_dialogue'>): boolean {
    return session.tts_auto_dialogue ?? this.getSettings().auto_dialogue_default;
  }

  // --- Estado ----------------------------------------------------------------------------------
  /** Metadados do áudio salvo, descartando-o se o texto da página mudou desde a narração. */
  private validMeta(page: Page, meta: AudioMeta | undefined): AudioMeta | undefined {
    if (!meta) return undefined;
    if (meta.text_sha256 !== sha256(page.generated_text)) {
      this.repos.audio.delete(page.id);
      return undefined;
    }
    return meta;
  }

  private infoFor(page: Page, meta: AudioMeta | undefined): AudioInfo | null {
    const job = this.jobs.get(page.id);
    if (job && job.state !== 'error') {
      return { status: 'generating', done: job.done, total: job.chunks.length, queued: job.state === 'queued' };
    }
    const valid = this.validMeta(page, meta);
    if (valid) {
      return {
        status: 'ready',
        duration_ms: valid.duration_ms,
        bytes: valid.bytes,
        voice: valid.voice,
        model: valid.model,
        created_at: valid.created_at,
        ...(job?.error ? { error: job.error } : {}),
      };
    }
    if (job) return { status: 'error', error: job.error };
    return null;
  }

  info(page: Page): AudioInfo | null {
    return this.infoFor(page, this.repos.audio.meta(page.id));
  }

  /** Acrescenta `audio` (estado da narração) a cada página devolvida pela API. */
  decorate<T extends Page>(pages: T[]): (T & { audio: AudioInfo | null })[] {
    const metas = this.repos.audio.metaFor(pages.map((p) => p.id));
    return pages.map((p) => ({ ...p, audio: this.infoFor(p, metas.get(p.id)) }));
  }

  /** MP3 salvo, se ainda for válido para o texto atual da página. */
  read(page: Page): { meta: AudioMeta; audio: Buffer } | undefined {
    const meta = this.validMeta(page, this.repos.audio.meta(page.id));
    if (!meta) return undefined;
    const audio = this.repos.audio.blob(page.id);
    return audio ? { meta, audio } : undefined;
  }

  usage(): { count: number; bytes: number } {
    return this.repos.audio.usage();
  }

  // --- Geração ---------------------------------------------------------------------------------
  /**
   * Agenda a narração da página (ou a refaz: o áudio antigo só é trocado quando o novo ficar
   * pronto). Idempotente: se já houver job em andamento para a página, devolve esse. Falha
   * imediatamente sem chave configurada ou sem texto.
   */
  start(page: Page): AudioInfo {
    const running = this.jobs.get(page.id);
    if (running && running.state !== 'error') return this.info(page)!;

    this.gatewayProvider(); // lança MissingApiKeyError sem chave
    const chunks = splitForSpeech(cleanForSpeech(page.generated_text), this.chunkChars);
    if (chunks.length === 0) throw new HttpError(409, 'Esta página não tem texto para narrar.');
    this.pruneErrors();

    let markFinished!: () => void;
    const job: Job = {
      pageId: page.id,
      hash: sha256(page.generated_text),
      chunks,
      settings: this.getSettings(),
      controller: new AbortController(),
      state: 'queued',
      done: 0,
      finished: new Promise<void>((resolve) => (markFinished = resolve)),
      markFinished,
    };
    this.jobs.set(page.id, job);
    this.queue.push(job);
    this.pump();
    return this.info(page)!;
  }

  /** Geração automática após uma página nova: só se ligada (sessão ou padrão global); nunca falha o turno. */
  autoStart(session: Session, page: Page): boolean {
    if (!(page.kind === 'dialogue' ? this.autoDialogueEnabled(session) : this.autoEnabled(session))) return false;
    try {
      this.start(page);
      return true;
    } catch {
      return false;
    }
  }

  /** Cancela o job da página (fila ou em andamento), sem mexer no áudio salvo. */
  cancel(pageId: string): boolean {
    const job = this.jobs.get(pageId);
    if (!job) return false;
    this.jobs.delete(pageId);
    const queued = this.queue.indexOf(job);
    if (queued >= 0) this.queue.splice(queued, 1);
    job.controller.abort();
    job.markFinished();
    return true;
  }

  cancelMany(pageIds: Iterable<string>): void {
    for (const id of pageIds) this.cancel(id);
  }

  cancelAll(): void {
    this.cancelMany([...this.jobs.keys()]);
  }

  /** A página foi editada ou regenerada: cancela o job e apaga o áudio salvo. */
  discard(pageId: string): void {
    this.cancel(pageId);
    this.repos.audio.delete(pageId);
  }

  /** Espera os jobs terminarem (testes e encerramento). */
  async idle(): Promise<void> {
    while (this.jobs.size > 0 && [...this.jobs.values()].some((j) => j.state !== 'error')) {
      await Promise.all([...this.jobs.values()].filter((j) => j.state !== 'error').map((j) => j.finished));
    }
  }

  /** Amostra de voz (não é guardada em lugar nenhum). */
  async sample(overrides: Partial<Pick<TtsSettings, 'model' | 'voice' | 'style'>> = {}): Promise<Buffer> {
    const settings = { ...this.getSettings(), ...overrides };
    const gateway = this.gatewayProvider();
    const pcm = await this.synthesizeChunk(gateway, TTS_SAMPLE_TEXT, settings, new AbortController().signal);
    return encodeMp3(pcm, MP3_KBPS);
  }

  // --- Internos --------------------------------------------------------------------------------
  private pruneErrors(): void {
    const limit = Date.now() - ERROR_RETENTION_MS;
    for (const [id, job] of this.jobs) {
      if (job.state === 'error' && (job.finishedAt ?? 0) < limit) this.jobs.delete(id);
    }
  }

  private pump(): void {
    while (this.running < this.maxConcurrent && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.running++;
      job.state = 'running';
      void this.run(job).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async run(job: Job): Promise<void> {
    const { signal } = job.controller;
    try {
      const gateway = this.gatewayProvider();
      const parts: Pcm[] = [];
      for (const chunk of job.chunks) {
        signal.throwIfAborted();
        parts.push(await this.synthesizeChunk(gateway, chunk, job.settings, signal));
        job.done = parts.length;
      }
      const pcm = joinPcm(parts, this.gapMs);
      const mp3 = await encodeMp3(pcm, MP3_KBPS, signal);
      signal.throwIfAborted();

      // O job pode ter sido substituído, ou a página editada/regenerada/descartada no meio da geração.
      if (this.jobs.get(job.pageId) !== job) return;
      const page = this.repos.pages.get(job.pageId);
      if (!page || sha256(page.generated_text) !== job.hash) {
        this.jobs.delete(job.pageId);
        return;
      }
      this.repos.audio.put(job.pageId, {
        text_sha256: job.hash,
        voice: job.settings.voice,
        model: job.settings.model,
        style: job.settings.style,
        duration_ms: durationMs(pcm),
        audio: mp3,
      });
      this.jobs.delete(job.pageId);
    } catch (err) {
      if (signal.aborted) return; // cancelado: quem cancelou já limpou o job
      job.state = 'error';
      job.error = toSynthesisError(err).message;
      job.finishedAt = Date.now();
    } finally {
      job.markFinished();
    }
  }

  /** Um trecho de texto → PCM, com novas tentativas em falhas transitórias. */
  private async synthesizeChunk(
    gateway: GeminiGateway,
    text: string,
    settings: Pick<TtsSettings, 'model' | 'voice' | 'style'>,
    signal: AbortSignal,
  ): Promise<Pcm> {
    const req: SynthesizeRequest = { model: settings.model, text, voice: settings.voice, style: settings.style, signal };
    for (let attempt = 0; ; attempt++) {
      try {
        const audio = await gateway.synthesize(req);
        return decodeAudio(audio.data, audio.mimeType);
      } catch (err) {
        if (signal.aborted) throw err;
        const failure = toSynthesisError(err);
        const delay = this.retryDelaysMs[attempt];
        if (!failure.retryable || delay === undefined) throw failure;
        await sleep(delay, signal);
      }
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
