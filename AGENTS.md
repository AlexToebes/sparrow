# AGENTS.md

Instructions for AI coding agents working on Sparrow. Read this file first in every session, then `IMPLEMENTATION_PLAN.md`.

## 1. What this project is

Sparrow is a self-hosted web app (one Docker container) that shows where each drive physically sits in a NAS and tracks cold spares and drive lifecycle. Live health data comes from a pluggable provider (Scrutiny first). The core must work fully without any provider.

Source of truth for behavior: `REQUIREMENTS.md` (requirement IDs like R27, defaults like D6). If code and requirements disagree, the requirements win. If the requirements are wrong or ambiguous, stop and ask. Do not guess, and do not edit `REQUIREMENTS.md` silently.

## 2. Stack (decided, see D9, D10, R16)

| Concern | Choice |
|---|---|
| Language | TypeScript (strict), Node 24, ESM |
| Package manager | pnpm (workspaces), pinned via the `packageManager` field in the root `package.json`; no npm or yarn lockfiles |
| Layout | pnpm workspace: `packages/shared`, `packages/server`, `packages/web` (`pnpm-workspace.yaml`) |
| Backend | Fastify, one process serving `/api/*` and the built web bundle |
| Database | SQLite via `better-sqlite3`, Drizzle ORM with SQL migrations, file at `$DATA_DIR/app.db` |
| Validation | zod schemas in `packages/shared`, used by API, UI and export/import |
| Frontend | React + Vite, Mantine, TanStack Query, React Router |
| Tests | Vitest (all packages), React Testing Library for UI |
| Lint | ESLint + Prettier |
| Image | Multi-stage Dockerfile on `node:24-slim` (not Alpine, to avoid native module issues on arm64), non-root user |

Do not add a dependency that is not in this table without a stated reason in the commit message. Prefer the standard library.

## 3. Architecture rules (non-negotiable)

1. **Ports and adapters.** `packages/server/src/core` never imports from `packages/server/src/providers/*` (except the registry in `providers/index.ts`, which is wired in `main.ts` only). Enforce with an ESLint `no-restricted-imports` rule.
2. **No provider vocabulary in the core.** Scrutiny field names (`device_status`, `wwn`, `risk_category`, `collector_date`, and so on), enums and IDs appear only inside `providers/scrutiny/`. The DB schema, API, UI and export never contain them (R53).
3. **Links are computed, never stored.** Match observations to drive records by normalized serial on every read (R2, R26, R54). Never store a provider ID. Never match on `sdX`.
4. **The app owns its records.** Layout, drives, pools, memberships and events live in SQLite and keep working when the provider is down or `none` (R32).
5. **Flag, never auto-change.** Missing or stale drives are flagged only. Status changes happen through an explicit user action and write an event (R10, R27).
6. **Every state change writes an event** in the same transaction as the change (R14, R33).
7. **No hard deletes of drives** (D5). Retire instead.
8. **Timestamps** are stored as UTC ISO strings and displayed in the browser's local time (D3). **Capacities** are decimal units (D4).
9. **No authentication** (N1). Do not add any.

## 4. Repository layout

```
.
├── AGENTS.md
├── IMPLEMENTATION_PLAN.md
├── REQUIREMENTS.md
├── README.md
├── Dockerfile
├── package.json                  # root scripts + packageManager pin
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── .github/workflows/build.yml
└── packages/
    ├── shared/                   # zod schemas + inferred types (drive, slot, pool, event, observation, export)
    ├── server/
    │   ├── src/
    │   │   ├── core/             # domain services, no provider imports
    │   │   ├── db/               # drizzle schema, migrations, repositories
    │   │   ├── providers/
    │   │   │   ├── port.ts       # DriveDataProvider interface (R48)
    │   │   │   ├── none/
    │   │   │   ├── scrutiny/     # adapter, mapping, fixtures in test/fixtures
    │   │   │   ├── contract.ts   # shared contract tests (R57)
    │   │   │   └── index.ts      # registry
    │   │   ├── api/              # Fastify routes, thin: parse, call core, return
    │   │   └── main.ts           # config, wiring, startup
    │   └── test/
    └── web/
        └── src/                  # pages, components, api hooks
```

## 5. Commands

Root scripts (all must exist and pass before any commit; CI runs them):

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build        # builds shared, server and web
pnpm dev          # server with watch + Vite dev server proxying /api
```

## 6. Working agreement

- **One plan step per session.** Pick the first unchecked step in `IMPLEMENTATION_PLAN.md`, finish it, tick it, stop.
- **Tests first for logic.** For core services and adapters, write failing tests that cite the requirement ID, then implement. UI: test the flows that matter (assign, retire, inbox), not styling.
- **Cite requirement IDs** in test names and commit messages (for example `R37: block assigning to an occupied slot`).
- **Small commits**, one logical change each, imperative subject line, body explains why.
- **Do not change scope.** New ideas go to the "Parking lot" section at the bottom of `IMPLEMENTATION_PLAN.md`, not into code.
- **Definition of done** for a step: acceptance criteria met, `lint`, `typecheck` and `test` green, plan step ticked with a one-line note of anything surprising, no TODOs left in code without a plan entry.
- **Ask before** changing a requirement, adding a dependency, changing the DB schema after step 1 without a migration, or touching `.github/workflows/build.yml` beyond what a step says.
- **Never** commit secrets, real serial numbers beyond the sanitized test fixture, or the contents of `/data`.

## 7. Test data

- `packages/server/test/fixtures/scrutiny-summary.json` is a real `/api/summary` capture (R57). Serial numbers in it are fine for tests but must not be copied into docs or the README.
- It includes the awkward cases the adapter must handle: archived drives, an empty `nvme0` record without serial or WWN, an NVMe whose "WWN" is its lowercase serial, stale `collector_date`, empty form factor, and `device_status` and `risk_category` that disagree.
- Expected values in adapter tests are written by hand from Appendix B, not generated from the adapter's own output.

## 8. UI conventions

- Mobile first, usable on a phone (D8).
- Health colors: ok green, warning amber, failed red, unknown grey. Never rely on color alone; add an icon or text.
- Stale data is shown as stale (hatched or labelled), never hidden (R18, R47).
- One bay grid component, driven by grid dimensions and orientation (R4, R7). No hardcoded 4x2.
- Destructive or overwriting actions (import, retire) always confirm first.
- Visual design direction (approved by the owner): `docs/UI_DESIGN.md`. Prototypes in `docs/design/prototypes/` are reference only.

## 9. When stuck

State what you tried, what you expected and what happened, then stop and ask. Do not loop on the same failing approach more than twice.
