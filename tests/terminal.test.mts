import "dotenv/config";
import { test } from "node:test";
import assert from "node:assert/strict";
import { canWorkOnTask, signStationId, verifyStationCookie } from "../src/lib/terminal.ts";

/**
 * The shared station terminal.
 *
 * Two things are worth testing and neither is the happy path: that the cookie
 * granting these rights cannot be forged, and that each of the five ways of
 * earning the right to work a step is honoured separately — because the old rule
 * was a single equality against the worker's own station, and everything a real
 * floor does that is not that got refused.
 */

const FRAME = 1;
const COIL = 2;
const WORKER = { role: "WORKER" as const, userId: 10 };

const ask = (over: Partial<Parameters<typeof canWorkOnTask>[0]>) =>
  canWorkOnTask({
    ...WORKER,
    homeStationId: FRAME,
    terminalStationId: null,
    taskStationId: FRAME,
    assignedToUserId: null,
    ...over,
  });

// --- the signature -------------------------------------------------------

test("a station cookie this server signed is accepted", () => {
  assert.equal(verifyStationCookie(signStationId(7)), 7);
  assert.equal(verifyStationCookie(signStationId(1)), 1);
});

test("a forged or tampered cookie is refused", () => {
  const good = signStationId(3);
  const [body, mac] = good.split(".");
  assert.equal(body, "3");

  for (const bad of [
    "3",                       // no signature at all
    "3.",                      // empty signature
    `4.${mac}`,                // another station, this station's signature
    `${body}.${mac}x`,         // mangled signature
    `${body}.${"a".repeat(mac.length)}`,
    "",
    undefined,
    "abc.def",
    "-1." + mac,
  ]) {
    assert.equal(verifyStationCookie(bad), null, `${JSON.stringify(bad)} must not verify`);
  }
});

test("the signature is bound to the station id, so one cannot be reused for another", () => {
  const a = signStationId(1).split(".")[1];
  const b = signStationId(2).split(".")[1];
  assert.notEqual(a, b);
  assert.equal(verifyStationCookie(`2.${a}`), null);
});

// --- who may work on what ------------------------------------------------

test("a worker may work at their own station", () => {
  assert.equal(ask({}).allowed, true);
});

test("a worker is stopped at a station they have not switched to", () => {
  const res = ask({ taskStationId: COIL, stationName: "Coil Line" });
  assert.equal(res.allowed, false);
  if (res.allowed) return;
  // It names the station rather than saying "another station", and says what to
  // do about it. Since the worker can switch freely this is a check against
  // reaching for the wrong card, not against the person.
  assert.match(res.reason, /Coil Line/);
  assert.match(res.reason, /Switch/i);
});

test("and switching to it is all that is required — no approval, no assignment", () => {
  const before = ask({ taskStationId: COIL, stationName: "Coil Line" });
  assert.equal(before.allowed, false);
  const after = ask({ taskStationId: COIL, terminalStationId: COIL });
  assert.equal(after.allowed, true, "picking the station is the whole flow");
});

test("standing at that station's tablet is permission to work there", () => {
  assert.equal(ask({ taskStationId: COIL, terminalStationId: COIL }).allowed, true);
});

test("a tablet pinned elsewhere does not grant rights to a third station", () => {
  assert.equal(ask({ taskStationId: COIL, terminalStationId: 3 }).allowed, false);
});

test("a tablet never takes away the right to their own station's work", () => {
  // Someone covering the coil line still owns their own queue back at Frame Fab.
  assert.equal(ask({ taskStationId: FRAME, terminalStationId: COIL }).allowed, true);
});

test("work given to them by name is theirs wherever it is", () => {
  assert.equal(ask({ taskStationId: COIL, assignedToUserId: WORKER.userId }).allowed, true);
});

test("work given to somebody else is not theirs, even at their own station", () => {
  assert.equal(ask({ taskStationId: FRAME, assignedToUserId: 99 }).allowed, true, "own station still wins");
  assert.equal(ask({ taskStationId: COIL, assignedToUserId: 99 }).allowed, false);
});

test("a step with no station belongs to nobody in particular", () => {
  assert.equal(ask({ taskStationId: null }).allowed, true);
});

test("a worker with no home station can still work at the tablet they are at", () => {
  assert.equal(
    ask({ homeStationId: null, taskStationId: COIL, terminalStationId: COIL }).allowed,
    true
  );
  assert.equal(ask({ homeStationId: null, taskStationId: COIL }).allowed, false);
});

test("supervisors and admins act anywhere, with or without a tablet", () => {
  for (const role of ["SUPERVISOR", "ADMIN"] as const) {
    assert.equal(
      canWorkOnTask({
        role,
        userId: 1,
        homeStationId: null,
        terminalStationId: null,
        taskStationId: COIL,
        assignedToUserId: 99,
      }).allowed,
      true
    );
  }
});
