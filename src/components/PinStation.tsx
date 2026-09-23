"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { pinTerminal } from "@/app/actions/terminal";

/**
 * Opening a station's page means you are standing at that station.
 *
 * The station tile pins the device on the way in, but that is only one way to
 * arrive here — a bookmark, the back button, a refresh after the cookie expired,
 * or a link from an alert all land on this URL with the device still pinned
 * somewhere else. The page then lists the jobs and refuses every button on them
 * with "this step is at another station", which reads as the app being broken.
 *
 * Pinning on arrival makes the page's own claim true.
 */
export function PinStation({
  stationId,
  pinnedTo,
}: {
  stationId: number;
  /** What the device is currently pinned to, so the common case writes nothing. */
  pinnedTo: number | null;
}) {
  const router = useRouter();
  const done = useRef(false);

  useEffect(() => {
    if (pinnedTo === stationId || done.current) return;
    done.current = true;
    void pinTerminal(stationId).then(() => router.refresh());
  }, [stationId, pinnedTo, router]);

  return null;
}
