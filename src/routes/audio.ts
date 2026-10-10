import type { FastifyInstance } from 'fastify';
import { HttpError, type AppContext } from '../context.js';
import type { Page } from '../db/types.js';
import { contentDisposition } from '../export.js';
import { TTS_DEFAULTS, TTS_MODELS, TTS_STYLE_MAX, TTS_VOICES } from '../tts/config.js';

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1 } },
};

const modelField = { type: 'string', pattern: '^[A-Za-z0-9._-]{3,100}$' };
const voiceField = { type: 'string', pattern: '^[A-Za-z0-9._-]{2,100}$' };
const styleField = { type: 'string', maxLength: TTS_STYLE_MAX };

/** `Range: bytes=a-b | a- | -n` → intervalo [start, end] (inclusive) ou `null` se inválido. */
export function parseRange(header: string, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return null;
  return { start, end };
}

/**
 * Narração por voz: geração (em segundo plano), estado, reprodução, descarte e configurações.
 * O Modo Diálogo não passa por aqui: só páginas (inclusive as arquivadas em volumes) têm áudio.
 */
export function registerAudioRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { repos, audio } = ctx;

  const requirePage = (id: string): Page => {
    const page = repos.pages.get(id);
    if (!page) throw new HttpError(404, 'Página não encontrada.');
    return page;
  };

  // --- Gerar (ou gerar de novo) ----------------------------------------------------------------
  // Responde na hora: a geração leva de segundos a minutos. O áudio antigo (se houver) só é
  // trocado quando o novo ficar pronto, então uma falha não o perde.
  app.post<{ Params: { id: string } }>(
    '/api/narrative/pages/:id/audio',
    { schema: { params: idParams } },
    async (req, reply) => {
      const page = requirePage(req.params.id);
      return reply.code(202).send({ page_id: page.id, audio: audio.start(page) });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/narrative/pages/:id/audio/status',
    { schema: { params: idParams } },
    async (req) => {
      const page = requirePage(req.params.id);
      return { page_id: page.id, audio: audio.info(page) };
    },
  );

  // Cancela a geração em andamento; um áudio já salvo continua valendo.
  app.post<{ Params: { id: string } }>(
    '/api/narrative/pages/:id/audio/cancel',
    { schema: { params: idParams } },
    async (req) => {
      const page = requirePage(req.params.id);
      audio.cancel(page.id);
      return { page_id: page.id, audio: audio.info(page) };
    },
  );

  // --- Reproduzir / baixar (MP3 com suporte a Range, para avançar e voltar no player) -------------
  app.get<{ Params: { id: string }; Querystring: { download?: boolean } }>(
    '/api/narrative/pages/:id/audio',
    {
      schema: {
        params: idParams,
        querystring: { type: 'object', properties: { download: { type: 'boolean' }, v: { type: 'string' } } },
      },
    },
    async (req, reply) => {
      const page = requirePage(req.params.id);
      const stored = audio.read(page);
      if (!stored) throw new HttpError(404, 'Esta página ainda não tem áudio.');
      const { meta, audio: bytes } = stored;

      reply
        .header('Content-Type', meta.mime)
        .header('Accept-Ranges', 'bytes')
        // O áudio muda quando é gerado de novo: o cliente acrescenta `?v=` e revalida sempre.
        .header('Cache-Control', 'private, no-cache')
        .header('ETag', `"${meta.text_sha256.slice(0, 16)}-${meta.created_at.replace(/\D/g, '')}-${meta.bytes}"`);
      if (req.query.download === true) {
        const session = repos.sessions.get(page.session_id);
        reply.header('Content-Disposition', contentDisposition(`${session?.title ?? 'Crônica'} — Página ${page.order_index}`, 'mp3'));
      }

      const rangeHeader = req.headers.range;
      if (rangeHeader) {
        const range = parseRange(rangeHeader, bytes.length);
        if (!range) {
          return reply.code(416).header('Content-Range', `bytes */${bytes.length}`).send({ error: 'Intervalo inválido.' });
        }
        return reply
          .code(206)
          .header('Content-Range', `bytes ${range.start}-${range.end}/${bytes.length}`)
          .header('Content-Length', range.end - range.start + 1)
          .send(bytes.subarray(range.start, range.end + 1));
      }
      return reply.header('Content-Length', bytes.length).send(bytes);
    },
  );

  // --- Apagar -----------------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>(
    '/api/narrative/pages/:id/audio',
    { schema: { params: idParams } },
    async (req) => {
      const page = requirePage(req.params.id);
      audio.discard(page.id);
      return { page_id: page.id, audio: null };
    },
  );

  // --- Configurações ---------------------------------------------------------------------------
  app.get('/api/settings/tts', async () => ({
    ...audio.getSettings(),
    defaults: TTS_DEFAULTS,
    models: TTS_MODELS,
    voices: TTS_VOICES,
    style_max: TTS_STYLE_MAX,
    usage: audio.usage(),
  }));

  app.put<{ Body: { auto_default?: boolean; model?: string; voice?: string; style?: string } }>(
    '/api/settings/tts',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: { auto_default: { type: 'boolean' }, model: modelField, voice: voiceField, style: styleField },
        },
      },
    },
    async (req) => ({ ...audio.updateSettings(req.body), usage: audio.usage() }),
  );

  // Amostra de voz com as configurações atuais (ou as informadas, ainda não salvas). Não é guardada.
  app.post<{ Body: { model?: string; voice?: string; style?: string } }>(
    '/api/settings/tts/sample',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { model: modelField, voice: voiceField, style: styleField },
        },
      },
    },
    async (req, reply) => {
      try {
        const mp3 = await audio.sample(req.body ?? {});
        return reply.header('Content-Type', 'audio/mpeg').header('Cache-Control', 'no-store').send(mp3);
      } catch (err) {
        if (err instanceof HttpError || (err as Error).name === 'MissingApiKeyError') throw err;
        req.log.warn({ err }, 'Falha ao gerar a amostra de voz');
        throw new HttpError(502, err instanceof Error ? err.message : 'Falha ao gerar a amostra de voz.');
      }
    },
  );

  // Apaga todos os áudios guardados (as páginas e os textos não são tocados).
  app.delete('/api/audio', async () => {
    audio.cancelAll();
    const deleted = repos.audio.deleteAll();
    return { deleted, usage: audio.usage() };
  });
}
