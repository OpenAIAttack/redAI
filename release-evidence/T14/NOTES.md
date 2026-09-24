# T14 — Budget & privacy pipeline — implementation notes

Spec: docs/11-llm-context-privacy.md · SPEC_LOCK budget_micro_usd=2000000, max_children=2,
max_child_depth=1. Branch claude/fervent-archimedes-fnkoam. Left UNCOMMITTED.

## Deliverables (files owned)

- `packages/llm/src/context/**` — context manifest + redaction pipeline
  - `types.ts`, `redact.ts` (Redactor: stable `[SECRET_REF_n]`/`[EMAIL_n]`/`[HOST_n]`,
    base64 echoes, mapping never logged), `manifest.ts` (token caps, summary selection,
    evidence truncation, mandatory band), `canary.ts` (egress-surface scanner),
    `index.ts`. Exported from the llm barrel (`packages/llm/src/index.ts`).
- `packages/application/src/budget/**` — budget service
  - `ports.ts`, `pricing.ts`, `errors.ts`, `service.ts`, `memoryRepository.ts` (fake),
    `dbRepository.ts` (row-lock ledger over `@redai/db`), `reservationGateway.ts` (the
    runtime seam), `index.ts`, `service.test.ts`, `dbRepository.test.ts`.
- `apps/web/src/**` — honest Usage panel (measured / held(estimated) / unknown)
  - `components/Workbench.tsx` (+ test), `lib/realtime/chatState.ts`, `lib/types.ts`,
    `i18n/en.ts`, `i18n/vi.ts`.

## Reservation seam the coordinator must wire in

The runtime seam is `ReservationGateway` (packages/application/src/budget/reservationGateway.ts),
built with `createReservationGateway(new BudgetService({ repo: createDbBudgetRepository(pool) }))`.

Wire TWO calls around the existing provider round-trip (do NOT change T14 files, and per
the task do NOT edit the committed T13 runtime files — the coordinator inserts these):

1. **Ask** — `packages/application/src/messages/service.ts`, `AskService.runStep`, immediately
   BEFORE `result = await this.generate(candidates, messages, dataMode)` (~line 251):
   ```ts
   const r = await gateway.reserveForModelCall({
     workspaceId: run.workspaceId, projectId: run.projectId, runId: run.id,
     providerAttempt, requestFingerprint, pricing, inputUpperBoundTokens: contextCap, maxOutputTokens,
   });
   if (!r.ok) { /* park/fail run with BUDGET_EXCEEDED — do not proceed */ }
   ```
   AFTER the round-trip (both success and the catch that has a sent request):
   ```ts
   await gateway.reconcileModelCall({ workspaceId, runId: run.id, reservationId: r.reservationId, pricing, usage: result.usage });
   ```

2. **Agent** — `packages/application/src/agent/service.ts`, ~line 227, BEFORE
   `result = await candidate.provider.generate({...})`; pass `agentStepId` for child steps so a
   child competes on the SAME run ledger. Reconcile after with `result.usage`.

Only a PROVEN pre-send failure (request never sent) may call `gateway.releaseModelCall(...)`.
An in-flight request whose result is unknown must be RECONCILED as unknown (usage `{kind:'unknown'}`),
which HOLDS the reservation — never released to 0.

`requestFingerprint` gives idempotency: `UNIQUE(run_id, request_fingerprint)` → a retry with the
same fingerprint replays the same reservation rather than double-charging.

## `@redai/application/budget` subpath export line (coordinator adds to packages/application/package.json)

Add to the `exports` map (I did NOT edit package.json, per task):

```json
"./budget": {
  "types": "./dist/budget/index.d.ts",
  "default": "./dist/budget/index.js"
}
```

## How the canary / redaction is tested

- `redact.test.ts` — stable tokenisation; secret value → `[SECRET_REF_n]` (never emitted);
  base64 echo caught; secret wins over email/host overlap; counts exposed, values are not.
- `manifest.test.ts` — ordering (platform/authority → body → goal), secret refs never reach
  messages, summary-selection when history overflows, evidence truncation, mandatory band /
  overBudget, provenance per entry.
- `canary.test.ts` — plants a canary in a note, redacts via the manifest, runs the MockProvider
  (T08 `onCapture`), then asserts `scanForSecret` returns `[]` across headers/body/HTML/errors/
  logs/payloadCapture. A positive control proves the scanner flags EVERY surface on a real leak,
  and the error message never contains the secret. Also reuses `selectProvider`/`isCandidateEligible`
  to prove local_only never switches to a cloud provider and redacted_cloud is not upgraded to cloud_full.

## How the reserve-race / unknown-held is tested

- `service.test.ts` (in-memory fake, atomic critical section): parallel `Promise.all` reserve →
  exactly one succeeds, ledger never over-commits; child requests compete on the shared run ledger;
  unknown usage → `held_unknown`, reserved stays 200 (never 0), `unknownReservationCount=1`; known
  reconcile replaces reserved with observed; idempotent replay; audited increase; decrease rejected.
- `dbRepository.test.ts` (live PG16): the same guarantees against real SQL — `SELECT … FOR UPDATE`
  on the run row serialises two concurrent reservations (one reserved, one exceeded); unknown held
  writes `usage_entries.observed_micro_usd = NULL` (NOT 0) and `budget_reservations.state='unknown'`;
  owner increase updates `runs.budget_limit_micro_usd` and appends a `budget.limit_increased` event.

## Commands + results

See the sibling `.txt` files. All green: llm context 20, full llm 66, budget unit 12,
budget live-PG 7, web usage 11. DB suite skips LOUDLY without DATABASE_URL.
Live PG: `initdb -D .tmp-pg/t14 -U redai --auth=trust`; `pg_ctl -o "-p 55469 -k /tmp"`;
`DATABASE_URL=postgres://redai@127.0.0.1:55469/postgres`.

## Scoping / concurrency

- Repo-wide `pnpm run check` and `pnpm --filter @redai/application run build` NOT run to green:
  T17's UNTRACKED `packages/application/src/execution/service.ts:467` has `TS2304 Cannot find name
  'Crypto'` (its own mid-edit). T14's budget module + tests are proven tsc-clean in isolation
  (`scoped-typecheck-budget.txt`). Once T17's error clears, the package build includes T14 cleanly.
- No new dependencies; no `pnpm install`; nothing committed/pushed; no agents spawned.

## Spec ambiguities (recorded here, not in docs/implementation-decisions.md, to avoid a
   concurrent-edit clash with T17 on a shared doc — coordinator may transcribe)

- D-T14-a: docs/11 §7 names ledger buckets `committed_observed + unresolved_reserved`. Mapped to
  SQL as: unresolved = SUM(reserved) WHERE state IN ('reserved','unknown'); committed =
  SUM(usage_entries.observed) WHERE observed IS NOT NULL. An `unknown` reservation therefore stays
  in `unresolved` (held), which is the fail-safe reading of "không refund về 0".
- D-T14-b: the owner budget-increase audit is written to the existing `events` table as
  `budget.limit_increased` via `appendEvent` (no budget-specific audit table exists and migrations
  are out of scope). The in-memory fake keeps an `audit[]` array for unit assertions.
- D-T14-c: the `budget.updated` event contract (packages/contracts, not editable here) carries only
  observed/reserved/limit — no unknown count. The web layer reads an OPTIONAL
  `data.unknown_reservation_count` defensively (the usage-summary schema already defines the field),
  so the Usage panel shows the unknown bucket the moment the backend/coordinator adds it to the event,
  with no further web change. Until then unknown stays HELD in `reserved` (never a fabricated $0).
- D-T14-d: token counting uses a deterministic char/4 heuristic for cap SELECTION only. Per docs/11 §7,
  the reservation upper bound is computed from the configured CONTEXT CAP (pass it as
  `inputUpperBoundTokens`) rather than a low tokenizer guess.

## Open risks

- The child-count limits (max_children=2, max_child_depth=1) are enforced by the agent loop, not the
  ledger; the budget module enforces only the shared-budget competition. Coordinator must keep the
  count/depth gate in the agent scheduler.
- `runs` has no update trigger today, so the increase writes `budget_limit_micro_usd`/`updated_at`
  directly; if a later migration adds a revision/updated_at trigger, revisit the UPDATE.
