# Trạng thái triển khai ứng dụng

Cập nhật: **2026-09-24**. **M0 + M1 (T00–T07) HOÀN TẤT** (T15 xong sớm) trên cây nguồn đã
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
| T08 — Mock model và compatible provider adapter | DONE | working tree trên main `1ad1c1f` (chưa commit) | Text/tools/SSE/structured output, synthetic probe + owner Settings/vault + persistent idempotency/fencing; PG18 395 PASS / 0 SKIP; E2E 4 PASS desktop/mobile; typecheck/lint/format/build/Go race PASS; `release-evidence/T08-probe/` | IPv6-only chưa hỗ trợ; deployment firewall/gVisor là gate riêng |
| T09 — Durable Ask và Chat persistence | NOT_STARTED | — | — | — |
| T10 — Giao diện chat-first và Workbench shell | IN_PROGRESS (Settings/login/Projects slice) | working tree | Settings probe E2E desktop/mobile; UI persistence nền tảng | Ask/Workbench/SSE chưa triển khai |
| T11 — SSE commit-ordered và reconnect | NOT_STARTED | — | — | — |
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


## Tiếp tục T08 — 2026-09-24

- Baseline `main` / `1ad1c1f`; không commit. Giữ nguyên các sửa đổi auth/vault/UI
  và tool installer có trước phiên này. Kế hoạch: `release-evidence/T08-streaming/PLAN.md`.
- Dependencies T03/T05 đã ghi DONE. Thêm `packages/llm/src/stream.ts`,
  `stream.test.ts`; mở rộng `compatible.ts`, `types.ts` cho SSE text/refusal,
  ghép tool fragments, kiểm tra finish/DONE, usage cuối stream, giới hạn bytes,
  timeout/cancel cả khi body treo. Chỉ trả tool calls sau validation hoàn chỉnh.
- Test viết trước implementation: 14 lỗi như dự kiến; sau triển khai: 19 SSE
  tests, tổng 58 scoped tests (56 provider + 2 boundary) PASS. Toàn suite với
  PostgreSQL 18 tại loopback 55448: **353 PASS, 0 SKIP**, gồm contract/DB tests.
- `pnpm run typecheck`, `lint`, `format`, `env:check` và `go test -race ./...`
  PASS. Production build PASS sau khi chạy lại ngoài sandbox. Sandbox chặn HTTP listen, child process và Go cache; những kiểm tra này
  đã chạy lại ngoài sandbox. Evidence trong `release-evidence/T08-streaming/`.
- Toolchain đã có Node 22.23.3, pnpm 10.33.0, Go 1.27.1, psql 16.15,
  runsc release-20260921.0; không cần tải thêm để làm T08. Có runsc binary
  chưa chứng minh Docker gVisor runtime/lab hoạt động.
- T08 còn IN_PROGRESS: probe synthetic có owner confirmation và persistence,
  Settings/vault wiring, deployment DNS/egress verification còn thiếu. T09 chưa
  bắt đầu. Không gọi provider tính phí hoặc target thật.


## T08 hoàn tất — 2026-09-25

- Giữ nguyên các thay đổi M0/M1/UI có sẵn; không commit/push/deploy. Task T08 đã
  đối chiếu dependencies T03/T05, tiêu chí, review security/concurrency và kiểm tra
  trên cây nguồn tích hợp. T09 là task kế tiếp; không tự tuyên bố G1/M2 hoàn tất.
- API owner-only `POST /api/v1/providers/:provider_id/probe`: confirmation/revision,
  CSRF + Origin, UUID idempotency; claim PostgreSQL trước network, replay kết quả
  đã commit, pending không auto-retry. Revision + attempt fence chặn stale completion.
- Settings/vault nối thật; 5 request synthetic bounded kiểm tra text/tools/SSE/
  structured JSON/cancel/usage. Kiểm tra credential/enabled/revision trước mỗi
  request, không dispatch tool giả. Thay config vô hiệu evidence cũ.
- Provider transport pin DNS IPv4 lookup, deny private/mixed results mặc định,
  local URL allowlist do installation quản lý, TLS verification, không redirect,
  retry hoặc ambient proxy. Không gọi provider tính phí/target thật.
- File chính: `packages/llm/src/{probe,transport}.ts`,
  `packages/application/src/settings/{probeService,probeStore}.ts`, API Settings,
  UI Settings, canonical contract/codegen và `db/migrations/0003_provider_probe.sql`.
  Quyết định D10 và hướng dẫn `docs/model-probe.md`.
- Checks cuối: **395 Vitest PASS, 0 SKIP** trên PostgreSQL 18;
  **4 Playwright PASS** desktop/mobile; ảnh được xem kiểm tra responsive;
  typecheck/lint/format/build và Go race PASS. Evidence:
  `release-evidence/T08-probe/RESULTS.md`, logs và screenshots cùng thư mục.
- Giới hạn: IPv6-only provider chưa hỗ trợ; cancel không chứng minh provider
  ngừng compute/billing; usage thiếu vẫn unknown. Deployment firewall/gVisor,
  context privacy/budget T14 và live-model opt-in T35 chưa được chứng nhận ở đây.


## Snapshot commit theo yêu cầu owner — 2026-09-25

Owner yêu cầu commit và push toàn bộ tiến độ hiện tại lên origin/main. Snapshot
bao gồm sửa auth/vault/readiness, UI nền tảng, T08 adapter/probe và evidence đã
kiểm tra. Commit subject: `feat: complete T08 provider probes and owner settings`.
395 Vitest + 4 E2E và quality checks nêu trên thuộc snapshot này; chưa triển khai
T09 hoặc chứng nhận các release gate còn lại. Local tools/runtime state vẫn bị
.gitignore loại trừ. Các ghi chú "chưa commit" phía trên là lịch sử trước snapshot.
