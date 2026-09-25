# M0/M1 remediation audit — 2026-09-24

Baseline main `1ad1c1f`, preserving the uncommitted T08 slice.
Single writer: coordinator. No agents delegated.

## Findings and execution plan

1. T00: Node/pnpm only temporary; PostgreSQL client and runsc absent. Establish
   reproducible local tools. Docker works outside sandbox, sudo needs a password.
   Install/check gVisor locally; privileged Docker runtime registration remains
   blocked unless owner runs the prepared admin command.
2. T02: previous tests only PG16; 54 DB tests skipped locally. Start isolated PG18,
   run fresh/upgrade and all DB tests, fix any failures.
3. T01/T02/T07: readiness trusts configuration presence. Add actual bounded DB and
   ObjectStore probes; regression-test unreachable/misconfigured services.
4. T04–T06: backend exists; login/setup, Settings, Project/Chat/notes UI is missing.
   Implement these deferred M1 surfaces with real backend and browser evidence.
5. T03/T07/T15: inspect contract parity, storage recovery tests and worker identity
   coverage; distinguish earlier acceptance from features intentionally owned by
   future T16/T17. Record every remaining gap explicitly.

Verification: scoped tests then full live-PG18 Vitest, typecheck/lint/format/build,
Go race, browser tests if UI added. No skip represented as PASS, no core milestone
DONE while acceptance is missing. No live targets/model API costs.
