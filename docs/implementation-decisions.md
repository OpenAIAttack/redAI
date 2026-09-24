# Implementation decisions

Durable record of spec-conflict resolutions and choices that later tasks must
respect. Architecture-level changes get an ADR under [`adr/`](../adr); this file
captures the smaller decisions and rationale.

| ID | Decision | Rationale | Affects |
|---|---|---|---|
| D01 | `specs/` is kept intact as the **frozen input package** (its MANIFEST/SHA256SUMS integrity stays valid). The single **edited** canonical contract source lives at repo root (`contracts/`, `db/`, `catalogs/`, `prompts/`, `AGENTS.md`, `SPEC_LOCK.json`, merged `docs/` & `implementation/`). | Architecture §10 forbids two *edited* contract sources but frames `specs/` as the input reference package. Copying (not moving) preserves provenance while giving one live source. | All contract/DB/codegen consumers read the root copies. |
| D02 | `apps/web` is a compiling **placeholder** in M0; the real Next.js app (routes, SSE client, Workbench shell) is scaffolded in **T10**. | Keeps the M0 build fast and offline-reproducible; T10 is the UI milestone and owns the web app. Health surface lives in `apps/api` per architecture §1. | T10 (UI). |
| D03 | Health readiness rule (`unconfigured` / `degraded` / `ready`) is implemented as **pure domain logic** in `@redai/domain` and rendered by `apps/api`. In M0 `healthy` mirrors configuration presence; **deep liveness probes** (real DB/ObjectStore connections) are wired when those components land (T02, T07). | Architecture: domain owns rules, apps render. Honest health: never claim a component healthy without verifying it. | T02, T07 set `healthy` from real checks. |
| D04 | PostgreSQL migrations are authored and **verified on the pinned test server (16.13)**. `SPEC_LOCK` target major is 18; nothing is marked verified on 18 until a pinned 18 server exists. Migrations avoid PG17/18-only syntax until then. | Reference environment ships PG16; the spec targets PG18. Recorded in `docs/dependency-baseline.md`. | T02 re-runs fresh+upgrade smoke on PG18 when available. |
| D05 | Generated **Go contract types must be plain structs with no third-party dependencies** (no additions to `worker/go.sum`). | Keeps the worker module dependency-light and avoids codegen-tool supply chain in the worker; TS side may use a codegen tool. | T03. |
| D06 | **T04 delivers API-side auth only** (bootstrap CLI, sessions, cookie/CSRF/Origin, rate limit, logout/reset/revoke) with full tests. The **login/`/setup` UI is deferred to T10** alongside the Next.js app (consistent with D02). | User-chosen (M1 kickoff): keep startup offline/fast; UI milestone owns the web app. Auth correctness lives in API + application layers where it is testable without a browser. | T04 (API), T10 (login UI). |
