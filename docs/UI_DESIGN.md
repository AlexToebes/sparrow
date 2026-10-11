# UI design direction

Chosen by the project owner on 2026-10-10 from five prototype explorations (kept in `docs/design/prototypes/`).
The base is **B "Calm status board"**, plus selected ideas from E, D and C. The prototypes are reference
material, not code to copy: build with Mantine components, the shared zod types and TanStack Query.

## Base (from B, `b-calm`)
- Mantine look: soft cards, generous spacing, one accent color (indigo), system font stack.
- Light and dark follow `prefers-color-scheme` (Mantine `defaultColorScheme="auto"`).
- App shell: sidebar on desktop (Layout, Drives, Inbox with count badge, Settings, plus provider status and
  "last updated" at the bottom); bottom tab bar on phone (<= 768px).
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
  "Bay 8 missing", "Boot stale 3 d", "2 in Inbox"); clicking a chip selects that slot / opens the inbox.
  Also a "N spares on hand" chip.
- **Life story** in the drive detail panel: a vertical timeline built from the drive's events (newest last
  or first — pick one and be consistent; E used oldest first with relative gaps like "after 1 mo"), with an
  icon per event type and a header line like "1 y 7 mo in service · 1 mo on the shelf". It is the drive's
  history view everywhere (slot panel and drive page).
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
  check icon. Occupied tiles are selectable and lead to the occupant step.
- Spares are chosen on cards (`SparePicker`), not a dropdown. "Replace" shows the fixed bay as a read-only grid.

## Formatting rules
- Capacities in decimal units via one helper (`formatBytes(4_000_000_000_000) === "4 TB"`, 500 GB, 1.92 TB).
- Timestamps: stored UTC, shown in local time; relative ("2 min ago", "3 d ago") for freshness, absolute
  dates in history.
