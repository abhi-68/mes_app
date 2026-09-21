# Showing it to Thermal Corp

Twenty minutes of software, forty minutes of them talking. The demo is not the point —
getting their real process out of them is, and a screen they can correct is the fastest
way to do it. People who go blank at "so how do you build these?" will happily spend ten
minutes telling you why your routing is wrong.

---

## The morning of

```
DATABASE_URL="...your neon url..." npm run db:setup
```

Resets the data to a clean state. Then open the link in a private window and sign in as
`supervisor@thermal-corp.com` to confirm it is awake — the free-tier database sleeps
when idle and the first load takes a few seconds. Do this twenty minutes before, not
while they are watching.

Have two browser windows ready, signed in as two different people. Switching accounts
live is where demos die.

- Window A: `worker4@thermal-corp.com` (Final Assembly)
- Window B: `supervisor@thermal-corp.com`

---

## The walkthrough

### 1. Open on the problem, not the product — 2 min

Window A, **My work**, as the Final Assembly worker. Do not explain anything yet. Let
them read:

> **Set frame on line & verify dimensions**
> Short 1 unit of Welded Casing Frame — "Fit base rail & lifting lugs" on WO-1001-01
> has not delivered any yet

Then say roughly: *this is a person at final assembly who cannot start. Today they find
that out by walking over to the frame bay. Here the step itself says which part is
missing, which order it is on, and which operation is holding it.*

**Ask:** "When this happens on your floor, how does the guy at final assembly find out?"

Then stop talking. This question is the whole meeting. Whatever they say — a whiteboard,
a radio, a supervisor walking the floor, a printed traveler — write it down word for
word.

### 2. The supervisor's version of the same fact — 3 min

Window B, **What's waiting**.

> Held up: 8 · Units affected: 2 · Queued behind an earlier step: 19

*Everything that cannot move right now, and why. The nineteen at the bottom are just
waiting their turn — normal. The eight at the top are the ones costing you days.*

**Ask:** "How many units are usually open at once, and how many of those are stuck on a
part?" You are calibrating whether this list would be five rows or five hundred.

### 3. Where the numbers come from — 3 min

Window A, tap **Start** on a step that is ready. The clock starts.

Then window B, **Inventory** — the component count is one lower. *Starting the step drew
the material. Same transaction: it is not possible to have the step running and the stock
untouched.*

Tap **Start** again on the same step. Nothing is consumed twice.

**Ask:** "Who pulls material today — the worker, or a stores person on a pick list?" The
answer decides whether consumption belongs on Start at all, or on a separate pick
confirmation. Do not defend the current choice; find out.

### 4. Time, and who can change it — 3 min

Window B, **Reports** → average time per step, per station, per worker. *All of it from
Start and Mark done. Nobody types a number.*

Then **Timesheets**. *The worker cannot edit these. A supervisor can correct one and the
correction is a separate record with their name on it.*

**Ask:** "How are hours captured now, and does anyone need to approve a correction?"
Also: "would workers object to this?" — an honest answer here tells you whether the whole
approach is politically viable on their floor, which is worth more than any feature.

### 5. The part they should argue with — 5 min

Window B, **Setup → Products →** the CF-3000 unit. Show the routing and the bill of
materials, and say plainly:

> **This is a guess.** We built it from your public Air Handlers catalogue. The stations,
> the order of operations and the times are all invented. Nothing here came from your
> floor.

Then walk the steps out loud — *shear and form, weld the frame, panels, coil, fan and
motor, final assembly, test* — and watch their faces.

**Ask:** "What is wrong with this?"

This is the highest-value minute of the meeting. Expect to be told the sequence is wrong,
that two of those happen at one station, that the coil is bought in, that nothing is
built to stock. Capture all of it verbatim. Every correction is a routing you no longer
have to guess.

### 6. Show that fixing it is data, not code — 2 min

Edit a step name or a time in front of them, release a new work order from **Setup → Work
orders**, and show the changed process coming out the other end.

*That is the point of building this rather than buying it. Your process is configuration.
Nobody has to ship a new version because you moved a station.*

### 7. Close — 2 min

Be straight about what it is:

- Working: the waiting view, material, timing, sub-assembly progress, the three roles.
- Not built: barcode scanning, lot and serial traceability, scheduling, purchasing,
  quality inspection screens.
- Unknown: their actual process, which is why everything above is a guess.

*Nothing has been decided. We wanted you to have something concrete to react to before
anyone writes the real thing.*

---

## What you need to leave with

Four things. Without them the next build is guesswork with better graphics.

1. **One real order, end to end.** A purchase order, the unit it became, the parts it
   needed, and when it actually shipped. One real order teaches more than ten hours of
   description.
2. **Its bill of materials** — what actually goes into that unit, as they hold it.
3. **Its production traveler** — the paper or spreadsheet that follows the job around
   the floor. This *is* their routing. It is the single most valuable document here.
4. **An hour on the floor** — thirty minutes with a supervisor, thirty with a worker,
   watching rather than asking.

If you get only one, get the traveler.

## Questions worth asking, in rough priority

Ordered so that if the meeting is cut to fifteen minutes you still ask the ones that
change the design.

**The problem itself**

- Walk me through the last time final assembly was held up. What was missing, who found
  out, how long did it sit?
- Does anyone know today which units are waiting and on what, or is it each supervisor's
  own head?
- How much of your late delivery is waiting-on-parts versus everything else?

**How work is really organised**

- Is a job one traveler from start to finish, or does each section get its own paperwork?
- Do sub-assemblies get built to a specific order, or to stock and drawn down?
- Can a worker cover more than one station? Does that change day to day?
- Who decides what gets worked on next, and on what basis?

**Material**

- Who pulls parts, and against what document?
- What happens when the part is not there — substitute, partial build, or stop?
- Do you track which batch of a component went into which unit? Would you want to?

**Quality**

- Where does inspection happen, and what does a failure do to the job?
- Rework: same station, or does it go somewhere else?
- Who can release a unit that has been held?

**Practicalities that decide the design**

- What are people holding on the floor — a tablet, a shared terminal, nothing?
- Would they scan barcodes? Do parts and travelers carry them today?
- What runs the office side — QuickBooks, an ERP, spreadsheets? Does this need to talk
  to it?
- Who, specifically, would own this system once it exists?

---

## Things not to say

- Do not say it is ready, nearly ready, or a pilot. It is a prototype with invented data.
- Do not compare it to Odoo, Fishbowl or Epicor in the room. Those products do far more.
  The case for custom is fit, not features, and claiming otherwise invites a comparison
  you lose.
- Do not promise dates. You do not yet know their process, and every estimate made before
  the traveler is on the table is fiction.
- Do not defend a design choice they push back on. They are describing their factory;
  that is the thing you came for.

## Straight after

Write it up the same day — the corrections to the routing especially, while you can still
read your own handwriting. Then the next build is: their real routing in the seed, and
whichever two or three gaps they actually named.
