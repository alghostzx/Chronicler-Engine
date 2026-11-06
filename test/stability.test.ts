import { describe, expect, it, vi } from 'vitest';
import { COMPACTION_IDLE_TIMEOUT_MS, GENERATION_IDLE_TIMEOUT_MS, GenerationError, GeminiGatewayImpl } from '../src/ai/gateway.js';
import { TurnRunner } from '../src/routes/turnRunner.js';
import { HttpError } from '../src/context.js';

describe('TurnRunner.withClaim', () => {
  it('reserva a chave durante a execução e a libera após sucesso', async () => {
    const runner = new TurnRunner({} as any);
    const key = 'session-1';

    let executed = false;
    const result = await runner.withClaim(key, async () => {
      executed = true;
      expect(runner.isBusy(key)).toBe(true);
      return 'ok';
    });

    expect(executed).toBe(true);
    expect(result).toBe('ok');
    expect(runner.isBusy(key)).toBe(false);
  });

  it('libera a chave mesmo se a ação lançar exceção', async () => {
    const runner = new TurnRunner({} as any);
    const key = 'session-2';

    await expect(
      runner.withClaim(key, async () => {
        expect(runner.isBusy(key)).toBe(true);
        throw new Error('falha inesperada na montagem');
      }),
    ).rejects.toThrow('falha inesperada na montagem');

    expect(runner.isBusy(key)).toBe(false);
  });

  it('bloqueia chamadas concorrentes com 409 na mesma chave', async () => {
    const runner = new TurnRunner({} as any);
    const key = 'session-3';

    let resolveGate!: () => void;
    const gate = new Promise<void>((r) => (resolveGate = r));

    const p1 = runner.withClaim(key, async () => {
      await gate;
      return 'done';
    });

    expect(runner.isBusy(key)).toBe(true);
    await expect(runner.withClaim(key, async () => 'segundo')).rejects.toThrow(HttpError);

    resolveGate();
    await expect(p1).resolves.toBe('done');
    expect(runner.isBusy(key)).toBe(false);
  });
});

describe('GeminiGatewayImpl idle timeout', () => {
  it('aborta a geração e lança GenerationError quando a API fica inativa além de 30s', async () => {
    vi.useFakeTimers();
    try {
      const gateway = new GeminiGatewayImpl('fake-key');
      const aiMock = (gateway as any).ai;

      // Mock do stream que nunca emite fragmentos
      aiMock.models = {
        generateContentStream: vi.fn().mockImplementation(async (opts: { config: { abortSignal: AbortSignal } }) => {
          return {
            async *[Symbol.asyncIterator]() {
              // Fica aguardando abortSignal
              await new Promise((_, reject) => {
                opts.config.abortSignal.addEventListener('abort', () => reject(opts.config.abortSignal.reason));
              });
            },
          };
        }),
      };

      const generator = gateway.streamGenerate({
        model: 'gemini-3.8-flash',
        userText: 'olá',
      });

      const consumePromise = (async () => {
        for await (const _ of generator) {
          // não emite
        }
      })();

      const failure = consumePromise.catch((err) => err);

      // Avança o tempo além do limite de 180s
      await vi.advanceTimersByTimeAsync(GENERATION_IDLE_TIMEOUT_MS + 100);

      const err = await failure;
      expect(err).toBeInstanceOf(GenerationError);
      expect(err.message).toBe('Tempo limite de inatividade na geração excedido (180 s sem resposta da API).');
    } finally {
      vi.useRealTimers();
    }
  });

  it('respeita idleTimeoutMs customizado (ex.: 300s na compactação)', async () => {
    vi.useFakeTimers();
    try {
      const gateway = new GeminiGatewayImpl('fake-key');
      const aiMock = (gateway as any).ai;

      aiMock.models = {
        generateContentStream: vi.fn().mockImplementation(async (opts: { config: { abortSignal: AbortSignal } }) => {
          return {
            async *[Symbol.asyncIterator]() {
              await new Promise((_, reject) => {
                opts.config.abortSignal.addEventListener('abort', () => reject(opts.config.abortSignal.reason));
              });
            },
          };
        }),
      };

      const generator = gateway.streamGenerate({
        model: 'gemini-3.8-flash',
        userText: 'corpus longo',
        idleTimeoutMs: COMPACTION_IDLE_TIMEOUT_MS,
      });

      let settled = false;
      const failure = (async () => {
        for await (const _ of generator) {
          // não emite
        }
      })().catch((err) => {
        settled = true;
        return err;
      });

      // Aos 200s (além dos 180s padrão) ainda não deve ter abortado
      await vi.advanceTimersByTimeAsync(200_000);
      expect(settled).toBe(false);

      // Ao ultrapassar 300s (COMPACTION_IDLE_TIMEOUT_MS), aborta com a mensagem de 300 s
      await vi.advanceTimersByTimeAsync(COMPACTION_IDLE_TIMEOUT_MS - 200_000 + 100);
      const err = await failure;
      expect(err).toBeInstanceOf(GenerationError);
      expect(err.message).toBe('Tempo limite de inatividade na geração excedido (300 s sem resposta da API).');
    } finally {
      vi.useRealTimers();
    }
  });
});
