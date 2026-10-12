# Sparrow

*Your spares, in rows.*

> **Status: pre-release.** This README describes the planned MVP (see `REQUIREMENTS.md`). Names, ports and options may change before the first release.

A small self-hosted web app, run as one Docker container on your NAS, that:

- shows **where each drive physically sits**, using named grids of slots (for example "Front bays" as a 4x2 grid, "Internal SSDs", "Boot");
- tracks your **cold spares** and every drive's lifecycle: spare, installed, retired (failed, replaced or other), with purchase and warranty info and a per-drive history (a log of activities, each made of atomic events);
- optionally **enriches this with live health data** from a pluggable provider. [Scrutiny](https://github.com/Starosdev/scrutiny) is the first.

The core works on its own. If the provider is unreachable, replaced or removed, your layout, drives and history stay fully usable.

## Quick start

Create a `docker-compose.yml`:

```yaml
services:
  sparrow:
    image: ghcr.io/alextoebes/sparrow:latest   # or ...:sha-<short> to pin an exact build
    container_name: sparrow
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      PROVIDER: scrutiny                 # "scrutiny" or "none" (manual only)
      SCRUTINY_URL: http://NAS_IP:8080   # your Scrutiny base URL
      # SCRUTINY_TOKEN: ""               # only if Scrutiny API auth is enabled
      # POLL_INTERVAL_MINUTES: "5"
      # STALE_AFTER_HOURS: "36"          # default: 1.5 x the provider's update interval
    volumes:
      - ./data:/data                     # SQLite database lives here
    # user: "568:568"                    # if your NAS needs a specific uid:gid to write to ./data
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s
```

Start it and open `http://NAS_IP:3000`:

```bash
docker compose up -d
```

Notes:

- **Data directory.** On a NAS, point the volume at a dataset or share (for example `/mnt/<pool>/apps/sparrow/data:/data`) and make sure the container user can write to it. The image runs as the non-root `node` user (uid and gid 1000), so a bind-mounted directory needs `chown 1000:1000 data` (or set `user:` in the compose file to the owner of the directory). On TrueNAS, if the dataset is owned by the `apps` user, set `user: "568:568"` instead. A named volume works without this. If the directory is not writable, the app exits at startup with a message naming the path and the uid it runs as.
- **Upgrading from an early build.** The database migrations are a single baseline that was edited in place before the first release (most recently for the activity model: a drive installed in a bay is an installation row that carries its pool, and history is a log of activities made of atomic events), so a database created by an earlier build cannot be upgraded. This build needs a fresh data directory again: delete the data directory's `app.db`, `app.db-wal` and `app.db-shm` before starting this version. Exports made by earlier builds (schema version 1 or 2) use the old format and cannot be imported into this one (they are rejected with a clear message), so there is no way to carry that data over.
- **Image access.** A newly published package on GitHub Container Registry may be private. If your NAS cannot pull it, set the package to public in its GitHub settings, or run `docker login ghcr.io` with a personal access token that has `read:packages`.
- **No authentication.** The app has no login by design. Run it on a trusted LAN only, and do not expose it to the internet.

## First run

1. Create your enclosure and grids in the UI (name, rows, columns, slot labels).
2. Open **Discovered** (the Discovered button on the Drives page). Every drive the provider reports appears there. Link each one to an existing spare, or create a new record, and assign it to a slot (with its pool and role).
3. Optional: use **Import retired drives** to create "retired" records from drives the provider has decommissioned (for example archived in Scrutiny). Pick a reason for each: failed, replaced or other.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port inside the container |
| `DATA_DIR` | `/data` | Where the SQLite database (`app.db`) and exports are stored |
| `PROVIDER` | `none` | `scrutiny` or `none` |
| `POLL_INTERVAL_MINUTES` | `5` | How often the provider is polled |
| `STALE_AFTER_HOURS` | derived (36 for Scrutiny) | A drive not reported for this long is flagged as missing |
| `SCRUTINY_URL` | none | Scrutiny base URL (used when `PROVIDER=scrutiny`) |
| `SCRUTINY_TOKEN` | none | Optional bearer token, if Scrutiny API auth is enabled |

## Providers

- **`scrutiny`**: reads `/api/summary` from Scrutiny. Drives are matched to your records by serial number. Health comes from Scrutiny's SMART status and replacement-risk rating. Scrutiny archives map to "decommissioned". The SMART collector runs daily by default, so the "missing drive" check works on a roughly 36 hour threshold.
- **`none`**: no live data. Everything is managed by hand.

Switching providers means changing `PROVIDER` and restarting. Nothing needs re-linking, because drives are matched by serial number on every poll.

## Backup and restore

All app data lives in the SQLite file in `/data`. You can also use **Export** in the UI to download everything (layout, drives, installations, pools, the activity log) as one JSON file, and **Import** to restore it. Import replaces all existing data, asks for confirmation, and first saves an export of the current data.

## Images and CI

A GitHub Actions workflow (`.github/workflows/build.yml`) runs lint, type checks, tests and the build, then builds a multi-arch image (`linux/amd64`, `linux/arm64`).

| Event | Published tags |
|---|---|
| Push to `main` | `latest`, `sha-<short>` |
| Version tag `vX.Y.Z` | `X.Y.Z`, `X.Y`, `sha-<short>` |
| Pull request | built, not pushed |

Images are published to `ghcr.io/alextoebes/sparrow`. Use `latest` to follow `main`, or a `sha-<short commit>` tag (for example `sha-250db1a`) to pin a specific build.

## Development

Requirements: Node.js 22.12 or newer (the image uses Node 24) and pnpm (the version is pinned in `package.json`; `corepack enable` picks it up).

```bash
pnpm install --frozen-lockfile
pnpm dev          # compiles shared + server in watch mode, restarts the server, and runs Vite
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

- `pnpm dev` serves the API on `http://localhost:3000` (data in `./data`, override with `DATA_DIR`; other settings are the environment variables above) and the web UI with hot reload on `http://localhost:5173`, which proxies `/api` to the server. Open the 5173 address.
- `pnpm build` compiles `packages/shared` and `packages/server` to `dist/` and bundles `packages/web` to `packages/web/dist`. After a build, `node packages/server/dist/main.js` serves the API and the UI on one port (`WEB_DIST_DIR` overrides the bundle location; the image sets it to `/app/web`).
- Tests (`pnpm test`) run against the TypeScript sources through a `source` export condition, so no build is needed first.
- Build the image locally with `docker build -t sparrow .`. It is multi-stage on `node:24-slim`, runs as the non-root `node` user, listens on `PORT` (3000), keeps data in the `/data` volume and has a health check on `/api/health`.

See `REQUIREMENTS.md` for the full requirements, and `AGENTS.md` and `IMPLEMENTATION_PLAN.md` for how the project is built.

## License

To be decided.
