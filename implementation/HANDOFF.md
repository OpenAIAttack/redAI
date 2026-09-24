# Handoff snapshot

**Updated:** 2026-09-24 · **Branch:** `claude/fervent-archimedes-fnkoam`

## Where we are
- **Milestones M0 + M1 + M2 (T00–T11, +T15) COMPLETE and integrated** on `claude/fervent-archimedes-fnkoam`. 12 of 37 tasks done.
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
1. **T07 — Local ObjectStore & safe upload** completes M1 (staging → size/type/
   hash check → atomic finalize; authenticated download; orphan handling). Depends
   on T06 (DONE).
2. Then M2 wave: T08 provider adapters, T09 durable Ask, T10 Chat/Workbench UI
   (+ the login/`/setup` UI deferred from T04 per D06), T11 SSE.
3. Wire `pingDatabase` into API readiness deep-probe (D03) and the worker daemon
   enrollment loop into `worker/cmd/redai-worker/main.go` (deferred to T16).

## D04 integration status (DONE)
- T05/T06/T15 wired into `apps/api/src/server.ts` via a shared owner-auth guard
  (`apps/api/src/auth/ownerGuard.ts`), `@redai/application` subpath exports (D08),
  and a boot-time installation signing key (D07). Full `pnpm run check` green;
  **219/219 tests pass on live PostgreSQL 16**.

Do not trust prior "done" claims without re-verifying source + tests.

## M2 status (DONE) — first developer alpha
- Provider adapters (T08, mock + OpenAI-compatible), durable Ask (T09), Next.js
  app (T10a shell + T10b chat/SSE client), SSE backend (T11). Full `pnpm run check`
  green; **414/414 tests on live PostgreSQL 16**; real offline `next build`.
- End-to-end (labeled mock provider): bootstrap → login → Project → Ask → streamed
  provisional→final answer; reconnect never creates a run or wipes history.
- Follow-ups recorded: D10 (small API gaps: bootstrap-state, worker list, browser
  password-change) and D11 (authenticated browser↔API SSE e2e).

## Next: M3 (worker execution) — T12–T19
- T12 DNS proof + scope/grant lifecycle; T13 durable Agent loop + checkpoints (adds
  the always-on runtime loop + lease renewal, reusing T09's createProviderResolver);
  T14 budget + privacy pipeline (uses T08's payload canary); T16 worker journal/
  supervisor; T17 scheduler/leases/results; T18 offline sandbox (BLOCKED: gVisor
  absent — see dependency-baseline); T19 offline tools/artifacts.
- T15 (worker identity) already DONE. Wire the worker daemon enroll loop into
  worker/cmd/redai-worker/main.go with T16.
