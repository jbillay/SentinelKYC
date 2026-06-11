# Postgres setup (one-time, manual)

Docker is not allowed on this machine — Postgres runs natively. These steps are Windows-first; they only need to run once per dev environment. Tested on Postgres 17 (already installed at `C:\Program Files\PostgreSQL\17`).

## 1. Install Postgres 17 (skip if already installed)

Either route works. Pick one.

**Option A — winget (recommended)**

```powershell
winget install -e --id PostgreSQL.PostgreSQL.17
```

**Option B — official installer**

Download the Windows x86-64 installer from https://www.postgresql.org/download/windows/ and run it. Default port `5432`. Remember the `postgres` superuser password you set during install.

After install, verify the service is running:

```powershell
Get-Service postgresql*
```

It should be `Running`. If not: `Start-Service postgresql-x64-17`.

## 2. Create the dev database and role

The Postgres bin directory is typically `C:\Program Files\PostgreSQL\17\bin`. Add it to your `PATH` for the rest of this session, or call the binaries by full path.

```powershell
$env:PATH += ";C:\Program Files\PostgreSQL\17\bin"
```

Create role + database. You'll be prompted for the `postgres` superuser password you chose during install.

```powershell
createuser -U postgres -P kyc_poc        # set a password — used in DATABASE_URL below
createdb  -U postgres -O kyc_poc kyc_poc
```

Smoke-test the connection:

```powershell
psql -U kyc_poc -d kyc_poc -c "select version();"
```

## 3. Wire up the server

Add `DATABASE_URL` to `server/.env`:

```
DATABASE_URL=postgres://kyc_poc:<the-password-you-set>@localhost:5432/kyc_poc
```

Run the migration:

```bash
cd server
npm run db:migrate
```

> **Migrations are hand-written, not generated.** The Drizzle snapshot history
> in `server/db/migrations/meta/` is incomplete (only 0000 + 0001), so
> `drizzle-kit generate` would misdiff against the current schema and emit a
> destructive migration. The `db:generate` script has been intentionally
> removed from `package.json`. To add a new migration, hand-author the next
> `NNNN_name.sql` file (use `IF NOT EXISTS` / `ADD VALUE IF NOT EXISTS` so the
> migration is idempotent) and append a matching entry to
> `migrations/meta/_journal.json`. Update `db/schema.js` in lockstep — Drizzle
> uses it only for runtime relations / typed queries, not for diffing.

Round-trip a fake dossier through the repo:

```bash
npm run db:smoke
```

If that prints a synthetic dossier with five fragments and exits cleanly, the data layer is ready.

## 4. Load sanctions lists (one-time per environment)

Screening reads from a local mirror of OFAC SDN + UK HMT. Without this step, `sanctions_entries` is empty and screening returns zero hits.

```bash
cd server
npm run lists:refresh
```

This downloads `SDN_ENHANCED.XML` (~40 MB) and the OFSI consolidated CSV, parses + upserts into `sanctions_entries`, and inserts a row into `sanctions_lists` per source. Idempotent — safe to re-run.

Then verify:

```bash
npm run screening:smoke
```

All assertions should pass.

### Adverse-media provider

Adverse-media screening uses the **GDELT 2.0 DOC API**, which is free and needs
no API key — nothing to configure. Optional `.env` overrides:

```
# GDELT_DOC_ENDPOINT=https://api.gdeltproject.org/api/v2/doc/doc
# GDELT_TIMESPAN=12m
```

## Troubleshooting

- **`psql: FATAL: password authentication failed`** — re-run `createuser -U postgres -P kyc_poc` and pick a new password; update `DATABASE_URL` to match.
- **`could not connect to server: Connection refused`** — the Windows service is stopped. `Start-Service postgresql-x64-17`.
- **`createdb: error: database creation failed: ERROR: permission denied`** — the `-O kyc_poc` flag needs `kyc_poc` to exist first; re-run `createuser` step.
- **`relation "dossiers" does not exist`** — you skipped `npm run db:migrate`.
