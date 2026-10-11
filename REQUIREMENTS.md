# Sparrow: Requirements

Sparrow keeps your spares in rows. Status: requirements settled (v1.2 draft). Defaults in section 7 are confirmed.

Changes since v1.0: visual slot picking, "Replace" and optional removal dates (R69, R70), slot history (R74); retirement reasons and reinstating (R13, R60 to R62), seeding retired drives from decommissioned observations (R63, moved from backlog), delivery items (R64 to R67: README with compose example, CI pipeline, Dockerfile, health endpoint), defaults confirmed (D5 revised, D10 and D11 added).

Changes since v1.1: project named Sparrow (D12), frontend stack decided (D9), pnpm as package manager (D13).

## 1. Purpose

A self-hosted web app, run as one Docker container on the NAS, that:

1. Shows where each drive physically sits (named grids of slots).
2. Tracks cold spares and each drive's lifecycle (spare, installed, retired).
3. Optionally enriches this with live health data from a pluggable provider (Scrutiny first).

The core must stay fully usable when the provider is unavailable or replaced.

## 2. Environment and observed facts

- NAS OS: TrueNAS. One enclosure.
- Pools: `big` (1 x raidz2 vdev, 8 HDDs), `fast` (1 x mirror vdev, 2 SSDs), `boot-pool` (NVMe).
- Physical layout: front bays are 8 HDD slots in a 4x2 grid. Two internal SSD slots (left and right, not front-accessible). One NVMe boot slot.
- Scrutiny: `starosdev/scrutiny:latest-omnibus` (fork, collector v1.76.4), SMART collector runs daily at 00:00 UTC.
- Observed in the Scrutiny API (verified against real output):
  - `serial_number` and `wwn` are present on devices. `sdX` names are reused across drives, so they are not identity.
  - The NVMe's "WWN" is its serial in lowercase. One empty `nvme0` record has no serial or WWN. The NVMe boot drive's last report was 2026-07-01 (collector likely lacks NVMe access).
  - No HDD/SSD field exists. `rotational_speed` is 0 for SSDs. `form_factor` can be empty.
  - Archived devices are included in the `/api/summary` response. There are 4 (3 HDDs, 1 SSD) that look like previously retired drives.
  - ZFS pool details identify vdev leaves only by partition UUID, with no serial or WWN.
- Pool `big` mixes 2, 3 and 4 TB drives. Usable size per disk is limited by the smallest member (relevant to R12).

## 3. Architecture

```mermaid
flowchart LR
  subgraph Core["App core (provider-agnostic)"]
    A[Enclosures, grids, slots] --- B[Drive records and spares]
    B --- C[Pools and memberships]
    B --- D[Event log]
    E[Serial matching] --- B
  end
  Core -->|uses| P{{"DriveDataProvider (port)"}}
  P --- S[Scrutiny adapter]
  P --- N["'none' adapter (manual only)"]
  P -.-> F[Future adapter]
```

Principles:
- The core owns all records (layout, drives, pools, memberships, events).
- Providers only report observations. Links are computed by serial, never stored.
- No provider field name, enum or ID reaches the core, UI, DB or export (R53).

## 4. Requirements (MVP)

### 4.1 Layout
- R4: An enclosure contains one or more named grids. Each grid has configurable rows and columns, and each slot can have a label.
- R5: Initial layout: grid "Front bays" (8 HDD slots, 4x2), grid "Internal SSDs" (2 slots, left and right), grid "Boot" (1 NVMe slot).
- R7: Grid orientation (4 columns by 2 rows, or the reverse) is configurable.
- R38: Enclosures and grids are created and edited in the web UI (name, rows, columns, slot labels) and stored in SQLite.
- R39: Slots have stable internal IDs. Renaming a grid or relabeling a slot never orphans an assignment or its history.
- R40: Removing a slot or shrinking a grid that would drop an occupied slot is blocked until the occupant is resolved.

### 4.2 Drives and lifecycle
- R3: The app owns bay positions, cold-spare records and pool membership.
- R11: Drive fields: serial, model, capacity, type (HDD/SSD/NVMe), form factor, storage location, condition (new/used/tested) with last test date, purchase date, warranty expiry, vendor, notes.
- R13: Each drive has one record for its whole life, with a status: spare, installed or retired. Purchase and warranty info stays attached.
- R14: Every change is logged as a timestamped event (installed in slot X, removed, retired, reinstated, sent for RMA, and so on). The log is browsable per drive.
- R21: Spares are created manually and can exist without any provider data.
- R8: Slot assignment is manual, picked from drives that have a record in the app. Retired drives cannot be assigned to a slot.
- R23: Linking or creating a drive from an observation sets its status to "installed" and writes an event. Decision (2026-10-10): resolving an inbox entry also picks the slot (with pool and role), so an installed drive always has a slot (D7).
- R37: Assigning a drive to an occupied slot first requires resolving the current occupant (see R27 and R62). The app never silently replaces it.
- R60: Retiring a drive requires a reason (failed, replaced, other) and optionally takes a retirement date (default today, editable, can be cleared; an empty date means "not recorded", it cannot be in the future) (retirement date made optional 2026-10-11 at the owner's request: an unknown date is stored as not recorded rather than guessed). It optionally takes a note. (changed 2026-10-11 at the owner's request: 'replaced by' removed; slot history shows what replaced what) Retiring a drive that sits in a slot frees the slot and logs the event.
- R61: A retired drive can be reinstated as a spare. The retirement reason and date stay in the event history.
- R62: Retiring is available from the drive's detail panel at any time, and as an outcome in the missing-slot flow (R27). When assigning a drive to an occupied slot, the occupant resolution offers "Retire it" (broken or done) with a reason the user must choose (no preset), a date and a note, next to back to spares and RMA. (changed 2026-10-11 at the owner's request: 'replaced by' removed; slot history shows what replaced what)
- R68 (added 2026-10-11 at the owner's request; made optional 2026-10-11 at the owner's request: an unknown date is stored as not recorded rather than guessed): An installed drive may have an installation date. Assigning a spare defaults it to today, and it can be set to a past date or cleared ("not recorded"); a drive found in the NAS and placed from the inbox starts as not recorded. The date can be set, changed or cleared later while the drive is installed; the event log still records when the change was made.
- R69 (added 2026-10-11 at the owner's request): Returning a drive to spares takes an optional removal date, like R68's installation date. When the removal is done now ("Remove to spares", the occupant outcome, "Replace") it defaults to today and can be backdated or cleared; in the missing-drive flow (R27) it starts empty because the drive went missing at an unknown time. Empty means "not recorded" and is shown that way in the life story; the date cannot be in the future, before the installation date or before the pool membership start. The event log still records when the change was made. Retiring or sending for RMA takes its own optional date (R60).
- R70 (added 2026-10-11 at the owner's request): Slots are always chosen on a visual bay grid (the same grid as the Layout page, honoring rows, columns and orientation), never from a list: assigning from the spares shelf, from an empty slot and from the inbox. Occupied slots are selectable and lead to the occupant step (R37). An installed drive offers "Replace", which swaps it in one step: pick the replacement from the spares (same-type drives of at least the same capacity are suggested first, smaller ones carry a note, both capacities are shown, R60), one optional swap date (the new drive's installation date and the old drive's removal date, R68, R69), then what happens to the old drive (back to spares, retire with a reason, or RMA, R27, R62). Pool and role default from the old drive (R35).
- R71 (added 2026-10-11 at the owner's request): The Inbox is reached from the Drives page, not from the main navigation. The Drives page header has an "Inbox" button next to "Add drive" that shows the inbox count (R9) as a badge, prominent when the count is above zero and quiet at zero. The inbox page lives at `/drives/inbox` (the old `/inbox` redirects), has a back link to Drives, and keeps "Drives" highlighted in the navigation. Other links to the inbox (such as the "N in Inbox" chip) point there too. (The page is labelled "Discovered" in the UI, renamed 2026-10-11 at the owner's request.)
- R72 (added 2026-10-11 at the owner's request): For a drive record that currently matches an observation (R2), the app suggests updates to the model, capacity, type, form factor and WWN. A field the record lacks and the observation has is a "fill" suggestion; a field both have with different values (compared trimmed, case-insensitively for model, form factor and WWN; exactly for capacity and type) is a "differs" suggestion. Suggestions are computed on every read from the record and the cached snapshot (R54, R55), never stored, and never applied automatically (R10): the owner ticks fields in the drive detail and confirms, which edits the drive through the normal update path in one transaction and writes one `drive-updated` event marked `source: 'provider'` (R14, R53: no provider ID or field names). A suggestion that stopped applying is refused (409). Only "fill" suggestions raise indicators (an "Updates" flag on the Drives list, a "Suggested updates" section on the inbox page); "differs" suggestions stay quietly collapsed in the drive detail. Each suggestion can be dismissed (changed 2026-10-11 at the owner's request): `POST /api/drives/:id/suggestions/dismiss` writes one `suggestion-dismissed` event per field, `{ field, value }` with the value that was suggested, in one transaction (a field that is not currently suggested is refused, 409, nothing written). A suggestion is hidden while the drive's latest such event for that field carries the same value (compared as above); if the provider later reports a different value it shows again. Dismissed suggestions do not count toward any indicator or the `GET /api/suggestions` counts, stay listed in the drive detail behind "N dismissed", and `POST .../suggestions/undismiss` restores them by writing an event with `value: null` (the latest event per field decides). Nothing provider-specific is stored (R53).
- R73 (added 2026-10-11 at the owner's request): An installed drive has one Move action (replacing the separate "Replace" and "Remove to spares" buttons): it goes to the spares, another bay, retirement or RMA, optionally with a spare taking its place, as one step with one optional date; a move between bays keeps pool membership. The date (default today, empty = not recorded) is the removal, retirement or RMA date of this drive, its installation date in a new bay and the installation date of the incoming spare. Moving into an occupied bay asks what happens to that drive (R37). It is one API call and one transaction (R14). Retire stays a separate button for spares.
- R74 (added 2026-10-11 at the owner's request): Each slot has a history of every drive that occupied it, with installed and removed dates and how each left (moved to another slot, back to the spares, retired with its reason, or sent for RMA). It is computed from the event log on every read, never stored, and refers to the slot by its stable ID so renaming keeps it (R39). It is shown as the "Slot" tab of the History section (next to "Drive", the drive's own history) for an installed drive and for an occupied slot, and alone for an empty slot; a spare or retired drive shows only its own history. Unrecorded dates are shown as "not recorded" (R68, R69). The drive history links entries about a slot to that slot's history.
- R20 (moved into scope 2026-10-11 at the owner's request; was in the post-MVP backlog): Health changes are written to the drive's event log (R14). After each successful poll, every drive record that matches an observation of the active provider (R2, R55) is compared with its last recorded health, which is the `to` of its latest `health-changed` event (no extra column). The first report writes `health-changed` with `from: null`; a difference writes `{ from, to, reportedAt }`, where `reportedAt` is the observation's last-reported time and the event time is the poll time. Values are the normalized health values only (R53). All events of one poll are written in one transaction; a failed poll, or a snapshot from another provider, writes nothing. Staleness and decommissioned state are not health changes (R10, R63), and the drive's status is never touched (flag only). The life story reads "Health: OK → Warning" or "Health first reported: OK" with the health icon and colour, ordered by `reportedAt`.

### 4.3 Discovery and matching
- R2: Observations are matched to records by normalized serial, with WWN as a fallback. Never by device name (`sdX`) or provider-internal IDs.
- R26: Serials are normalized before comparison (trim whitespace, case-insensitive).
- R9: A "New drives discovered" inbox lists active (not decommissioned) observations whose serial matches no record. The UI flags when it is non-empty.
- R22: Resolving an inbox entry means linking it to an existing spare (fields the spare lacks are filled from the observation) or creating a new drive record from it.
- R25: If the observation's normalized serial matches an existing spare, the inbox suggests that spare. Nothing changes until you confirm.
- R24: On first run all observed drives appear in the inbox, so initial setup uses the same flow.
- R58: Observations without a serial (such as the empty `nvme0` record) are shown as "unidentified", informational only, and are not linkable or in the inbox.
- R63: A skippable "Import retired drives" step, offered after first-run setup and available later from the inbox page, lists decommissioned observations that have a serial and no matching record. For each, you pick a reason (failed, replaced, other). Bulk-applying a reason is allowed, but there is no silent default. The retirement date is prefilled from the observation's last-reported time (approximate, editable, and it can be cleared to record none, R60). Serial, model, capacity and type are filled from the observation. The observation's last known health is shown as a hint (for example "failed") and is never applied automatically. Decommissioned observations that match an existing record are not offered (that is the R10 case).

### 4.4 Missing and stale detection
- R10: A slot is flagged when its drive's observation is decommissioned, or when its last-reported time is older than the stale threshold while other drives are fresh. Flag only, never automatic changes.
- R27: A flagged slot shows "drive missing". The record stays "installed" until you choose an outcome: back to spares, retired (with a reason, see R60), or sent for RMA (retired as failed, plus an RMA event). The outcome is logged.
- R28: The stale threshold is configurable in hours. Its default is 1.5 x the provider's declared update interval (Scrutiny: 24h, so 36h).
- R56: Each provider declares an expected update interval.
- R47: If every tracked drive is stale at once, the UI shows one "provider data is stale" banner instead of flagging each slot.

### 4.5 Pools
- R29: Pool membership is a relationship between a drive and a pool, with a role (data, hot spare), a start and end date, and a source (manual or provider-suggested). It is always manually editable.
- R30: Pools are records in the app DB (name, layout label such as raidz2 or mirror). If the provider supports pools, its list can suggest or seed them, but it is not required.
- R31: Automatic membership detection is out of scope for the MVP (see section 2: leaves are identified by partition UUID only).
- R35: The assign-to-slot form asks for pool and role together with the slot. Pool and role default to those of the drive previously in that slot.
- R36: Pool and role stay editable later from the drive's detail panel.
- R33: Pool membership changes (joined, left, role change) are written to the drive's event log.

### 4.6 Provider port
- R1: The core manages drives, slots, spares, pools and events on its own. Drive data comes from a pluggable provider. Scrutiny is the first.
- R48: The core defines a TypeScript interface `DriveDataProvider` with a pull-based snapshot fetch and a connectivity check. The core imports nothing from any adapter.
- R49: Normalized observation shape (see Appendix A).
- R50: A provider declares capabilities: drives (required) and pools (optional).
- R51: Exactly one provider is active at a time, chosen in config at startup. Switching means changing config and restarting.
- R52: A built-in "none" provider (no observations) must work, so the app is fully usable by hand.
- R53: Adapters own provider quirks and mapping. No provider field names or enums reach the core, UI, DB or export.
- R54: Links are computed, not stored. Observations are matched by serial on each snapshot, and no provider IDs are saved.
- R55: The snapshot cache stores normalized observations tagged with a provider ID, and is discarded when the active provider changes.
- R18: The server polls the active provider on an interval and stores a normalized snapshot in SQLite. The UI shows a "last updated" time. If the provider is unreachable, the last known state stays visible, marked stale.
- R19: Poll interval is configurable, default 5 minutes.
- R32: Drives, spares, slots, memberships and events live in the app's own DB and stay fully usable when the provider is unreachable or removed.
- R57: A shared contract test suite that every adapter must pass. The Scrutiny adapter is tested against a real `/api/summary` capture as a fixture.

### 4.7 Scrutiny adapter
- R45: Adapter settings (base URL, optional bearer token) are namespaced environment variables owned by the adapter, not core settings.
- R46: Reads `/api/summary` unpaginated. Archived entries (included in the response) map to "decommissioned".
- R59: Mapping: drive type from rotational speed (0 means SSD) and protocol (NVMe). Missing SMART data maps to health "unknown", never "ok". An empty form factor is tolerated. Health mapping: see Appendix B.

### 4.8 Slot display (MVP)
- R15: Each slot shows the slot label, a normalized health color and an empty-slot style. Clicking opens a detail panel with the full record and event log.

### 4.9 Export and import
- R41: A button exports all app data (enclosures, grids, slots, drives, pools, memberships, events) as one JSON file.
- R42: The export contains a schema version and excludes the snapshot cache.
- R43: A matching import restores an export. It replaces all existing data and asks for confirmation first.
- R44: Before an import overwrites anything, the app saves an export of the current data automatically.

### 4.10 Platform
- R16: TypeScript, one container serving the API and the web UI, SQLite in a single file on a mounted volume.
- R17: Runs on a trusted LAN with no authentication.
- R66: A `Dockerfile` in the repo root builds the image: multi-stage, runs as a non-root user, listens on `PORT`, stores data in the `/data` volume.
- R67: `GET /api/health` returns 200 with a small JSON body. It does not depend on the provider, so it stays healthy when the provider is down. Used by the compose healthcheck.

### 4.11 Delivery
- R64: `README.md` in the repo root contains: overview, status, a docker compose example (published GHCR image, port, `/data` volume, provider env vars, healthcheck), a configuration table, provider notes (Scrutiny, none), backup and restore (export/import), image tags and how CI publishes them, and development notes.
- R65: A GitHub Actions workflow `.github/workflows/build.yml`:
  - Triggers: push to `main`, version tags (`v*`), pull requests, manual dispatch.
  - Job 1: install Node, run lint, typecheck and tests (each skipped if the package script does not exist yet).
  - Job 2: build a multi-arch image (linux/amd64 and linux/arm64) with Buildx. Push to GHCR only on `main` and version tags. Pull requests build without pushing.
  - Image tags: `latest` (main), `X.Y.Z` and `X.Y` (version tags), `sha-<short>`.
  - Uses the built-in `GITHUB_TOKEN` with `packages: write` on the image job only, a GitHub Actions build cache, and provenance attestations disabled to keep the GHCR platform listing clean.

## 5. Non-goals
- N1: Authentication or user management.
- N2 (MVP): Calling the TrueNAS API.
- N3 (MVP): Scheduled automatic exports.

## 6. Post-MVP backlog
- R12: Compatibility check "can this spare replace the drive in slot X?" (type, capacity, pool of the current occupant). For pools like `big`, compare against the vdev's usable per-disk size (smallest member), not the replaced drive's size. To confirm when designing.
- R34: Pool leaf-count sanity check against the provider's reported count.
- Richer slot display: model, capacity, serial, temperature, pool badge.
- Several providers at once with priority (observations are already tagged by provider).
- Automatic pool membership (resolve partition UUIDs via `/dev/disk/by-partuuid` and `by-id`, or the TrueNAS API).
- Scheduled automatic exports.
- Dependabot for GitHub Actions and npm packages.

## 7. Defaults (confirmed)
- D1: Container port default 3000 (Scrutiny uses 8080 and 8086).
- D2: Config via environment variables. SQLite at `/data/app.db` on the mounted volume.
- D3: Timestamps stored in UTC and displayed in the browser's local time.
- D4: Capacities displayed in decimal units (4 TB), matching drive labels.
- D5: Drive records are never hard-deleted in the MVP. Use the "retired" status with a reason (R60).
- D6: Serial numbers are unique across drive records. Duplicates are blocked on entry.
- D7: One drive per slot, and one slot per drive.
- D8: The UI is responsive and usable on a phone.
- D9: Frontend: React + Vite + TypeScript, served as a static bundle by the backend (one image, one port). Mantine for components, TanStack Query for data fetching, React Router for pages, and zod schemas shared between API and UI (also used for the export/import format). Project structure is decided in the implementation plan.
- D10: Image platforms: linux/amd64 and linux/arm64.
- D11: The image is published to GitHub Container Registry (`ghcr.io/<owner>/<repo>`).
- D12: Project name: Sparrow. Repository, image and container are named `sparrow` (image `ghcr.io/<owner>/sparrow`).
- D13: Package manager: pnpm (workspaces), pinned with the `packageManager` field. CI and the Dockerfile use it.

## Appendix A: Normalized observation (R49)

| Field | Type | Notes |
|---|---|---|
| serial | string | Required for linking. Observations without it are "unidentified" (R58). |
| wwn | string, optional | Fallback match only. |
| model | string, optional | |
| capacityBytes | number, optional | |
| driveType | HDD / SSD / NVMe, optional | |
| formFactor | string, optional | |
| health | ok / warning / failed / unknown | Mapped by the adapter. |
| lastReportedAt | ISO timestamp | Basis for staleness (R10, R28) and the retirement date prefill (R63). |
| state | active / decommissioned | |
| temperatureC | number, optional | |
| detailUrl | string, optional | Link back to the provider's own page. |

## Appendix B: Scrutiny health mapping (R59)

Inputs: `device_status` (bit field: 1 = SMART failed, 2 = Scrutiny threshold failed; consistent with the README's health labels, to verify in the adapter tests) and `risk_category`.

| Normalized health | Condition |
|---|---|
| failed (red) | SMART-failed bit set, or risk is `replace_soon` |
| warning (amber) | Scrutiny-failed bit set, or risk is `plan_replacement` |
| ok (green) | Otherwise (`monitor` counts as ok) |
| unknown | No SMART data |

A stale drive keeps its last known health, marked stale. Raw provider details are shown in the drive's detail panel.

## Appendix C: Configuration (suggested)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | HTTP port |
| `DATA_DIR` | `/data` | SQLite and exports |
| `PROVIDER` | `none` | `scrutiny` or `none` |
| `POLL_INTERVAL_MINUTES` | 5 | R19 |
| `STALE_AFTER_HOURS` | derived (36 for Scrutiny) | R28 |
| `SCRUTINY_URL` | none | Adapter setting (R45) |
| `SCRUTINY_TOKEN` | none | Optional, if Scrutiny auth is enabled |
