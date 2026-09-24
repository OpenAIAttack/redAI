# Handoff snapshot

**Updated:** 2026-09-24 · **Branch:** `claude/fervent-archimedes-fnkoam`

## Where we are
- Milestone **M0** in progress. Foundation (T00 + T01) implemented and green.
- Canonical spec sources imported to repo root (decision D01); `specs/` frozen.
- `pnpm run check` passes end-to-end: env check, `tsc -b`, ESLint, Prettier,
  Vitest (9 tests: domain readiness, api health via inject, import-boundary),
  workspace build, and `go vet/build/test` in `worker/`.
- Dependencies for T02 (`pg`, `@types/pg`) and T03 (`ajv`, `ajv-formats`,
  `json-schema-to-typescript`) are pre-installed so parallel agents don't touch
  the lockfile.

## In flight
- **T02 (Agent A):** versioned PostgreSQL migrations from `db/001_reference_schema.sql`,
  typed repositories/transactions, DB-invariant integration tests on a real PG16.
- **T03 (Agent B):** TS + Go type generation from `contracts/`, strict Ajv-2020
  validation, positive/negative fixtures, drift check.

## Reproduce / verify
```bash
corepack enable && pnpm install
pnpm run check            # full pipeline
pnpm --filter @redai/api run dev   # health server on :8787
```

## Key invariants to preserve
- `domain` and `policy` stay pure (enforced by `tests/import-boundary`).
- Health is honest: `healthy` only true when actually verified (D03).
- No ORM auto-sync/drop; migrations are explicit SQL (T02).
- Runtime validation uses schema validators, never TS casts (T03).
- Enums/defaults must match `SPEC_LOCK.json`.

## Next steps
1. Integrate T02 + T03 on this branch; run `pnpm run check` + DB/contract suites
   on the integrated tree.
2. Mark T02/T03 DONE only after review + integration checks; record evidence.
3. Milestone gate **G0** (release doc §18) before proceeding to M1 (T04–T07).

Do not trust prior "done" claims without re-verifying source + tests.
