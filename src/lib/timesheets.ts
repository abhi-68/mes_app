/**
 * Splitting one person's clock time across the steps they had open at the time.
 *
 * The problem this solves is real and easy to miss. A worker tending three
 * machines clocks on to all three and works a seven-hour shift. Add the raw
 * durations up and you have twenty-one hours of labour against a person who was
 * there for seven — every cost, every average and every "how long does this
 * normally take" number inflated threefold, with no clue on the screen that
 * anything is wrong. Epicor solves it by prorating concurrent activities; most
 * simple systems do not solve it at all, which is why their labour figures quietly
 * stop being usable the first time someone minds two machines.
 *
 * The rule: at any instant, a person's attention is worth exactly one person. If
 * three of their entries are open at that instant, each one earns a third of a
 * second per second.
 *
 * WHY A SWEEP, NOT A RATIO. Dividing each entry by "how many things they had open"
 * is wrong whenever the overlap is partial — the common case. Someone on step A
 * for two hours who joins step B for the last twenty minutes should be charged
 * 1h50 to A, not one hour. So the timeline is cut at every start and every end,
 * and each resulting slice is divided by how many entries were live during THAT
 * slice. Entries that never overlap anything come out exactly as recorded, which
 * is what keeps this invisible on a floor where nobody multitasks.
 *
 * WHAT IS NOT PRORATED. A supervisor's manual correction is a human decision about
 * what a time entry should say, and this function does not second-guess it: an
 * adjusted entry is charged at its adjusted value, and it is removed from the pool
 * before the remaining entries are split. Paid clock time (what payroll owes) is
 * always the recorded duration; charged time (what the job cost) is what this
 * returns. They are different questions and the interface shows both.
 */

export type ProratableEntry = {
  id: number;
  userId: number;
  startedAt: Date;
  /** Null means still running. Open entries are prorated up to `now`. */
  endedAt: Date | null;
  /** As recorded. Null while still running. */
  durationSeconds: number | null;
  /** A supervisor's correction, if one exists. Wins outright over the split. */
  adjustedSeconds?: number | null;
};

export type ChargedEntry = {
  id: number;
  /** Wall-clock seconds this entry was open — what payroll sees. */
  clockSeconds: number;
  /** Seconds charged to the job after sharing overlaps — what costing sees. */
  chargedSeconds: number;
  /** How many of this person's entries were open at the busiest moment of this one. */
  peakConcurrency: number;
  /** True when this entry gave up time to another. Drives the "shared" label. */
  shared: boolean;
  /** True when a supervisor's correction set the charged figure directly. */
  corrected: boolean;
};

/**
 * Prorate one person's entries.
 *
 * Pass every entry for the window you are reporting on — a partial list gives a
 * partial answer, because an entry can only be split against overlaps it can see.
 */
export function prorateForUser(
  entries: ProratableEntry[],
  now: Date = new Date()
): Map<number, ChargedEntry> {
  const out = new Map<number, ChargedEntry>();
  if (entries.length === 0) return out;

  const nowMs = now.getTime();

  type Span = { id: number; start: number; end: number; corrected: boolean };
  const spans: Span[] = [];

  for (const e of entries) {
    const start = e.startedAt.getTime();
    // A still-running entry is open up to this instant. An entry that somehow ends
    // before it starts is treated as zero rather than as negative time.
    const end = Math.max(start, e.endedAt ? e.endedAt.getTime() : nowMs);
    // Never negative. A duration below zero is meaningless and, left alone,
    // propagates into every average and total downstream as a silent subtraction.
    const clockSeconds = Math.max(
      0,
      e.endedAt && e.durationSeconds != null
        ? e.durationSeconds
        : Math.round((end - start) / 1000)
    );
    const corrected = e.adjustedSeconds != null;

    out.set(e.id, {
      id: e.id,
      clockSeconds,
      // Overwritten below for entries that take part in the split.
      chargedSeconds: corrected ? e.adjustedSeconds! : clockSeconds,
      peakConcurrency: 1,
      shared: false,
      corrected,
    });

    if (!corrected) spans.push({ id: e.id, start, end, corrected });
  }

  if (spans.length === 0) return out;

  // Cut the timeline at every boundary, then walk the slices.
  const boundaries = Array.from(
    new Set(spans.flatMap((s) => [s.start, s.end]))
  ).sort((a, b) => a - b);

  const chargedMs = new Map<number, number>(spans.map((s) => [s.id, 0]));
  const peak = new Map<number, number>(spans.map((s) => [s.id, 0]));

  for (let i = 0; i < boundaries.length - 1; i++) {
    const from = boundaries[i];
    const to = boundaries[i + 1];
    const width = to - from;
    if (width <= 0) continue;

    // Half-open [start, end): an entry that ends exactly as another begins is not
    // concurrent with it, which is the behaviour anyone would expect from a clock.
    const live = spans.filter((s) => s.start <= from && s.end > from);
    if (live.length === 0) continue;

    const share = width / live.length;
    for (const s of live) {
      chargedMs.set(s.id, (chargedMs.get(s.id) ?? 0) + share);
      if (live.length > (peak.get(s.id) ?? 0)) peak.set(s.id, live.length);
    }
  }

  for (const s of spans) {
    const row = out.get(s.id)!;
    const concurrency = Math.max(1, peak.get(s.id) ?? 1);
    const span = s.end - s.start;

    /*
      The sweep produces a FRACTION of this entry's span, not an absolute time,
      and the fraction is then applied to the recorded duration.

      That extra step matters. The recorded duration is what was clocked; the
      timestamps are only how the overlap is worked out. They are written in the
      same transaction so they normally agree, but they can disagree — imported
      history, a seeded demo, a clock adjusted at the database. When they did
      disagree, computing charged time straight from the timestamps produced
      rows charged with MORE time than they were clocked for, which is both
      wrong and obviously wrong to anyone reading the two columns side by side.
      Scaling the recorded duration cannot do that: with nothing overlapping the
      fraction is exactly 1 and the two columns match to the second.
    */
    const share = span > 0 ? (chargedMs.get(s.id) ?? 0) / span : 1;
    row.chargedSeconds = Math.round(row.clockSeconds * share);
    row.peakConcurrency = concurrency;
    row.shared = concurrency > 1;
  }

  return out;
}

/** Prorate a mixed list of entries belonging to several people. */
export function prorate(
  entries: ProratableEntry[],
  now: Date = new Date()
): Map<number, ChargedEntry> {
  const byUser = new Map<number, ProratableEntry[]>();
  for (const e of entries) {
    const list = byUser.get(e.userId);
    if (list) list.push(e);
    else byUser.set(e.userId, [e]);
  }

  const out = new Map<number, ChargedEntry>();
  for (const list of byUser.values()) {
    for (const [id, charged] of prorateForUser(list, now)) out.set(id, charged);
  }
  return out;
}

/**
 * How many steps this person has open right now.
 *
 * Used to tell a worker on the shop floor that their time is being shared, at the
 * moment they are clocking on to a second thing rather than in a report a month
 * later. Nobody should have to discover this from a variance.
 */
export function openConcurrency(entries: ProratableEntry[]): number {
  return entries.filter((e) => e.endedAt === null).length;
}
