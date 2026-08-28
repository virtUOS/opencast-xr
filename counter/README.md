# opencast-xr-counter

A small, standalone, anonymous visitor counter for the
[Opencast-XR player](../README.md). It exists to answer exactly three
questions an operator asked for, and nothing more:

- How many people visit, and on which days?
- Roughly which country do they come from?
- Did they open it in an actual VR/AR headset, or just in a flat browser?

Nothing else is tracked. In particular: **no IP address is ever written to
disk**, and **no video/episode identifier is ever sent to this service at
all** (the player beacon — see `../src/telemetry.ts` — only ever sends
`{"kind": "page" | "vr" | "ar"}`, with no reference to what's playing).

This is a separate Node package from the player app on purpose — it has its
own runtime (a systemd service, not a static file), its own tiny dependency
footprint, and no reason to share the player's `pnpm install`/build pipeline.

## Endpoints

- `POST /api/hit` — body `{"kind": "page" | "vr" | "ar"}`, nothing else.
  Rejects anything that doesn't match exactly (extra fields, wrong types,
  bodies over 256 bytes) with `400`/`413`. Responds `204` on success; the
  response never waits on the disk write (see "Persistence" below).
- `GET /stats` — a self-contained German HTML page: totals, last 30 days
  (as a table with a small bar per day), totals per country, and the
  VR/AR/browser-only split. No external assets, no JavaScript. **Must be
  put behind authentication by the reverse proxy** — see the install guide's
  Caddyfile stanza with `basic_auth`. The service itself has no login of its
  own and binds `127.0.0.1` only.
- `GET /stats.json` — the same aggregate data as raw JSON (plus a
  `generatedAt` timestamp), for scripting/monitoring.

## What's kept in memory only, and what's persisted

| Data | Where | How long |
|---|---|---|
| Client IP address | RAM only, inside one request handler | Discarded after that request; never logged, never written anywhere |
| Per-day HMAC(salt, ip) dedup set | RAM only | Until the next UTC day starts (see below) |
| Daily dedup salt | RAM only, random per day | Same — never persisted, so a process restart loses that day's dedup and a returning visitor is briefly counted as "new" again. Accepted trade-off: the alternative is persisting an IP-derived artifact to disk, which is exactly what this service exists to avoid. |
| `{date → country → {pageHits, uniqueVisitors, vrSessions, arSessions}}` | `COUNTER_STATE_FILE` (JSON, atomic writes) | Forever (until an operator deletes it) |

See `src/dedup.js` and `src/aggregate.js` for the code this table describes.

## Country lookup (GeoIP)

Uses a local [db-ip.com "Country Lite"](https://db-ip.com/db/download/ip-to-country-lite)
`.mmdb` file — free, no account/API key, licensed **CC BY 4.0** (attribution
is on the `/stats` page itself, so operators don't have to add it anywhere).

Download it once as part of setup:

```bash
curl -fsSL "https://download.db-ip.com/free/dbip-country-lite-$(date -u +%Y-%m).mmdb.gz" \
  | gunzip > dbip-country-lite.mmdb
```

or use `scripts/update-mmdb.sh`, which does exactly that and installs it at
the path the systemd unit expects. The database is monthly-versioned by db-ip
(hence the `-YYYY-MM-` in the URL); refreshing it is optional (IP-to-country
assignments drift slowly) but the script can be re-run any time, e.g. from a
monthly cron/systemd timer.

If the file is missing or fails to open, every hit is recorded under the
`"ZZ"` ("unknown") country bucket instead of failing the request — see
`src/geo.js`. **This repository ships no `.mmdb` file and no test exercises
real GeoIP data** — the lookup is abstracted behind a single function type
(`CountryLookup`) and tests inject a fixture (`createFixtureCountryLookup`).

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `COUNTER_PORT` | `8787` | TCP port to listen on. Host is always `127.0.0.1` — not configurable, this is never meant to be reached directly. |
| `COUNTER_STATE_FILE` | `./data/state.json` | Path to the persisted aggregate JSON. |
| `COUNTER_MMDB_PATH` | `./data/dbip-country-lite.mmdb` | Path to the db-ip `.mmdb` file. |
| `COUNTER_TRUST_PROXY` | unset (`0`) | Set to `1` **only** when a reverse proxy you control (Caddy, per the install guide) is the sole path to this service and sets `X-Forwarded-For` itself. With this unset, any `X-Forwarded-For` header is ignored and the raw TCP peer address is used instead — otherwise a direct caller could forge its own "country" by sending the header itself. |
| `COUNTER_FAKE_GEO` | unset | Dev/manual-testing escape hatch only: a JSON object literal (`{"127.0.0.1":"DE"}`) used instead of opening a real `.mmdb` file. Never set this in production. |

## Running it

```bash
cd counter
pnpm install
pnpm start        # node server.js
```

### Tests

The counter is its own package with its own `vitest` — it does **not** run
as part of the root player app's `pnpm test` (separate runtime, separate
`node_modules`, no shared config). Run it from `counter/`:

```bash
cd counter
pnpm install
pnpm test
```

### Type checking

Written as plain modern JS with JSDoc type annotations (`// @ts-check` at
the top of every `src/*.js` file) rather than TypeScript — this is a service
meant to be deployed by copying files and running `node server.js` directly,
with no build/compile step in the middle. `tsc --noEmit` (via the `checkJs`
tsconfig) still gives full type checking:

```bash
cd counter
pnpm install
pnpm run typecheck
```

## Deployment

See [`../docs/INSTALL-rocky-linux-10.md`](../docs/INSTALL-rocky-linux-10.md),
section 9, for the full Rocky Linux 10 walkthrough: systemd unit
(`opencast-xr-counter.service`, `DynamicUser`, `StateDirectory`,
`ProtectSystem=strict`), the Caddy `handle` blocks for `/api/hit` and
`/stats` (with `basic_auth` on the latter), and firewalld (spoiler: nothing
new needs opening — Caddy is the only thing that talks to this service, over
loopback).
