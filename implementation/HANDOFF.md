# Handoff snapshot

**Updated:** 2026-09-24 · **Branch:** `main` · **Baseline:** `1ad1c1f`

## Current working tree

- Fetched origin and fast-forwarded main from `c0ca9ce` to `1ad1c1f` at owner request.
  The pre-existing empty, untracked README was preserved at
  `/tmp/redAI-README-local-20260924-empty.md` before checkout.
- Upstream STATUS records M0/M1 and T15 complete; T04 login UI remains deferred
  to T10. Previous evidence is retained, not re-certified by this session.
- T08 is **IN_PROGRESS**, with uncommitted work in `packages/llm/src`:
  non-stream Chat-Completions-compatible adapter, strict response/tool argument
  parsing, explicit unknown usage, timeout/cancel, byte cap, no retries/redirects,
  exact owner local-endpoint allowlist, scripted development/test mock.
- No API route or runtime consumer is wired to this adapter yet. No paid provider
  was contacted, no key configured, no commit/push/deploy performed.

## Verification on this machine

Use the temporary Node 22.16.0 / pnpm 10.33.0 toolchain:

```bash
export PATH=/tmp/redai-toolchain/node_modules/.bin:$PATH
pnpm install --frozen-lockfile --store-dir /tmp/redai-pnpm-store
pnpm run typecheck
pnpm run lint
pnpm run format
pnpm run build
pnpm exec vitest run
```

Typecheck/lint/format/build passed. Vitest: **257 passed, 54 skipped**;
37 adapter tests passed, including a real synthetic loopback server with redirect
and stalled-body checks. DB suites skipped because no DATABASE_URL was supplied;
PostgreSQL client is also absent. Thus full `pnpm run check` / G1 are **not**
certified. Go was unchanged and its suite was not rerun. Full test output and
limitations: `release-evidence/T08/`.

Sandbox blocks loopback listeners and registry DNS. Installation and HTTP tests
were run with approved escalation. Node 26 and the global pnpm wrapper are not
suitable for this repo; do not change engine requirements to accommodate them.

## Next work

1. Finish T08 streaming: bounded SSE parser, fragmented tool calls, duplicate
   indices, termination/truncation, cancellation, trailing usage, interrupt tests.
2. Add synthetic capability probe with persisted timestamp/results and explicit
   owner confirmation before requests; connect Settings/vault through trusted
   service wiring. Unverified tools must remain disabled.
3. Enforce local provider DNS/egress and test it at deployment boundary; exact
   URL matching in this adapter alone is not DNS-rebinding protection. Add the
   T14 context privacy pipeline and canary coverage before sending Project data.
4. Reverify G1 on a disposable PostgreSQL instance. T09 depends on completed T08;
   do not mark it ready based on this non-stream slice.

Preserve canonical contracts and root AGENTS.md. No automatic mock fallback,
secret logging, tool execution from prose, or usage=0 for missing metadata.


## Superseding continuation snapshot — 2026-09-24

Earlier toolchain/DB/streaming gaps above are stale. Preserved all existing
uncommitted remediation/UI changes. T08 now has `CompatibleAdapter.stream`
with bounded incremental SSE, provisional text/refusal callbacks, terminal-only
validated tool calls, trailing usage, required finish/DONE and cancel/timeout.
Tests: 19 new stream cases; 58 scoped tests; full PG18 suite 353 passed, zero
skips. Typecheck/lint/format/environment, production build and Go race passed. Evidence and plan:
`release-evidence/T08-streaming/`. No commits or paid model calls.

Use `PATH="$PWD/.tools/bin:$PATH"`; Node 22.23.3/pnpm 10.33.0 installed locally.
Docker lab `redai-repair-pg18` binds 127.0.0.1:55448, DB URL for synthetic tests:
`postgres://redai@127.0.0.1:55448/redai`. Full suite command:
`PATH="$PWD/.tools/bin:$PATH" DATABASE_URL=postgres://redai@127.0.0.1:55448/redai pnpm exec vitest run`.
Loopback tests and nested tool/version/build processes need sandbox escalation.
No additional dependency download required for this slice.

Next: capability probe with explicit owner confirmation, synthetic payloads,
persisted timestamp/results and Settings/vault wiring; deployment DNS/egress
verification. Then T09 Ask persistence. Existing UI is login/Settings/Projects,
not a finished Ask/Workbench flow. T08 and G1 remain uncertified as whole gates.
Local runsc exists but Docker registration and actual isolation lab need checks.


## Latest snapshot — 2026-09-25 (supersedes T08 pending notes above)

T08 DONE: bounded compatible adapter + strict structured output + synthetic probe,
canonical owner-confirmed API and Settings UI, trusted vault wiring, PostgreSQL
idempotency/revision/attempt fencing. Config changes invalidate evidence; live
credential/revision/enabled rechecked between synthetic requests. No paid model
or real target contacted. Baseline main `1ad1c1f`, all work remains uncommitted.

Final verification: PostgreSQL 18 suite **395 passed / 0 skipped**, browser suite
**4 passed** desktop/mobile, screenshots inspected; typecheck/lint/format/build
and Go race passed. Evidence `release-evidence/T08-probe/`; D10 and
`docs/model-probe.md` describe consent, bounded usage and transport limitations.
Production build passed; last SQL argument fix was incrementally rebuilt and
verified with the full DB suite. Browser tests rerun after the fix passed.

Next task T09 (T08/T06 dependencies met): durable Ask/chat persistence. Read its
steps and contracts, append a plan before edits. T10 has Settings/login/Projects
but no Ask/Workbench/SSE flow. Preserve T14 privacy boundary before sending Project
context. Runtime tools verification must use derived probe evidence, never
owner/model-declared config flags. G1/M2 whole-milestone acceptance not claimed.

Apply new migration 0003 before starting API on an existing DB; fixtures already
prove fresh + upgrade on PG18. Existing old UI-created provider config may have
legacy adapter_kind/missing max_output_tokens; recreate via the corrected form.
Local provider list is installation env REDAI_LOCAL_MODEL_BASE_URLS. IPv6-only
providers unsupported. Firewall/gVisor deployment lab remains pending.

Important test operation: do not run Next production build concurrently with
Playwright's Next dev server (shared .next directory). Interrupted E2E once left
ports 8789/3008 occupied; identified fixture PIDs were terminated, clean rerun
passed. No need to reuse an existing test server. No secrets in this handoff.


## Owner-requested commit snapshot — 2026-09-25

Owner authorized commit/push to origin/main. This snapshot is committed with
subject `feat: complete T08 provider probes and owner settings`; earlier
"uncommitted" notes describe the pre-snapshot history. Next work remains T09.
