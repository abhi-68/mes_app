"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireRole } from "@/lib/session";
import { CommandError } from "@/lib/inventory";
import { reserveRemainingMaterial, type ReservationResult } from "@/lib/material-planning";

const request = z.object({ requirementId: z.number().int().positive(), commandId: z.uuid() }).strict();
export async function reserveMaterial(input: { requirementId: number; commandId: string }): Promise<
  { ok: true; result: ReservationResult } | { ok: false; error: string }
> {
  try {
    const user = await requireRole("ADMIN", "SUPERVISOR");
    const parsed = request.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Invalid material reservation request" };
    const result = await reserveRemainingMaterial({ ...parsed.data, actorUserId: user.id });
    revalidatePath("/", "layout");
    return { ok: true, result };
  } catch (error) {
    if (error instanceof CommandError) return { ok: false, error: error.message };
    // A generic failure may be a lost response after commit. The client retains its
    // command ID, so a retry is safe and returns the original result.
    return { ok: false, error: "Unable to reserve materials. Check your access and retry." };
  }
}
