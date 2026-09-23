/**
 * The parts of the attachments module a browser is allowed to see.
 *
 * Separate from `attachments.ts` because that file imports the database, and a
 * client component pulling one helper out of it drags the Postgres driver into
 * the browser bundle — which fails the build rather than shipping, but only at
 * build time, which is late to find out.
 */

export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

export type AttachmentSummary = {
  id: number;
  title: string | null;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number;
  revision: string | null;
  uploadedBy: string | null;
  createdAt: Date;
  /** Null on an order-level drawing: it belongs to the whole unit. */
  workOrderTaskId: number | null;
};

/** Bytes as something a person reads. */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/**
 * Types a browser can draw without being able to run anything.
 *
 * SVG and HTML are deliberately absent. Both carry script, drawings are served
 * from our own origin, and the type recorded against a file is whatever the
 * uploader's browser claimed — so rendering an unrecognised one inline would run
 * an uploader's code as whoever opened it.
 */
const RENDERABLE_INLINE = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/tiff",
]);

/** Whether a stored type may be handed to the browser to render, rather than downloaded. */
export function renderableInline(mimeType: string | null): boolean {
  if (!mimeType) return false;
  return RENDERABLE_INLINE.has(mimeType.split(";")[0].trim().toLowerCase());
}
