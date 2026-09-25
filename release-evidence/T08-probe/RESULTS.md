# T08 probe evidence — 2026-09-25

Implemented canonical owner-confirmed probe API, Settings UI, vault wiring,
durable idempotency and revision/attempt fencing; added migration 0003. At most
5 synthetic requests, 64 output tokens per request, 5 seconds and 64 KiB per
response. No model key or Project content in probe payloads/results/logs.

Verification:
- Full PostgreSQL 18 Vitest: 395 passed, 0 skipped (`vitest-pg18.txt`). Includes
  canonical contracts/codegen drift, 9 durable probe tests, live synthetic HTTP
  with DNS localhost, restart/duplicate/reordering/revocation and secret canary.
- Production build: passed (`build.txt`); final SQL parameter correction also
  rebuilt with `tsc -b packages/application` and verified by the full DB suite.
- Go race: passed (`go-race.txt`; packages without tests remain explicitly listed).
- Typecheck/lint/format: interactive checks, final exit recorded in STATUS.
- Browser evidence: `browser.txt`, desktop/mobile Settings screenshots. Screenshots
  visually reviewed for overflow/layout; no model/target outside lab contacted.

Failures found and repaired: Settings add-model form closed when loading changed
its `open` prop; fixed by keeping native user-controlled disclosure state. A SQL
parameter-count error introduced with attempt fencing was caught by integration
and corrected. An interrupted browser run left fixture ports occupied; terminated
only the identified test processes before rerun. No test deletion or skip.

Limits: IPv6-only providers unsupported; public IPv4 filtering is conservative.
Cancellation proves local transport abort, not remote billing termination.
`usage_observed` means at least one response had metadata, not total probe cost.
Unknown pending idempotency keys never auto-replay; a new confirmed key may start
after the exclusion deadline. Deployment firewall/gVisor gates remain separate.
