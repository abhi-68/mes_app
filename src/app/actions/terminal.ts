"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { stations } from "@/db/schema";
import { requireUser } from "@/lib/session";
import { setTerminalStation } from "@/lib/terminal";

/**
 * Choose which station this device is working at.
 *
 * Open to every signed-in person, including workers: picking a station is how an
 * operator says "I am at the bending press now", which is a thing they do for
 * themselves several times a week. It is not a privilege — see `canWorkOnTask`
 * for why the station guards against mistakes rather than against people.
 */
export async function pinTerminal(
  stationId: number | null
): Promise<{ ok: true; name: string | null } | { ok: false; error: string }> {
  try {
    await requireUser();

    if (stationId === null) {
      await setTerminalStation(null);
      revalidatePath("/", "layout");
      return { ok: true, name: null };
    }

    if (!Number.isSafeInteger(stationId) || stationId <= 0) {
      return { ok: false, error: "That is not a station" };
    }
    const [station] = await db
      .select({ id: stations.id, name: stations.name, active: stations.active })
      .from(stations)
      .where(eq(stations.id, stationId));
    if (!station) return { ok: false, error: "That station does not exist" };
    if (!station.active) return { ok: false, error: `${station.name} is not active` };

    await setTerminalStation(station.id);
    revalidatePath("/", "layout");
    return { ok: true, name: station.name };
  } catch {
    return { ok: false, error: "Could not switch station. Please try again." };
  }
}
