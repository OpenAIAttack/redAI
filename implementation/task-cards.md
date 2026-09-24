# Task cards — redAI Personal v1

Các đường dẫn `target_modules` là đường dẫn repository ứng dụng **cần được tạo**, không phải file đã triển khai trong gói đặc tả.

## T00 — Khóa dependency và môi trường

**Milestone:** M0 · **Priority:** MUST · **Dependencies:** Không

**Đọc:** `docs/04-architecture-repository.md` và `AGENTS.md`.

**Module bàn giao:** `docs/dependency-baseline.md`, `ops/`, `package.json`, `worker/go.mod`.

### Cách thực hiện

1. Kiểm tra toolchain hiện có; chọn các version stable đang được hỗ trợ theo docs chính thức, ghi version và ngày kiểm tra.
2. Pin Node/pnpm/Go/PostgreSQL và framework, không dùng floating latest trong release.
3. Lập license/provenance inventory và xác nhận không vendor code/asset/prompt HackerAI.

### Kiểm thử phải có

- Version check chạy được trên máy dev và CI.
- Danh sách dependency có license và nguồn; không chứa production key.

### Tiêu chí hoàn tất

- Baseline có version cụ thể và lockfile strategy.
- Thiếu Linux/gVisor chỉ ghi blocker cho execution suite, không chặn scaffold/DB/mocks.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

## T01 — Khởi tạo monorepo và quality commands

**Milestone:** M0 · **Priority:** MUST · **Dependencies:** T00

**Đọc:** `docs/04-architecture-repository.md` và `AGENTS.md`.

**Module bàn giao:** `apps/web`, `apps/api`, `apps/runtime`, `packages/domain`, `worker/`, `implementation/STATUS.md`.

### Cách thực hiện

1. Tạo pnpm workspace và Go module theo architecture, dependency graph không cyclic.
2. Thiết lập lint/format/typecheck/test/build commands và environment validation.
3. Tạo health stub phân biệt chưa cấu hình với ready; cấu hình test profile có nhãn mock.

### Kiểm thử phải có

- Clean install từ lockfile và build skeleton.
- Import boundary test: domain không import web/Docker/provider SDK.

### Tiêu chí hoàn tất

- Một lệnh checks cho TS và Go có exit status đúng.
- README hướng dẫn chạy dev không cần model key thật.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

## T02 — Migration PostgreSQL và invariants DB

**Milestone:** M0 · **Priority:** MUST · **Dependencies:** T01

**Đọc:** `docs/05-data-model.md` và `AGENTS.md`.

**Module bàn giao:** `packages/db`, `db/001_reference_schema.sql`, `tests/integration/db`.

### Cách thực hiện

1. Chuyển reference DDL thành migration versioned; apply trên PostgreSQL thật bản đã pin.
2. Thêm typed repositories/transaction wrapper và fixture seed owner/project.
3. Thực thi index/constraint/immutable trigger/counter helper; ghi các invariant bắt buộc ở application.

### Kiểm thử phải có

- Fresh migration và upgrade smoke.
- Composite FK cross-project negative; active-run unique; immutable artifacts/versions.
- Event counter concurrent commit-order test.

### Tiêu chí hoàn tất

- DDL apply không lỗi thực tế, không chỉ parse.
- Backup/rollback strategy cho schema được ghi; app không auto synchronize/drop tables.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

## T03 — Sinh type và kiểm tra API contracts

**Milestone:** M0 · **Priority:** MUST · **Dependencies:** T01

**Đọc:** `docs/06-api-realtime.md` và `AGENTS.md`.

**Module bàn giao:** `packages/contracts`, `contracts/`, `tests/contracts`.

### Cách thực hiện

1. Copy canonical schemas vào implementation source-of-truth, sinh TS/Go types bằng tooling đã pin.
2. Tích hợp JSON Schema validation strict và format/unknown-field checks.
3. Sinh OpenAPI clients/stubs nhưng domain handler chưa có phải báo not implemented ở dev, không fake success.

### Kiểm thử phải có

- Tất cả positive/negative fixtures trong tests/contract-cases.json.
- TS/Go parse cùng payload và từ chối cùng malformed fields.
- Contract drift check chạy trong CI.

### Tiêu chí hoàn tất

- Không dùng TypeScript cast như runtime validation.
- Enums/defaults khớp SPEC_LOCK và schemas.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

## T04 — Bootstrap owner và sessions

**Milestone:** M1 · **Priority:** MUST · **Dependencies:** T02, T03

**Đọc:** `docs/13-identity-settings.md` và `AGENTS.md`.

**Module bàn giao:** `apps/api/auth`, `packages/application/auth`, `ops/bootstrap`, `apps/web/login`.

### Cách thực hiện

1. Viết CLI bootstrap qua stdin, singleton owner/Workspace/Inbox, recovery code.
2. Session opaque hashed, cookie/CSRF/Origin, rate limit, logout/password reset/revoke.
3. Tạo login UI và session renewal/error states.

### Kiểm thử phải có

- Bootstrap race, invalid password, CSRF foreign origin, idle/absolute expiry.
- Worker token không gọi owner endpoint; reset revokes sessions.

### Tiêu chí hoàn tất

- Không public signup hoặc default credentials.
- Không password/token trong logs hoặc command args.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

## T05 — Secret vault và model/settings configs

**Milestone:** M1 · **Priority:** MUST · **Dependencies:** T04

**Đọc:** `docs/11-llm-context-privacy.md` và `AGENTS.md`.

**Module bàn giao:** `packages/application/secrets`, `packages/llm/config`, `apps/web/settings`.

### Cách thực hiện

1. AEAD secret storage với master key file, key_id/AAD, metadata-only API.
2. Provider config version, data modes/prices/endpoint allowlist và explicit fallback config.
3. Settings If-Match/revision, locked-key/placeholder rejection, session/password UI.

### Kiểm thử phải có

- Ciphertext khác mỗi nonce, wrong AAD/key fail; restart missing key không tự tạo key mới.
- Cross-project secret/ref denial; config revisions conflict.

### Tiêu chí hoàn tất

- Owner nhập key qua UI, không hard-code; runtime đọc qua credential_ref.
- local_only và cloud route hiển thị đúng, chưa probe không tuyên bố ready.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

## T06 — Project, Chat metadata, notes và bindings

**Milestone:** M1 · **Priority:** MUST · **Dependencies:** T04, T03

**Đọc:** `docs/02-prd-use-cases.md` và `AGENTS.md`.

**Module bàn giao:** `packages/application/projects`, `apps/api/projects`, `apps/web/projects`.

### Cách thực hiện

1. CRUD/archive Project, Inbox logic, Chat metadata, notes selected_for_context.
2. Mọi repository use case bind Workspace/Project; versioned settings và pagination.
3. Binding worker API chỉ owner điều khiển; phần worker cụ thể hoàn thiện sau T15.

### Kiểm thử phải có

- Project A không truy cập note/chat Project B qua đổi UUID.
- Revision conflict, archive không delete data, pending delete active run.

### Tiêu chí hoàn tất

- Empty/error/loading khác nhau.
- Project scope không chỉ là text trong chat.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

## T07 — Local ObjectStore và upload an toàn

**Milestone:** M1 · **Priority:** MUST · **Dependencies:** T06

**Đọc:** `docs/12-findings-evidence-reports.md` và `AGENTS.md`.

**Module bàn giao:** `packages/storage`, `apps/api/artifacts`, `tests/integration/storage`.

### Cách thực hiện

1. Implement staged upload, server hash/size verification, atomic rename và metadata finalize.
2. Logical storage keys, authenticated download, redacted preview, quarantine.
3. Document parsing text/Markdown/JSON/YAML/CSV/PNG/JPEG bounded; không fetch external refs.

### Kiểm thử phải có

- Hash mismatch, interrupted upload, finalize duplicate, disk full.
- Traversal/symlink/media mismatch/unsafe HTML preview.

### Tiêu chí hoàn tất

- Artifact ready chỉ khi bytes có và verified.
- Crash giữa rename/DB commit có reconciliation path, không public orphan.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

## T08 — Mock model và compatible provider adapter

**Milestone:** M2 · **Priority:** MUST · **Dependencies:** T05, T03

**Đọc:** `docs/11-llm-context-privacy.md` và `AGENTS.md`.

**Module bàn giao:** `packages/llm`, `tests/fixtures/models`.

### Cách thực hiện

1. Tạo scripted mock adapter, compatible adapter text/tools/stream/cancel/usage.
2. Capability probe bằng synthetic data, endpoint routing owner-only.
3. Map errors, disable hidden unbounded SDK retries, record unknown usage.

### Kiểm thử phải có

- Malformed tool JSON, stream interrupt, duplicate indices, provider429/timeouts.
- Mock payload capture canary; no cloud fallback local_only.

### Tiêu chí hoàn tất

- CI không cần trả phí hoặc key.
- Provider không hỗ trợ tools không được chạy Agent bằng text parsing.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

## T09 — Durable Ask và Chat persistence

**Milestone:** M2 · **Priority:** MUST · **Dependencies:** T06, T07, T08

**Đọc:** `docs/07-agent-runtime.md` và `AGENTS.md`.

**Module bàn giao:** `apps/runtime/ask`, `packages/application/messages`, `apps/api/runs`.

### Cách thực hiện

1. Atomic create Run/message, checkpoint, persist partial/final message với generation ID.
2. Ask toolset rỗng, context chỉ notes/files được chọn và current Project.
3. Pagination lịch sử, append notes không tạo run duplicate.

### Kiểm thử phải có

- Double-click/cùng Idempotency-Key; API crash sau commit.
- Close browser/restart API vẫn đọc Chat, Ask không tạo worker task.

### Tiêu chí hoàn tất

- Chat hoạt động end-to-end qua DB/provider thật hoặc mock được gắn nhãn.
- Tool failure/output không bị tạo trong Ask.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

## T10 — Giao diện chat-first và Workbench shell

**Milestone:** M2 · **Priority:** MUST · **Dependencies:** T06, T09

**Đọc:** `docs/03-ux-ui-spec.md` và `AGENTS.md`.

**Module bàn giao:** `apps/web`, `packages/ui`.

### Cách thực hiện

1. Xây sidebar Project/Chat, composer modes, attachment, theme/i18n/responsive.
2. Workbench Plan/Activity/Files/Findings/Usage gắn state API, chưa có data hiển thị empty không fake.
3. Keyboard/IME/focus/Markdown sanitize/long text handling.

### Kiểm thử phải có

- Browser tests1440/1024/390px, dark/light, keyboard, IME enter.
- Long transcript/composer rerender/unsafe Markdown.

### Tiêu chí hoàn tất

- Không chỉ screenshot mock; components nối API thật.
- Local worker vs local model wording không nhầm.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

## T11 — SSE commit-ordered và reconnect

**Milestone:** M2 · **Priority:** MUST · **Dependencies:** T02, T09, T10

**Đọc:** `docs/06-api-realtime.md` và `AGENTS.md`.

**Module bàn giao:** `apps/api/events`, `packages/application/events`, `apps/web/realtime`.

### Cách thực hiện

1. Event counter row lock cùng business transaction, durable event journal, NOTIFY wake-up.
2. Snapshot cursor, Last-Event-ID replay/dedup, filtering/cursor advancement.
3. Proxy buffering off, slow consumer backpressure, cursor expiry recovery.

### Kiểm thử phải có

- Commit inversion A delayed/B concurrent không skip.
- Disconnect after frame, duplicate IDs, expired cursor, buffer overflow.

### Tiêu chí hoàn tất

- UI không tạo run mới hoặc xóa history khi reconnect.
- Message provisional/final được phân biệt.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

## T12 — DNS proof, scope policy và grant lifecycle

**Milestone:** M3 · **Priority:** MUST · **Dependencies:** T06, T03

**Đọc:** `docs/10-authorization-scope.md` và `AGENTS.md`.

**Module bàn giao:** `packages/policy`, `apps/api/scope`, `apps/web/project-settings`.

### Cách thực hiện

1. Implement domain normalization/rules/exclusions/lab zones và shared test vectors.
2. One-time Project DNS challenge/proof, owner attestation/grant version/revoke epoch.
3. Policy reason codes/mode matrix; no model endpoint mutation.

### Kiểm thử phải có

- Toàn tests/policy-cases.json, deceptive suffix, IPv6, exclusions, shared IP.
- Second Chat không verify lại; revoke active grant không giữ permission.

### Tiêu chí hoàn tất

- Automatic không override deny; dependency explicit_only.
- Scope immutable, broadening chỉ Run mới.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

## T13 — Durable Agent loop và checkpoints

**Milestone:** M3 · **Priority:** MUST · **Dependencies:** T09, T11, T12

**Đọc:** `docs/07-agent-runtime.md` và `AGENTS.md`.

**Module bàn giao:** `apps/runtime/agent`, `packages/domain/runs`.

### Cách thực hiện

1. Claim run lease/fence, step boundaries, parsed plan, stable logical tool IDs.
2. Checkpoint source manifests/pending tools/notes and CAS commits.
3. Loop detection, time/step limits, finalization gate chưa dispatch network thật.

### Kiểm thử phải có

- Restart mỗi boundary bằng mock tool transport.
- Hai runtimes stale-fence commits, model response invalid không tool dispatch.

### Tiêu chí hoàn tất

- Không agent loop trong web request.
- No duplicate logical call sau retry/restart.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

## T14 — Ngân sách và privacy pipeline

**Milestone:** M3 · **Priority:** MUST · **Dependencies:** T13, T05

**Đọc:** `docs/11-llm-context-privacy.md` và `AGENTS.md`.

**Module bàn giao:** `packages/llm/context`, `packages/application/budget`, `apps/web/usage`.

### Cách thực hiện

1. Context manifest/redaction/token caps/summary selection; secret refs không values.
2. Budget reservations trước request, shared ledger, pricing version, unknown held.
3. Owner budget increase audit và usage UI measured/estimated/unknown.

### Kiểm thử phải có

- Parallel reserve race; missing usage; child requests cạnh tranh budget.
- Canary trong headers/body/HTML/errors/logs/payload capture.

### Tiêu chí hoàn tất

- Không số0 giả khi usage unknown.
- Không bật full-cloud hoặc provider khác tự động.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

## T15 — Worker enrollment và identity

**Milestone:** M3 · **Priority:** MUST · **Dependencies:** T04, T03

**Đọc:** `docs/08-worker-protocol.md` và `AGENTS.md`.

**Module bàn giao:** `worker/cmd/redai-worker`, `apps/api/worker-auth`, `apps/web/workers`.

### Cách thực hiện

1. Enrollment token one-use, idempotent encrypted retransmission, worker credential rotation.
2. Stable UUID/local permissions, session generation, heartbeat/doctor metadata.
3. Worker list/bind/drain/revoke và no public token reveal.

### Kiểm thử phải có

- Token replay/new identity denial, lost-response retry same intent.
- Two daemons cloned identity, expired/revoked token, path permissions.

### Tiêu chí hoàn tất

- Worker giữ danh tính sau restart nhưng session mới được reconcile.
- Credential chỉ được phép worker API/binding.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

## T16 — Worker journal, spool và supervisor

**Milestone:** M3 · **Priority:** MUST · **Dependencies:** T15

**Đọc:** `docs/08-worker-protocol.md` và `AGENTS.md`.

**Module bàn giao:** `worker/internal/journal`, `worker/internal/executor`, `worker/internal/lease`.

### Cách thực hiện

1. Persistent atomic manifests/fsync records, single-instance lock và bounded output spool.
2. Container labels/start_intent/state inspection và orphan reaper.
3. Watchdog độc lập execution goroutine, monotonic deadline/cancel process tree.

### Kiểm thử phải có

- Crash windows received/create/start/result trước ACK.
- Spool full, corrupted tail record, worker daemon restart, zombie child.

### Tiêu chí hoàn tất

- Không start container mới khi attempt container đã tồn tại.
- Outcome không biết được giữ unknown, không replay.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

## T17 — Task scheduler, signed leases và results

**Milestone:** M3 · **Priority:** MUST · **Dependencies:** T12, T13, T15, T16

**Đọc:** `docs/08-worker-protocol.md` và `AGENTS.md`.

**Module bàn giao:** `apps/api/worker-tasks`, `packages/application/execution`, `worker/internal/api`.

### Cách thực hiện

1. Task claim txn, worker capacity/binding, Ed25519 JWS/JCS input hash, renewal live grant.
2. ACK started/result dedup/conflicting digest/quarantine, fence current attempt.
3. Input artifact download và credential capability ràng buộc attempt.

### Kiểm thử phải có

- Signature tamper, session superseded, policy epoch stale, lease expiry.
- Concurrent claim, duplicate ACK/result, mismatched result digest, slot accounting.

### Tiêu chí hoàn tất

- Fencing không được tuyên bố exactly-once external effect.
- Không reassign lost external operation sang worker khác.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

## T18 — Offline sandbox runtime

**Milestone:** M3 · **Priority:** MUST · **Dependencies:** T16, T17

**Đọc:** `docs/09-sandbox-tool-execution.md` và `AGENTS.md`.

**Module bàn giao:** `worker/internal/sandbox`, `tools/images`, `ops/worker-doctor`.

### Cách thực hiện

1. Docker/runsc profile, non-root/cap-drop/read-only roots/no mounts, resource caps.
2. Offline network none, logical paths và isolated agent workspace.
3. Doctor kiểm tra runtime/image/guard; không downgrade.

### Kiểm thử phải có

- Host filesystem/socket/metadata inaccessible; memory/PID/time caps.
- Missing runsc/image mismatch fail closed; process tree cancel.

### Tiêu chí hoàn tất

- Linux lab thật có evidence, không chỉ mocks.
- Sandbox không nhận DB/model/worker token.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

## T19 — Offline tools và artifacts

**Milestone:** M3 · **Priority:** MUST · **Dependencies:** T18, T07

**Đọc:** `docs/09-sandbox-tool-execution.md` và `AGENTS.md`.

**Module bàn giao:** `worker/internal/tools`, `catalogs/tools.json`.

### Cách thực hiện

1. file list/read/write, terminal offline, parse OpenAPI external refs disabled.
2. Typed input/output, effect from registry, version manifest và safe previews.
3. Artifact upload/finalize nối provenance đúng call/attempt.

### Kiểm thử phải có

- Path traversal/symlink export, invalid args, timeout, tool binary unavailable.
- Two homogeneous workers cùng fixtures, hashes bằng nhau ở pure tools.

### Tiêu chí hoàn tất

- Offline vertical slice Agent→tool→artifact→summary chạy thật.
- Không command thực thi trên host hoặc tự tải package.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

## T20 — HTTP typed adapter

**Milestone:** M4 · **Priority:** MUST · **Dependencies:** T17, T19

**Đọc:** `docs/09-sandbox-tool-execution.md` và `AGENTS.md`.

**Module bàn giao:** `worker/internal/http`, `packages/policy`.

### Cách thực hiện

1. Normalize target components, resolver pinning, TLS verify, redirect từng hop.
2. Secret injection đúng origin/capability, request/body/response limits.
3. Evidence HTTP redacted/raw classification, method effect classification server-owned.

### Kiểm thử phải có

- DNS change, redirects foreign origin, Host/SNI mismatch, IPv6, private lab.
- Harmless POST counter không duplicate khi result ACK mất.

### Tiêu chí hoàn tất

- Không blind external network qua shell.
- HTTP lỗi không được kết luận target an toàn.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

## T21 — Browser automation và scoped inspecting proxy

**Milestone:** M4 · **Priority:** MUST · **Dependencies:** T20

**Đọc:** `docs/09-sandbox-tool-execution.md` và `AGENTS.md`.

**Module bàn giao:** `worker/internal/proxy`, `worker/internal/browser`, `tools/browser-image`.

### Cách thực hiện

1. Run-local TLS CA/inspecting proxy, authority/path checks từng request, upstream verify.
2. Browser firewall only proxy, deny UDP/direct/DNS paths; Playwright action schema.
3. Session affinity, pinning unsupported states, screenshot/DOM evidence, lease revoke.

### Kiểm thử phải có

- Hai vhost cùng IP; JS subresource/redirect/WS/WebRTC attempts ngoài grant.
- Proxy crash/lease expire grant revoke chặn request mới.
- Actual runsc+Chromium compatibility và no --no-sandbox shortcut.

### Tiêu chí hoàn tất

- CONNECT passthrough đơn thuần không đạt task.
- Browser state/cookies không vào logs/default export.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

## T22 — Approval UI và exact-action decisions

**Milestone:** M4 · **Priority:** MUST · **Dependencies:** T12, T13, T17, T10

**Đọc:** `docs/10-authorization-scope.md` và `AGENTS.md`.

**Module bàn giao:** `packages/application/approvals`, `apps/web/approval-card`.

### Cách thực hiện

1. Bốn mode snapshot, exact fingerprint/TTL, owner approve/reject one-shot.
2. Card đủ tool/target/worker/risk/time, stale/canceled visual states.
3. Transaction approve→attempt chỉ một lần, no reusable model grants.

### Kiểm thử phải có

- Hai tab approve; scope/secret/worker thay đổi; approve sau cancel/revoke/expiry.
- Automatic routine không popup, Reject no execution but Ask works.

### Tiêu chí hoàn tất

- Policy deny không được owner card chuyển allow.
- Nút success phản ánh committed result.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

## T23 — Pause/cancel/reconcile từ UI tới worker

**Milestone:** M4 · **Priority:** MUST · **Dependencies:** T17, T19, T22

**Đọc:** `docs/07-agent-runtime.md` và `AGENTS.md`.

**Module bàn giao:** `packages/application/run-control`, `worker/internal/lease`, `apps/web/run-controls`.

### Cách thực hiện

1. Cooperative pause boundary, notes consumption, terminal resume tạo Run mới.
2. Cancel fan-out child/tasks, revoke proxy lease, track quiescence.
3. Owner reconciliation modal có evidence/reason, không blind retry ambiguous effects.

### Kiểm thử phải có

- Cancel vs result race, lost worker, child active, approval pending.
- Healthy ack target và partition unknown state, no false canceled.

### Tiêu chí hoàn tất

- Stop button không chỉ ngắt streaming UI.
- Emergency stop và revoked grant deny renewals.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

## T24 — Bounded subagents và context compaction

**Milestone:** M4 · **Priority:** MUST · **Dependencies:** T14, T23

**Đọc:** `docs/07-agent-runtime.md` và `AGENTS.md`.

**Module bàn giao:** `apps/runtime/subagents`, `packages/llm/summary`, `prompts/`.

### Cách thực hiện

1. Coordinator delegation depth1/max2 children, allowed tools subset, shared budget.
2. Child workspace riêng và evidence handoff, parent finalization verification.
3. Schema-valid summary, retained tail, fallback không mất context cũ.

### Kiểm thử phải có

- Child tries recursive delegation/budget escape; parent finalizes too early.
- Summary omits active task, malformed/empty output, incomplete tool pair.

### Tiêu chí hoàn tất

- Không tạo worker role chuyên biệt.
- Summary không thay live domain/authorization state.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

## T25 — Finding workflow và evidence verification

**Milestone:** M5 · **Priority:** MUST · **Dependencies:** T19, T20, T07

**Đọc:** `docs/12-findings-evidence-reports.md` và `AGENTS.md`.

**Module bàn giao:** `packages/application/findings`, `apps/web/findings`.

### Cách thực hiện

1. Candidate/versions/status/severity/confidence, source provenance và evidence gates.
2. Owner review/high-critical confirmation, manual external source label.
3. Dedup suggestions không destructive merge, history giữ nguyên.

### Kiểm thử phải có

- Verified no evidence, wrong Project artifact, stale/fake result source.
- Edit text không sửa artifact hash, confidence không đổi severity.

### Tiêu chí hoàn tất

- Mọi verified finding có evidence ready traceable.
- Không model text tự gán status vượt verification gate.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

## T26 — Report snapshot và retest

**Milestone:** M5 · **Priority:** MUST · **Dependencies:** T25, T23

**Đọc:** `docs/12-findings-evidence-reports.md` và `AGENTS.md`.

**Module bàn giao:** `packages/application/reports`, `apps/web/reports`, `prompts/report-template.md`.

### Cách thực hiện

1. Snapshot finding versions/coverage/source scopes trước render Markdown/JSON/HTML.
2. Offline HTML escaped, artifact index/hash, report status thật.
3. Retest Run mới, current grants, observed_fixed/still_present/inconclusive.

### Kiểm thử phải có

- Report cũ không đổi khi finding sửa, target HTML scripts escaped.
- Retest unavailable/credentials missing không fixed.

### Tiêu chí hoàn tất

- Không hứa full pentest khi coverage partial.
- Report bytes download được và hashes khớp.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

## T27 — Search và Project export/import

**Milestone:** M5 · **Priority:** MUST · **Dependencies:** T26, T07

**Đọc:** `docs/12-findings-evidence-reports.md` và `AGENTS.md`.

**Module bàn giao:** `packages/application/export`, `packages/db/search`, `apps/web/search`.

### Cách thực hiện

1. Project-bound full-text metadata/redacted chunks, pagination.
2. ZIP manifest/hash, no credentials/sessions/live grants, UUID remap on import.
3. Archive size/path validation và staging commit/partial import explicit.

### Kiểm thử phải có

- Search cross-project, secret canary indexing.
- Zip traversal/symlink/bomb/hash mismatch; imported grants inactive.

### Tiêu chí hoàn tất

- Export/import roundtrip giữ nội dung và provenance external_source_id.
- Không auto execute bất cứ file/task nhập vào.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

## T28 — Deployment scripts và doctor

**Milestone:** M6 · **Priority:** MUST · **Dependencies:** T19, T05

**Đọc:** `docs/14-deployment-operations.md` và `AGENTS.md`.

**Module bàn giao:** `ops/compose`, `ops/systemd`, `ops/scripts`, `README.md`.

### Cách thực hiện

1. Compose control-plane/volumes/proxy và Linux worker service, migration startup order.
2. Bootstrap/doctor/key checks, private HTTPS, no exposed DB, pinned digests.
3. Upgrade/drain/rollback/emergency-stop commands có exit codes thật.

### Kiểm thử phải có

- Fresh install từ máy sạch, missing config/key, read-only storage.
- Restart services/worker identity persistent, no orphan auto-restart.

### Tiêu chí hoàn tất

- Không runnable compose tham chiếu image chưa build/push mà không hướng dẫn.
- Debug/mock profile không bị hiểu là personal production.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

## T29 — Security integration lab

**Milestone:** M6 · **Priority:** MUST · **Dependencies:** T20, T21, T22, T23, T28

**Đọc:** `docs/16-threat-model.md` và `AGENTS.md`.

**Module bàn giao:** `tests/security`, `tests/lab`, `release-evidence/G3`.

### Cách thực hiện

1. Tạo lab domains/resolver/vhosts/counters/storage fixtures, không external targets.
2. Chạy toàn threat/policy/canary/isolation cases và thu evidence.
3. Review secrets, network boundary, signatures và dependency supply chain.

### Kiểm thử phải có

- Zero scope bypass, zero secret canary leaks, zero unverified claims auto verified.
- Proxy fail-closed, session-clone, stale lease/fence and command injection inputs.

### Tiêu chí hoàn tất

- G3/G4 có Linux-runtime evidence thật.
- Critical/high security bugs không defer qua release.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

## T30 — Chaos, performance và UX regression

**Milestone:** M6 · **Priority:** MUST · **Dependencies:** T24, T27, T29, T11

**Đọc:** `docs/15-testing-evaluation.md` và `AGENTS.md`.

**Module bàn giao:** `tests/chaos`, `tests/e2e`, `release-evidence/G6`.

### Cách thực hiện

1. Fault injection tất cả recovery windows và concurrency race bằng deterministic fixtures.
2. Đo API/event/UI/history/capacity trên hardware ghi rõ, không giả LLM latency.
3. Long transcript/IME/mobile/theme/accessibility và source component screenshot.

### Kiểm thử phải có

- Recovery matrix, result dedup, counter commit order, cancel vs complete.
- Target latency and long history; ghi số đo/skips/hardware.

### Tiêu chí hoàn tất

- Không automatic replay unsafe side effect.
- Targets không đạt phải có measured gap/ADR, không sửa report giả.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

## T31 — Backup/verify/restore và key recovery

**Milestone:** M6 · **Priority:** MUST · **Dependencies:** T28, T27, T23

**Đọc:** `docs/14-deployment-operations.md` và `AGENTS.md`.

**Module bàn giao:** `ops/backup`, `ops/restore`, `tests/restore`, `release-evidence/G7`.

### Cách thực hiện

1. Quiescent snapshot DB+ObjectStore inventory+encrypted key recovery material.
2. Verify archive/hash/decryption, recovery locks/sessions/worker tokens revoked.
3. Fresh-machine restore, consistency checker, explicit execution re-enable.

### Kiểm thử phải có

- Missing/corrupt key, missing artifact, interrupted backup, hash mismatch.
- Active Run restore không replay, re-enroll worker + new lab task.

### Tiêu chí hoàn tất

- Backup created khác verified; fail exit nonzero.
- Restore drill có log/version/hash và measured time, không chỉ script exists.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

## T32 — Observability và diagnostic export

**Milestone:** M6 · **Priority:** MUST · **Dependencies:** T13, T17, T25

**Đọc:** `docs/17-observability-errors.md` và `AGENTS.md`.

**Module bàn giao:** `packages/observability`, `apps/web/operations`, `apps/api/diagnostics`.

### Cách thực hiện

1. Structured safe logs/correlation/metrics, reason codes nhất quán UI/API.
2. Operations health/unknown effects/backup/key/disk banners.
3. Diagnostics bundle default excludes raw prompts/commands/evidence/secrets.

### Kiểm thử phải có

- Log canary, high-cardinality labels, wrong request_id data, error schema.
- Disconnected SSE vs run state, diagnostics download access control.

### Tiêu chí hoàn tất

- Không external telemetry mặc định.
- Owner tìm được request→attempt→artifact bằng IDs mà không secret leak.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

## T33 — CI/release hardening và source provenance

**Milestone:** M7 · **Priority:** MUST · **Dependencies:** T29, T30, T31, T32

**Đọc:** `docs/18-release-acceptance.md` và `AGENTS.md`.

**Module bàn giao:** `.github/workflows`, `ops/release`, `release-evidence`, `docs/licenses`.

### Cách thực hiện

1. CI contracts/unit/integration/Go race/E2E/security runners, lockfiles và image digests.
2. SBOM/license inventory, release notes/known limits, migration compatibility.
3. Artifact build/checksum/signing process với keys không trong repo.

### Kiểm thử phải có

- Fresh build từ lockfile, package/release smoke, dependency audit review.
- No skipped critical gates, no mock provider fallback production.

### Tiêu chí hoàn tất

- G0–G7 matrix có trạng thái và file evidence.
- Không tự push/deploy bên ngoài khi owner chưa yêu cầu.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

## T34 — Owner acceptance và polish luồng dùng thật

**Milestone:** M7 · **Priority:** MUST · **Dependencies:** T33, T10, T26

**Đọc:** `docs/18-release-acceptance.md` và `AGENTS.md`.

**Module bàn giao:** `apps/web`, `docs/user-guide`, `release-evidence/owner-acceptance`.

### Cách thực hiện

1. Chạy owner script toàn chuỗi create→Ask→Agent→pause/cancel→finding→report→retest→restore.
2. Sửa friction onboarding/error/help states theo test thực, không thêm scope mới.
3. Ghi limitation và cách chạy job hằng ngày cho owner.

### Kiểm thử phải có

- Hai Project tách biệt, worker1 offline không nhảy worker2.
- App labels/data modes/cost unknown/human review đúng semantics.

### Tiêu chí hoàn tất

- Owner xác nhận workflow dùng được; unmet gates không che giấu.
- No TODO trong critical happy/error path.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

## T35 — Live-model capability và quality eval tùy chọn

**Milestone:** M7 · **Priority:** OPTIONAL · **Dependencies:** T24, T29, T25

**Đọc:** `docs/15-testing-evaluation.md` và `AGENTS.md`.

**Module bàn giao:** `tests/evals`, `docs/model-baseline`.

### Cách thực hiện

1. Chỉ khi owner đã cấu hình endpoint/key, chạy synthetic capability và lab20-case eval budget-capped.
2. Lưu model/version/config/prompt hashes, measured usage, numerator/denominator.
3. So sánh ground truth độc lập và ghi uncertainty/unsupported cases.

### Kiểm thử phải có

- Không target ngoài lab hoặc dữ liệu bí mật.
- Unknown cost được ghi nhận, provider capability không giả.

### Tiêu chí hoàn tất

- Task opt-in; thiếu key ghi NOT_RUN, không PASS.
- Kết quả không dùng quảng cáo benchmark chung từ mẫu nhỏ.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

## T36 — Bàn giao phiên bản cá nhân

**Milestone:** M7 · **Priority:** MUST · **Dependencies:** T34

**Đọc:** `docs/18-release-acceptance.md` và `AGENTS.md`.

**Module bàn giao:** `README.md`, `CHANGELOG.md`, `implementation/STATUS.md`, `release-evidence`.

### Cách thực hiện

1. Tổng hợp version/images/binary checksums, config/env, setup, upgrade, backup/recovery và known limits.
2. Đối chiếu requirements traceability; mọi MUST có implementation/test evidence.
3. Chuẩn bị repository/tag/release nội bộ; chỉ commit/push/deploy khi owner yêu cầu.

### Kiểm thử phải có

- Cài từ hướng dẫn cuối cùng trên fresh machine/VM và chạy lab smoke.
- Không link/file thiếu; package không chứa secrets hoặc private user data.

### Tiêu chí hoàn tất

- Ứng dụng và tài liệu nhất quán, owner tự vận hành/khôi phục được.
- T35 có trạng thái riêng, không giả đã benchmark model nếu chưa chạy.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.
