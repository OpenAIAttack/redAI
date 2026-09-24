# Dependency baseline — redAI Personal v1

Task: **T00** · Milestone: **M0** · Verified on: **2026-09-24** · Owner: Coordinator

This file pins the toolchain and framework versions used by the implementation.
Versions were verified against the tools actually installed in the reference
build/dev environment on the date above. Where a spec target differs from the
pinned test version, both are recorded. Do **not** copy versions from the
HackerAI reference repository or from any document author's machine and assume
compatibility — the pinned values below are the ones this repo builds and tests
against.

## 1. Toolchain (verified in environment)

| Tool | Pinned version | Verified command | Lifecycle / notes |
|---|---|---|---|
| Node.js | 22.x (22.22.2 verified) | `node -v` → v22.22.2 | Active LTS line ("Jod"). `.nvmrc` / `engines` pin the major. |
| pnpm | 10.x (10.33.0 verified) | `pnpm -v` → 10.33.0 | Pinned via `packageManager` in root `package.json`; enable with Corepack. |
| Corepack | 0.34.6 | `corepack --version` | Used to activate the pinned pnpm without a global install. |
| Go | 1.24.x (1.24.7 verified) | `go version` → go1.24.7 linux/amd64 | `worker/go.mod` sets `go 1.24`. `go.sum` committed. |
| PostgreSQL (test) | 16.x (16.13 verified) | `psql --version` → 16.13; `/usr/lib/postgresql/16/bin/postgres` present | Migrations are **applied and tested** on this pinned server. |
| Python | 3.11.15 | `python3 --version` | Only for `scripts/validate_spec.py` (spec structure check), not app runtime. |
| Docker | 29.3.1 | `docker --version` | Available for future toolbox image builds (tools/). Not required for M0. |
| git | 2.43.0 | `git --version` | — |

### PostgreSQL major-version note

`SPEC_LOCK.json` sets `architecture.database_major = 18` as the **target**
production major. The reference environment ships PostgreSQL **16.13**, so M0
migrations are authored to be portable and are **applied and verified on 16.13**.
Migrations must avoid syntax exclusive to PG 17/18 until a pinned 18 server is
available for verification. When an 18 server is introduced, T02 re-runs the
fresh + upgrade smoke there and records the result; nothing is marked verified
on 18 until that run exists.

## 2. Framework / library versions

Framework majors are pinned per-package in each `package.json` (see workspace).
The application uses supported, stable releases:

| Component | Target major | Package | Notes |
|---|---|---|---|
| Web UI | Next.js (React) | `apps/web` | UI implementation lands in T10; M0 ships a minimal placeholder that builds. |
| API | Fastify | `apps/api` | Health endpoints + SSE adapters. |
| Runtime | TypeScript process | `apps/runtime` | Durable Agent loop (T13+). |
| Schema validation | Ajv 2020-12 | `packages/contracts` | JSON Schema 2020-12 is the contract format. |
| DB access | `pg` + explicit SQL migrations | `packages/db` | No ORM auto-sync/drop. Typed query wrappers only. |
| Test runner (TS) | Vitest | workspace-wide | Labeled mock profile for provider/worker. |
| Lint/format | ESLint + Prettier | workspace-wide | — |
| Go worker | stdlib-first | `worker/` | Dependencies added only as needed, owned by worker owner. |

Exact patch versions are locked by `pnpm-lock.yaml` (TypeScript) and `go.sum`
(Go). Release builds MUST install from the lockfile; floating `latest` is not
permitted in release.

## 3. Lockfile / image strategy

- **TypeScript:** single `pnpm-lock.yaml` at repo root, committed. `pnpm install
  --frozen-lockfile` in CI and release.
- **Go:** `worker/go.sum` committed; `GOFLAGS=-mod=readonly` in CI.
- **OCI images (future toolbox):** pin by digest (`@sha256:...`), not tag, once
  `tools/` builds a toolbox image. Not required for M0.

## 4. License / provenance inventory

- **redAI source:** independently implemented from the specification package in
  this repo. It contains **no HackerAI source code, logo, or prompts**. The
  HackerAI reference is cited by commit only in `docs/19-research-sources.md`.
- **Repo license:** see root `LICENSE`.
- **Third-party dependencies:** each added dependency must carry an OSI-approved
  or otherwise permissive license; the resolved set is auditable from
  `pnpm-lock.yaml` / `go.sum`. No production keys, secrets, or credentials are
  vendored into the repository.
- **`assets/logo.png`:** original working-name asset for redAI.

## 5. Known infrastructure blockers (recorded, not blocking M0)

| Blocker | Impact | Affects |
|---|---|---|
| **gVisor (`runsc`) not installed** (`which runsc` → not found) | `security_invariants.production_runtime = "runsc"` cannot be exercised. | Execution/sandbox lab suites (T18, T19, T29). Scaffold, DB, contracts, and mocks are **not** blocked. |
| PostgreSQL **18** server not present | Target-major verification deferred. | Final DB acceptance on PG18 (T02 re-run when available). |

Per the task card, a missing gVisor is recorded as an execution-suite blocker
only and does not block scaffold / DB / mocks.
