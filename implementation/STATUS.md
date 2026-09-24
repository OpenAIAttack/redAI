# Trạng thái triển khai ứng dụng

Cập nhật: **2026-09-24**. Milestone M0 đang triển khai. Baseline: nhánh
`claude/fervent-archimedes-fnkoam`. DONE chỉ đặt sau review + integration checks
trên cây nguồn đã tích hợp; "PASS" do coder tự báo chưa đủ để đóng task.

Lệnh kiểm tra chung: `pnpm run check` (env → typecheck → lint → format → test →
build → `go:check`). Bằng chứng M0 khác ở `release-evidence/` và STATUS bên dưới.

| Task | Trạng thái | Commit | Checks/evidence | Blocker |
|---|---|---|---|---|
| T00 — Khóa dependency và môi trường | DONE | (M0 baseline) | `docs/dependency-baseline.md`; `pnpm run env:check` passes | gVisor thiếu → chỉ chặn execution lab (T18/T19/T29) |
| T01 — Khởi tạo monorepo và quality commands | DONE | (M0 baseline) | `pnpm run check` xanh (9 vitest, tsc -b, eslint, prettier, go vet/build/test); import-boundary test | — |
| T02 — Migration PostgreSQL và invariants DB | IN_PROGRESS | — | Agent A dispatched (own PG DB) | — |
| T03 — Sinh type và kiểm tra API contracts | IN_PROGRESS | — | Agent B dispatched (fixtures) | — |
| T04 — Bootstrap owner và sessions | NOT_STARTED | — | — | — |
| T05 — Secret vault và model/settings configs | NOT_STARTED | — | — | — |
| T06 — Project, Chat metadata, notes và bindings | NOT_STARTED | — | — | — |
| T07 — Local ObjectStore và upload an toàn | NOT_STARTED | — | — | — |
| T08 — Mock model và compatible provider adapter | NOT_STARTED | — | — | — |
| T09 — Durable Ask và Chat persistence | NOT_STARTED | — | — | — |
| T10 — Giao diện chat-first và Workbench shell | NOT_STARTED | — | — | apps/web placeholder (D02) tới T10 |
| T11 — SSE commit-ordered và reconnect | NOT_STARTED | — | — | — |
| T12 — DNS proof, scope policy và grant lifecycle | NOT_STARTED | — | — | — |
| T13 — Durable Agent loop và checkpoints | NOT_STARTED | — | — | — |
| T14 — Ngân sách và privacy pipeline | NOT_STARTED | — | — | — |
| T15 — Worker enrollment và identity | NOT_STARTED | — | — | — |
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
