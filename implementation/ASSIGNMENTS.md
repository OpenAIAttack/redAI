# Assignments — file ownership & integration state

One writer per file region at a time (agent-execution-plan §2). Coordinator owns
shared files: root `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`,
`tsconfig*.json`, `eslint.config.mjs`, `SPEC_LOCK.json`, base migrations index.

## Wave D00–D02 (Milestone M0)

| Task | Agent | Owns (may edit) | Shared (propose only) | Test env | Integration |
|---|---|---|---|---|---|
| T00 | Coordinator | `docs/dependency-baseline.md` | — | — | ✅ integrated |
| T01 | Coordinator | `apps/*`, `packages/*` skeleton, `worker/*` skeleton, root config, `scripts/`, `tests/import-boundary/`, `README.md`, coordinator books | — | local | ✅ integrated |
| T02 | **Agent A** | `packages/db/**`, `tests/integration/db/**`, `db/**` (versioned migrations from reference DDL) | root lockfile/manifests (deps pre-installed: `pg`, `@types/pg`) | own PG database `redai_t02_*`, ports/object roots labeled per task | ✅ integrated (commit 23d8870); coordinator fixed 3 eslint unused-import errors in its test files |
| T03 | **Agent B** | `packages/contracts/**`, `tests/contracts/**`, generated Go types under `worker/internal/contracts/**` | root lockfile (may add TS codegen dep — sole installer this wave) | fixtures only | ✅ integrated (no lockfile change; `worker/go.sum` still absent) |

### Concurrency guard for this wave
- Disjoint subtrees: A ⇒ `packages/db` + `tests/integration/db` + `db`; B ⇒
  `packages/contracts` + `tests/contracts` + `worker/internal/contracts`.
- **A must NOT run `pnpm install`** (its deps are pre-installed). B is the only
  agent that may add a dependency this wave.
- Neither agent edits root `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`,
  `eslint.config.mjs`, or another agent's files. No repo-wide formatter runs.
- Generated Go types are plain structs (decision D05): no `worker/go.sum` change.

## Next waves (not yet dispatched)
D03: T04 owner/session (Agent A). D04: T05 vault + T06 project/chat + T15 worker
identity. See `docs/agent-execution-plan.md` §3 for the full schedule.
