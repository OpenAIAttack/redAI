T09 — Durable Ask & chat persistence — release evidence
=======================================================

Scope owned & changed
---------------------
NEW  packages/application/src/messages/**   (ports, errors, context, service, dbRepository,
       contextBuilder, providerResolver, memoryRepository, cursor, index, service.test.ts)
NEW  apps/runtime/src/ask/**                 (driver.ts, index.ts, driver.test.ts)
NEW  apps/api/src/runs/**                     (bodySchemas.ts, errors.ts, plugin.ts, index.ts, plugin.test.ts)
NEW  tests/integration/db/ask-runs.test.ts    (live-PG integration, D09 relative-source imports)
EDIT apps/api/src/server.ts                   (wire registerRuns behind createOwnerGuard)
EDIT apps/runtime/src/index.ts                (export Ask driver; guard entrypoint)
EDIT packages/application/package.json         (add "./messages" subpath export ONLY)

Commands run (all green)
------------------------
# scoped builds
pnpm --filter @redai/application run build
pnpm --filter @redai/api run build
pnpm --filter @redai/runtime run build
    -> see build-lint-format.txt

# lint + format (my files)
pnpm exec eslint <my paths>                 -> clean (exit 0)
pnpm exec prettier --check <my paths>       -> all files use Prettier code style

# unit + integration tests
export DATABASE_URL="postgres://redai@127.0.0.1:55465/postgres"
pnpm exec vitest run packages/application/src/messages apps/runtime/src/ask \
    apps/api/src/runs tests/integration/db/ask-runs.test.ts
    -> 4 files, 33 tests passed (see vitest-t09.txt)
       - application service.test.ts .... 9  (idempotency, e2e mock, tool-ignore, recovery, history)
       - api runs plugin.test.ts ........ 13 (auth/csrf, idempotency-key, replay, 409, double-submit, shapes)
       - runtime ask driver.test.ts ..... 4  (tick, final, recovery)
       - db ask-runs.test.ts ............ 7  (live-PG idempotency + concurrent, crash-readability,
                                              e2e step + NO tool rows, lease-expiry recovery, pagination)

# loud skip without a DB
(unset DATABASE_URL) pnpm exec vitest run tests/integration/db/ask-runs.test.ts
    -> 7 skipped, prints the DATABASE_URL setup hint (see skip-loudly-no-db.txt)

Throwaway PG16 provisioning (as the postgres OS user)
-----------------------------------------------------
rm -rf .tmp-pg/t09 && mkdir -p .tmp-pg && chown postgres:postgres .tmp-pg
runuser -u postgres -- /usr/lib/postgresql/16/bin/initdb -D "$PWD/.tmp-pg/t09" -U redai --auth=trust
runuser -u postgres -- /usr/lib/postgresql/16/bin/pg_ctl -D "$PWD/.tmp-pg/t09" \
    -o "-p 55465 -k /tmp" -l "$PWD/.tmp-pg/t09/log" start
export DATABASE_URL="postgres://redai@127.0.0.1:55465/postgres"
# cluster stopped and .tmp-pg removed after the run (coordinator re-provisions).

Behaviour proven
----------------
- Atomic create: run(mode='ask') + user message + run.created event in ONE transaction.
- Idempotency (docs/06 §4): repeated Idempotency-Key+body -> same run; different body -> 409
  IDEMPOTENCY_CONFLICT; double-submit (app fake AND live-PG concurrent) -> exactly one run;
  second safety net = one_active_run_per_chat + UNIQUE(chat_id, client_message_id).
- Crash after create-commit: run+message durable & readable; retry replays, never re-creates.
- Durable step: fence-guarded begin(partial) -> provider(EMPTY toolset) -> persistPartial ->
  finalize(final), generation id = runtime_fence; no DB txn held across the model call.
- Lease-expiry recovery: a resumed runtime (higher fence) finishes the SAME assistant-message
  row; the stale runtime's finalize is rejected ('stale') -> NO duplicate final message.
- Ask has an EMPTY toolset (mock capture: tools=[]) and creates NO tool_calls / task_attempts
  rows and no worker task; a provider that scripts tool calls never surfaces tool output.
- History pagination by seq with an opaque base64url cursor.
