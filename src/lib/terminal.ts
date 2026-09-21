import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { stations } from "@/db/schema";
import type { Role } from "@/lib/session";

/**
 * Which station this device is working at.
 *
 * Set by whoever is using it — a worker signs in and picks their station off a
 * grid, the way they would walk up to a machine. It is stored on the DEVICE and
 * survives sign-out, so a tablet bolted to the coil line stays on the coil line
 * across a shift change and nobody re-picks it every morning.
 *
 * WHAT THIS IS NOT: a permission. Because a worker chooses it freely, the station
 * cannot stop anyone from reaching any step — switching station is one tap. What
 * it does is stop ACCIDENTS: you cannot finish a step at a station you are not
 * standing at without first saying you moved, and that move is recorded against
 * the work. Prevention of mistakes, not of people.
 *
 * It is still signed, so the value is always a real station this server issued
 * rather than anything typed into devtools, and so the recorded choice means
 * something when a report is read back later.
 */

const COOKIE = "mes_terminal_station";
const MAX_AGE = 60 * 60 * 24 * 365;

function secret(): string {
  const value = process.env.AUTH_SECRET;
  if (!value) throw new Error("AUTH_SECRET is not set — a terminal cannot be pinned without it");
  return value;
}

export function signStationId(stationId: number): string {
  const body = String(stationId);
  const mac = createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

/** Returns the station id only if the value was signed by this server. */
export function verifyStationCookie(value: string | undefined): number | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = value.slice(0, dot);
  const given = value.slice(dot + 1);
  if (!/^\d{1,9}$/.test(body)) return null;

  const expected = createHmac("sha256", secret()).update(body).digest("base64url");
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const id = Number(body);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export type Terminal = { id: number; name: string } | null;

/** The station this device is pinned to, or null if it is somebody's own browser. */
export async function terminalStation(): Promise<Terminal> {
  let raw: string | undefined;
  try {
    raw = (await cookies()).get(COOKIE)?.value;
  } catch {
    // Reading cookies is not allowed in every rendering context. No cookie simply
    // means "not a station tablet", which is the safe answer.
    return null;
  }
  const id = verifyStationCookie(raw);
  if (id === null) return null;

  const [station] = await db
    .select({ id: stations.id, name: stations.name })
    .from(stations)
    .where(eq(stations.id, id));
  // A station that was deleted or deactivated stops being a terminal rather than
  // silently granting rights to nothing.
  return station && station.id ? station : null;
}

export async function setTerminalStation(stationId: number | null): Promise<void> {
  const jar = await cookies();
  if (stationId === null) jar.delete(COOKIE);
  else
    jar.set(COOKIE, signStationId(stationId), {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: MAX_AGE,
    });
}

export type WorkPermission = { allowed: true } | { allowed: false; reason: string };

/**
 * May this person work on this step, from where they are now?
 *
 * Pure, so the rule can be tested without a session, a cookie or a database.
 *
 *   1. Supervisors and admins act anywhere — they cover absences and clear blocks.
 *   2. A step with no station belongs to nobody in particular.
 *   3. Work given to someone by name is theirs, wherever it is.
 *   4. Their own home station, always — even after picking another one, so that
 *      switching station cannot strand a job they are already clocked on to.
 *   5. The station they are currently working at, which they chose themselves.
 *
 * Rule 5 is why this is a guard against mistakes rather than against people: a
 * worker who needs another station picks it, and then rule 5 lets them in. The
 * refusal exists so that reaching for the wrong card is a question rather than a
 * silent clock-on to somebody else's job.
 */
export function canWorkOnTask(input: {
  role: Role;
  userId: number;
  homeStationId: number | null;
  terminalStationId: number | null;
  taskStationId: number | null;
  assignedToUserId: number | null;
  stationName?: string | null;
}): WorkPermission {
  const {
    role, userId, homeStationId, terminalStationId, taskStationId, assignedToUserId,
  } = input;

  if (role === "SUPERVISOR" || role === "ADMIN") return { allowed: true };
  if (taskStationId === null) return { allowed: true };
  if (assignedToUserId !== null && assignedToUserId === userId) return { allowed: true };
  if (homeStationId !== null && taskStationId === homeStationId) return { allowed: true };
  if (terminalStationId !== null && taskStationId === terminalStationId) return { allowed: true };

  const where = input.stationName ? ` at ${input.stationName}` : "";
  return {
    allowed: false,
    reason: `This step is${where ? where : " at another station"}. Switch to that station to work on it.`,
  };
}
