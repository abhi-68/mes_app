import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { attachmentBytes } from "@/lib/attachments";
import { renderableInline } from "@/lib/attachment-shared";

/**
 * Serve a drawing.
 *
 * Signed in is the whole check. Anything narrower means a welder cannot open the
 * sheet for the unit in front of them, which defeats the purpose of having it.
 *
 * `inline` so a tablet opens the PDF rather than downloading it — the drawing is
 * meant to be read at the bench, not collected. Anything we do not positively
 * recognise is handed over as a download instead, never rendered.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Not signed in", { status: 401 });

  const { id } = await context.params;
  const attachmentId = Number(id);
  if (!Number.isInteger(attachmentId) || attachmentId < 1) {
    return new NextResponse("Not found", { status: 404 });
  }

  const file = await attachmentBytes(attachmentId);
  if (!file) return new NextResponse("Not found", { status: 404 });

  // The stored type came from whoever uploaded the file, so it is a hint, not a fact.
  const renderable = renderableInline(file.mimeType);
  const safeName = file.fileName.replace(/[^\w.\- ]/g, "_").slice(0, 200);

  return new NextResponse(new Uint8Array(file.content), {
    headers: {
      "Content-Type": renderable
        ? file.mimeType!.split(";")[0].trim().toLowerCase()
        : "application/octet-stream",
      "Content-Disposition": `${renderable ? "inline" : "attachment"}; filename="${safeName}"`,
      "Content-Length": String(file.content.byteLength),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      // A drawing is immutable: a new revision is a new row with a new id.
      "Cache-Control": "private, max-age=3600",
    },
  });
}
