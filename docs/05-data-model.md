# 05 — Domain model, persistence và invariants

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

## 1. Quy ước

ID dùng UUID do application tạo; không chứa tên mục tiêu. Thời gian DB `timestamptz` UTC, API RFC 3339 UTC, UI chuyển theo timezone Settings (`Asia/Bangkok` ban đầu). Thời gian lease server là authoritative; worker dùng monotonic timer và safety margin. Số tiền dùng integer micro-USD, truyền JSON dưới dạng chuỗi thập phân để không mất chính xác JavaScript. Không dùng float cho ledger.

Mọi row thuộc owner data đều có `workspace_id`; thực thể cấp Project có `project_id`. V1 chỉ một Workspace không phải lý do bỏ predicate hoặc foreign key cùng Workspace. `revision` tăng khi edit với optimistic concurrency. JSONB dùng cho snapshot/typed payload, không dùng thay tất cả quan hệ.

## 2. Entity và nguồn sự thật

| Entity | Vai trò và liên kết |
|---|---|
| `workspaces`, `owners`, `sessions` | Installation chứa một Workspace/owner; session chỉ lưu hash token |
| `projects` | Hồ sơ công việc; Inbox là Project hệ thống |
| `dns_proofs` | Bằng chứng DNS có challenge và timestamp; không tự là grant vô hạn |
| `scope_versions` | Phạm vi immutable, mỗi version liên kết một Project |
| `authorization_grants` | Cho phép sử dụng scope version; actor, attestation, trạng thái, epoch, expiry |
| `assets` | Tài sản đã khai báo/phát hiện; trạng thái discovered/authorized là view theo grant, không boolean tự cấp quyền |
| `workers`, `worker_credentials`, `enrollment_tokens` | Máy thực thi, phiên kết nối và credentials tách biệt |
| `project_workers` | Binding Project → worker/zone được cho phép |
| `provider_configs`, `secrets` | Model config và ciphertext secret, không lưu secret trong JSON snapshot |
| `chats`, `messages` | Conversation; mỗi Chat có thứ tự message riêng |
| `runs`, `agent_sessions`, `agent_steps` | Phiên công việc, coordinator/child logic, durable model boundary |
| `tool_calls`, `task_attempts` | Ý định công cụ ổn định và các lần thực thi cụ thể |
| `approvals` | Quyết định một lần cho fingerprint chính xác |
| `artifacts`, `artifact_links` | Metadata bytes immutable và liên kết provenance |
| `findings`, `finding_versions`, `finding_evidence`, `retests` | Nhận định và lịch sử kiểm chứng |
| `reports` | Snapshot phiên bản finding và artifact đầu ra |
| `notes`, `document_chunks` | Ngữ cảnh Project được chọn/trích xuất |
| `events`, `event_counters` | Journal sự kiện có cursor commit-ordered trong Workspace |
| `budget_reservations`, `usage_entries` | Dự trù và chi phí quan sát được, không tự bỏ mất khoản unknown |
| `idempotency_keys`, `audit_events`, `maintenance_jobs` | Dedup requests, nhật ký bảo mật, cleanup/backup |

DDL cụ thể ở `db/001_reference_schema.sql`. Các JSON payload được kiểm tra theo schema trước persist; DB cũng check enum, unique và FK quan trọng.

## 3. Invariants không được phá

**INV-001 — Ownership closure.** Run, Chat, scope version, grant, worker binding và artifact link phải cùng Workspace/Project nơi quan hệ yêu cầu. Một UUID hợp lệ không đủ cho authorization. Composite FK bảo vệ quan hệ Project; server vẫn kiểm tra session/binding.

**INV-002 — Một run active trên một Chat.** Active gồm queued, running, waiting_approval, waiting_worker, paused, cancel_requested, cancellation_pending, needs_attention. Partial unique index bảo vệ khi hai tab gửi cùng lúc. Terminal run gồm completed, failed, canceled, expired. Tiếp tục terminal run tạo run mới `resumes_run_id`, không sửa history.

**INV-003 — Versioned authority.** Scope version immutable. Grant có thể revoked ngay; run snapshot không được giữ quyền sống sau revoke. Mọi dispatch/renewal kiểm tra live grant epoch và worker status. Owner mở rộng scope tạo version mới và áp dụng cho run mới; không âm thầm mở rộng run đang chạy.

**INV-004 — Durable before effect.** Logical call + attempt + input digest + event được commit trước worker dispatch. Worker journal `start_intent` trước container start. Không lưu ý định quan trọng chỉ trong RAM.

**INV-005 — Một kết quả authoritative.** Chỉ attempt/fence đang được công nhận có thể chuyển logical tool call sang succeeded/failed. Duplicate submit cùng result digest trả cùng ACK. Submit digest khác cùng attempt là conflict/security event. Late result stale được quarantined, không ghi đè authoritative state.

**INV-006 — Không giả exactly-once.** Lease/fencing ngăn stale worker commit vào control-plane, không chứng minh tác động ngoài mạng chỉ xảy ra một lần. Outcome unknown phải reconcile hoặc yêu cầu owner review; không auto replay external_write/unknown/destructive.

**INV-007 — Bằng chứng immutable.** Payload artifact đã finalize không bị overwrite. Redaction, parsing hoặc report tạo artifact/version mới với link nguồn. Hash chứng minh tính toàn vẹn bytes trong hệ thống, không tự chứng minh tính trung thực của target/worker.

**INV-008 — Budget chung.** Child agents dùng cùng run ledger. Reservation được tạo transaction trước model request. Unknown usage giữ reservation chưa reconcile, không tính 0. Owner có thể tăng hạn mức bằng một audit action, không model.

**INV-009 — Event nhất quán.** Business mutation và durable event cùng transaction. Cursor cấp theo Workspace bằng row counter được khóa đến commit. SSE được phép giao lặp, không được bỏ vĩnh viễn event đã commit vì thứ tự sequence/commit đảo nhau.

**INV-010 — Tắt không đồng nghĩa dừng.** Grant revoked, cancel requested hoặc lease expired ngăn hoạt động mới; trạng thái canceled chỉ khi mọi active attempt đã xác nhận dừng hoặc đã được đối soát quiescent. Không biết thì cancellation_pending/needs_attention.

**INV-011 — Model không cấp quyền.** AI output không tạo live grant, binding, provider config, secret grant hoặc approval decision. Các use case đó chỉ owner API/session được phép.

**INV-012 — Xuất/nhập không cấp quyền.** Import tạo identifiers mới, đánh dấu grants inactive, worker bindings unset, secrets absent. Không import session/token để đăng nhập hoặc điều khiển worker.

## 4. State model

### Run

`queued → running`; `running → waiting_approval | waiting_worker | paused | completed | failed | needs_attention | cancel_requested`. Waiting/paused có thể về running sau kiểm tra live policy, absolute expiry và input note. Mọi trạng thái active có thể vào cancel_requested. `cancel_requested → canceled` khi đã quiescent, nếu chưa biết vào cancellation_pending. `cancellation_pending → canceled | needs_attention`. `needs_attention` chỉ trở lại running sau reconciliation minh bạch; không nút Retry mù.

`outcome` tách với lifecycle: `none | complete | partial | blocked`. completed/partial cho phép khi Agent chủ động kết thúc với coverage thiếu và unresolved items rõ; không dùng chữ “đã kiểm tra đầy đủ”. failed có thể giữ partial evidence. expiry khi có task đang chạy trước hết phải đi cancel path; không đổi thẳng expired làm mất theo dõi task.

### Tool call và attempt

Call: requested, blocked, waiting_approval, queued, executing, succeeded, failed, canceled, unknown. Attempt: queued, leased, started, uploading, succeeded, failed, cancel_requested, canceled, lost, unknown. `lost` nghĩa mất liên lạc; `unknown` nghĩa chưa xác định outcome của hiệu ứng. Không dùng `lost` như bằng chứng tool chưa chạy.

### Finding

Đánh giá kỹ thuật (`candidate`, `needs_review`, `verified`, `rejected`, `inconclusive`) tách remediation (`open`, `fixed`, `accepted_risk`). Retest có result riêng `observed_fixed`, `still_present`, `inconclusive`; finding `fixed` không làm mất verification ban đầu. Severity `info | low | medium | high | critical`, confidence `low | medium | high` độc lập.

## 5. Transaction quan trọng

**Create run:** check owner/Project/chat; lock Chat; check active unique; snapshot settings/scope; insert user message nếu atomic send; insert run/agent_session; update message_seq; append event; persist idempotency response; commit. API response chỉ sau commit. Một endpoint mutation không vừa gửi message lại vừa tạo run không gắn message rõ ràng.

**Model boundary commit:** compare run lease/fence; store model response artifact/parsed plan; insert tool_calls với unique `(agent_step_id, provider_tool_index)`; update step checkpoint; append events. Không dispatch tool_calls nằm trong response chưa commit. Streaming text trước commit được đánh dấu provisional, không trở thành kế hoạch authoritative.

**Approve:** lock approval, verify pending/expires/fingerprint/live grant; set decision; create attempt duy nhất với unique call attempt_no; event; commit. Policy denial không thể được override bằng approval card.

**Finalize artifact:** check upload pending/owner/attempt; verify size/digest bằng bytes server quan sát; atomic rename; transaction metadata ready + event. DB/file không atomic cùng hệ thống: staging và reconciliation xử lý crash giữa hai thao tác. File final tồn tại mà DB chưa ready là orphan candidate, không tự public.

**Cancel:** lock run; mark intent; invalidate pending approvals; mark queued attempts canceled, started attempts cancel_requested; append event. Sau đó worker heartbeat/lease renewal nhận directive. Request transaction không chờ tất cả tiến trình chết.

## 6. Deletion và retention

Archive khác delete. Delete Project yêu cầu không run active hoặc chấp nhận cancel trước; tombstone Project ngay và tạo maintenance job. Revoke grants/bindings, chặn reads mới trừ owner recovery view. Purge theo batch có checkpoint; xóa artifact link trước, xóa payload khi không còn reference hợp lệ và retention hết. Audit ghi đối tượng đã xóa bằng ID/timestamp không cần giữ target content.

V1 đề xuất raw task logs 30 ngày, artifacts/finding/report giữ đến khi owner xóa, SSE events 30 ngày; job spool worker tối đa 24 giờ sau ACK. Owner có thể đặt dài hơn. Secret deletion xóa ciphertext và mapping; backup cũ vẫn có dữ liệu tới expiry của backup, UI không hứa xóa xuyên mọi bản sao.

## 7. Index, search và migration

Index cho Chat message cursor, Project updated_at, active run, claimable attempts, worker heartbeat, grant trạng thái và artifact references. Full-text index trên title/notes/redacted extracted text; không index secrets hoặc raw sensitive dump. Mọi query search có Workspace/Project predicate trước pagination.

Migration additive trước code dùng field; backfill bounded; cutover; cleanup ở release sau. Không drop field đang có run active. Backup trước migration destructive. SQL reference chưa là chứng cứ chạy thành công trên PostgreSQL; T02 phải apply/test constraints và generate rollback/runbook.
