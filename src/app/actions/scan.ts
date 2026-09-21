"use server";

import { requireUser } from "@/lib/session";
import { resolveScan, type ScanTarget } from "@/lib/scan";

/**
 * Resolve a scanned code to something on the floor.
 *
 * Read-only, but still behind a session check: what work orders exist and which
 * batch numbers are real is not public, and an unauthenticated probe should not
 * be able to enumerate either.
 */
export async function lookupScan(code: string): Promise<ScanTarget> {
  try {
    await requireUser();
  } catch {
    return { kind: "unknown", code };
  }
  if (typeof code !== "string" || code.length > 64) return { kind: "unknown", code: "" };
  return resolveScan(code);
}
