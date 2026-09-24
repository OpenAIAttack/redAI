# T17 — Task scheduler, signed leases & results (evidence)

Security-critical scheduler / signed-lease / claim-ACK-result plane plus the Go worker
claim loop over a **mock/stub** executor (real sandbox is T18, BLOCKED on gVisor).

## What runs where

- `packages/application/src/execution/**` — `ExecutionService` (enqueue, claim + signed
  lease, ACK, renew with live grant/epoch/session re-check, result dedup/conflict,
  fence, input-artifact auth, credential capability), `createDbExecutionRepository`
  (SQL, `FOR UPDATE SKIP LOCKED`), in-memory fake, JCS + Ed25519 JWS (`jcs.ts`),
  `createDbExecutionService` factory.
- `apps/api/src/worker-tasks/**` — `/worker/v1` task plane Fastify plugin
  (`registerWorkerTasks`): claim / ack / renew / result / input fetch, bearer-guarded,
  `@redai/contracts`-validated (incl. validating the minted envelope).
- `worker/internal/lease` — Ed25519-JWS-over-JCS verify (+ claims cross-check, input
  hash, audience/time); `worker/internal/executor` — deterministic offline mock;
  `worker/internal/api` — task HTTP client + `Scheduler` (T16 seam): claim → verify →
  journal → mock execute → renew → result, settling `unknown` on an unproven outcome.

## Commands + results (all green)

| Evidence file | Command |
|---|---|
| `ts-vitest-livepg.txt` | `DATABASE_URL=…:55470 pnpm exec vitest run packages/application/src/execution apps/api/src/worker-tasks` → 31 passed |
| `ts-skip-loud-no-db.txt` | same DB suite with `DATABASE_URL` unset → **skips loudly** (D09) |
| `go-race.txt` | `gofmt -l . / go vet ./... / go build ./... / go test -race ./...` → all ok, `go.sum` absent (stdlib-only) |
| `ts-typecheck.txt` | `tsc --noEmit` for `packages/application` + `apps/api` → no errors in owned files |
| `prettier-eslint.txt` | prettier `--check` + eslint on owned TS → clean |
| `scoped-builds.txt` | `pnpm --filter @redai/application run build` + `@redai/api` → both succeed |

Live PostgreSQL was a throwaway PG16 cluster on `127.0.0.1:55470` (postgres OS user).

## Required-test mapping

- signature tamper → `lease/verify_test.go` (`TestVerifyTamperReject`) +
  `jcs`/`service.test.ts` (`rejects a tampered JWS`).
- session superseded / policy-epoch stale / lease expiry refuse renewal →
  `service.test.ts` + `dbRepository.test.ts` (live PG).
- concurrent claim (exactly one winner) + capacity/slot accounting →
  `dbRepository.test.ts` (two connections, `FOR UPDATE SKIP LOCKED`) + `service.test.ts`.
- duplicate ACK/result idempotent, mismatched digest → quarantine, stale fence rejected
  → `service.test.ts` + `dbRepository.test.ts`.
- claim→execute(mock)→journal→result, renew-before-expiry, unproven→unknown, executor
  opens no network → `worker/internal/api/scheduler_test.go`, `executor/mock_test.go`.
