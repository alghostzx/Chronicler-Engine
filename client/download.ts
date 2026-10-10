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

export type ExportScope = 'all' | 'active' | 'archived';

/** Baixa um endpoint de exportação como .md (via fetch + blob, para tratar erros normalmente). */
export async function downloadMarkdown(url: string, fallbackName = 'cronica.md'): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url);
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
  const name = filenameFromDisposition(res.headers.get('Content-Disposition'), fallbackName);
  const blob = new Blob([await res.text()], { type: 'text/markdown;charset=utf-8' });
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
  return name;
}

/** Baixa a história da sessão (escopo: crônica completa, só o Tome ou só as páginas já em volumes). */
export function downloadStoryMarkdown(sessionId: string, opts: { includeContext: boolean; scope: ExportScope }): Promise<string> {
  const params = new URLSearchParams({ scope: opts.scope });
  if (opts.includeContext) params.set('include_context', 'true');
  return downloadMarkdown(`/api/sessions/${sessionId}/export?${params}`);
}

/** Baixa um volume (sinopse opcional + as páginas que ele consumiu). */
export function downloadVolumeMarkdown(archiveId: string, includeSummary: boolean): Promise<string> {
  return downloadMarkdown(`/api/archives/${archiveId}/export?include_summary=${includeSummary}`, 'volume.md');
}
