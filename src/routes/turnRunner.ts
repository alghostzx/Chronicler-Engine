import type { FastifyReply, FastifyRequest } from 'fastify';
import type { NarratorRequestParts } from '../ai/contextBuilder.js';
import { GenerationError, type GeminiGateway } from '../ai/gateway.js';
import { streamNarratorTurn } from '../ai/narrator.js';
import { NarratorResponseError, type NarratorResult } from '../ai/narratorSchema.js';
import { HttpError, type AppContext } from '../context.js';
import type { DialogueSession, Page, Session } from '../db/types.js';
import { openSse } from './sse.js';

export interface PersistOutcome {
  page: Page;
  /** Páginas posteriores descartadas (apenas em regeneração intermediária). */
  discarded: number;
  dialogue?: DialogueSession;
}

export function friendlyError(err: unknown): string {
  if (err instanceof GenerationError || err instanceof NarratorResponseError) return err.message;
  const message = err instanceof Error ? err.message : String(err);
  return `Falha ao gerar a narrativa: ${message.slice(0, 300)}`;
}

/**
 * Orquestra turnos do Narrador (próxima página, regeneração, costura de diálogo) e as
 * travas de concorrência compartilhadas entre as rotas.
 */
export class TurnRunner {
  /** Chaves em uso (id de sessão ou `d:<id do diálogo>`): evita turnos concorrentes. */
  private readonly busy = new Set<string>();

  constructor(private readonly ctx: AppContext) {}

  isBusy(key: string): boolean {
    return this.busy.has(key);
  }

  /** Reserva a chave; falha com 409 se já estiver reservada. */
  claim(key: string, message = 'Já existe uma geração em andamento nesta sessão.'): void {
    if (this.busy.has(key)) throw new HttpError(409, message);
    this.busy.add(key);
  }

  release(key: string): void {
    this.busy.delete(key);
  }

  /** Cria o diálogo pedido pelo Narrador, se houver `dialogue_trigger` ativo e válido. */
  maybeCreateDialogue(sessionId: string, result: NarratorResult): DialogueSession | undefined {
    const t = result.dialogue_trigger;
    if (!t.activate) return undefined;
    return this.ctx.repos.dialogues.create(sessionId, t.npc_name!, t.dynamic_system_prompt!);
  }

  /**
   * Executa um turno do Narrador via SSE. A chave `session.id` deve ter sido reservada com
   * `claim` antes; é liberada aqui ao final. Eventos:
   *  - `start`  {model}
   *  - `chunk`  {text}              (parse incremental de narrative_text)
   *  - `page`  {page, discarded}  (no fechamento do payload, após persistir)
   *  - `dialogue_trigger` {dialogue_id, npc_name}   (somente se o Narrador ativou diálogo)
   *  - `error`  {message}
   *  - `done`   {}
   * Nada é gravado se a geração falhar ou o cliente desconectar.
   */
  async run(
    req: FastifyRequest,
    reply: FastifyReply,
    opts: {
      session: Session;
      request: NarratorRequestParts;
      persist: (result: NarratorResult, model: string) => PersistOutcome;
    },
  ): Promise<void> {
    const { session } = opts;
    // Falhas antes de abrir o SSE (ex.: sem chave) ainda retornam JSON normal e precisam
    // liberar a reserva.
    let gateway: GeminiGateway;
    let model: string;
    try {
      gateway = this.ctx.gatewayProvider();
      model = await this.ctx.models.resolve(session);
    } catch (err) {
      this.release(session.id);
      throw err;
    }

    const sse = openSse(req, reply);
    try {
      sse.send('start', { model });

      let result: NarratorResult | undefined;
      for await (const ev of streamNarratorTurn(gateway, { model, request: opts.request, signal: sse.signal })) {
        if (ev.type === 'chunk') sse.send('chunk', { text: ev.text });
        else result = ev.result;
      }
      if (sse.signal.aborted || !result) return;

      const outcome = opts.persist(result, model);
      sse.send('page', { page: outcome.page, discarded: outcome.discarded });
      if (outcome.dialogue) {
        sse.send('dialogue_trigger', {
          dialogue_id: outcome.dialogue.id,
          npc_name: outcome.dialogue.npc_name,
        });
      }
      sse.send('done', {});
    } catch (err) {
      if (!sse.signal.aborted) {
        req.log.error({ err }, 'Falha na geração do turno narrativo');
        sse.send('error', { message: friendlyError(err) });
      }
    } finally {
      this.release(session.id);
      sse.end();
    }
  }
}
