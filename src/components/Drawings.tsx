"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { DocumentTextIcon } from "@heroicons/react/24/outline";
import { uploadAttachment, deleteAttachment } from "@/app/actions/attachments";
import { formatBytes, type AttachmentSummary } from "@/lib/attachment-shared";
import { Button, Panel } from "@/components/ui";

/**
 * The drawings for a job.
 *
 * Read by anyone signed in, added only by the office. Revision sits next to the
 * name everywhere it appears, because the failure worth designing against is
 * somebody fabricating to rev B while rev C is on the server.
 */
export function Drawings({
  workOrderId,
  workOrderTaskId,
  files,
  canUpload,
  heading = "Drawings",
  compact = false,
}: {
  workOrderId?: number;
  workOrderTaskId?: number;
  files: AttachmentSummary[];
  canUpload: boolean;
  heading?: string;
  compact?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  function submit(form: FormData) {
    setError(null);
    startTransition(async () => {
      if (workOrderId) form.set("workOrderId", String(workOrderId));
      if (workOrderTaskId) form.set("workOrderTaskId", String(workOrderTaskId));
      const res = await uploadAttachment(form);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      formRef.current?.reset();
      setOpen(false);
      router.refresh();
    });
  }

  function remove(id: number) {
    startTransition(async () => {
      await deleteAttachment(id);
      router.refresh();
    });
  }

  const list = (
    <ul className="divide-y divide-gray-200">
      {files.map((f) => (
        <li key={f.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
          <DocumentTextIcon className="h-5 w-5 shrink-0 text-gray-400" aria-hidden />
          <a
            href={`/api/attachments/${f.id}`}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 flex-1 text-sm font-medium text-primary-700 underline-offset-2 hover:underline"
          >
            {f.title ?? f.fileName}
          </a>
          {f.revision && (
            <span className="rounded-lg bg-gray-100 px-1.5 py-0.5 text-xs font-semibold text-gray-700">
              Rev {f.revision}
            </span>
          )}
          <span className="tnum text-xs text-gray-400">{formatBytes(f.sizeBytes)}</span>
          {f.workOrderTaskId && (
            <span className="text-xs text-gray-400">this step only</span>
          )}
          {canUpload && (
            <Button tone="ghost" size="sm" disabled={pending} onClick={() => remove(f.id)}>
              Remove
            </Button>
          )}
        </li>
      ))}
    </ul>
  );

  const body = (
    <>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold leading-6 text-gray-950">{heading}</h2>
        {canUpload && (
          <Button disabled={pending} onClick={() => setOpen(!open)}>
            {open ? "Cancel" : "Add a drawing"}
          </Button>
        )}
      </div>

      {files.length === 0 ? (
        <p className="py-2 text-sm text-gray-500">
          Nothing here yet. The people building this have no drawing to work from.
        </p>
      ) : (
        list
      )}

      {open && canUpload && (
        <form ref={formRef} action={submit} className="mt-3 rounded-lg bg-gray-50 p-4">
          <div className="flex flex-wrap gap-3">
            <label className="text-xs text-gray-600">
              What is it
              <input
                name="title"
                placeholder="GA drawing"
                className="mt-1 block min-h-11 w-48 rounded-lg border-0 bg-white px-3 text-sm ring-1 ring-inset ring-gray-300"
              />
            </label>
            <label className="text-xs text-gray-600">
              Revision
              <input
                name="revision"
                placeholder="C"
                className="mt-1 block min-h-11 w-24 rounded-lg border-0 bg-white px-3 text-sm ring-1 ring-inset ring-gray-300"
              />
            </label>
          </div>
          <input
            type="file"
            name="file"
            required
            className="mt-3 block w-full text-sm text-gray-700 file:mr-3 file:rounded-lg file:border-0 file:bg-gray-900 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-gray-800"
          />
          <p className="mt-2 text-xs text-gray-500">
            Up to 8 MB. A flattened PDF opens on a tablet; a native CAD file does not.
          </p>
          <div className="mt-3">
            <Button type="submit" disabled={pending}>
              {pending ? "Uploading…" : "Upload"}
            </Button>
          </div>
        </form>
      )}

      {error && (
        <p role="alert" className="mt-2 text-sm text-danger-700">
          {error}
        </p>
      )}
    </>
  );

  if (compact) return <div className="mt-4">{body}</div>;
  return <Panel className="mt-4 p-6">{body}</Panel>;
}
