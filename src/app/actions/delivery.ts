"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireRole } from "@/lib/session";
import { CommandError } from "@/lib/inventory";
import { advanceDeliveryNote, createDeliveryNote } from "@/lib/delivery";

type Result<T> = { ok: true; result: T } | { ok: false; error: string };

const createRequest = z
  .object({
    workOrderId: z.number().int().positive(),
    quantity: z.number().int().positive(),
    handlerUserId: z.number().int().positive().nullable(),
    notes: z.string().trim().max(300).optional(),
  })
  .strict();

export async function raiseDeliveryNote(
  input: z.infer<typeof createRequest>
): Promise<Result<{ id: number; noteNumber: string }>> {
  try {
    const user = await requireRole("ADMIN", "SUPERVISOR");
    const parsed = createRequest.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Invalid delivery note" };
    const result = await createDeliveryNote({ ...parsed.data, actorUserId: user.id });
    revalidatePath("/", "layout");
    return { ok: true, result };
  } catch (error) {
    if (error instanceof CommandError) return { ok: false, error: error.message };
    return { ok: false, error: "Could not raise that delivery note. Check your access and retry." };
  }
}

const advanceRequest = z
  .object({
    noteId: z.number().int().positive(),
    to: z.enum(["ALLOCATED", "PICKED_UP", "DELIVERED", "CANCELLED"]),
    handlerUserId: z.number().int().positive().nullable().optional(),
  })
  .strict();

export async function moveDeliveryNote(
  input: z.infer<typeof advanceRequest>
): Promise<Result<null>> {
  try {
    const user = await requireRole("ADMIN", "SUPERVISOR");
    const parsed = advanceRequest.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Invalid delivery update" };
    await advanceDeliveryNote({ ...parsed.data, actorUserId: user.id });
    revalidatePath("/", "layout");
    return { ok: true, result: null };
  } catch (error) {
    if (error instanceof CommandError) return { ok: false, error: error.message };
    return { ok: false, error: "Could not update that delivery note." };
  }
}
