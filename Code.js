/**
 * WSC Assumptions Collection — server-side code.
 *
 * Windsor Swimming Club, 2027 budget cycle. This is a STANDALONE Apps Script
 * project bound to its own Google Sheet (see SHEET_ID below) — it is a
 * separate project from ClubHuB, not a module inside it.
 *
 * Maker-checker workflow: five submitting groups (Meet Team, Pool & Venues,
 * Coaching & Staffing, Membership, General Admin) each file their own 2027
 * budget assumptions as a "Draft" they can keep editing, then "Submit" for
 * Treasurer/Admin review. A reviewer can Approve or Request changes with a
 * note.
 *
 * Approving a submission does NOT by itself update the master budget — see
 * the "Master 2027 tab" section below. An Admin/Treasurer runs
 * refreshMasterTab() (a button in the Review screen) whenever they want the
 * master tab recalculated from whatever's currently Approved, then
 * publishLiveBudget() once it's ready to be treated as the live 2027 budget.
 * Both are safe to re-run — refreshMasterTab() only ever overwrites its own
 * "Auto"-sourced rows; "Manual" rows (typed directly into the Master_2027
 * tab) are always preserved.
 *
 * Identity is NEVER trusted from the client. Every server function resolves
 * Session.getActiveUser().getEmail() itself, looks that email up in the
 * Users tab to find a Person ID, and looks the Person ID up in People —
 * exactly mirroring the "Users -> Person ID, never Email directly" pattern
 * already proven in the sister ClubHuB project.
 *
 * See BRIEFING.md for setup steps and the paste-ready Baseline_Squads /
 * Baseline_Venues data blocks.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

var SHEET_ID = '1VNBtb24dpbAJcpAtgQkuiheLZOLCXGVa8t7LY386dM4';

/**
 * Data-driven description of each of the 6 submitting groups: which tabs
 * back them, and how client-side field/row keys map onto real column
 * headers in the Sheet. All load/save logic below is generic and driven
 * entirely off this table, so adding a column is a one-line change here
 * (plus adding the column header in the Sheet itself).
 *
 * JUDGEMENT CALLS Matt should sanity-check — see BRIEFING.md for the full
 * list, but flagged here too since this is where they live in code:
 *
 * 1. RESOLVED 11 Sept — was: Coaching_Fields' "Employees Count" column held
 *    the SALARIED-EMPLOYEE ANNUAL COST TOTAL (£), not a headcount, a naming
 *    mismatch inherited from the approved mockup. Now moot: those 4 payroll
 *    fields (Employees/HoA/NI%/Pension%) moved off Coaching & Staffing
 *    entirely, onto the new `treasurer` group's own Treasurer_Fields sheet
 *    — Cameron (Head Coach) submits Coaching & Staffing and shouldn't be
 *    the one entering or seeing club payroll figures. Column is now called
 *    "Employees Annual Salary Total" there, matching what it actually
 *    holds.
 * 2. Several notes/detail fields from the mockup (away-meet notes,
 *    mid-year venue notes, CPD budget, staffing notes, membership outlook
 *    notes) don't have columns in the 12 tabs you specified, since those
 *    were designed around the numeric core. Rather than drop them from the
 *    UI, this code writes them into a few EXTRA columns appended to
 *    existing tabs (Away Meet Notes, CPD Budget, Staffing Notes, Notes) —
 *    listed in BRIEFING.md. If a column isn't there yet, saving that field
 *    is silently skipped (no crash) until you add it.
 * 3. Mid-year venue notes are stored once per submission by duplicating the
 *    same text into every PoolVenues row's Notes column for that
 *    Submission ID (read back from the first row) — simpler than adding a
 *    separate one-row-per-submission tab just for one note field.
 */
var GROUP_DEFS = {
  meets: {
    label: 'Meet Team',
    singleSheet: 'MeetTeam_Fields',
    singleFields: [
      // Novice Gala Count/Fee REMOVED 23 Sept — novice galas are now just rows in the
      // meets table below, auto-classified by name (like Club Champs already was).
      { key: 'away_meet_notes', col: 'Away Meet Notes', type: 'text' }, // EXTRA column — see note 2 above
      { key: 'trophies_medals_rosettes', col: 'Trophies Medals Rosettes', type: 'number' } // EXTRA column, moved in from Treasurer 23 Sept
    ],
    repeaters: [
      {
        rowsKey: 'meets',
        sheet: 'MeetTeam_Meets',
        columns: [
          { field: 'name', col: 'Meet Name', type: 'text' },
          { field: 'month', col: 'Month', type: 'text' },
          { field: 'income', col: 'Income', type: 'number' },
          { field: 'poolHire', col: 'Pool Hire', type: 'number' },
          { field: 'numCoaches', col: 'Number of Coaches', type: 'number' }, // EXTRA column, added 15 Sept — replaces the old free-typed Coach Costs figure
          { field: 'coachHours', col: 'Coach Hours', type: 'number' }, // EXTRA column, added 15 Sept — see NMW_RATE below
          { field: 'gifts', col: 'Gifts', type: 'number' },
          { field: 'catering', col: 'Catering', type: 'number' },
          { field: 'roomHire', col: 'Room Hire', type: 'number' }, // EXTRA column, added 10 Sept — see BRIEFING.md §4
          { field: 'parkingPermits', col: 'Parking Permits', type: 'number' } // EXTRA column, added 10 Sept
        ]
      }
    ]
  },
  venues: {
    label: 'Pool & Venues',
    singleSheet: null,
    singleFields: [],
    repeaters: [
      {
        rowsKey: 'venues',
        sheet: 'PoolVenues',
        columns: [
          { field: 'name', col: 'Venue', type: 'text' },
          { field: 'rate', col: 'Rate', type: 'number' },
          { field: 'unit', col: 'Rate Basis', type: 'text' },
          { field: 'inflation', col: 'Annual Inflation %', type: 'number' },
          { field: 'effectiveMonth', col: 'Inflation Effective Month', type: 'text' },
          { field: 'notes', col: 'Notes', type: 'text' }, // EXTRA column — see note 3 above
          // EXTRA column, added 23 Sept: confirmed real-world, every venue except WLC
          // doesn't train or pay in August (WEEKS_IN_MONTH's shared Aug=0), but WLC
          // does. Leave 0/blank to keep using the shared calendar's Aug value; a
          // venue that DOES train in August (WLC) gets its own real weeks figure here
          // instead. See computeMasterLines_ below.
          { field: 'augWeeksOverride', col: 'August Weeks (override)', type: 'number' }
        ]
      },
      // New repeater, added 23 Sept — lifeguards are technically staffing but are
      // provided by the pool operators, so Matt wanted them collected here rather
      // than on Coaching & Staffing. Not yet wired into a Ledger line (no dedicated
      // lifeguard-requirements cost line exists in the real Ledger) — collected for
      // now as assumptions data; see claude/Assumptions-to-Ledger-Mapping.md.
      {
        rowsKey: 'lifeguards',
        sheet: 'PoolVenues_Lifeguards',
        columns: [
          { field: 'venue', col: 'Venue', type: 'text' },
          { field: 'numLifeguards', col: 'Number of Lifeguards', type: 'number' },
          { field: 'rate', col: 'Rate', type: 'number' }
        ]
      }
    ]
  },
  staffing: {
    label: 'Coaching & Staffing',
    singleSheet: 'Coaching_Fields',
    singleFields: [
      // Employees/HoA/NI%/Pension% moved OUT to the new 'treasurer' group, 11 Sept —
      // Cameron (Head Coach) submits this group and shouldn't be the one entering
      // club payroll figures. See claude/Assumptions-to-Ledger-Mapping.md.
      // CPD Budget REMOVED 23 Sept — replaced by the 'development' repeater below,
      // which also absorbed L2/L1/Coach-Assistant/Lifeguard Course from Treasurer.
      { key: 'staffing_notes', col: 'Staffing Notes', type: 'text' } // EXTRA column
    ],
    repeaters: [
      {
        rowsKey: 'coaches_comp',
        sheet: 'Coaching_CompetitiveCoaches',
        columns: [
          { field: 'name', col: 'Name', type: 'text' },
          { field: 'payCode', col: 'Pay Scale Code', type: 'text' },
          { field: 'rate', col: 'Hourly Rate', type: 'number' },
          { field: 'hours', col: 'Hours/week', type: 'number' }, // EXTRA column, added 10 Sept for the master-tab build — see BRIEFING.md
          { field: 'notes', col: 'Notes', type: 'text' } // EXTRA column, added 23 Sept, e.g. "Assisting County Development"
        ]
      },
      {
        rowsKey: 'coaches_academy',
        sheet: 'Coaching_AcademyStaff',
        columns: [
          { field: 'name', col: 'Name', type: 'text' },
          { field: 'payCode', col: 'Pay Scale Code', type: 'text' },
          { field: 'rate', col: 'Hourly Rate', type: 'number' },
          { field: 'hours', col: 'Hours/week', type: 'number' }, // EXTRA column, added 10 Sept for the master-tab build — see BRIEFING.md
          { field: 'notes', col: 'Notes', type: 'text' } // EXTRA column, added 23 Sept
        ]
      },
      // New repeater, added 23 Sept, replacing the flat CPD Budget figure. Four rows
      // are fixed/hardcoded ('kind' = l2/l1/coachAssistant/lifeguard — these moved in
      // from Treasurer, 23 Sept, see claude/Assumptions-to-Ledger-Mapping.md) plus
      // any number of free-form 'other' rows the Head Coach adds (label is their own
      // typed name, e.g. a specific CPD course). Total = Number × Cost per course,
      // computed both client-side (live) and server-side (computeMasterLines_).
      {
        rowsKey: 'development',
        sheet: 'Coaching_Development',
        columns: [
          { field: 'kind', col: 'Kind', type: 'text' }, // 'l2' | 'l1' | 'coachAssistant' | 'lifeguard' | 'other'
          { field: 'label', col: 'Label', type: 'text' }, // only used/editable for kind = 'other'
          { field: 'number', col: 'Number', type: 'number' },
          { field: 'costPerCourse', col: 'Cost per course', type: 'number' }
        ]
      }
    ]
  },
  membership: {
    label: 'Membership',
    singleSheet: 'Membership_Discounts',
    singleFields: [
      // 2nd Child Discount REMOVED 23 Sept — confirmed it doesn't exist in reality,
      // only 3rd and 4th+ swimmers get a discount. "3rd+" split into separate 3rd
      // and 4th rate boxes since they can differ (50% / 100% as of 23 Sept).
      { key: 'discount_3rd_pct', col: '3rd Child Discount %', type: 'number' },
      { key: 'discount_4th_pct', col: '4th Child Discount %', type: 'number' }, // EXTRA column, added 23 Sept
      // EXTRA column, added 23 Sept — formalizes what used to happen implicitly via
      // "Staff (Free) Count" alone. Pre-filled 100 for a fresh submission (see
      // getMyGroupSubmission's fresh-start defaults) so existing behaviour doesn't
      // silently change unless someone edits it.
      { key: 'discount_staff_pct', col: 'Staff Discount %', type: 'number' },
      { key: 'membership_notes', col: 'Notes', type: 'text' } // EXTRA column
    ],
    repeaters: [
      {
        rowsKey: 'squads',
        sheet: 'Membership_Squads',
        columns: [
          { field: 'name', col: 'Squad Name', type: 'text' },
          { field: 'members', col: 'Members', type: 'number' },
          // Fee £/mo SPLIT 23 Sept into Training Fee + Membership Fee — discounts
          // apply to Training Fee only; Membership Fee is always charged in full.
          // Easier to amend either figure independently (Matt's own reasoning).
          { field: 'trainingFee', col: 'Training Fee £/mo', type: 'number' },
          { field: 'membershipFee', col: 'Membership Fee £/mo', type: 'number' }, // EXTRA column, added 23 Sept
          { field: 'third', col: '3rd Child Discount Count', type: 'number' },
          { field: 'fourth', col: '4th Child Discount Count', type: 'number' }, // EXTRA column, added 23 Sept
          { field: 'staff', col: 'Staff (Free) Count', type: 'number' },
          // Three new discount types, added 23 Sept — rates are HARDCODED constants
          // (see BOARDING_TERM_DISCOUNT_PCT etc. below), not editable boxes. Whoever
          // submits just enters a per-squad count.
          { field: 'boardingTerm', col: 'Term-Time Boarding Discount Count', type: 'number' }, // EXTRA column
          { field: 'boardingNonTerm', col: 'Non-Term-Time Boarding Discount Count', type: 'number' }, // EXTRA column
          { field: 'teacherCoach', col: 'Teacher/Coach Discount Count', type: 'number' } // EXTRA column
        ]
      }
    ]
  },
  admin: {
    label: 'General Admin',
    singleSheet: 'GeneralAdmin_Fields',
    singleFields: [
      // RESTRUCTURED 23 Sept — ASA Affiliation Fee replaced with rate × headcount
      // (real-world: ASA charges different rates for swimmers and volunteers).
      // Swimmer headcount is computed automatically from Membership's squad
      // totals; volunteer headcount is a new manual field since nothing tracks
      // that today. ASA Volunteer Fees moves in from Treasurer as part of this —
      // see computeMasterLines_ below.
      { key: 'asa_swimmer_rate', col: 'ASA Rate — Swimmer (£)', type: 'number' }, // EXTRA column
      { key: 'asa_volunteer_rate', col: 'ASA Rate — Volunteer (£)', type: 'number' }, // EXTRA column
      { key: 'volunteer_headcount', col: 'Volunteer Headcount', type: 'number' }, // EXTRA column
      // Software/Subscriptions and Kit Budget REMOVED 23 Sept — replaced by the
      // 'software' and 'kit' repeaters below (add-a-row line items instead of one
      // flat figure each).
      { key: 'admin_notes', col: 'Notes', type: 'text' }
    ],
    repeaters: [
      // New 23 Sept. Also fixes a latent gap: the old flat "Software/Subscriptions"
      // figure was never actually wired into any Ledger line — this repeater now
      // feeds 'Club Sundries Admin, Software' (moved off Treasurer to avoid the
      // two sources double-counting the same line — see
      // claude/Assumptions-to-Ledger-Mapping.md for the full reasoning).
      {
        rowsKey: 'software',
        sheet: 'GeneralAdmin_Software',
        columns: [
          { field: 'name', col: 'Name', type: 'text' },
          { field: 'cost', col: 'Cost', type: 'number' }
        ]
      },
      // New 23 Sept, replacing the flat Kit Budget figure. Pre-seeded with
      // Staff/Volunteers/Finals as starting example categories (see
      // getMyGroupSubmission's fresh-start defaults) — more can be added.
      {
        rowsKey: 'kit',
        sheet: 'GeneralAdmin_Kit',
        columns: [
          { field: 'category', col: 'Category', type: 'text' },
          { field: 'cost', col: 'Cost', type: 'number' }
        ]
      }
    ]
  },
  // Added 11 Sept — houses club payroll (moved out of Coaching & Staffing, since
  // Cameron submits that group and shouldn't see/enter salary figures) plus the
  // ~24 Ledger lines that previously had no submitting group at all and were only
  // ever typed straight into the Master_2027 tab. Each is a flat annual £ figure,
  // split evenly across months by computeMasterLines_ — same pattern as CPD/Kit
  // investment. "Unplanned spend (logged)" deliberately stays OUT of this group —
  // it's actual spend being logged against the budget, not a planned assumption,
  // so it stays as direct Master_2027 editing. Access is via the Groups column on
  // the Treasurer's own Users row, same as every other group — see
  // userCanAccessGroup_(). See claude/Assumptions-to-Ledger-Mapping.md for the
  // full reasoning and the flat-annual-vs-monthly-grid judgement call (flat
  // annual chosen, 11 Sept).
  treasurer: {
    label: 'Treasurer',
    singleSheet: 'Treasurer_Fields',
    singleFields: [
      { key: 'employees_cost', col: 'Employees Annual Salary Total', type: 'number' },
      { key: 'hoa_salary', col: 'Head of Academy Salary', type: 'number' },
      { key: 'ni_pct', col: 'NI %', type: 'number' },
      { key: 'pension_pct', col: 'Pension %', type: 'number' },
      { key: 'other_income', col: 'Other Income', type: 'number' },
      { key: 'clothing_income', col: 'Clothing Income', type: 'number' },
      { key: 'spectator_fee', col: 'Spectator Fee', type: 'number' },
      { key: 'lt_equipment_hire', col: 'LT Equipment Hire', type: 'number' },
      { key: 'coach_meet_expenses', col: 'Coach Meet Expenses', type: 'number' },
      { key: 'coach_meet_passes', col: 'Coach Meet Passes', type: 'number' },
      // l2/l1/coach-assistant/lifeguard course fields MOVED to Coaching & Staffing
      // (development repeater) 23 Sept — see GROUP_DEFS.staffing and
      // claude/Assumptions-to-Ledger-Mapping.md, "Update, 23 Sept (part 4)".
      { key: 'sc_cost', col: 'S&C', type: 'number' },
      { key: 'lifeguard_cover_bishopsgate', col: 'Lifeguard Cover Bishopsgate', type: 'number' },
      { key: 'lifeguard_cover_wlc', col: 'Lifeguard Cover WLC', type: 'number' },
      // asa_volunteer_fees MOVED to General Admin (asa_volunteer_rate × volunteer_headcount) 23 Sept.
      // club_sundries_software MOVED to General Admin ('software' repeater) 23 Sept.
      { key: 'commit_swimming_software', col: 'Commit Swimming Software', type: 'number' },
      { key: 'it_cost', col: 'IT', type: 'number' },
      { key: 'arena_fees', col: 'Arena Fees', type: 'number' },
      { key: 'bsbasa_fee', col: 'BSBASA Fee', type: 'number' },
      // trophies_medals_rosettes MOVED to Meet Team 23 Sept.
      { key: 'outside_services', col: 'Outside Services', type: 'number' },
      { key: 'specialist_staff', col: 'Specialist Staff', type: 'number' },
      { key: 'meeting_room_hire', col: 'Meeting Room Hire', type: 'number' },
      { key: 'clothing_cost', col: 'Clothing', type: 'number' },
      { key: 'treasurer_notes', col: 'Notes', type: 'text' }
    ],
    repeaters: []
  }
};

var REQUIRED_TABS = [
  'Settings', 'People', 'Users', 'Submissions',
  'MeetTeam_Fields', 'MeetTeam_Meets', 'PoolVenues',
  'Coaching_Fields', 'Coaching_CompetitiveCoaches', 'Coaching_AcademyStaff',
  'Membership_Squads', 'Membership_Discounts', 'GeneralAdmin_Fields',
  'Treasurer_Fields', // added 11 Sept for the new Treasurer group — see GROUP_DEFS
  // added 23 Sept for the full form review restructure — see GROUP_DEFS and
  // claude/Assumptions-to-Ledger-Mapping.md, "Update, 23 Sept (part 4)"
  'PoolVenues_Lifeguards', 'Coaching_Development', 'GeneralAdmin_Software', 'GeneralAdmin_Kit'
];

var OPTIONAL_TABS = ['Baseline_Squads', 'Baseline_Venues'];

// ---------------------------------------------------------------------------
// Master 2027 tab — config
// ---------------------------------------------------------------------------
//
// Rolls the five groups' latest APPROVED submissions up into one tab shaped
// exactly like the real Ledger's own '2027' tab (same line items, same
// month columns), so the Ledger can eventually be rebuilt to read live from
// here instead of a static workbook snapshot. See
// claude/Assumptions-to-Ledger-Mapping.md in the project for the full
// scoping and the judgement calls below.
//
// Each line is "auto" (recalculated every refreshMasterTab() run from
// Approved submissions — never hand-edit these, they'll be overwritten),
// "manual" (Matt/Treasurer types the figure straight into the Master_2027
// tab — refreshMasterTab() always preserves whatever's there), or "total"
// (recomputed by summing its category, or — for the Summary category — by
// combining the category totals; never hand-edit these either).
//
// JUDGEMENT CALLS baked into computeMasterLines_() below, confirmed with
// Matt 10 Sept except where marked:
// 1. Employer NI & Pension applies to Employees + HoA only, not contractors
//    (matches how UK payroll actually works — confirmed).
// 2. Pool costs use the real "weeks in month" calendar from the treasurer's
//    own Pool Hire tab (Aug = 0, term-time weighted) rather than a flat
//    1/12 split — confirmed as the v1 approach; a v2 could instead pull
//    real booked hours from ClubHuB's TimetableRules for full accuracy.
// 3. Coach Meet Costs is AUTO — Number of Coaches × Coach Hours × NMW_RATE,
//    from each meet's own two fields on the MEET TEAM form (confirmed 15
//    Sept, replacing a single typed-in £ figure). Applies the same for
//    every meet, home or away. Coach Meet Expenses / Coach Meet Passes are
//    a different thing (mileage/accommodation/per-diem, not per-meet coach
//    pay) and now live as flat annual figures on the Treasurer group
//    (11 Sept) — see item 6 below.
// 4. Meet Costs is AUTO — confirmed by Matt, 10 Sept, as "combined meet
//    costs" — read as each meet's Gifts + Catering + Room Hire + Parking
//    Permits added together. The latter two are new fields (added 10 Sept,
//    per Matt's flag that meets can also carry venue room-hire and parking
//    permit costs beyond gifts/catering) — see GROUP_DEFS above and
//    BRIEFING.md §4 for the two new "extra" columns to add to the Sheet.
//    Confirmed 11 Sept: these four fields only ever apply to meets Windsor
//    hosts — away/external meets simply get £0 in all four, no separate
//    home/away flag needed (Coach Costs is the only field that's non-zero
//    for an away meet).
// 5. Comp/Academy Coaches costs need the new Hours/week field (see
//    GROUP_DEFS above) — a coach row with no hours entered contributes £0,
//    it won't error. Confirmed 11 Sept: Hours/week is the coach's real paid
//    time block, not summed per squad — a coach covering several squads at
//    once in one session still logs that session's actual length once, not
//    once per squad. See the mapping doc's V2 section for the matching
//    gotcha once hours are ever pulled from ClubHuB's TimetableRules
//    automatically instead of typed in by hand.
// 6. RESOLVED 11 Sept — was: ~20 lines stayed "manual" (ASA Volunteer Fees,
//    IT, Trophies/Medals/Rosettes, course costs, etc.), typed straight into
//    Master_2027 with no submitting group. Now AUTO, sourced from the new
//    `treasurer` group as flat annual figures (split ÷12, same pattern as
//    CPD/Kit investment) — see the TREASURER_LINE_MAP block below and
//    claude/Assumptions-to-Ledger-Mapping.md. Chosen over a per-line
//    monthly grid to keep the form simple; the trade-off is these lines
//    lose whatever real month-to-month shape they had when typed directly
//    into Master_2027 (e.g. Trophies concentrated around gala season) —
//    flagged to Matt, accepted. "Unplanned spend (logged)" deliberately
//    stays manual/direct-edit — it's logged actual spend, not a plan
//    assumption.
//
// Six groups' LATEST APPROVED submission is used per group (five plus the
// new Treasurer group, 11 Sept), preferring one with Period = "Full Year"
// if more than one Approved submission exists (a v1 simplification —
// quarterly resubmissions aren't merged/diffed yet, see BRIEFING.md).

var MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Real training-weeks-per-month pattern from the treasurer's own Pool Hire
// tab (2026 working file) — Aug = 0 (pools closed), otherwise term-time
// weighted. Used for both pool-venue and coach-contractor cost spreading.
var WEEKS_IN_MONTH = [4.142857143, 4, 4.428571429, 3.714285714, 4.142857143, 4.285714286, 4.428571429, 0, 4.285714286, 4.428571429, 4.285714286, 3];

// National Minimum Wage (21+ rate), used as the default per-hour rate for meet-day coach
// cover — added 15 Sept, confirmed by Matt: a meet's Coach Meet Costs is Number of Coaches
// × Coach Hours × this rate, rather than a single typed-in £ figure per meet. NMW normally
// rises each April — re-check and update this figure ahead of the 2027 season.
var NMW_RATE = 12.71;

// Hardcoded discount rates (% off Training Fee), added 23 Sept — confirmed real
// club policy, not editable via the form (unlike 3rd/4th/Staff, which are rate
// boxes on Membership_Discounts). See claude/Assumptions-to-Ledger-Mapping.md.
var BOARDING_TERM_DISCOUNT_PCT = 37; // Term-Time Only Boarding School Swimmer (pays 63%)
var BOARDING_NONTERM_DISCOUNT_PCT = 70; // Non-Term-Time Boarding School & University Swimmer (pays 30%)
var TEACHER_COACH_DISCOUNT_PCT = 100; // Teacher/Coach Discount for Masters Squad

var MASTER_TAB_NAME = 'Master_2027';

// Exact labels the real Ledger uses for its 6 pool venues (Bishopsgate is
// ClubHuB's "Bishopsgate" + "Bishopsgate Pool" combined — confirmed 10
// Sept). Baseline_Venues should use these exact names as its "Venue"
// column so a Pool & Venues submission's rows match up automatically.
var MASTER_VENUE_LABELS = ['Aldershot', 'Athens', 'Bishopsgate', 'Heathfield', 'WLC', 'BLC'];

// Mirrors the real Ledger's '2027' tab line-by-line, in the same order.
var MASTER_LINE_ORDER = [
  { label: 'Membership', category: 'Income', kind: 'auto' },
  { label: 'WSC Open Meets Income', category: 'Income', kind: 'auto' },
  { label: 'Club Champs Income', category: 'Income', kind: 'auto' },
  { label: 'Novice', category: 'Income', kind: 'auto' },
  { label: 'Other', category: 'Income', kind: 'auto' }, // now Treasurer group, 11 Sept
  { label: 'Clothing income', category: 'Income', kind: 'auto' }, // now Treasurer group, 11 Sept
  { label: 'Spectator Fee', category: 'Income', kind: 'auto' }, // now Treasurer group, 11 Sept
  { label: 'TOTAL INCOME', category: 'Income', kind: 'total' },

  { label: 'Aldershot', category: 'Pool Costs', kind: 'auto' },
  { label: 'Athens', category: 'Pool Costs', kind: 'auto' },
  { label: 'Bishopsgate', category: 'Pool Costs', kind: 'auto' },
  { label: 'Heathfield', category: 'Pool Costs', kind: 'auto' },
  { label: 'WLC', category: 'Pool Costs', kind: 'auto' },
  { label: 'BLC', category: 'Pool Costs', kind: 'auto' },
  { label: 'LT Equipment hire', category: 'Pool Costs', kind: 'auto' }, // now Treasurer group, 11 Sept
  { label: 'Total Pool Cost', category: 'Pool Costs', kind: 'total' },

  { label: 'Employees', category: 'Staff/Contractor Costs', kind: 'auto' },
  { label: 'HoA', category: 'Staff/Contractor Costs', kind: 'auto' },
  { label: 'Employer NI & Pension', category: 'Staff/Contractor Costs', kind: 'auto' },
  { label: 'Comp Coaches (Contractor)', category: 'Staff/Contractor Costs', kind: 'auto' },
  { label: 'Academy Coaches (Contractor)', category: 'Staff/Contractor Costs', kind: 'auto' },
  { label: 'Coach Meet Costs', category: 'Staff/Contractor Costs', kind: 'auto' },
  { label: 'Coach Meet Expenses', category: 'Staff/Contractor Costs', kind: 'auto' }, // now Treasurer group, 11 Sept
  { label: 'Coach Meet Passes', category: 'Staff/Contractor Costs', kind: 'auto' }, // now Treasurer group, 11 Sept
  { label: 'CPD', category: 'Staff/Contractor Costs', kind: 'auto' }, // now Coaching & Staffing group ('other' rows in the Development table), 23 Sept
  { label: 'L2 Coach Courses', category: 'Staff/Contractor Costs', kind: 'auto' }, // now Coaching & Staffing group (Development table), 23 Sept (was Treasurer, 11 Sept)
  { label: 'L1 Coach Course', category: 'Staff/Contractor Costs', kind: 'auto' }, // now Coaching & Staffing group (Development table), 23 Sept (was Treasurer, 11 Sept)
  { label: 'Coach/Assistant Course', category: 'Staff/Contractor Costs', kind: 'auto' }, // now Coaching & Staffing group (Development table), 23 Sept (was Treasurer, 11 Sept)
  { label: 'Lifeguard Course', category: 'Staff/Contractor Costs', kind: 'auto' }, // now Coaching & Staffing group (Development table), 23 Sept (was Treasurer, 11 Sept)
  { label: 'S&C', category: 'Staff/Contractor Costs', kind: 'auto' }, // now Treasurer group, 11 Sept
  { label: 'Lifeguard Cover Bishopsgate', category: 'Staff/Contractor Costs', kind: 'auto' }, // now Treasurer group, 11 Sept
  { label: 'Lifeguard Cover WLC', category: 'Staff/Contractor Costs', kind: 'auto' }, // now Treasurer group, 11 Sept
  { label: 'Total Employee/Contractor Cost', category: 'Staff/Contractor Costs', kind: 'total' },

  { label: 'ASA', category: 'Membership/Admin', kind: 'auto' }, // now General Admin group (rate × swimmer headcount), 23 Sept
  { label: 'ASA Volunteer Fees', category: 'Membership/Admin', kind: 'auto' }, // now General Admin group (rate × volunteer headcount), 23 Sept (was Treasurer, 11 Sept)
  { label: 'Meet Pool Hire', category: 'Membership/Admin', kind: 'auto' },
  { label: 'Meet Costs', category: 'Membership/Admin', kind: 'auto' },
  { label: 'Club Sundries Admin, Software', category: 'Membership/Admin', kind: 'auto' }, // now General Admin group ('software' repeater), 23 Sept (was Treasurer, 11 Sept)
  { label: 'Commit Swimming Software', category: 'Membership/Admin', kind: 'auto' }, // now Treasurer group, 11 Sept
  { label: 'IT', category: 'Membership/Admin', kind: 'auto' }, // now Treasurer group, 11 Sept
  { label: 'Arena Fees', category: 'Membership/Admin', kind: 'auto' }, // now Treasurer group, 11 Sept
  { label: 'BSBASA Fee', category: 'Membership/Admin', kind: 'auto' }, // now Treasurer group, 11 Sept
  { label: 'Trophies, Medals, Rosettes', category: 'Membership/Admin', kind: 'auto' }, // now Meet Team group, 23 Sept (was Treasurer, 11 Sept)
  { label: 'Outside Services', category: 'Membership/Admin', kind: 'auto' }, // now Treasurer group, 11 Sept
  { label: 'Kit investment', category: 'Membership/Admin', kind: 'auto' },
  { label: 'Specialist Staff (Nutrition, Psychologist)', category: 'Membership/Admin', kind: 'auto' }, // now Treasurer group, 11 Sept
  { label: 'Meeting Room Hire', category: 'Membership/Admin', kind: 'auto' }, // now Treasurer group, 11 Sept
  { label: 'Clothing', category: 'Membership/Admin', kind: 'auto' }, // now Treasurer group, 11 Sept
  { label: 'Total Membership/Admin', category: 'Membership/Admin', kind: 'total' },

  { label: 'TOTAL CASH OUT', category: 'Summary', kind: 'total' },
  { label: 'NET CASH FLOW', category: 'Summary', kind: 'total' },
  { label: 'Unplanned spend (logged)', category: 'Summary', kind: 'manual' }, // deliberately stays manual/direct-edit — it's logged actual spend, not a Treasurer-group assumption (confirmed 11 Sept)
  { label: 'Adjusted Net Cash Flow (incl. unplanned spend)', category: 'Summary', kind: 'total' }
];

// ---------------------------------------------------------------------------
// Web app entry point
// ---------------------------------------------------------------------------

function doGet(e) {
  var template = HtmlService.createTemplateFromFile('Index');
  return template.evaluate()
    .setTitle('WSC 2027 Assumptions Collection')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ---------------------------------------------------------------------------
// Spreadsheet plumbing
// ---------------------------------------------------------------------------

var _ssCache_ = null;

function getSpreadsheet_() {
  if (!_ssCache_) _ssCache_ = SpreadsheetApp.openById(SHEET_ID);
  return _ssCache_;
}

function getSheetOrThrow_(name) {
  var sh = getSpreadsheet_().getSheetByName(name);
  if (!sh) throw new Error('Missing expected tab "' + name + '" — check the Sheet matches the schema in BRIEFING.md.');
  return sh;
}

function getSheetOptional_(name) {
  return getSpreadsheet_().getSheetByName(name); // may be null — callers must handle that
}

function headerMap_(sheet) {
  var lastCol = sheet.getLastColumn();
  var map = {};
  if (lastCol === 0) return map;
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  for (var i = 0; i < headers.length; i++) {
    var h = String(headers[i] || '').trim();
    if (h) map[h] = i + 1; // 1-based column index
  }
  return map;
}

/**
 * Converts a raw cell value for safe return to the client. Sheets silently
 * turns recognisable date/time strings into JS Date objects on read — an
 * unconverted Date crossing google.script.run can hang or come back null,
 * so every Date is formatted to a plain string here first.
 */
function normalizeCellValue_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  }
  return v;
}

function getRowsAsObjects_(sheet) {
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol === 0) return [];
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h || '').trim(); });
  var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  return values.map(function (row, idx) {
    var obj = { __row: idx + 2 };
    for (var i = 0; i < headers.length; i++) {
      if (headers[i]) obj[headers[i]] = normalizeCellValue_(row[i]);
    }
    return obj;
  });
}

function findRowById_(sheet, idHeader, idValue) {
  var rows = getRowsAsObjects_(sheet);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][idHeader]) === String(idValue)) return rows[i];
  }
  return null;
}

function findRowsById_(sheet, idHeader, idValue) {
  return getRowsAsObjects_(sheet).filter(function (r) { return String(r[idHeader]) === String(idValue); });
}

/**
 * Updates the row matching idValue (preserving any columns not named in
 * dataObj), or appends a new row if none exists. Unknown column names in
 * dataObj are silently skipped — this is what lets an EXTRA column (see
 * GROUP_DEFS comment) fail gracefully if Matt hasn't added it to the Sheet
 * yet, instead of crashing the save.
 */
function upsertRowById_(sheet, idHeader, idValue, dataObj) {
  var map = headerMap_(sheet);
  var lastCol = sheet.getLastColumn();
  var existing = findRowById_(sheet, idHeader, idValue);
  var rowArr = new Array(lastCol).fill('');
  if (existing) {
    var existingVals = sheet.getRange(existing.__row, 1, 1, lastCol).getValues()[0];
    for (var i = 0; i < lastCol; i++) rowArr[i] = existingVals[i];
  }
  Object.keys(dataObj).forEach(function (key) {
    var col = map[key];
    if (col) rowArr[col - 1] = dataObj[key];
  });
  if (existing) {
    sheet.getRange(existing.__row, 1, 1, lastCol).setValues([rowArr]);
  } else {
    sheet.appendRow(rowArr);
  }
}

function deleteRowsById_(sheet, idHeader, idValue) {
  var map = headerMap_(sheet);
  var idCol = map[idHeader];
  if (!idCol) return;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  var idValues = sheet.getRange(2, idCol, lastRow - 1, 1).getValues();
  for (var i = idValues.length - 1; i >= 0; i--) {
    if (String(idValues[i][0]) === String(idValue)) sheet.deleteRow(i + 2);
  }
}

function appendRows_(sheet, objArray) {
  if (!objArray.length) return;
  var map = headerMap_(sheet);
  var lastCol = sheet.getLastColumn();
  var rows = objArray.map(function (obj) {
    var arr = new Array(lastCol).fill('');
    Object.keys(obj).forEach(function (key) {
      var col = map[key];
      if (col) arr[col - 1] = obj[key];
    });
    return arr;
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, lastCol).setValues(rows);
}

function normalizeOutgoing_(value, type) {
  if (value === undefined || value === null) return type === 'number' ? 0 : '';
  if (type === 'number') {
    var n = Number(value);
    return isNaN(n) ? 0 : n;
  }
  return String(value);
}

/**
 * Scans idHeader for the highest numeric suffix actually in use after
 * prefix and returns prefix + that number + 1, zero-padded to 4 digits
 * (e.g. "A0001"). Scanning current rows (rather than using row count)
 * avoids collisions if rows are ever deleted.
 */
function getNextSequentialId_(sheet, idHeader, prefix) {
  var rows = getRowsAsObjects_(sheet);
  var max = 0;
  rows.forEach(function (r) {
    var v = String(r[idHeader] || '');
    if (v.indexOf(prefix) === 0) {
      var n = parseInt(v.slice(prefix.length), 10);
      if (!isNaN(n) && n > max) max = n;
    }
  });
  var next = max + 1;
  var padded = String(next);
  while (padded.length < 4) padded = '0' + padded;
  return prefix + padded;
}

// ---------------------------------------------------------------------------
// Identity / access control
// ---------------------------------------------------------------------------

/**
 * Resolves the caller's identity: Session email -> Users row (Person ID,
 * Role, Groups) -> People row (Name, Status). Never trusts anything the
 * client claims about who it is.
 */
function getUserContext_() {
  var email = '';
  try { email = (Session.getActiveUser().getEmail() || '').trim().toLowerCase(); } catch (err) { email = ''; }
  if (!email) {
    return { ok: false, error: 'We could not determine your Google identity. Make sure you are signed in with your club Google account and try reloading.' };
  }

  var usersSheet = getSheetOrThrow_('Users');
  var userRow = null;
  var userRows = getRowsAsObjects_(usersSheet);
  for (var i = 0; i < userRows.length; i++) {
    if (String(userRows[i]['Email'] || '').trim().toLowerCase() === email) { userRow = userRows[i]; break; }
  }
  if (!userRow) {
    return { ok: false, error: 'The email ' + email + ' is not set up in the Users tab. Ask the Treasurer to add you.' };
  }
  if (String(userRow['Status'] || '').trim().toLowerCase() !== 'active') {
    return { ok: false, error: 'Your account (' + email + ') is marked inactive in the Users tab. Contact the Treasurer.' };
  }

  var personId = String(userRow['Person ID'] || '').trim();
  if (!personId) {
    return { ok: false, error: 'Your Users row (' + email + ') has no Person ID set. Ask the Treasurer to fix this.' };
  }

  var peopleSheet = getSheetOrThrow_('People');
  var personRow = findRowById_(peopleSheet, 'Person ID', personId);
  if (!personRow) {
    return { ok: false, error: 'Person ID ' + personId + ' (from your Users row) was not found in the People tab.' };
  }
  if (String(personRow['Status'] || '').trim().toLowerCase() !== 'active') {
    return { ok: false, error: (personRow['Name'] || personId) + ' is marked inactive in the People tab.' };
  }

  var roles = String(userRow['Role'] || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  var rolesLower = roles.map(function (r) { return r.toLowerCase(); });
  var groupsRaw = String(userRow['Groups'] || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  var isReviewer = rolesLower.indexOf('admin') !== -1 || rolesLower.indexOf('treasurer') !== -1;
  var isAdmin = rolesLower.indexOf('admin') !== -1;

  return {
    ok: true,
    email: email,
    personId: personId,
    name: personRow['Name'] || email,
    roles: roles,
    groupsRaw: groupsRaw,
    isReviewer: isReviewer,
    isAdmin: isAdmin
  };
}

function requireUserContext_() {
  var ctx = getUserContext_();
  if (!ctx.ok) throw new Error(ctx.error);
  return ctx;
}

function normalizeGroupText_(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Admins can access every submit-form (they manage the whole system).
 * Everyone else is gated purely by the Groups column on their own Users
 * row, matched against either the group's id ("membership") or its
 * display label ("Membership") so small formatting differences in the
 * Sheet don't lock someone out.
 * JUDGEMENT CALL: giving Admin blanket submit access isn't spelled out in
 * the brief — flag this to Matt to confirm it's what he wants.
 */
function userCanAccessGroup_(ctx, groupId) {
  if (ctx.isAdmin) return true;
  var def = GROUP_DEFS[groupId];
  if (!def) return false;
  var wantedLabel = normalizeGroupText_(def.label);
  var wantedId = normalizeGroupText_(groupId);
  return ctx.groupsRaw.some(function (g) {
    var n = normalizeGroupText_(g);
    return n === wantedLabel || n === wantedId;
  });
}

function groupIdFromLabel_(label) {
  var found = null;
  Object.keys(GROUP_DEFS).forEach(function (gid) {
    if (GROUP_DEFS[gid].label === label) found = gid;
  });
  return found;
}

function getPeopleById_() {
  var sh = getSheetOrThrow_('People');
  var rows = getRowsAsObjects_(sh);
  var map = {};
  rows.forEach(function (r) {
    map[String(r['Person ID'] || '').trim()] = { name: r['Name'], status: r['Status'] };
  });
  return map;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function readSettings_() {
  var sh = getSheetOrThrow_('Settings');
  var lastRow = sh.getLastRow();
  var map = {};
  if (lastRow >= 2) {
    var values = sh.getRange(2, 1, lastRow - 1, 2).getValues(); // Key, Value
    values.forEach(function (row) {
      var key = String(row[0] || '').trim();
      if (key) map[key] = row[1];
    });
  }
  var enforceRaw = String(map['Enforce Segregation of Duties'] || 'No').trim().toLowerCase();

  var deadline = '';
  var rawDeadline = map['Submission Deadline'];
  if (rawDeadline) {
    if (Object.prototype.toString.call(rawDeadline) === '[object Date]') {
      deadline = Utilities.formatDate(rawDeadline, Session.getScriptTimeZone(), 'd MMMM yyyy');
    } else if (String(rawDeadline).trim()) {
      deadline = String(rawDeadline).trim();
    }
  }

  function formatDateSetting_(raw) {
    if (!raw) return '';
    if (Object.prototype.toString.call(raw) === '[object Date]') {
      return Utilities.formatDate(raw, Session.getScriptTimeZone(), 'd MMM yyyy HH:mm');
    }
    return String(raw).trim();
  }

  return {
    year: map['Current Assumptions Year'] ? String(map['Current Assumptions Year']) : '',
    deadline: deadline,
    enforceSoD: (enforceRaw === 'yes' || enforceRaw === 'true'),
    masterLastRefreshedAt: formatDateSetting_(map['Master Tab Last Refreshed']),
    masterLastRefreshedBy: String(map['Master Tab Last Refreshed By'] || '').trim(),
    liveBudgetStatus: map['Live Budget Status'] ? String(map['Live Budget Status']).trim() : 'Draft',
    livePublishedBy: String(map['Live Budget Published By'] || '').trim(),
    livePublishedAt: formatDateSetting_(map['Live Budget Published At'])
  };
}

// ---------------------------------------------------------------------------
// Baseline readers (Membership / Pool & Venues pre-fill — "living data")
// ---------------------------------------------------------------------------

function getBaselineSquads_() {
  var sh = getSheetOptional_('Baseline_Squads');
  if (!sh) return [];
  return getRowsAsObjects_(sh).map(function (r) {
    return {
      name: String(r['Squad Name'] || ''),
      cat: String(r['Category'] || ''),
      members: Number(r['Members'] || 0),
      fee: Number(r['Fee £/mo'] || 0)
    };
  }).filter(function (s) { return s.name; });
}

function getBaselineVenues_() {
  var sh = getSheetOptional_('Baseline_Venues');
  if (!sh) return [];
  return getRowsAsObjects_(sh).map(function (r) {
    return {
      name: String(r['Venue'] || ''),
      unit: String(r['Rate Basis'] || ''),
      rate: Number(r['Rate'] || 0),
      inflation: Number(r['Annual Inflation %'] || 0)
    };
  }).filter(function (v) { return v.name; });
}

// ---------------------------------------------------------------------------
// Submission read/write (generic, driven by GROUP_DEFS)
// ---------------------------------------------------------------------------

/** Latest non-Approved submission for this group/period/person — the one still open for editing. */
function findEditableSubmission_(subSheet, groupLabel, period, personId) {
  var rows = getRowsAsObjects_(subSheet);
  var candidates = rows.filter(function (r) {
    return String(r['Group']) === groupLabel &&
      String(r['Period']) === period &&
      String(r['Submitted By']) === personId &&
      String(r['Status']) !== 'Approved';
  });
  if (!candidates.length) return null;
  candidates.sort(function (a, b) { return String(b['Submitted At']).localeCompare(String(a['Submitted At'])); });
  return candidates[0];
}

/**
 * Loads the current user's own in-progress/submitted data for one group +
 * period so reopening a group does NOT wipe it (a known bug in the old
 * mockup, where all state was client-side only). If nothing editable
 * exists yet, returns fresh defaults — pre-filled from Baseline_Squads /
 * Baseline_Venues for those two groups.
 */
function getMyGroupSubmission(groupId, period) {
  var ctx = requireUserContext_();
  var def = GROUP_DEFS[groupId];
  if (!def) throw new Error('Unknown group: ' + groupId);
  if (!userCanAccessGroup_(ctx, groupId)) throw new Error('You do not have access to submit for ' + def.label + '.');

  var subSheet = getSheetOrThrow_('Submissions');
  var existing = findEditableSubmission_(subSheet, def.label, period, ctx.personId);

  var result = { groupId: groupId, period: period, submissionId: null, status: null, reviewNotes: '', values: {}, rows: {} };
  def.repeaters.forEach(function (rep) { result.rows[rep.rowsKey] = []; });

  if (existing) {
    result.submissionId = existing['Submission ID'];
    result.status = existing['Status'];
    result.reviewNotes = existing['Review Notes'] || '';

    if (def.singleSheet) {
      var singleSheet = getSheetOrThrow_(def.singleSheet);
      var singleRow = findRowById_(singleSheet, 'Submission ID', result.submissionId);
      if (singleRow) {
        def.singleFields.forEach(function (f) { result.values[f.key] = singleRow[f.col]; });
      }
    }
    def.repeaters.forEach(function (rep) {
      var repSheet = getSheetOrThrow_(rep.sheet);
      var repRows = findRowsById_(repSheet, 'Submission ID', result.submissionId);
      result.rows[rep.rowsKey] = repRows.map(function (row) {
        var o = {};
        rep.columns.forEach(function (c) { o[c.field] = row[c.col]; });
        return o;
      });
    });
  } else {
    // Fresh start — pre-fill from baseline / sensible defaults.
    if (groupId === 'membership') {
      // Fee split 23 Sept: baseline only ever had one combined "fee" figure, so it
      // seeds Training Fee and leaves Membership Fee at 0 for the Treasurer/HC to
      // fill in — see claude/Assumptions-to-Ledger-Mapping.md.
      result.rows.squads = getBaselineSquads_().map(function (s) {
        return {
          name: s.name, cat: s.cat, members: s.members,
          trainingFee: s.fee, membershipFee: 0,
          third: 0, fourth: 0, staff: 0,
          boardingTerm: 0, boardingNonTerm: 0, teacherCoach: 0
        };
      });
      // Staff Discount % defaults to 100 on a fresh submission so behaviour doesn't
      // silently change from today's fully-free-staff treatment unless edited.
      result.values.discount_staff_pct = 100;
    }
    if (groupId === 'venues') {
      result.rows.venues = getBaselineVenues_().map(function (v) {
        return { name: v.name, unit: v.unit, rate: v.rate, inflation: v.inflation, effectiveMonth: 'Jan', notes: '', augWeeksOverride: 0 };
      });
      // Lifeguard requirements, added 23 Sept — seeded with the same venue list so
      // it's a fill-in-the-numbers exercise rather than starting from a blank table.
      result.rows.lifeguards = getBaselineVenues_().map(function (v) {
        return { venue: v.name, numLifeguards: 0, rate: 0 };
      });
    }
    if (groupId === 'meets') {
      result.rows.meets = [1, 2, 3].map(function (i) {
        return { name: 'Meet ' + i, month: '', income: 0, poolHire: 0, numCoaches: 0, coachHours: 0, gifts: 0, catering: 0, roomHire: 0, parkingPermits: 0 };
      });
    }
    if (groupId === 'staffing') {
      result.rows.coaches_comp = [];
      result.rows.coaches_academy = [];
      // Development table, added 23 Sept — 4 fixed rows (moved in from Treasurer)
      // plus the Head Coach adds any 'other' rows themselves.
      result.rows.development = [
        { kind: 'l2', label: '', number: 0, costPerCourse: 0 },
        { kind: 'l1', label: '', number: 0, costPerCourse: 0 },
        { kind: 'coachAssistant', label: '', number: 0, costPerCourse: 0 },
        { kind: 'lifeguard', label: '', number: 0, costPerCourse: 0 }
      ];
    }
    if (groupId === 'admin') {
      // Kit table, added 23 Sept — pre-seeded with the three categories Matt named
      // (Staff/Volunteers/Finals) as a starting point; more rows can be added.
      // Software table starts empty — add-a-row, no fixed starting categories.
      result.rows.kit = ['Staff', 'Volunteers', 'Finals'].map(function (cat) {
        return { category: cat, cost: 0 };
      });
      result.rows.software = [];
    }
  }

  // Mid-year venue notes live duplicated on every PoolVenues row (see GROUP_DEFS note 3) — surface once.
  if (groupId === 'venues') {
    result.values.midyear_notes = (result.rows.venues[0] && result.rows.venues[0].notes) || '';
  }

  return result;
}

/**
 * Upserts a submission (Submissions row + its detail tabs) at the given
 * status. Repeater tables are saved by deleting all rows for this
 * Submission ID and re-inserting the current set — simple and safe at this
 * scale (a few dozen rows per submission at most).
 */
function saveSubmission_(groupId, period, payload, status) {
  var ctx = requireUserContext_();
  var def = GROUP_DEFS[groupId];
  if (!def) throw new Error('Unknown group: ' + groupId);
  if (!userCanAccessGroup_(ctx, groupId)) throw new Error('You do not have access to submit for ' + def.label + '.');
  if (!period) throw new Error('Choose a reporting period before saving.');
  payload = payload || {};
  var values = payload.values || {};
  var rowsPayload = payload.rows || {};

  var subSheet = getSheetOrThrow_('Submissions');
  var existing = findEditableSubmission_(subSheet, def.label, period, ctx.personId);
  var submissionId = existing ? existing['Submission ID'] : getNextSequentialId_(subSheet, 'Submission ID', 'A');
  var now = new Date();

  var subRowData = {
    'Submission ID': submissionId,
    'Group': def.label,
    'Period': period,
    'Submitted By': ctx.personId,
    'Submitted At': now,
    'Status': status
  };
  if (status === 'Submitted') {
    // Resubmitting clears the previous decision so it reads as freshly pending.
    subRowData['Reviewed By'] = '';
    subRowData['Reviewed At'] = '';
  } else if (existing) {
    subRowData['Reviewed By'] = existing['Reviewed By'] || '';
    subRowData['Reviewed At'] = existing['Reviewed At'] || '';
  }
  upsertRowById_(subSheet, 'Submission ID', submissionId, subRowData);

  if (def.singleSheet) {
    var singleSheet = getSheetOrThrow_(def.singleSheet);
    var singleData = { 'Submission ID': submissionId };
    def.singleFields.forEach(function (f) {
      singleData[f.col] = normalizeOutgoing_(values[f.key], f.type);
    });
    upsertRowById_(singleSheet, 'Submission ID', submissionId, singleData);
  }

  def.repeaters.forEach(function (rep) {
    var repSheet = getSheetOrThrow_(rep.sheet);
    deleteRowsById_(repSheet, 'Submission ID', submissionId);
    var rows = rowsPayload[rep.rowsKey] || [];
    if (rows.length) {
      var objs = rows.map(function (r) {
        var o = { 'Submission ID': submissionId };
        rep.columns.forEach(function (c) { o[c.col] = normalizeOutgoing_(r[c.field], c.type); });
        return o;
      });
      appendRows_(repSheet, objs);
    }
  });

  return { submissionId: submissionId, status: status };
}

function saveDraft(groupId, period, payload) {
  return saveSubmission_(groupId, period, payload, 'Draft');
}

function submitForReview(groupId, period, payload) {
  return saveSubmission_(groupId, period, payload, 'Submitted');
}

// ---------------------------------------------------------------------------
// Bootstrap (called once on page load)
// ---------------------------------------------------------------------------

function getBootstrapData() {
  var ctx = getUserContext_();
  var settings = readSettings_();
  if (!ctx.ok) {
    return { ok: false, error: ctx.error, settings: { year: settings.year, deadline: settings.deadline } };
  }

  var allowedGroups = Object.keys(GROUP_DEFS).filter(function (gid) { return userCanAccessGroup_(ctx, gid); });

  var subSheet = getSheetOrThrow_('Submissions');
  var subRows = getRowsAsObjects_(subSheet);

  var groupStatus = {};
  allowedGroups.forEach(function (gid) {
    var label = GROUP_DEFS[gid].label;
    var mine = subRows.filter(function (r) { return String(r['Group']) === label && String(r['Submitted By']) === ctx.personId; });
    mine.sort(function (a, b) { return String(b['Submitted At']).localeCompare(String(a['Submitted At'])); });
    groupStatus[gid] = mine.length ? { status: mine[0]['Status'], period: mine[0]['Period'], submissionId: mine[0]['Submission ID'] } : null;
  });

  var pendingReviewCount = 0;
  if (ctx.isReviewer) {
    pendingReviewCount = subRows.filter(function (r) { return String(r['Status']) === 'Submitted'; }).length;
  }

  return {
    ok: true,
    user: { name: ctx.name, email: ctx.email, personId: ctx.personId, roles: ctx.roles, isReviewer: ctx.isReviewer, isAdmin: ctx.isAdmin },
    allowedGroups: allowedGroups,
    groupStatus: groupStatus,
    settings: { year: settings.year, deadline: settings.deadline, enforceSoD: settings.enforceSoD },
    baselineSquads: getBaselineSquads_(),
    baselineVenues: getBaselineVenues_(),
    pendingReviewCount: pendingReviewCount
  };
}

// ---------------------------------------------------------------------------
// Treasurer / Admin review queue
// ---------------------------------------------------------------------------

function getReviewQueue() {
  var ctx = requireUserContext_();
  if (!ctx.isReviewer) throw new Error('Only Admin or Treasurer can view the review queue.');

  var subSheet = getSheetOrThrow_('Submissions');
  var rows = getRowsAsObjects_(subSheet);
  var peopleById = getPeopleById_();
  var settings = readSettings_();

  var list = rows.map(function (r) {
    var submittedById = String(r['Submitted By'] || '');
    var sameAsSubmitter = submittedById === ctx.personId;
    return {
      submissionId: r['Submission ID'],
      groupId: groupIdFromLabel_(r['Group']),
      groupLabel: r['Group'],
      period: r['Period'],
      status: r['Status'],
      submittedByName: (peopleById[submittedById] && peopleById[submittedById].name) || submittedById || '—',
      submittedAt: r['Submitted At'] || '',
      reviewedByName: (peopleById[String(r['Reviewed By'] || '')] && peopleById[String(r['Reviewed By'] || '')].name) || r['Reviewed By'] || '',
      reviewedAt: r['Reviewed At'] || '',
      reviewNotes: r['Review Notes'] || '',
      blockedBySoD: settings.enforceSoD && sameAsSubmitter && String(r['Status']) === 'Submitted'
    };
  });
  list.sort(function (a, b) { return String(b.submittedAt).localeCompare(String(a.submittedAt)); });

  return {
    items: list,
    pending: list.filter(function (s) { return s.status === 'Submitted'; }).length,
    approved: list.filter(function (s) { return s.status === 'Approved'; }).length,
    total: list.length
  };
}

/** Full detail for one submission across its detail tabs — reviewers, or the submission's own owner. */
function getSubmissionDetail(submissionId) {
  var ctx = requireUserContext_();
  var subSheet = getSheetOrThrow_('Submissions');
  var subRow = findRowById_(subSheet, 'Submission ID', submissionId);
  if (!subRow) throw new Error('Submission ' + submissionId + ' was not found.');

  var groupId = groupIdFromLabel_(subRow['Group']);
  var def = groupId ? GROUP_DEFS[groupId] : null;
  var isOwner = String(subRow['Submitted By']) === ctx.personId;
  if (!ctx.isReviewer && !isOwner) throw new Error('You do not have access to this submission.');
  if (!def) throw new Error('Submission ' + submissionId + ' has an unrecognised Group value: "' + subRow['Group'] + '".');

  var values = {};
  if (def.singleSheet) {
    var singleSheet = getSheetOrThrow_(def.singleSheet);
    var singleRow = findRowById_(singleSheet, 'Submission ID', submissionId);
    if (singleRow) def.singleFields.forEach(function (f) { values[f.key] = singleRow[f.col]; });
  }
  var rows = {};
  def.repeaters.forEach(function (rep) {
    var repSheet = getSheetOrThrow_(rep.sheet);
    var repRows = findRowsById_(repSheet, 'Submission ID', submissionId);
    rows[rep.rowsKey] = repRows.map(function (row) {
      var o = {};
      rep.columns.forEach(function (c) { o[c.field] = row[c.col]; });
      return o;
    });
  });
  if (groupId === 'venues') {
    values.midyear_notes = (rows.venues[0] && rows.venues[0].notes) || '';
  }

  var peopleById = getPeopleById_();
  var settings = readSettings_();
  var sameAsSubmitter = String(subRow['Submitted By']) === ctx.personId;
  var isPending = String(subRow['Status']) === 'Submitted';
  var blockedBySoD = settings.enforceSoD && sameAsSubmitter && isPending;

  return {
    submissionId: submissionId,
    groupId: groupId,
    groupLabel: subRow['Group'],
    period: subRow['Period'],
    status: subRow['Status'],
    values: values,
    rows: rows,
    submittedByName: (peopleById[String(subRow['Submitted By'] || '')] || {}).name || subRow['Submitted By'],
    submittedAt: subRow['Submitted At'] || '',
    reviewedByName: (peopleById[String(subRow['Reviewed By'] || '')] || {}).name || subRow['Reviewed By'] || '',
    reviewedAt: subRow['Reviewed At'] || '',
    reviewNotes: subRow['Review Notes'] || '',
    canDecide: ctx.isReviewer && isPending && !blockedBySoD,
    blockedBySoD: ctx.isReviewer && blockedBySoD
  };
}

function decideSubmission_(submissionId, newStatus, notes) {
  var ctx = requireUserContext_();
  if (!ctx.isReviewer) throw new Error('Only Admin or Treasurer can review submissions.');

  var subSheet = getSheetOrThrow_('Submissions');
  var subRow = findRowById_(subSheet, 'Submission ID', submissionId);
  if (!subRow) throw new Error('Submission ' + submissionId + ' was not found.');
  if (String(subRow['Status']) !== 'Submitted') throw new Error('Only submissions with status "Submitted" can be decided.');

  var settings = readSettings_();
  if (settings.enforceSoD && String(subRow['Submitted By']) === ctx.personId) {
    throw new Error('Segregation of duties is enabled: you cannot approve or request changes on your own submission, even under a different login.');
  }

  upsertRowById_(subSheet, 'Submission ID', submissionId, {
    'Submission ID': submissionId,
    'Status': newStatus,
    'Reviewed By': ctx.personId,
    'Reviewed At': new Date(),
    'Review Notes': notes || ''
  });

  return { submissionId: submissionId, status: newStatus };
}

/**
 * Approve & merge. For this first version "merge" just means setting
 * Status to "Approved" — there's no separate master 2027 Assumptions tab
 * (a different workbook) to merge into yet.
 */
function approveSubmission(submissionId, notes) {
  return decideSubmission_(submissionId, 'Approved', notes);
}

function requestChanges(submissionId, notes) {
  return decideSubmission_(submissionId, 'Changes Requested', notes);
}

// ---------------------------------------------------------------------------
// Master 2027 tab — computation
// ---------------------------------------------------------------------------

function emptyMonths_() {
  var a = [];
  for (var i = 0; i < 12; i++) a.push(0);
  return a;
}

function monthIndexFromName_(s) {
  var n = String(s || '').trim().toLowerCase().slice(0, 3);
  for (var i = 0; i < MONTH_NAMES.length; i++) {
    if (MONTH_NAMES[i].toLowerCase() === n) return i;
  }
  return -1;
}

/** Adds amount to one month, or — if the month wasn't recognised — spreads it evenly across all 12 so the FY total is still right. */
function addToMonth_(months, idx, amount) {
  if (idx >= 0 && idx < 12) {
    months[idx] += amount;
  } else {
    for (var i = 0; i < 12; i++) months[i] += amount / 12;
  }
}

/** Latest Approved submission for a group, preferring Period = "Full Year" if more than one is Approved. */
function findApprovedSubmission_(subRows, groupLabel) {
  var candidates = subRows.filter(function (r) { return String(r['Group']) === groupLabel && String(r['Status']) === 'Approved'; });
  if (!candidates.length) return null;
  var fullYear = candidates.filter(function (r) { return String(r['Period']) === 'Full Year'; });
  var pool = fullYear.length ? fullYear : candidates;
  pool.sort(function (a, b) { return String(b['Submitted At']).localeCompare(String(a['Submitted At'])); });
  return pool[0];
}

/** Loads one group's latest-Approved values + repeater rows, generic over GROUP_DEFS. Returns null if nothing's Approved yet. */
function loadApprovedGroupData_(groupId, subRows) {
  var def = GROUP_DEFS[groupId];
  var sub = findApprovedSubmission_(subRows, def.label);
  if (!sub) return null;
  var submissionId = sub['Submission ID'];
  var values = {};
  if (def.singleSheet) {
    var singleSheet = getSheetOrThrow_(def.singleSheet);
    var singleRow = findRowById_(singleSheet, 'Submission ID', submissionId);
    if (singleRow) def.singleFields.forEach(function (f) { values[f.key] = singleRow[f.col]; });
  }
  var rows = {};
  def.repeaters.forEach(function (rep) {
    var repSheet = getSheetOrThrow_(rep.sheet);
    var repRows = findRowsById_(repSheet, 'Submission ID', submissionId);
    rows[rep.rowsKey] = repRows.map(function (row) {
      var o = {};
      rep.columns.forEach(function (c) { o[c.field] = row[c.col]; });
      return o;
    });
  });
  return { submissionId: submissionId, values: values, rows: rows };
}

/**
 * Computes every "auto" line item's 12 months from the five groups' latest
 * Approved submissions. Costs are negative, income positive — matching the
 * real Ledger's own sign convention exactly, so totals add up the same way.
 */
function computeMasterLines_() {
  var subSheet = getSheetOrThrow_('Submissions');
  var subRows = getRowsAsObjects_(subSheet);

  var meetsData = loadApprovedGroupData_('meets', subRows);
  var venuesData = loadApprovedGroupData_('venues', subRows);
  var staffingData = loadApprovedGroupData_('staffing', subRows);
  var membershipData = loadApprovedGroupData_('membership', subRows);
  var adminData = loadApprovedGroupData_('admin', subRows);
  var treasurerData = loadApprovedGroupData_('treasurer', subRows);

  var lines = {};
  MASTER_LINE_ORDER.forEach(function (li) {
    if (li.kind === 'auto') lines[li.label] = emptyMonths_();
  });

  // --- Membership income (squads table; August is fee-free, matching the real Ledger) ---
  // RESTRUCTURED 23 Sept: Fee £/mo split into Training Fee + Membership Fee, with
  // every discount applying to Training Fee only (Membership Fee always charged in
  // full). 2nd-child discount removed (doesn't exist); 3rd/4th are now separate
  // editable rate boxes; Staff/Boarding/Teacher-Coach are new discount categories,
  // each contributing full Membership Fee + discounted Training Fee. See
  // claude/Assumptions-to-Ledger-Mapping.md, "Update, 23 Sept (part 4)".
  if (membershipData) {
    var disc3 = Number(membershipData.values.discount_3rd_pct || 0) / 100;
    var disc4 = Number(membershipData.values.discount_4th_pct || 0) / 100;
    var discStaff = Number(membershipData.values.discount_staff_pct || 0) / 100;
    var discBoardTerm = BOARDING_TERM_DISCOUNT_PCT / 100;
    var discBoardNonTerm = BOARDING_NONTERM_DISCOUNT_PCT / 100;
    var discTeacherCoach = TEACHER_COACH_DISCOUNT_PCT / 100;
    (membershipData.rows.squads || []).forEach(function (sq) {
      var members = Number(sq.members || 0);
      var trainingFee = Number(sq.trainingFee || 0);
      var membershipFee = Number(sq.membershipFee || 0);
      var staff = Number(sq.staff || 0);
      var third = Number(sq.third || 0);
      var fourth = Number(sq.fourth || 0);
      var boardTerm = Number(sq.boardingTerm || 0);
      var boardNonTerm = Number(sq.boardingNonTerm || 0);
      var teacherCoach = Number(sq.teacherCoach || 0);
      var discountedCount = staff + third + fourth + boardTerm + boardNonTerm + teacherCoach;
      var fullPayers = Math.max(0, members - discountedCount);

      function discountedIncome_(count, discPct) {
        return count * (trainingFee * (1 - discPct) + membershipFee);
      }

      var monthlyIncome = fullPayers * (trainingFee + membershipFee)
        + discountedIncome_(staff, discStaff)
        + discountedIncome_(third, disc3)
        + discountedIncome_(fourth, disc4)
        + discountedIncome_(boardTerm, discBoardTerm)
        + discountedIncome_(boardNonTerm, discBoardNonTerm)
        + discountedIncome_(teacherCoach, discTeacherCoach);

      for (var m = 0; m < 12; m++) {
        if (m === 7) continue; // August
        lines['Membership'][m] += monthlyIncome;
      }
    });
  }

  // --- Meet Team: per-meet income/pool hire/coach costs/meet costs ---
  // Novice galas RESTRUCTURED 23 Sept: no longer a separate flat count×fee figure —
  // they're just rows in the meets table now, classified by name like Club Champs.
  // Trophies, Medals, Rosettes moved in from Treasurer, 23 Sept (flat annual figure).
  if (meetsData) {
    var trophiesTotal = Number(meetsData.values.trophies_medals_rosettes || 0);
    for (var mTro = 0; mTro < 12; mTro++) {
      lines['Trophies, Medals, Rosettes'][mTro] += -trophiesTotal / 12;
    }

    (meetsData.rows.meets || []).forEach(function (mt) {
      var mIdx = monthIndexFromName_(mt.month);
      var meetNameLower = String(mt.name || '').toLowerCase();
      var isChamps = meetNameLower.indexOf('champs') !== -1;
      var isNovice = meetNameLower.indexOf('novice') !== -1;
      var incomeLine = isNovice ? 'Novice' : (isChamps ? 'Club Champs Income' : 'WSC Open Meets Income');
      addToMonth_(lines[incomeLine], mIdx, Number(mt.income || 0));
      addToMonth_(lines['Meet Pool Hire'], mIdx, -Math.abs(Number(mt.poolHire || 0)));
      // Coach Meet Costs = coaches × hours worked × NMW rate (confirmed 15 Sept) — applies the
      // same whether the meet is hosted or away, matching each meet's real Coach Hours entry.
      var meetCoachCost = Number(mt.numCoaches || 0) * Number(mt.coachHours || 0) * NMW_RATE;
      addToMonth_(lines['Coach Meet Costs'], mIdx, -Math.abs(meetCoachCost));
      var meetCostsTotal = Number(mt.gifts || 0) + Number(mt.catering || 0) + Number(mt.roomHire || 0) + Number(mt.parkingPermits || 0);
      addToMonth_(lines['Meet Costs'], mIdx, -Math.abs(meetCostsTotal));
    });
  }

  // --- Pool & Venues: rate × real weeks-in-month (or flat if Rate Basis is "monthly"), inflation from its effective month ---
  if (venuesData) {
    (venuesData.rows.venues || []).forEach(function (v) {
      var label = MASTER_VENUE_LABELS.filter(function (l) { return l.toLowerCase() === String(v.name || '').trim().toLowerCase(); })[0];
      if (!label) return; // venue name didn't match one of the 6 real Ledger labels — leave for Matt to reconcile, don't crash
      var baseRate = Number(v.rate || 0);
      var isMonthly = /month|mo\b/i.test(String(v.unit || ''));
      var inflationPct = Number(v.inflation || 0);
      var effIdx = monthIndexFromName_(v.effectiveMonth);
      if (effIdx < 0) effIdx = 0;
      var augOverride = Number(v.augWeeksOverride || 0);
      for (var m2 = 0; m2 < 12; m2++) {
        var rate = (m2 >= effIdx) ? baseRate * (1 + inflationPct / 100) : baseRate;
        // Per-venue August, added 23 Sept: every venue except WLC doesn't train/pay in
        // August (shared calendar's Aug=0 default still applies). A venue with a real
        // non-zero override (WLC) uses that instead for August specifically.
        var weeksThisMonth = (m2 === 7 && augOverride > 0) ? augOverride : WEEKS_IN_MONTH[m2];
        var monthlyCost = isMonthly ? rate : rate * weeksThisMonth;
        lines[label][m2] += -Math.abs(monthlyCost);
      }
    });
  }

  // --- Coaching & Staffing ---
  if (staffingData) {
    // Development table, added 23 Sept — replaces the flat CPD Budget figure and
    // absorbs L2/L1/Coach-Assistant/Lifeguard Course from Treasurer (moved in same
    // day). Four rows are fixed by 'kind'; anything else ('other') rolls into CPD.
    var DEV_KIND_TO_LABEL = {
      l2: 'L2 Coach Courses',
      l1: 'L1 Coach Course',
      coachAssistant: 'Coach/Assistant Course',
      lifeguard: 'Lifeguard Course'
    };
    (staffingData.rows.development || []).forEach(function (d) {
      var rowTotal = Number(d.number || 0) * Number(d.costPerCourse || 0);
      var targetLine = DEV_KIND_TO_LABEL[d.kind] || 'CPD';
      addToMonth_(lines[targetLine], -1, -rowTotal); // flat annual, spread evenly like the old CPD figure
    });
    function addCoachCosts_(rows, targetLabel) {
      (rows || []).forEach(function (c) {
        var rate = Number(c.rate || 0);
        var hours = Number(c.hours || 0);
        for (var m4 = 0; m4 < 12; m4++) {
          lines[targetLabel][m4] += -(rate * hours * WEEKS_IN_MONTH[m4]);
        }
      });
    }
    addCoachCosts_(staffingData.rows.coaches_comp, 'Comp Coaches (Contractor)');
    addCoachCosts_(staffingData.rows.coaches_academy, 'Academy Coaches (Contractor)');
  }

  // --- General Admin ---
  // RESTRUCTURED 23 Sept: ASA Affiliation Fee is now rate × headcount (swimmer
  // rate × swimmer headcount, computed from Membership's squad totals; volunteer
  // rate × a manually-entered volunteer headcount). Kit investment and Club
  // Sundries Admin, Software are now summed from add-a-row repeaters instead of
  // one flat figure each — see GROUP_DEFS.admin and
  // claude/Assumptions-to-Ledger-Mapping.md, "Update, 23 Sept (part 4)".
  if (adminData) {
    var swimmerHeadcount = 0;
    if (membershipData) {
      (membershipData.rows.squads || []).forEach(function (sq) {
        swimmerHeadcount += Number(sq.members || 0);
      });
    }
    var volunteerHeadcount = Number(adminData.values.volunteer_headcount || 0);
    var asaSwimmerRate = Number(adminData.values.asa_swimmer_rate || 0);
    var asaVolunteerRate = Number(adminData.values.asa_volunteer_rate || 0);
    var asaVolunteerFeesTotal = volunteerHeadcount * asaVolunteerRate;

    var kitTotal = 0;
    (adminData.rows.kit || []).forEach(function (k) {
      kitTotal += Number(k.cost || 0);
    });
    var softwareTotal = 0;
    (adminData.rows.software || []).forEach(function (s) {
      softwareTotal += Number(s.cost || 0);
    });

    for (var m5 = 0; m5 < 12; m5++) {
      lines['ASA'][m5] += -(swimmerHeadcount * asaSwimmerRate) / 12;
      lines['ASA Volunteer Fees'][m5] += -asaVolunteerFeesTotal / 12;
      lines['Kit investment'][m5] += -kitTotal / 12;
      lines['Club Sundries Admin, Software'][m5] += -softwareTotal / 12;
    }
  }

  // --- Treasurer (added 11 Sept) — payroll (moved out of Coaching & Staffing) plus
  // the ~24 Ledger lines that previously had no submitting group. Every field here
  // is a flat annual £ figure, split evenly ÷12 across months — same pattern as
  // CPD/Kit investment above. "Unplanned spend (logged)" is deliberately NOT here;
  // it stays a direct-edit Master_2027 line (logged actuals, not a plan assumption).
  if (treasurerData) {
    var tv = treasurerData.values;
    var tEmployeesTotal = Number(tv.employees_cost || 0);
    var tHoaTotal = Number(tv.hoa_salary || 0);
    var tNiPct = Number(tv.ni_pct || 0);
    var tPensionPct = Number(tv.pension_pct || 0);

    // label -> [field key, +1 for income / -1 for cost]
    // NOTE 23 Sept: L2/L1/Coach-Assistant/Lifeguard courses, ASA Volunteer Fees,
    // Club Sundries Admin/Software, and Trophies/Medals/Rosettes were REMOVED from
    // this map — they moved to Coaching & Staffing, General Admin, and Meet Team
    // respectively and are now computed in those groups' own blocks above. Leaving
    // them here would double-count those Ledger lines. See
    // claude/Assumptions-to-Ledger-Mapping.md, "Update, 23 Sept (part 4)".
    var TREASURER_LINE_MAP = {
      'Other': ['other_income', 1],
      'Clothing income': ['clothing_income', 1],
      'Spectator Fee': ['spectator_fee', 1],
      'LT Equipment hire': ['lt_equipment_hire', -1],
      'Coach Meet Expenses': ['coach_meet_expenses', -1],
      'Coach Meet Passes': ['coach_meet_passes', -1],
      'S&C': ['sc_cost', -1],
      'Lifeguard Cover Bishopsgate': ['lifeguard_cover_bishopsgate', -1],
      'Lifeguard Cover WLC': ['lifeguard_cover_wlc', -1],
      'Commit Swimming Software': ['commit_swimming_software', -1],
      'IT': ['it_cost', -1],
      'Arena Fees': ['arena_fees', -1],
      'BSBASA Fee': ['bsbasa_fee', -1],
      'Outside Services': ['outside_services', -1],
      'Specialist Staff (Nutrition, Psychologist)': ['specialist_staff', -1],
      'Meeting Room Hire': ['meeting_room_hire', -1],
      'Clothing': ['clothing_cost', -1]
    };

    for (var m6 = 0; m6 < 12; m6++) {
      lines['Employees'][m6] += -tEmployeesTotal / 12;
      lines['HoA'][m6] += -tHoaTotal / 12;
      lines['Employer NI & Pension'][m6] += -((tNiPct + tPensionPct) / 100) * (tEmployeesTotal + tHoaTotal) / 12;
    }
    Object.keys(TREASURER_LINE_MAP).forEach(function (label) {
      var fieldKey = TREASURER_LINE_MAP[label][0];
      var sign = TREASURER_LINE_MAP[label][1];
      var annualTotal = Number(tv[fieldKey] || 0);
      for (var m7 = 0; m7 < 12; m7++) {
        lines[label][m7] += sign * annualTotal / 12;
      }
    });
  }

  return lines;
}

/**
 * Recalculates the Master_2027 tab: "auto" rows from the five groups'
 * latest Approved submissions (see computeMasterLines_), "manual" rows
 * preserved exactly as they were typed, "total" rows recomputed by summing
 * their category. Creates the tab (with headers + every line item's label
 * pre-filled) the first time it's run. Safe to re-run any time.
 */
function refreshMasterTab() {
  var ctx = requireUserContext_();
  if (!ctx.isReviewer) throw new Error('Only Admin or Treasurer can recalculate the master budget tab.');

  var sh = getSheetOptional_(MASTER_TAB_NAME);
  if (!sh) {
    sh = getSpreadsheet_().insertSheet(MASTER_TAB_NAME);
    var header = ['Line Item', 'Category', 'Source'].concat(MONTH_NAMES).concat(['FY']);
    sh.getRange(1, 1, 1, header.length).setValues([header]);
    var seedRows = MASTER_LINE_ORDER.map(function (li) {
      return [li.label, li.category, li.kind === 'manual' ? 'Manual' : (li.kind === 'total' ? 'Computed' : 'Auto')];
    });
    sh.getRange(2, 1, seedRows.length, 3).setValues(seedRows);
  }

  var autoLines = computeMasterLines_();
  var existingRows = getRowsAsObjects_(sh);
  var rowByLabel = {};
  existingRows.forEach(function (r) { rowByLabel[String(r['Line Item'])] = r; });

  var finalMonths = {};
  MASTER_LINE_ORDER.forEach(function (li) {
    if (li.kind === 'auto') {
      finalMonths[li.label] = autoLines[li.label] || emptyMonths_();
    } else if (li.kind === 'manual') {
      var existing = rowByLabel[li.label];
      var months = emptyMonths_();
      if (existing) {
        for (var m = 0; m < 12; m++) months[m] = Number(existing[MONTH_NAMES[m]] || 0);
      }
      finalMonths[li.label] = months;
    }
  });

  function sumCategory_(category) {
    var months = emptyMonths_();
    MASTER_LINE_ORDER.forEach(function (li) {
      if (li.category === category && li.kind !== 'total' && finalMonths[li.label]) {
        for (var m = 0; m < 12; m++) months[m] += finalMonths[li.label][m];
      }
    });
    return months;
  }

  finalMonths['TOTAL INCOME'] = sumCategory_('Income');
  finalMonths['Total Pool Cost'] = sumCategory_('Pool Costs');
  finalMonths['Total Employee/Contractor Cost'] = sumCategory_('Staff/Contractor Costs');
  finalMonths['Total Membership/Admin'] = sumCategory_('Membership/Admin');

  var totalCashOut = emptyMonths_();
  for (var mc = 0; mc < 12; mc++) {
    totalCashOut[mc] = finalMonths['Total Pool Cost'][mc] + finalMonths['Total Employee/Contractor Cost'][mc] + finalMonths['Total Membership/Admin'][mc];
  }
  finalMonths['TOTAL CASH OUT'] = totalCashOut;

  var netCashFlow = emptyMonths_();
  for (var mn = 0; mn < 12; mn++) netCashFlow[mn] = finalMonths['TOTAL INCOME'][mn] + totalCashOut[mn];
  finalMonths['NET CASH FLOW'] = netCashFlow;

  var unplannedExisting = rowByLabel['Unplanned spend (logged)'];
  var unplannedMonths = emptyMonths_();
  if (unplannedExisting) {
    for (var mu = 0; mu < 12; mu++) unplannedMonths[mu] = Number(unplannedExisting[MONTH_NAMES[mu]] || 0);
  }
  finalMonths['Unplanned spend (logged)'] = unplannedMonths;

  var adjusted = emptyMonths_();
  for (var ma = 0; ma < 12; ma++) adjusted[ma] = netCashFlow[ma] + unplannedMonths[ma];
  finalMonths['Adjusted Net Cash Flow (incl. unplanned spend)'] = adjusted;

  var out = MASTER_LINE_ORDER.map(function (li) {
    var months = finalMonths[li.label] || emptyMonths_();
    var fy = months.reduce(function (a, b) { return a + b; }, 0);
    var source = li.kind === 'manual' ? 'Manual' : (li.kind === 'total' ? 'Computed' : 'Auto');
    return [li.label, li.category, source].concat(months.map(function (v) { return Math.round(v * 100) / 100; })).concat([Math.round(fy * 100) / 100]);
  });
  sh.getRange(2, 1, out.length, out[0].length).setValues(out);

  upsertSettingKeys_(getSheetOrThrow_('Settings'), { 'Master Tab Last Refreshed': new Date(), 'Master Tab Last Refreshed By': ctx.personId });

  return { updated: out.length, at: new Date().toISOString() };
}

function upsertSettingKeys_(sheet, kv) {
  var lastRow = sheet.getLastRow();
  var keyToRow = {};
  if (lastRow >= 2) {
    var keys = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    keys.forEach(function (k, i) { keyToRow[String(k[0] || '').trim()] = i + 2; });
  }
  Object.keys(kv).forEach(function (key) {
    var row = keyToRow[key];
    if (row) {
      sheet.getRange(row, 2).setValue(kv[key]);
    } else {
      sheet.appendRow([key, kv[key]]);
    }
  });
}

/**
 * Marks the current Master_2027 tab as the live 2027 budget — a distinct,
 * explicit step from recalculating it, so nothing is treated as "live"
 * until an Admin/Treasurer says so. Does not lock the tab's cells (Sheets
 * doesn't make that simple without protected ranges) — it's a status flag
 * for now; the Ledger's eventual live rebuild reads this same tab.
 */
function publishLiveBudget() {
  var ctx = requireUserContext_();
  if (!ctx.isReviewer) throw new Error('Only Admin or Treasurer can publish the live budget.');
  upsertSettingKeys_(getSheetOrThrow_('Settings'), {
    'Live Budget Status': 'Published',
    'Live Budget Published By': ctx.personId,
    'Live Budget Published At': new Date()
  });
  return { status: 'Published', at: new Date().toISOString() };
}

/** Status for the Review screen's Master Budget panel. */
function getMasterTabStatus() {
  var ctx = requireUserContext_();
  if (!ctx.isReviewer) throw new Error('Only Admin or Treasurer can view the master budget status.');
  var settings = readSettings_();
  var exists = !!getSheetOptional_(MASTER_TAB_NAME);
  return {
    exists: exists,
    lastRefreshedAt: settings.masterLastRefreshedAt,
    lastRefreshedByName: (getPeopleById_()[settings.masterLastRefreshedBy] || {}).name || settings.masterLastRefreshedBy || '',
    liveStatus: settings.liveBudgetStatus,
    publishedByName: (getPeopleById_()[settings.livePublishedBy] || {}).name || settings.livePublishedBy || '',
    publishedAt: settings.livePublishedAt
  };
}

// ---------------------------------------------------------------------------
// Manual setup check — run this from the Apps Script editor (Run menu) after
// binding the project to double-check the Sheet matches what the code
// expects. Does not end in "_" on purpose, so it shows up in the editor's
// function dropdown.
// ---------------------------------------------------------------------------

function checkSetup() {
  var ss = getSpreadsheet_();
  var missing = REQUIRED_TABS.filter(function (t) { return !ss.getSheetByName(t); });
  var missingOptional = OPTIONAL_TABS.filter(function (t) { return !ss.getSheetByName(t); });

  var extraColsByTab = {};
  Object.keys(GROUP_DEFS).forEach(function (gid) {
    var def = GROUP_DEFS[gid];
    if (def.singleSheet) {
      var sh = ss.getSheetByName(def.singleSheet);
      if (sh) {
        var map = headerMap_(sh);
        def.singleFields.forEach(function (f) {
          if (!map[f.col]) {
            extraColsByTab[def.singleSheet] = extraColsByTab[def.singleSheet] || [];
            extraColsByTab[def.singleSheet].push(f.col);
          }
        });
      }
    }
    def.repeaters.forEach(function (rep) {
      var sh2 = ss.getSheetByName(rep.sheet);
      if (sh2) {
        var map2 = headerMap_(sh2);
        rep.columns.forEach(function (c) {
          if (!map2[c.col]) {
            extraColsByTab[rep.sheet] = extraColsByTab[rep.sheet] || [];
            extraColsByTab[rep.sheet].push(c.col);
          }
        });
      }
    });
  });

  Logger.log('Missing REQUIRED tabs: ' + (missing.length ? missing.join(', ') : 'none'));
  Logger.log('Missing OPTIONAL Baseline tabs (pre-fill will be empty until added): ' + (missingOptional.length ? missingOptional.join(', ') : 'none'));
  Object.keys(extraColsByTab).forEach(function (tab) {
    Logger.log('Tab "' + tab + '" is missing columns (those fields will not save until added): ' + extraColsByTab[tab].join(', '));
  });
  if (!missing.length && !missingOptional.length && !Object.keys(extraColsByTab).length) {
    Logger.log('All tabs and columns look correct.');
  }
}
