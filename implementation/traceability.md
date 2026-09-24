# Traceability yêu cầu → triển khai → nghiệm thu

Test IDs dưới đây là tên cần coding agent triển khai, không phải test đã chạy trong gói.

| Requirement | Yêu cầu | Task | Gate | Test ID |
|---|---|---|---|---|
| REQ-001 | Một owner, không public signup | T04 | G1 | `AUTH-singleton-race` |
| REQ-002 | Chat–Project–Agent và UI thật | T06, T09, T10 | G2 | `UI-real-backend` |
| REQ-003 | Project ownership closure | T02, T06 | G1 | `DATA-cross-project` |
| REQ-004 | File integrity và immutable evidence | T07, T25 | G5 | `FILE-hash-immutable` |
| REQ-005 | Ask không execution tools | T09 | G2 | `ASK-zero-task` |
| REQ-006 | Durable Run độc lập browser | T13, T11 | G2 | `RUN-reconnect` |
| REQ-007 | Idempotent create/message/approval | T09, T22 | G6 | `API-duplicate-requests` |
| REQ-008 | Scope/DNS một lần Project | T12 | G4 | `SCOPE-proof-reuse` |
| REQ-009 | Bốn approval modes đúng semantics | T22 | G4 | `POLICY-mode-matrix` |
| REQ-010 | Không tự authorize dependency/shared IP | T12, T20, T21 | G3 | `NET-shared-vhost` |
| REQ-011 | Worker đồng nhất và stable identity | T15, T19 | G3 | `WORKER-two-machines` |
| REQ-012 | Signed lease/session/fencing | T17 | G3 | `LEASE-tamper-stale` |
| REQ-013 | Không host shell/mount/docker socket | T18 | G3 | `SANDBOX-host-boundary` |
| REQ-014 | Không unsafe effect replay | T16, T17, T23 | G6 | `CHAOS-post-counter` |
| REQ-015 | Cancel có quiescence acknowledgement | T23 | G6 | `CANCEL-partition-race` |
| REQ-016 | Pause boundary và notes | T23 | G4 | `RUN-pause-note` |
| REQ-017 | Budget shared và unknown held | T14, T24 | G4 | `BUDGET-parallel-unknown` |
| REQ-018 | Context summary không mất authority/state | T24 | G4 | `SUMMARY-preserve-state` |
| REQ-019 | Secret không vào model/log/report | T05, T14, T26 | G3 | `PRIVACY-canary` |
| REQ-020 | Provider local_only không cloud fallback | T08, T14 | G4 | `MODEL-local-only` |
| REQ-021 | Browser authority/path scope guard | T21 | G3 | `BROWSER-inspected-proxy` |
| REQ-022 | Typed HTTP/DNS/redirect checks | T20 | G3 | `HTTP-dns-redirect` |
| REQ-023 | Finding verified có bằng chứng | T25 | G5 | `FINDING-no-evidence-deny` |
| REQ-024 | Report snapshot và sanitize | T26 | G5 | `REPORT-immutable-html` |
| REQ-025 | Retest unavailable là inconclusive | T26 | G5 | `RETEST-inconclusive` |
| REQ-026 | Export/import không grant/secrets active | T27 | G5 | `IMPORT-no-authority` |
| REQ-027 | Backup DB+files+key và restore thật | T31 | G7 | `RESTORE-fresh-machine` |
| REQ-028 | SSE không mất vì commit ordering | T11 | G6 | `EVENT-commit-inversion` |
| REQ-029 | Version/schema contracts TS và Go | T00, T03 | G0 | `CONTRACT-cross-language` |
| REQ-030 | Ops/errors safe và observable | T32 | G7 | `LOG-redaction` |
| REQ-031 | Default không external telemetry | T28, T32 | G7 | `OPS-no-telemetry` |
| REQ-032 | Hardening không tự downgrade | T18, T21, T29 | G3 | `GUARD-fail-closed` |
| REQ-033 | UI keyboard/mobile/error states | T10, T30 | G2 | `UI-responsive-ime` |
| REQ-034 | Không copy source/assets HackerAI | T00, T33 | G0 | `LICENSE-provenance` |
| REQ-035 | Release gates không mock/skip giả | T33, T34, T36 | G7 | `RELEASE-evidence` |
| REQ-036 | Đánh giá model có ground truth và uncertainty | T35 | OPTIONAL | `EVAL-20-cases` |
