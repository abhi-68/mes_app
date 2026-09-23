"use client";

import { uploadAttachment } from "@/app/actions/attachments";

/**
 * The drawing that arrives with the purchase order.
 *
 * It belongs on the form because that is the moment the office has it in their
 * hand. Attaching it afterwards means finding the order again, and a drawing
 * nobody attached is a unit built to whatever was remembered.
 *
 * Per-step drawings stay on the order page: the steps do not have ids until the
 * order is released, so there is nothing to attach them to yet.
 */
export function DrawingField({
  file,
  onChange,
}: {
  file: File | null;
  onChange: (file: File | null) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs text-gray-500">Drawing</span>
      <input
        type="file"
        onChange={(e) => onChange(e.target.files?.[0] ?? null)}
        className="mt-1 block w-full text-sm text-gray-700 file:mr-3 file:rounded-lg file:border-0 file:bg-gray-900 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-gray-800"
      />
      {file && <span className="mt-1 block text-xs text-gray-500">{file.name}</span>}
    </label>
  );
}

/**
 * Attach it once the order exists.
 *
 * Returns a message rather than throwing: the order is already raised by this
 * point, so a failed upload must not read as a failed order.
 */
export async function attachDrawing(orderId: number, file: File | null): Promise<string | null> {
  if (!file) return null;
  const form = new FormData();
  form.set("file", file);
  form.set("workOrderId", String(orderId));
  form.set("title", "Drawing");
  const res = await uploadAttachment(form);
  return res.ok ? null : `The order was raised, but the drawing did not upload: ${res.error}`;
}
