# Sparrow

*Your spares, in rows.*

> **Status: pre-release.** This README describes the planned MVP (see `REQUIREMENTS.md`). Names, ports and options may change before the first release.

A small self-hosted web app, run as one Docker container on your NAS, that:

- shows **where each drive physically sits**, using named grids of slots (for example "Front bays" as a 4x2 grid, "Internal SSDs", "Boot");
- tracks your **cold spares** and every drive's lifecycle: spare, installed, retired (failed, replaced or other), with purchase and warranty info and a per-drive event log;
- optionally **enriches this with live health data** from a pluggable provider. [Scrutiny](https://github.com/Starosdev/scrutiny) is the first.

The core works on its own. If the provider is unreachable, replaced or removed, your layout, drives and history stay fully usable.

## Quick start

Create a `docker-compose.yml`:

```yaml
services:
  sparrow:
    image: ghcr.io/OWNER/sparrow:latest   # replace OWNER with the GitHub account or org
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

- **Data directory.** On a NAS, point the volume at a dataset or share (for example `/mnt/<pool>/apps/sparrow/data:/data`) and make sure the container user can write to it.
- **Image access.** A newly published package on GitHub Container Registry may be private. If your NAS cannot pull it, set the package to public in its GitHub settings, or run `docker login ghcr.io` with a personal access token that has `read:packages`.
- **No authentication.** The app has no login by design. Run it on a trusted LAN only, and do not expose it to the internet.

## First run

1. Create your enclosure and grids in the UI (name, rows, columns, slot labels).
2. Open the **New drives discovered** inbox. Every drive the provider reports appears there. Link each one to an existing spare, or create a new record, and assign it to a slot (with its pool and role).
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

All app data lives in the SQLite file in `/data`. You can also use **Export** in the UI to download everything (layout, drives, pools, memberships, events) as one JSON file, and **Import** to restore it. Import replaces all existing data, asks for confirmation, and first saves an export of the current data.

## Images and CI

A GitHub Actions workflow (`.github/workflows/build.yml`) runs lint, type checks and tests, then builds a multi-arch image (`linux/amd64`, `linux/arm64`).

| Event | Published tags |
|---|---|
| Push to `main` | `latest`, `sha-<short>` |
| Version tag `vX.Y.Z` | `X.Y.Z`, `X.Y`, `sha-<short>` |
| Pull request | built, not pushed |

Images are published to `ghcr.io/<owner>/<repo>`, so name the repository `sparrow` to match the compose example.

## Development

Planned: Node.js and TypeScript, one container serving the API and the web UI. The project uses pnpm. Scripts expected by CI: `pnpm lint`, `pnpm typecheck`, `pnpm test`. Each is skipped by the pipeline until it exists, so tighten the workflow once they do.

See `REQUIREMENTS.md` for the full requirements, and `AGENTS.md` and `IMPLEMENTATION_PLAN.md` once they exist.

## License

To be decided.
