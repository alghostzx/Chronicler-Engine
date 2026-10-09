import type { FastifyReply, FastifyRequest } from 'fastify';

export interface SseStream {
  /** Envia um evento SSE com `data` serializado em JSON. */
  send(event: string, data: unknown): void;
  /** Encerra a resposta. */
  end(): void;
  /** Abortado quando o cliente desconecta antes do fim. */
  signal: AbortSignal;
}

/**
 * Assume o controle da resposta HTTP e a transforma num stream SSE. Depois de chamar isto,
 * erros devem ser enviados como evento `error` (os cabeçalhos HTTP já foram enviados).
 */
export function openSse(req: FastifyRequest, reply: FastifyReply): SseStream {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  raw.write(': stream aberto\n\n');

  const controller = new AbortController();
  raw.on('close', () => {
    if (!raw.writableFinished) controller.abort();
  });

  return {
    signal: controller.signal,
    send(event, data) {
      if (raw.writableEnded || raw.destroyed) return;
      raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    end() {
      if (!raw.writableEnded) raw.end();
    },
  };
}
