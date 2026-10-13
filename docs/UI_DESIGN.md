# UI design direction

Chosen by the project owner on 2026-10-10 from five prototype explorations (kept in `docs/design/prototypes/`).
The base is **B "Calm status board"**, plus selected ideas from E, D and C. The prototypes are reference
material, not code to copy: build with Mantine components, the shared zod types and TanStack Query.

## Base (from B, `b-calm`)
- Mantine look: soft cards, generous spacing, one accent color (indigo), system font stack.
- Light and dark follow `prefers-color-scheme` (Mantine `defaultColorScheme="auto"`).
- App shell: sidebar on desktop (Layout, Drives, Pools, Settings, plus provider status and
  "last updated" at the bottom); bottom tab bar on phone (<= 768px) with the same four tabs. The Discovered page (formerly
  Inbox, R71) is not a tab: the Drives page header has a "Discovered" button beside "Add drive", filled with a count badge when
  something waits, plain when empty. The page is `/drives/discovered` (`/drives/inbox` and `/inbox` redirect) with a "Drives" back link and keeps the
  Drives tab highlighted.
- Pools page (`/pools`, R76, R34): a card per pool with name, layout label, size check and members. The size check is icon plus text ("5 of 6 drives — one missing", "7 drives, expected 6"; a check mark with "6 of 6 drives" when it matches; nothing when no expected number is set). Members are rows (serial, capacity, bay, role badge) that open the drive detail in the usual drawer. "New pool", Edit and Delete live here, not in Settings.
- Suggested updates (R72): drive detail has a "reports details this record doesn't have" block (ticked rows,
  "Apply selected", "Dismiss selected", a text "Dismiss" per row, and a quiet "N dismissed — show" toggle listing
  dismissed suggestions with "Undo"; no confirmation, it is reversible) and a collapsed "reports different values" toggle; Drives rows with fillable details show an
  "Updates" flag (icon plus text); the Discovered page lists them in a "Suggested updates" card.
- Layout page opens with a one-line summary sentence ("Four things need a look" / "Everything is healthy"),
  then the grids as cards (one `BayGrid` per grid; title, "4 x 2 · 7 of 8 occupied").
- Slot tile: label top-left, health icon top-right, health word, capacity (decimal, "8 TB"), serial (monospace).
  States: ok (neutral tile, green icon), warning (amber tint), failed (red tint), unknown (grey), empty
  (dashed border, "Empty", "+ Assign"), missing (dashed amber border, "Missing" + reason), stale
  (hatched background + "Stale, seen 3 d ago"). Never color alone: always icon + word.
- Slot detail: right-hand side panel on desktop (Mantine `Drawer position="right"` or a sticky column), bottom
  sheet on phone (`Drawer position="bottom"`). Retire and import use confirm dialogs.
- Provider-stale (R47): one banner across the top of the page instead of per-slot flags.

## From E (`e-lifecycle`)
- **Problem chips** under the summary sentence: one chip per issue ("Bay 6 failed", "Bay 4 warning",
  "Bay 8 missing", "Boot stale 3 d", "2 discovered"); clicking a chip selects that slot / opens the Discovered page.
  Also a "N spares on hand" chip.
- **Life story** in the drive detail panel: a vertical timeline built from the drive's activities, one entry per activity (newest last
  or first — pick one and be consistent; E used oldest first with relative gaps like "after 1 mo"), with an
  icon per event type and a header line like "1 y 7 mo in service · 1 mo on the shelf". It is the drive's
  history view everywhere (slot panel and drive page). Health entries (R20) read "Health: OK → Warning" or
  "Health first reported: OK", with the health icon and colour of the new value (icon plus text, never colour
  alone), and sit at the time the provider reported them.
- **History section** (R74): one "History" heading in the drive detail and the slot panel. An installed drive (in the slot panel or on the Drives page) and an occupied slot show a `SegmentedControl` labelled "History for" with **Drive** (default, the life story) and **Slot** (the current bay's history). An empty slot shows only the slot history, with no toggle; a spare or retired drive shows only its own history. The slot history is a compact timeline, newest first: the serial (a link that opens that drive) and capacity, then "installed 2022-08-19 → removed 2026-03-14, retired (failed)", "… moved to Bay 7", "… back to spares", "… sent for RMA", and for the current drive "in this slot since 2022-08-19". Unrecorded dates read "not recorded" with the day it was logged as a hint. The life story's "Installed in / Removed from Bay 3" entries carry a "Slot history" link that opens that bay's panel on the Slot tab (`/?slot=ID&view=slot`). Replaced-by was dropped: the slot history shows what replaced what. Tapping an empty tile opens this panel (with "Assign a drive").
- Per-grid orientation toggle button ("Flip to 2 x 4") in the grid card header (R7) — in Settings/edit mode
  only, or directly on the card; keep it unobtrusive.

## From D (`d-spatial`)
- **Pool brackets**: on a grid, slots of the same pool are visually grouped by a thin colored outline/badge
  with the pool name and layout label ("tank · raidz2"). Simplest acceptable version: a small pool badge on
  each tile in the pool's color plus a legend row; the outline grouping is a nice-to-have when the pool's
  slots are contiguous.
- "Needs attention" list idea is covered by the problem chips.
- Do NOT adopt the floor-plan enclosure drawing (needs physical-placement data we don't model).

## From C (`c-ops`)
- **Spares shelf**: below the grids on the Layout page, a compact list/table of spares (serial, model,
  capacity, condition, location) with an "Assign" action — makes replacing a failed drive one screen.
- Monospace for serials and numbers. Keyboard shortcuts go to the parking lot.

## Choosing a slot (R70)
- Never offer a slot in a dropdown. Any flow that needs a slot shows the bay grids with `SlotPicker`: it renders
  the shared `BayGrid` (same rows, columns and orientation as the Layout page) with each tile a radio showing
  label, serial plus capacity or "Empty", and the health icon. The selected tile has an accent border and a
  check icon. Occupied tiles are selectable and lead to the occupant step (Move offers "Swap" first and then skips "What goes into this bay?").
- Spares are chosen on cards (`SparePicker`), not a dropdown. When a spare is chosen for a bay (Assign, Move with a spare) each card carries an R12 badge, icon plus words, never color alone: green check "Fits", amber warning "Too small · needs ≥ 4 TB", red cross "Different type", grey question mark "Unknown size"; fits come first. It is advice, every card stays selectable. The Pools card adds a dim line "Smallest member 2 TB · 3 spares fit". "Move" (R73) draws the grids with the bay the drive is leaving disabled and tagged "Current".

## Multi-step dialogs (R70)
- One decision per step; the slot picker is always its own step. `StepFlow` shows "Step N of M · title" (M counts only the steps in play), one step's content, and a footer (Back / Next, or the final action) that stays visible while the content scrolls. Next is disabled until the step is valid, and focus moves to the step heading on every change. On a phone the dialog is fullscreen. Assign and Move use it; opened from a slot, Assign skips the slot step and shows a read-only bay summary with a "Change" link.

## Move (R73)
- An installed drive has one primary **Move** button (drive detail and the slot panel); there is no separate Replace or Remove to spares. **Retire** stays its own button: for a spare it opens the Retire dialog, for an installed drive it opens Move with "Retire" already chosen.
- Steps (only the ones that apply are counted): **Where does this drive go?** (radio cards: Spares shelf, Another bay, Retire with a required reason and optional note, Send for RMA with an optional note; below the cards and any reason or note, the ONE **When? (optional)** date field: default today, Today/Clear, the usual "better not recorded than a guess" helper; it is the removal, retirement or RMA date of this drive, its installation date in a new bay and the installation date of the incoming spare; empty = not recorded for all) -> **Which bay?** (only for Another bay: `SlotPicker`, the current bay disabled) -> **What happens to the drive in that bay?** (only when that bay is occupied: back to spares, retire with reason, RMA; R37) -> **What goes into this bay?** (Leave it empty, or A spare via `SparePicker` with the R12 badges and both capacities, R60; the bay is the one being vacated) -> **Details** (only when a spare goes in: pool and role, defaulting from the outgoing drive, R35) -> **Confirm** (one-paragraph summary, one `POST /api/drives/:id/move`).
- A move between bays keeps the drive's pool and role; the summary says so. The life story shows ONE entry per activity (R14): a Move is one `moved` activity, "Moved Bay 3 → Bay 7"; a replacement reads from each drive's side, "Replaced by ZL2SPR01 (8 TB) in Bay 3 · retired (failed) · left tank" for the outgoing drive and "Replaced ZL2ABC03 (4 TB) in Bay 3 · it was retired (failed)" for the incoming one; a swap reads "Swapped with ZL… — Bay 3 → Bay 7". An assignment reads "Installed in Bay 3 · tank (data)". The slot history says "replaced by ..." next to how the old drive left, and each Pools card has a collapsed History list sorted by the day it shows.

## Setup wizard (R77)
- A new install has no layout. The Layout page opens `SetupWizard` on `StepFlow` (fullscreen on a phone, sticky footer): **Welcome** (two lines about Sparrow, an indigo note "Scrutiny found 16 drives" when the provider reports drives; footer "Skip, I'll set it up later" and Start), **Name your enclosure** (default "NAS"), **Describe your bays**, **Pools (optional)**, **Review**, **All set**. Next is disabled until the step is valid; on the pools step with no pools the button reads "Skip this step".
- Grids step: pill-shaped quick-add chips ("+ 8 bays (4 × 2)", "+ 2 internal SSDs (2 × 1, Left/Right)", "+ 1 boot drive (1 × 1)", "+ Custom") add a grid card (soft grey card inside the dialog): name, Columns and Rows side by side, an orientation toggle, then the real `BayGrid` whose tiles are small text inputs holding the bay label (1 to n by default, Left and Right for the SSD preset). The caption says how it is drawn ("Bays, shown as 4 × 2"). Up, Down and Remove sit in each card's header as plain text buttons.
- Review lists the enclosure, each grid with its drawn size, bay count and labels, and the pools; Create is the only button that writes. A refused Create shows the server's message and stays on Review.
- After "Skip", or when the wizard is closed with the X, the Layout page shows a card "No enclosure yet" (or "Welcome to Sparrow" with "Start setup" while setup is still needed) with "Set up now" and "Open Settings → Layout", above the Spares shelf and Recent changes. Settings > Layout shows "Run setup wizard" beside "No enclosures yet".

## Formatting rules
- Capacities in decimal units via one helper (`formatBytes(4_000_000_000_000) === "4 TB"`, 500 GB, 1.92 TB).
- Timestamps: stored UTC, shown in local time; relative ("2 min ago", "3 d ago") for freshness, absolute
  dates in history.
