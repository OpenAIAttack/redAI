# T04 — Bootstrap owner & sessions (API side) — evidence

Wave D03, Milestone M1. API-side auth only (D06); login/`/setup` UI deferred to T10.

## Files
- `00-env.txt` — toolchain + PG version + git HEAD/branch.
- `01-check.txt` — full `pnpm run check` (env → typecheck → lint → format → test → build → go). Green; DB integration suites skip loudly without `DATABASE_URL` (82 passed / 23 skipped).
- `02-vitest-live-pg.txt` — full `vitest run` with `DATABASE_URL` set (all 105 tests pass). The 4 "unhandled errors" are pre-existing T02 test-infra teardown noise (`DROP DATABASE ... WITH FORCE` resets in-flight pooled connections when many DB suites run in parallel); no test fails and they are unrelated to T04.
- `03-auth-tests-live-pg.txt` — isolated run of just the T04 auth suites with live PG (6 files, 39 tests, exit 0) — clean, no teardown noise.
- `04-cli-transcript.txt` — bootstrap CLI end-to-end: password via stdin, one-time recovery code printed, second bootstrap refused, singleton counts, `password_hash` stored as a scrypt KDF (never plaintext).

## How to reproduce the live-PG run
```
runuser -u postgres -- /usr/lib/postgresql/16/bin/initdb -D $PWD/.tmp-pg/t04 -U redai --auth=trust
runuser -u postgres -- /usr/lib/postgresql/16/bin/pg_ctl -D $PWD/.tmp-pg/t04 -o "-p 55432 -k /tmp" -l $PWD/.tmp-pg/t04/log start
export DATABASE_URL="postgres://redai@127.0.0.1:55432/postgres"
npx vitest run tests/integration/db/sessions.test.ts tests/integration/db/auth-bootstrap.test.ts packages/application/src/auth apps/api/src/auth
```
