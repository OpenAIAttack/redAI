# T08 — non-stream adapter slice

Date: 2026-09-24. Baseline: main `1ad1c1f` plus uncommitted T08 changes.
Task state: **IN_PROGRESS**, not full T08 acceptance.

## Commands executed

Toolchain: Node 22.16.0 and pnpm 10.33.0 installed outside the repository at
`/tmp/redai-toolchain`. Workspace dependencies installed from frozen lockfile;
no manifest/lockfile changes.

With `PATH=/tmp/redai-toolchain/node_modules/.bin:$PATH`:

| Command | Result |
|---|---|
| `pnpm run typecheck` | PASS |
| `pnpm run lint` | PASS |
| `pnpm run format` | PASS |
| `pnpm run build` | PASS |
| `pnpm exec vitest run` | 257 PASS, 54 DB tests SKIPPED; see `vitest.txt` |
| `git diff --check` | PASS |

The first scoped run hit sandbox `listen EPERM` at the loopback server. Rerun
with approved permissions passed. Final full-suite run used approved permissions;
it includes 37 adapter tests. DB tests are not counted as passed, and G1 is not
recertified. Go source was untouched and Go tests were not rerun.

## Covered behavior

- Explicit owner-configured endpoint/model snapshot; no discovery or fallback.
- One HTTP POST; redirects disabled; non-approved plain HTTP endpoints rejected.
- `local_only` requires exact owner-approved URL and allowed data mode.
- Config and tool-declaration snapshots survive caller mutation during request.
- Output token cap, response byte cap, cancellation, timeout including body reads.
- HTTP 401/403/429/500, malformed JSON, interrupted bodies, safe error mapping.
- Usage absent/invalid remains unknown; observed zero remains distinguishable.
- Only declared, schema-validated tools; malformed/duplicate calls, duplicate
  choices, truncated calls and unverified tool capability fail closed.
- Scripted mock is explicitly labeled and rejects production; no network fallback.
- Payload projection omits extra metadata and does not serialize the API key into
  the request body. This is not a claim of full prompt redaction.

## Remaining acceptance work

SSE streaming/fragment assembly and its failure tests; synthetic capability probe;
owner confirmation and Settings/vault wiring; integration with runtime/privacy.
The adapter expects trusted inputs and prefiltered message/tool text. It does not
redact secrets embedded in content. Local URL approval does not enforce DNS/egress;
that needs the separate deployment boundary before production local_only claims.
No live-model capability, production endpoint, privacy gate, or full T08 DONE claim.
