/** MIME allowlist for untrusted downloaded documents: Content-Disposition alone is not a script boundary. */
import type { Response } from 'express';
export function safeDocumentType(res: Response, mime: string | null | undefined): void {
  const type = (mime || '').split(';')[0]!.trim().toLowerCase();
  const safe = /^(image\/(jpeg|png|gif|webp)|application\/pdf|text\/plain)$/.test(type);
  res.type(safe ? type : 'application/octet-stream');
}
