import { ApiError } from './api';

/** Extrai o nome do arquivo de um Content-Disposition (prefere `filename*` UTF-8). */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  if (header) {
    const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
    if (star?.[1]) {
      try {
        return decodeURIComponent(star[1].trim());
      } catch {
        /* cai para o filename simples */
      }
    }
    const plain = /filename="([^"]+)"/i.exec(header);
    if (plain?.[1]) return plain[1];
  }
  return fallback;
}

/** Baixa a história da sessão como .md (via fetch + blob, para tratar erros normalmente). */
export async function downloadStoryMarkdown(sessionId: string, includeContext: boolean): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`/api/sessions/${sessionId}/export${includeContext ? '?include_context=true' : ''}`);
  } catch {
    throw new ApiError('Não foi possível contatar o servidor.', 0);
  }
  if (!res.ok) {
    let message = `Erro HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* corpo não-JSON */
    }
    throw new ApiError(message, res.status);
  }
  const name = filenameFromDisposition(res.headers.get('Content-Disposition'), 'cronica.md');
  const blob = new Blob([await res.text()], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}
