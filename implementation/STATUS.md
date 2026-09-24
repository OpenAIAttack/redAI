# Trạng thái triển khai ứng dụng

Cập nhật: **2026-09-24**. **M0 + M1 + M2 (T00–T11) HOÀN TẤT** (T15 xong sớm) trên cây nguồn đã
tích hợp. Baseline: nhánh `claude/fervent-archimedes-fnkoam`. DONE chỉ đặt sau
review + integration checks trên cây nguồn đã tích hợp; "PASS" do coder tự báo
chưa đủ để đóng task.

Integrated M0 evidence: `pnpm run check` xanh (52 test luôn chạy) + 14 DB
integration test xanh trên PostgreSQL 16.13 (chạy với DATABASE_URL trực tiếp).
Tiếp theo: xác nhận cổng **G1** (M1) rồi sang **M2** (T08 provider, T09 Ask, T10 UI, T11 SSE).

Lệnh kiểm tra chung: `pnpm run check` (env → typecheck → lint → format → test →
build → `go:check`). Bằng chứng M0 khác ở `release-evidence/` và STATUS bên dưới.

| Task | Trạng thái | Commit | Checks/evidence | Blocker |
|---|---|---|---|---|
| T00 — Khóa dependency và môi trường | DONE | (M0 baseline) | `docs/dependency-baseline.md`; `pnpm run env:check` passes | gVisor thiếu → chỉ chặn execution lab (T18/T19/T29) |
| T01 — Khởi tạo monorepo và quality commands | DONE | (M0 baseline) | `pnpm run check` xanh (9 vitest, tsc -b, eslint, prettier, go vet/build/test); import-boundary test | — |
| T02 — Migration PostgreSQL và invariants DB | DONE | 23d8870 | 14 integration tests xanh trên PG16.13 (fresh+upgrade, cross-project FK, active-run, immutable rows, event counter); `release-evidence/T02/` | PG18 verify hoãn (D04) |
| T03 — Sinh type và kiểm tra API contracts | DONE | (M0 integ) | 43 TS contract tests + drift guard; Go parity tests; `release-evidence/T03/` | — |
| T04 — Bootstrap owner và sessions | DONE (API) | (M1) | `pnpm run check` xanh (82 test); 23 DB integration test xanh trên PG16 (EXIT=0); auth inject tests (Origin/CSRF/rate-limit/worker-token isolation), bootstrap race, expiry, reset-revoke; `release-evidence/T04/` | Login UI hoãn tới T10 (D06) |
| T05 — Secret vault và model/settings configs | DONE | (D04) | AES-256-GCM vault, credential refs, versioned settings; 53 tests (7 live-PG); wired into API | — |
| T06 — Project, Chat metadata, notes và bindings | DONE | (D04) | CRUD/archive, Inbox, notes context, bindings; cross-project isolation; 35 tests (10 live-PG); wired | — |
| T07 — Local ObjectStore và upload an toàn | DONE | (M1) | Staged upload→hash/size verify→atomic finalize, authenticated download, safe preview/quarantine, orphan reconcile; 55 tests (9 live-PG); wired | — |
| T08 — Mock model và compatible provider adapter | DONE | (M2) | @redai/llm: mock + OpenAI-compatible (text/tools/stream/cancel/usage), probe, no cloud fallback local_only; 46 tests, no key | — |
| T09 — Durable Ask và Chat persistence | DONE | (M2) | Atomic idempotent Run+message, durable step, generation-id recovery, empty toolset; 33 tests (live-PG) | — |
| T10 — Giao diện chat-first và Workbench shell | DONE | (M2) | Next.js app: login/setup/projects/settings (T10a) + chat composer/SSE client/live Workbench (T10b); 55 web tests + Playwright smoke | — |
| T11 — SSE commit-ordered và reconnect | DONE | (M2) | Commit-ordered journal SSE, Last-Event-ID replay, NOTIFY+poll, backpressure; 22 tests (9 live-PG) | — |
| T12 — DNS proof, scope policy và grant lifecycle | NOT_STARTED | — | — | — |
| T13 — Durable Agent loop và checkpoints | NOT_STARTED | — | — | — |
| T14 — Ngân sách và privacy pipeline | NOT_STARTED | — | — | — |
| T15 — Worker enrollment và identity | DONE | (D04) | Enrollment tokens, hashed credentials, dual-plane auth, Go client; 26 TS + 4 Go tests; wired (main.go loop deferred to T16) | — |
| T16 — Worker journal, spool và supervisor | NOT_STARTED | — | — | — |
| T17 — Task scheduler, signed leases và results | NOT_STARTED | — | — | — |
| T18 — Offline sandbox runtime | NOT_STARTED | — | — | gVisor blocker |
| T19 — Offline tools và artifacts | NOT_STARTED | — | — | gVisor blocker |
| T20 — HTTP typed adapter | NOT_STARTED | — | — | — |
| T21 — Browser automation và scoped inspecting proxy | NOT_STARTED | — | — | — |
| T22 — Approval UI và exact-action decisions | NOT_STARTED | — | — | — |
| T23 — Pause/cancel/reconcile từ UI tới worker | NOT_STARTED | — | — | — |
| T24 — Bounded subagents và context compaction | NOT_STARTED | — | — | — |
| T25 — Finding workflow và evidence verification | NOT_STARTED | — | — | — |
| T26 — Report snapshot và retest | NOT_STARTED | — | — | — |
| T27 — Search và Project export/import | NOT_STARTED | — | — | — |
| T28 — Deployment scripts và doctor | NOT_STARTED | — | — | — |
| T29 — Security integration lab | NOT_STARTED | — | — | gVisor blocker |
| T30 — Chaos, performance và UX regression | NOT_STARTED | — | — | — |
| T31 — Backup/verify/restore và key recovery | NOT_STARTED | — | — | — |
| T32 — Observability và diagnostic export | NOT_STARTED | — | — | — |
| T33 — CI/release hardening và source provenance | NOT_STARTED | — | — | — |
| T34 — Owner acceptance và polish luồng dùng thật | NOT_STARTED | — | — | — |
| T35 — Live-model capability và quality eval tùy chọn | NOT_RUN (OPTIONAL) | — | — | cần owner opt-in |
| T36 — Bàn giao phiên bản cá nhân | NOT_STARTED | — | — | — |
