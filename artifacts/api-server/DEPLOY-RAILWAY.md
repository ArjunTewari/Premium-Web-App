# Deploying Emerald AI to Railway (single service, same-origin)

The report pipeline runs 15–30 min for 15–16 orgs. Vercel functions cap at
300 s (≤ 800 s on Pro), so the job is killed mid-run there. Railway runs the
Express server as a normal long-lived process with **no request-duration cap**,
so `POST /api/run` can stream for as long as it needs and the frontend's
`/api/run/status/:runId` poll (already implemented, 45-min budget) recovers the
result if the SSE socket drops.

## Layout

**One Railway service** builds the Vite frontend *and* the API, then the Express
server serves the static `emerald-web` bundle itself (`src/app.ts`). Frontend and
API share one origin → the existing relative `/api/...` calls and
`sameSite: "lax"` auth cookies keep working with **zero frontend changes**.

## Build & start commands

Root directory: repo root (`/`).

**Build:**
```
pnpm install --frozen-lockfile && BASE_PATH=/ PORT=8080 pnpm --filter @workspace/emerald-web run build && pnpm --filter @workspace/api-server run build
```
- `@workspace/db` / `@workspace/api-zod` have no build step — esbuild bundles
  them from source, so they need no pre-build.
- `BASE_PATH` / `PORT` are required by `emerald-web/vite.config.ts` at build time
  only. Values are inlined here so they don't depend on Railway env.

**Start:**
```
node --enable-source-maps artifacts/api-server/dist/index.mjs
```

**Healthcheck path:** `/api/healthz`

## Environment variables (set in Railway → service → Variables)

Required:
| Var | Notes |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` — references the Railway Postgres service in the same project. (Or paste an external Postgres URL.) |
| `JWT_SECRET` | any long random string — **required in production** (`lib/auth.ts` throws without it) |
| `SERPER_KEY` | |
| `CLAUDE_KEY` | |
| `FIRECRAWL_KEY` | |

Used when present (report sections degrade gracefully if missing):
`OPENAI_KEY`, `PERPLEXITY_KEY`, `GEMINI_KEY`, `YOUTUBE_KEY`, `X_BEARER_TOKEN`,
`APIDIRECT_KEY`, `META_ACCESS_TOKEN`, `IG_BUSINESS_ACCOUNT_ID`.

Admin seed (first deploy against an **empty** database): set
`SEED_ADMIN=true` + `ADMIN_INITIAL_PASSWORD=<pick one>`. On boot the server
creates its tables (`src/lib/ensure-schema.ts`) and then inserts the `admin`
user. Remove both vars once you've logged in and changed the password.

Performance tuning (optional — sensible defaults baked in):
| Var | Default | Effect |
|---|---|---|
| `FIRECRAWL_CONCURRENCY` | `5` | Per-org Firecrawl searches in flight (print + TV steps) |
| `FIRECRAWL_MAX_AGE_MS` | `172800000` (2 days) | Serve cached page scrapes this fresh — big win on re-runs; set `0` to disable |
| `YT_CONCURRENCY` | `4` | Orgs scanned in parallel in the YouTube ER step |

Railway injects `PORT` at runtime; `src/index.ts` reads it.

## Persistent report storage (recommended)

Generated HTML is written to `<cwd>/outputs` and served by `/api/download/:file`.
On Railway the container filesystem is wiped on every deploy. Attach a **volume**
mounted at `/app/outputs` so past reports survive redeploys. (`/api/admin/reports`
also logs each run to Postgres, so metadata is safe regardless.)

## After first deploy

1. `generate-domain` → gives `*.up.railway.app`. Open it — the login page should
   render from the same origin that serves `/api`.
2. Log in, run a 2-org report to smoke-test, then a full 15–16 org run.
3. Point any existing DNS / bookmarks at the Railway domain. The Vercel project
   can be paused once traffic is cut over.

## Schema bootstrap

There is **no separate migration step**. `src/index.ts` calls `ensureSchema()`
before the server accepts traffic — plain `CREATE TABLE IF NOT EXISTS`, a no-op
on an existing database. A real schema *change* later still goes through
`pnpm --filter @workspace/db run push` against the database; `drizzle` stays the
source of truth (`lib/db/src/schema/index.ts`), and `ensure-schema.ts` mirrors it.

## Note on the pre-existing Railway project

`agile-enthusiasm` (project `6df68010-8e7a-4773-a6a5-1300cba2fbab`) is already set
up: the **`@workspace/api-server`** service (`aace5646-…`) has the build/start/
healthcheck config above and domain
`workspaceapi-server-production-79c5.up.railway.app`, and a **`Postgres`** service
(`ed62e6bd-…`) is provisioned with a managed volume. The 4 other auto-imported
workspace services are all `FAILED` — ignore or delete them.
