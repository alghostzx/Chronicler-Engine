import { HttpError } from '../context.js';
import type { Repositories } from '../db/index.js';
import type { Page, Session } from '../db/types.js';
import type { TurnRunner } from './turnRunner.js';

export const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1 } },
} as const;

export function requireSession(repos: Repositories, id: string): Session {
  const session = repos.sessions.get(id);
  if (!session) throw new HttpError(404, 'Sessão não encontrada.');
  return session;
}

export function requirePage(repos: Repositories, id: string): Page {
  const page = repos.pages.get(id);
  if (!page) throw new HttpError(404, 'Página não encontrada.');
  return page;
}

export function assertNoActiveDialogue(
  repos: Repositories,
  sessionId: string,
  message = 'Há um diálogo ativo nesta sessão. Encerre-o antes de narrar.',
): void {
  if (repos.dialogues.getActive(sessionId)) {
    throw new HttpError(409, message);
  }
}

export function assertNotArchived(page: Page, action = 'editadas'): void {
  if (page.is_archived) {
    throw new HttpError(409, `Páginas arquivadas não podem ser ${action}.`);
  }
}

export function assertNotBusy(
  turns: TurnRunner,
  sessionId: string,
  message = 'Já existe uma geração em andamento nesta sessão.',
): void {
  if (turns.isBusy(sessionId)) {
    throw new HttpError(409, message);
  }
}
