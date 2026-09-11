# WSC 2027 Assumptions Collection — briefing for Matt

## What this is

A small web app so the five club groups (Meet Team, Pool & Venues, Coaching & Staffing,
Membership, General Admin) can each submit their own 2027 budget assumptions, save drafts,
and resubmit — with a Treasurer/Admin review queue (approve, or request changes with a note)
before anything counts. Approved submissions then roll up into a **Master 2027 budget tab**
(§8, new 10 Sept) that an Admin/Treasurer recalculates and eventually publishes as the live
2027 budget. It reads and writes directly to the **WSC Assumptions Collection v0.1**
Google Sheet (id `1VNBtb24dpbAJcpAtgQkuiheLZOLCXGVa8t7LY386dM4`) using the 12 tabs already in
it, plus the new `Master_2027` tab the app creates itself the first time it's recalculated.
This is its own Apps Script project with its own deployment — separate from ClubHuB, though
built the same way so the two can be linked or combined later. Source lives at
`https://github.com/WindsorSC-Admin/WSC-Assumptions-Collection`, same handoff pattern as
ClubHuB and the Swim Session Tool: paste these files into Apps Script first, then push to the
repo yourself (or via a Claude Code CLI session) — per the project's own rule, Apps Script wins
over GitHub if the two ever drift.

There are two files: `Code.gs` (server logic) and `Index.html` (the page). Both are complete,
paste-in-whole files — there's nothing to merge into anything else.

## 1. Bind a new Apps Script project to the Sheet

1. Open the **WSC Assumptions Collection v0.1** Google Sheet.
2. Extensions → Apps Script. This opens a new, empty Apps Script project already bound to
   that Sheet (you don't need to look up or paste in the Sheet ID — the code has it, but
   binding via this menu is what lets `Session.getActiveUser()` and simple deployment work
   the same way ClubHuB does).
3. You'll see a default `Code.gs` with an empty `myFunction(){}` in it. Select all the text
   in that editor tab and delete it.
4. Paste in the **entire contents** of the `Code.gs` file from this delivery.
5. Click the `+` next to "Files" → HTML → name it exactly `Index` (Apps Script adds the
   `.html` itself, and the code refers to the file as `'Index'`).
6. Delete the placeholder content in that new file and paste in the **entire contents** of
   `Index.html` from this delivery.
7. Save the project (the disk icon, or Ctrl/Cmd+S). Give the project a name when prompted,
   e.g. "WSC Assumptions Collection".
8. From the Run menu's function dropdown, select `checkSetup` and click Run. The first run
   will ask you to authorize the script (click through the "unverified app" warning — this
   is normal for a script you just wrote yourself). Then View → Logs (or Ctrl+Enter) to see
   what it found — it tells you if any tab or the "extra" columns described in section 4
   below are missing, without touching any data.

## 2. Deploy as a web app

1. Deploy → New deployment.
2. Click the gear next to "Select type" → Web app.
3. Description: anything, e.g. "v1".
4. **Execute as: User accessing the web app** (not "Me") — this is what lets the app see
   who's actually logged in via `Session.getActiveUser()`, matching how ClubHuB is deployed.
5. **Who has access: Anyone within [your Google Workspace domain]** — not "Anyone", so it
   isn't open to the public internet, and not "Only myself", so the club's groups can use it.
6. Click Deploy, authorize again if asked, and copy the web app URL it gives you — that's
   the link to share with the five groups and the Treasurer.
7. Whenever you paste in an updated `Code.gs` or `Index.html` later, you need to make a
   **new deployment** (or use "Manage deployments" → edit → new version) for the changes to
   go live at the same URL — saving the files alone isn't enough.

## 3. Two new tabs to add: Baseline_Squads and Baseline_Venues

These don't exist yet. They hold the reference data a fresh Membership or Pool & Venues
submission pre-fills from — the same 26 squads / 6 venues that were hardcoded in the old
mockup, now living in the Sheet so you can update them yourself without a redeploy. The app
reads them at runtime and degrades gracefully (empty pre-fill, not a crash) if either tab is
missing or empty.

**To add each one:** right-click a sheet tab → Insert sheet, rename it exactly as shown
below, click cell A1, and paste the block — Google Sheets auto-expands tab-separated text
across cells and rows.

### Baseline_Squads

```
Squad Name	Category	Members	Fee £/mo
Advanced	Train	22	94.55
Beginner 1	Train	4	56.39
Beginner 2	Train	4	58.09
Beginner 3	Train	4	58.09
Club Junior	Train	16	64.70
Club Senior	Train	9	67.54
Improver 1A	Train	8	61.79
Improver 1B	Train	11	61.79
Improver 1C	Train	6	61.79
Improver 2A	Train	8	79.53
Improver 2B	Train	5	79.53
Improver 2C	Train	8	79.53
Improver 2D	Train	5	79.53
Improver 3A	Train	6	88.77
Improver 3B	Train	4	88.77
Improver 3C	Train	9	88.77
Improver 3D	Train	3	88.77
Masters Cat 2	Train	21	71.40
County Development	Compete	27	105.05
Early Development	Compete	33	97.71
Junior Development	Compete	22	97.71
Masters Cat 1	Compete	19	71.40
National Development	Compete	34	124.89
Regional Development	Compete	24	122.85
Senior Competitive	Compete	3	101.33
Senior Development	Compete	35	98.02
```

### Baseline_Venues

**Rebuilt 10 Sept from ClubHuB's real `Venues` tab, not the old mockup's guesses.** The mockup's
original 6 venues (Aldershot, Eton, Bishopsgate, Braywick, Heathfield, WLC) didn't actually
match the real Ledger's cost lines (Aldershot, **Athens**, Bishopsgate, Heathfield, WLC, **BLC**)
— "Athens" and "Aldershot" turned out to be real ClubHuB venues (Athens Sports Complex, Eton
College and Aldershot Garrison Sports Centre) that the mockup never had right. Use these exact
6 names below — the Master 2027 tab (§8) matches a Pool & Venues submission's rows to the real
Ledger's cost lines by this exact name, so renaming a row here (or in a live submission) will
stop that venue rolling up automatically.

```
Venue	Rate	Rate Basis	Annual Inflation %
Aldershot	165	£/wk	3
Athens	210	£/wk	3
Bishopsgate	145	£/wk	3
Heathfield	190	£/wk	3
WLC	4700	£/mo, flat	3
BLC	178	£/wk	3
```

**Judgement calls:** (1) the old mockup didn't have a baseline inflation figure per venue — it
just defaulted every fresh row to 3%; carried that through here, adjust any if you have a
better starting figure. (2) **Confirmed 10 Sept: "Bishopsgate" is ClubHuB's `Bishopsgate` +
`Bishopsgate Pool` venues combined into one line**, matching the real Ledger's single
Bishopsgate cost line — so there's no separate "Bishopsgate Pool" row here.

## 4. A few extra columns beyond the 12-tab schema you gave me

Most fields map straight onto the columns you specified. A handful of narrative/notes fields
from the approved mockup UI don't have a column in the 12 tabs as given, so rather than drop
them from the form, the code writes them to a few **extra columns you'll need to add** to
existing tabs (add the header text below to the next empty column in each — the code finds
columns by header name, so exact spelling matters, and it will just silently skip saving that
one field, no crash, until you add the column):

| Tab | New column header | Holds |
|---|---|---|
| `MeetTeam_Fields` | `Away Meet Notes` | The "away-meet costs, trending up/down" textarea |
| `PoolVenues` | `Notes` | The "any confirmed mid-year rate changes" textarea (same text repeated on every venue row for that submission — read back from the first row) |
| `Coaching_Fields` | `CPD Budget` | CPD & course budget (£) |
| `Coaching_Fields` | `Staffing Notes` | "New hires, leavers, or rate changes" textarea |
| `Membership_Discounts` | `Notes` | "Expected joiners/leavers or fee changes" textarea |
| `Coaching_CompetitiveCoaches` | `Hours/week` | Added 10 Sept for the Master 2027 tab (§8) — each coach's typical weekly hours, used with their hourly rate to project their annual cost |
| `Coaching_AcademyStaff` | `Hours/week` | Same as above, for academy staff |
| `MeetTeam_Meets` | `Room Hire` | Added 10 Sept — Matt confirmed meets can carry room-hire costs beyond gifts/catering; rolls into the Ledger's "Meet Costs" line alongside Gifts + Catering |
| `MeetTeam_Meets` | `Parking Permits` | Added 10 Sept — same reason, for parking permit costs at away meets |

`GeneralAdmin_Fields` already has its `Notes` column in your schema, so nothing to add there.

## 5. Judgement calls to double-check

1. **`Coaching_Fields`' "Employees Count" column holds a £ total, not a headcount.** The
   approved mockup's field was "Employees — annual salary total (£)"; your schema names the
   column "Employees Count". I kept the mockup's meaning (an annual cost figure) and just
   write it into that column, since the code reads/writes every column by its header text —
   if you'd rather it store a genuine headcount, or want the column renamed, say so and it's
   a one-line change (plus renaming the header in the Sheet).
2. **Admins can submit for every group, not just review.** The brief didn't say either way,
   so I gave Admin-role logins blanket access to all five submission forms (Treasurer-only
   logins are still gated by their `Groups` field, same as a plain Submitter). If you'd
   rather Admins only review, tell me and I'll change `userCanAccessGroup_` in `Code.gs`.
3. **A `Users` row's `Groups` field is matched loosely** (case/punctuation-insensitive
   against both the group's short id and its full name, e.g. "membership" or "Membership"
   both work) so small typos in the Sheet don't lock someone out. Worth a quick look at what
   you actually type into that column so it's not surprising.
4. **Resubmitting after "Changes Requested" clears the previous Reviewed By/At** (so it reads
   as freshly pending) but **keeps the previous Review Notes visible** until the next
   decision overwrites them, so the group can see what they were asked to fix. If you'd
   rather notes cleared immediately on resubmit, that's also a one-line change.
5. **Approving a submission still doesn't write anywhere by itself** — "Approved" just means
   it's eligible to be picked up next time someone recalculates the Master 2027 tab (§8),
   which is a separate, explicit step an Admin/Treasurer runs from the Review screen.

## 6. What's not built yet

- **Pay scale codes (CC1–CC4, AC1–AC3) are illustrative only.** They're a small hardcoded
  lookup in `Index.html`, same as the mockup — ClubHuB's real pay-scale table (`PayMatrix` tab
  on the ClubHuB Sheet) isn't wired up yet.
- **No email notifications** on submit, approve, or request-changes. Everyone currently finds
  out by checking the app.
- **No audit trail beyond the single "Reviewed By / Reviewed At / Review Notes" columns** — a
  second decision on the same submission overwrites the first rather than keeping history.
- **Pool & coach costs use a real but fixed weeks-per-month calendar (§8), not ClubHuB's live
  timetable.** More accurate for real usage (pulling actual booked hours per venue/coach from
  ClubHuB's `TimetableRules` tab) is a deliberate v2, not built now — see
  `claude/Assumptions-to-Ledger-Mapping.md` in the project for the full plan.
- **Coach Meet Expenses / Coach Meet Passes, and the other Manual lines listed in §8**, aren't
  sourced from any form — they're typed directly into the Master 2027 tab. Your own 2026
  working file has real, explained figures for all of them if you want a starting point.

## 7. If something looks wrong

Run `checkSetup` from the Apps Script editor's Run menu any time (see step 1.8) — it logs any
missing required tab, missing optional Baseline tab, or missing "extra" column from section 4
(this now includes the new `Hours/week` columns), without changing any data.

## 8. The Master 2027 budget tab — new, 10 Sept

The Review screen (Admin/Treasurer only) now has a **Master 2027 budget** panel above the
submissions queue, with two buttons:

- **Recalculate from Approved submissions** — runs `refreshMasterTab()`, which creates the
  `Master_2027` tab the first time (one row per real Ledger line item, columns Jan–Dec + FY,
  same shape as the workbook's own `2027` tab) and refreshes it any time after. It only ever
  overwrites its own **Auto**-sourced rows — anything you've typed into a **Manual** row is
  always preserved. Safe to click as often as you like; nothing is "live" until you publish.
- **Publish as live 2027 budget** — a separate, explicit step (`publishLiveBudget()`) that just
  stamps a status ("Live Budget Status", who, when) in the `Settings` tab. It doesn't lock the
  Master_2027 tab's cells — Sheets doesn't make that simple without protected ranges — so
  treat "Published" as a marker of intent for now, not a hard lock.

**What's Auto vs Manual, and why.** Only the five groups' *latest Approved* submission is used
per group (preferring one with Period = "Full Year" if there's more than one Approved). From
there:

- **Auto** (recalculated every time, don't hand-edit): Membership, Novice, Employees, HoA,
  Employer NI & Pension (Employees + HoA only, not contractors — confirmed), CPD, Kit
  investment, the 6 real venues' pool costs (rate × the real "weeks in month" calendar from
  your own 2026 Pool Hire tab — Aug = 0), Comp/Academy Coaches (rate × Hours/week × the same
  calendar), WSC Open Meets Income / Club Champs Income (split by whether a meet's name
  contains "champs"), Meet Pool Hire, **Coach Meet Costs** (each meet's own Coach Costs
  field — confirmed correct, 10 Sept) and **Meet Costs** (confirmed 10 Sept as "combined
  meet costs" — each meet's Gifts + Catering + Room Hire + Parking Permits added together;
  the latter two are new fields, added the same day, since meets can carry those costs too).
- **Manual** (type straight into the Master_2027 tab, always preserved): Other income,
  Clothing income, Spectator Fee, LT Equipment hire, Coach Meet Expenses, Coach Meet Passes,
  L1/L2 Coach Courses, Coach/Assistant Course, Lifeguard Course, S&C, Lifeguard Cover
  (Bishopsgate/WLC), ASA Volunteer Fees, Club Sundries/Software, Commit Swimming Software, IT,
  Arena Fees, BSBASA Fee, Trophies/Medals/Rosettes, Outside Services, Specialist Staff,
  Meeting Room Hire, Clothing (cost), Unplanned spend. All of these are real, explained
  figures already sitting in your 2026 working file — nothing here is inventing a number, it's
  just not pulled through automatically yet. You mentioned you'd flag any obvious ones that
  should move into a group's own form later — nothing to do on your end until then.
- **Computed** (subtotals — don't hand-edit): TOTAL INCOME, Total Pool Cost, Total
  Employee/Contractor Cost, Total Membership/Admin, TOTAL CASH OUT, NET CASH FLOW, Adjusted Net
  Cash Flow.

The full scoping — every real Ledger line item, where it comes from, and the open v2 ideas
(ClubHuB timetable integration, porting the mileage/per-diem model) — is written up in
`claude/Assumptions-to-Ledger-Mapping.md` in the project.
