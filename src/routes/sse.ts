import type { FastifyReply, FastifyRequest } from 'fastify';

export interface SseStream {
  /** Envia um evento SSE com `data` serializado em JSON. */
  send(event: string, data: unknown): void;
  /** Envia um comentário SSE (`: keep-alive`) para manter o stream e buffers intermediários ativos. */
  ping(): void;
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
  raw.socket?.setNoDelay?.(true);
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

  // Comentário SSE de 2 KB após eventos de status/controle: força proxies e buffers HTTP/2 a
  // despacharem o pacote imediatamente ao navegador, sem esperar o fim da próxima chamada à IA.
  const FLUSH_PAD = `: ${' '.repeat(2048)}\n\n`;

  return {
    signal: controller.signal,
    send(event, data) {
      if (raw.writableEnded || raw.destroyed) return;
      raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (event === 'status' || event === 'retry') {
        raw.write(FLUSH_PAD);
      }
    },
    ping() {
      if (raw.writableEnded || raw.destroyed) return;
      raw.write(': keep-alive\n\n');
    },
    end() {
      if (!raw.writableEnded) raw.end();
    },
  };
}
