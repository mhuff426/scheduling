# Shift Scheduler

A small full-stack app for scheduling shift workers: admins configure shifts and the roster,
employees request time off, and the system generates fair schedules everyone can view and
export to their personal calendars.

## Run it

```sh
npm install
npm run dev        # API on :3001, web app on http://localhost:5173
```

Optional demo data: `node server/seed.js` (overwrites `data/data.json`).

Production: `npm run build` then `npm start` (serves the built app and API on :3001).

## How it works

**Roles** — pick who you are with the "Signed in as" switcher in the top bar (prototype-style;
no passwords). Admins see the extra Admin tab.

**Admin tab**
- **Shift Types** — name, start/end time, frequency (every 24 hours or weekly on a chosen
  weekday), and headcount per occurrence. Overnight shifts (end ≤ start) roll to the next day.
- **Roster** — add employees and set each person's vacation days per year (editable inline).
- **Settings** — the maximum number of people who may take vacation on the same day.
- **Generate Schedule** — start date, end date, and a minimum number of shifts per employee.

**My Time Off tab** — click days on the calendar to tag them:
- 🏖️ **Vacation** — you absolutely cannot work. Spends one of your yearly vacation days and is
  rejected if you're out of days or the day already hit the per-day vacation cap.
- 🤞 **Prefer off** — costs nothing, but coverage may still require scheduling you (you'll see
  it in the schedule warnings).

**Schedule tab** — month calendar color-coded by employee, a per-person list view, and
"Add my shifts to calendar" which downloads an `.ics` file you can import into Google
Calendar (Settings → Import & export) or Apple Calendar (File → Import).

## Scheduling rules

Hard constraints: vacation days are never scheduled over; nobody works more than one shift per
day; at least 8 hours of rest between shifts (no "clopening"); nobody exceeds their personal
consecutive-overnight cap (counting all overnight types together, set on My Requests); nobody
exceeds their maximum shifts for the block — the block-wide max set when generating, or the
per-employee "Max / block" override in the Roster, which wins. A cap below someone's minimum
lowers their minimum (the ceiling is hard, the floor is a goal); slots nobody can legally take
go open. Soft goals, in priority order:
fill every slot → get everyone to their personal minimum (the schedule minimum reduced by their
vacation days in the range) → avoid preferred-off days → give extra shifts to people who asked
for more than the minimum → spread overnight shifts (🌙) evenly and balance weighted load.
Every shift type can carry a fairness **weight** (Admin → Shift Types): heavier shifts count for
more when balancing load, and a weight of **0 marks standby/backup duty** — still scheduled,
still blocks the day and obeys rest rules, but adds nothing to load and doesn't count toward
minimums, maximums, or desired-shift targets. Blank weight = automatic: 1 for normal shifts, or
the Settings "overnight shift weight" default for overnight types. A rotation record persists
across schedules so tie-breaks don't always favor the same people.

Unfillable shifts appear as red OPEN chips on the calendar and as warnings — a hiring signal.
Admins can click any chip to reassign a shift or fill an open one (hard rules still apply).
Employees can request a desired shift count per block on the My Requests page.

## Shift runs (keeping people on a shift several days running)

Each shift type can carry a **run range** (`minRun`–`maxRun`, set in Admin → Shift Types). When
set, the scheduler tries to keep one person on that shift type for a streak of days: it continues
a run hard until `minRun`, prefers to continue through `maxRun`, then forces a switch. Crucially
the work still **rotates across the team** — when a run ends the next one goes to whoever has done
that shift type least this block, so the same few people don't monopolize it or always work
together. Each day's slots are filled in run-urgency order — active runs below their minimum
first, then active runs inside the band, then new-run starts, then ungrouped types, with ties
rotating daily — so a run continuation always claims its holder before any other shift type can
poach them, no matter where the type sits in the list. A preferred-off day inside a run hands that day to
someone else if anyone's available (the run pauses, then resumes); vacation always breaks it.
Leave the range blank for no grouping (the original behavior).

Each employee can set a **max consecutive overnight shifts** on My Requests — a hard personal cap
across all overnight types (work four nights of any kind and a fifth, of any overnight type, is
blocked). The repair pass that tops people up to their minimum prefers to pull shifts from a run's
edges rather than splitting it mid-stream.

**Recovery days between stretches** — after working consecutive days (any shift types), people
ideally get real time off before their next shift: 1 full day after a 2–4 day stretch, 2 days
after 5+. This is soft: it outranks handing someone extra shifts they asked for, but never
coverage, minimums, or the run caps — if nobody rested can take a slot, the early return happens
and the admin sees a warning ("X returns on … with only 1 day off after a 5-day stretch").
Continuing the same run isn't an "early return"; the rule kicks in when a stretch ends.

When generating a schedule, the admin checks who can be scheduled in that block — anyone
unchecked (manager included) gets no shifts and no minimum-shift warnings for that block.

## Shift trading

The **Trades** tab (badge shows unread notifications) lets employees rearrange a published
schedule themselves, three ways — both shifts must be in the same schedule block and in the
future:

- **Open swap** — post one of your shifts; everyone is notified; coworkers counter-offer one of
  their shifts; you pick which offer to accept. No vacation used.
- **Direct swap** — propose your shift for a specific shift of a specific person; they accept or
  reject (you're notified either way). No vacation used.
- **Give up a shift** — costs **1 vacation day**, confirmed up front (refused if you have no days
  left for that year — then you must swap instead). Everyone is alerted; the shift **stays yours
  until a coworker claims it**. Cancel before it's claimed for a refund. Claimed shifts count as
  the claimer's **extra shifts**, shown on the Trades tab and in the schedule's My Shifts view
  (admins see any employee's count via the person selector there).

Every trade execution re-checks the safety rules for the receiving person — vacation conflicts,
one shift per day, 8h rest, personal night caps — but deliberately not the max-shifts cap.
Trades that go stale (a shift changed hands via admin reassignment first) expire safely with a
notification. Core logic lives in `server/trades.js`; tests in `server/trades.test.js`.

## Preference anti-gaming

"Prefer off" requests are kept honest by two independent mechanisms:

- **Per-block outlier cap** — anyone asking for dramatically more preferred days than the rest
  of the roster (above everyone else's average + 4 × max(std dev, 1 day)) keeps full priority
  only on the days they requested first; the excess is demoted to least-preference (honored
  only when it costs nobody anything). The admin sees a warning naming the cap.
- **Preference standing** — a derived score (0.5–1.25, neutral 1.0) recomputed from the ask
  snapshots of the last 6 schedules. Chronic over-askers sink and their preferences lose
  contested days first; people who rarely ask drift up and are overridden last. One-time
  spikes recover to neutral within ~3 normal blocks. Standing only affects preference
  priority — never shift counts, minimums, vacation, or desired-shift priority. It is shown
  read-only in the admin roster ("Pref standing") and is invisible to employees.

## Parked / future work

- **Slot fill order** — today the greedy pass fills slots in chronological (date) order. Review
  changing this to resolve the most-contested days first (most time-off requests / fewest
  available people), then by date — so the scarcest days get the best pick of coverage before
  the easy days consume it.
- Keep published schedules in sync with roster/time-off changes (stale schedule detection)
- Replace greedy+repair with a real constraint solver for chain reassignments
- Vacation caps that consider actual shift demand per day, plus an approval workflow
- Vacation accrual rules (earning days over time rather than a flat yearly grant)

## Tech notes

- Express API (`server/`), React + Vite frontend (`client/`), data persisted to
  `data/data.json` — no database to set up.
- Scheduler tests: `node server/scheduler.test.js`.
