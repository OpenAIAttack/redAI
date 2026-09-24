# Handoff snapshot

**Updated:** 2026-09-24 · **Branch:** `claude/fervent-archimedes-fnkoam`

## Where we are
- **Milestone M0 (T00–T03) COMPLETE and integrated** on `claude/fervent-archimedes-fnkoam`.
- Canonical spec sources imported to repo root (decision D01); `specs/` frozen.
- `pnpm run check` passes end-to-end: env check, `tsc -b`, ESLint, Prettier,
  Vitest (**52 always-on tests**: domain readiness, api health, import-boundary,
  43 contract cases + drift guard), workspace build, `go vet/build/test`.
- **14 DB integration tests** pass on live PostgreSQL 16.13 (run with
  `DATABASE_URL` set; skip loudly otherwise).
- Commits: `1b3bd7a` (M0 foundation T00/T01), `23d8870` (T02 DB), plus the T03 +
  integration commit.

## Reproduce / verify
```bash
corepack enable && pnpm install
pnpm run check            # full pipeline (DB integration skips without DATABASE_URL)
pnpm --filter @redai/api run dev   # health server on :8787

# DB integration on a throwaway PG16 (run initdb/pg_ctl as the postgres OS user):
export PGBIN=/usr/lib/postgresql/16/bin PGDATA=$PWD/.tmp-pg/integ PGPORT=55442
runuser -u postgres -- "$PGBIN/initdb" -D "$PGDATA" -U redai --auth=trust
runuser -u postgres -- "$PGBIN/pg_ctl" -D "$PGDATA" -o "-p $PGPORT -k /tmp" -l "$PGDATA/log" start
DATABASE_URL="postgres://redai@127.0.0.1:$PGPORT/postgres" pnpm exec vitest run tests/integration/db
```

## Key invariants to preserve
- `domain` and `policy` stay pure (enforced by `tests/import-boundary`).
- Health is honest: `healthy` only true when actually verified (D03).
- No ORM auto-sync/drop; migrations are explicit SQL (T02).
- Runtime validation uses schema validators, never TS casts (T03).
- Enums/defaults must match `SPEC_LOCK.json`.

## Next steps
1. Confirm milestone gate **G0** (release doc §18): reproducible from clean
   checkout — toolchain pin, migration apply, contract drift check, builds.
2. Start **M1 (T04–T07)**. Wave D03: **T04 owner/session** (bootstrap one-owner
   CLI, sessions, CSRF/Origin, rate limit) — depends on T02 + T03 (both DONE).
   Then D04: T05 vault + T06 project/chat + T15 worker identity.
3. Wire `pingDatabase` (from `@redai/db`) into API readiness deep-probe (D03)
   when T04 brings a live pool into the API process.

Do not trust prior "done" claims without re-verifying source + tests.
