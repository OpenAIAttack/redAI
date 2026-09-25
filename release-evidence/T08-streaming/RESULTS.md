# T08 streaming verification — 2026-09-24

- Red: 14 tests failed before implementation (`red.txt`).
- Scoped: 58 passed, zero skips (`scoped.txt`). Includes real loopback SSE with
  DONE while socket stays open, plus existing redirect/stalled-response coverage.
- Full suite with PostgreSQL 18 lab: 353 passed, zero skips (`vitest-pg18.txt`).
- Typecheck, lint, format: exit 0 (interactive command output this session).
- Environment: passed (`environment.txt`). No new dependencies required.
- Production build: passed (`build.txt`).
- Go race: passed (`go-race.txt`); empty packages still report no test files.

Initial sandbox runs blocked loopback listen and Go cache, and Next build exited
1. Reruns outside sandbox succeeded. No UI changed in this slice; browser tests
were not rerun and prior UI screenshots are not new acceptance evidence.

T08 remains IN_PROGRESS: capability probe with confirmation/persistence,
Settings/vault wiring and deployment DNS/egress verification are outstanding.
Provisional deltas must be marked incomplete by a future consumer if the stream
fails. Only a resolved response exposes validated tool calls. Compatibility is
intentionally strict: one choice, contiguous tool indices, identity declared once,
required finish and DONE. Missing usage stays unknown; no retry/fallback.
