import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { prorate, prorateForUser, openConcurrency } from "../src/lib/timesheets";

/**
 * Proration is pure arithmetic over intervals, so it is tested without a database.
 *
 * The cases that matter are the ones where the naive implementation — divide each
 * entry by how many things the person had open — gives a different answer from the
 * right one. Those are P3 and P4.
 */

const T0 = new Date("2026-09-16T08:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

type Row = Parameters<typeof prorateForUser>[0][number];
const entry = (
  id: number,
  startMin: number,
  endMin: number | null,
  extra: Partial<Row> = {}
): Row => ({
  id,
  userId: 1,
  startedAt: at(startMin),
  endedAt: endMin === null ? null : at(endMin),
  durationSeconds: endMin === null ? null : (endMin - startMin) * 60,
  ...extra,
});

describe("proration", () => {
  test("P1 a single entry is charged exactly as recorded", () => {
    const out = prorateForUser([entry(1, 0, 60)]);
    assert.equal(out.get(1)!.chargedSeconds, 3600);
    assert.equal(out.get(1)!.clockSeconds, 3600);
    assert.equal(out.get(1)!.shared, false);
    assert.equal(out.get(1)!.peakConcurrency, 1);
  });

  test("P2 entries that never overlap are untouched", () => {
    const out = prorateForUser([entry(1, 0, 60), entry(2, 60, 120)]);
    // Half-open intervals: one ending exactly as the next begins is not concurrent.
    assert.equal(out.get(1)!.chargedSeconds, 3600);
    assert.equal(out.get(2)!.chargedSeconds, 3600);
    assert.equal(out.get(1)!.shared, false);
    assert.equal(out.get(2)!.shared, false);
  });

  test("P3 fully overlapping entries each get an equal share", () => {
    const out = prorateForUser([entry(1, 0, 60), entry(2, 0, 60), entry(3, 0, 60)]);
    for (const id of [1, 2, 3]) {
      assert.equal(out.get(id)!.chargedSeconds, 1200, `entry ${id}`);
      assert.equal(out.get(id)!.clockSeconds, 3600, `entry ${id} clock`);
      assert.equal(out.get(id)!.peakConcurrency, 3);
    }
    // One hour of a person's attention stays one hour, however many machines.
    const total = [1, 2, 3].reduce((s, id) => s + out.get(id)!.chargedSeconds, 0);
    assert.equal(total, 3600);
  });

  test("P4 partial overlap splits only the overlapping part", () => {
    // A runs 0–120. B joins for the last 20 minutes only.
    const out = prorateForUser([entry(1, 0, 120), entry(2, 100, 120)]);

    // A dividing ratio would have said 60 minutes for A. The right answer is 110.
    assert.equal(out.get(1)!.chargedSeconds, 110 * 60);
    assert.equal(out.get(2)!.chargedSeconds, 10 * 60);
    assert.equal(out.get(1)!.clockSeconds, 120 * 60);

    // Nothing invented, nothing lost.
    assert.equal(
      out.get(1)!.chargedSeconds + out.get(2)!.chargedSeconds,
      120 * 60
    );
  });

  test("P5 a still-open entry is charged up to now and shares with what it overlaps", () => {
    const now = at(60);
    const out = prorateForUser([entry(1, 0, null), entry(2, 0, 60)], now);
    assert.equal(out.get(1)!.chargedSeconds, 1800);
    assert.equal(out.get(2)!.chargedSeconds, 1800);
    assert.equal(out.get(1)!.clockSeconds, 3600);
  });

  test("P6 a supervisor's correction wins and leaves the rest to share", () => {
    // Two entries fully overlap, but one has been corrected to 15 minutes. The
    // correction is a human decision; the split must not quietly halve it.
    const out = prorateForUser([
      entry(1, 0, 60, { adjustedSeconds: 900 }),
      entry(2, 0, 60),
    ]);
    assert.equal(out.get(1)!.chargedSeconds, 900);
    assert.equal(out.get(1)!.corrected, true);
    // The uncorrected entry is no longer competing with anything, so it keeps its
    // full hour rather than being penalised by a figure someone overrode.
    assert.equal(out.get(2)!.chargedSeconds, 3600);
    assert.equal(out.get(2)!.shared, false);
  });

  test("P7 different people never share with each other", () => {
    const out = prorate([
      { ...entry(1, 0, 60), userId: 1 },
      { ...entry(2, 0, 60), userId: 2 },
    ]);
    assert.equal(out.get(1)!.chargedSeconds, 3600);
    assert.equal(out.get(2)!.chargedSeconds, 3600);
  });

  test("P8 concurrency is measured at the peak, not averaged", () => {
    // Three overlap in the middle; A alone at the edges. A is still "shared".
    const out = prorateForUser([entry(1, 0, 90), entry(2, 30, 60), entry(3, 30, 60)]);
    assert.equal(out.get(1)!.peakConcurrency, 3);
    assert.equal(out.get(1)!.shared, true);
    // A: 30 alone + 30 at a third + 30 alone = 70 minutes.
    assert.equal(out.get(1)!.chargedSeconds, 70 * 60);
    assert.equal(out.get(2)!.chargedSeconds, 10 * 60);
    assert.equal(out.get(3)!.chargedSeconds, 10 * 60);
  });

  test("P9 an empty list and a malformed entry do not throw", () => {
    assert.equal(prorateForUser([]).size, 0);
    // Ends before it starts — clamped to zero rather than producing negative time.
    const out = prorateForUser([entry(1, 60, 30)]);
    assert.equal(out.get(1)!.chargedSeconds, 0);
  });

  test("P10 openConcurrency counts only what is still running", () => {
    assert.equal(openConcurrency([entry(1, 0, 60), entry(2, 0, null), entry(3, 10, null)]), 2);
  });

  test("P11 charged time never exceeds clocked time, even on inconsistent data", () => {
    // The recorded duration and the timestamps normally agree because the app
    // writes both in one transaction. Imported history and seeded demo data can
    // disagree, and when they did, charging from the timestamps produced rows
    // charged with more time than they were clocked for. The fraction is taken
    // from the timestamps; it is applied to the recorded duration.
    const short: Row = {
      id: 1,
      userId: 1,
      startedAt: at(0),
      endedAt: at(120),
      durationSeconds: 50 * 60, // half what the span says
    };
    const out = prorateForUser([short]);
    assert.equal(out.get(1)!.clockSeconds, 50 * 60);
    assert.equal(out.get(1)!.chargedSeconds, 50 * 60);

    const withOverlap = prorateForUser([short, entry(2, 0, 120)]);
    assert.equal(withOverlap.get(1)!.chargedSeconds, 25 * 60, "half of the recorded 50m");
    assert.ok(
      withOverlap.get(1)!.chargedSeconds <= withOverlap.get(1)!.clockSeconds,
      "charged can never exceed clocked"
    );
  });
});
