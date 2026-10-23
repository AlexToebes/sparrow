# Sparrow

*Your spares, in rows.*

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
- **Upgrading.** From the 2026-10-23 release on, databases are upgraded in place: new versions bring numbered migrations that run at startup and keep your data. Back up the data directory (or use Export) before upgrading if you want a way back. Databases created by pre-release builds (before 2026-10-23) cannot be upgraded and need a fresh data directory: delete `app.db`, `app.db-wal` and `app.db-shm` before starting this version. Exports made by builds before the activity model (schema version 1 or 2) cannot be imported.
- **"This database was created by an incompatible pre-release build".** The same rule, enforced at startup: if `app.db` lacks tables or columns the current build needs, Sparrow exits with that message instead of failing later. Stop the container, delete `app.db`, `app.db-wal` and `app.db-shm` in the data directory and start again.
- **Image access.** A newly published package on GitHub Container Registry may be private. If your NAS cannot pull it, set the package to public in its GitHub settings, or run `docker login ghcr.io` with a personal access token that has `read:packages`.
- **No authentication.** The app has no login by design. Run it on a trusted LAN only, and do not expose it to the internet.

## First run

1. A new install opens the **setup wizard** on the Layout page. It walks you through naming your enclosure, adding grids of bays (pick a preset such as "8 bays (4 × 2)" or build a custom grid, and rename any bay) and, if you like, your pools; nothing is saved until you press **Create**. You can skip it ("Skip, I'll set it up later") and run it later from the Layout page or Settings > Layout, or build the layout by hand in Settings.
2. Open **Discovered** (the Discovered button on the Drives page). Every drive the provider reports appears there. Link each one to an existing drive record (a spare is assigned to a slot, an installed drive stays where it is), or create a new record and assign it to a slot (with its pool and role).
3. Optional: use **Import retired drives** to create "retired" records from drives the provider has decommissioned (for example archived in Scrutiny). Pick a reason for each: failed, replaced or other.

Sparrow ships a web app manifest and icons, so on a phone you can use "Add to Home Screen" to open it like an app.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port inside the container |
| `HOST` | `0.0.0.0` | Address the server binds to (use `127.0.0.1` behind a local reverse proxy) |
| `WEB_DIST_DIR` | `packages/web/dist` (the image sets `/app/web`) | Where the built web UI is served from; leave unset unless you build your own image |
| `ALLOWED_HOSTS` | unset (any) | Optional comma-separated host names the server answers to, for example `sparrow.lan,192.168.1.20`. Other `Host` headers get 403 (guards against DNS rebinding). `/api/health` is exempt |
| `DATA_DIR` | `/data` | Where the SQLite database (`app.db`) and exports are stored |
| `PROVIDER` | `none` | `scrutiny` or `none` |
| `POLL_INTERVAL_MINUTES` | `5` | How often the provider is polled |
| `STALE_AFTER_HOURS` | derived (36 for Scrutiny) | A drive not reported for this long is flagged as missing |
| `SCRUTINY_URL` | none | Scrutiny base URL (used when `PROVIDER=scrutiny`) |
| `SCRUTINY_TOKEN` | none | Optional bearer token, if Scrutiny API auth is enabled |

## Security

Sparrow has no login (N1): run it on a trusted network, or put an authenticating reverse proxy in front. It does close the doors a web page on another site could use against a server on your LAN: every write (`POST`, `PATCH`, `DELETE` under `/api`) must send `content-type: application/json`, otherwise the answer is 415 (a browser cannot send that cross-site without a CORS preflight, which Sparrow never grants); responses carry `Content-Security-Policy: frame-ancestors 'none'`, `X-Frame-Options: DENY` and `X-Content-Type-Options: nosniff`; and `ALLOWED_HOSTS` can restrict the host names the server answers to. Scripts that call the API with `curl -X POST` need `-H 'content-type: application/json' -d '{}'`.

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
- Dependabot (`.github/dependabot.yml`) opens weekly update PRs for npm packages, GitHub Actions and the pinned Docker base image, with minor and patch updates grouped.
- Tests (`pnpm test`) run against the TypeScript sources through a `source` export condition, so no build is needed first.
- Build the image locally with `docker build -t sparrow .`. It is multi-stage on `node:24-slim`, runs as the non-root `node` user, listens on `PORT` (3000), keeps data in the `/data` volume and has a health check on `/api/health`.

See `REQUIREMENTS.md` for the full requirements, and `AGENTS.md` and `IMPLEMENTATION_PLAN.md` for how the project is built.

## License

To be decided.
