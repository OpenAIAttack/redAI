# 17 — Quan sát hệ thống, mã lỗi và chẩn đoán

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

## 1. Correlation

Log structured gồm timestamp, level, service, version, request_id, workspace_id, project_id optional, run_id, agent_step_id, tool_call_id, attempt_id, worker_id, fencing_token và reason_code. ID lấy từ server/validated input, không raw user string tùy ý. Trace xuyên HTTP/model/worker theo correlation IDs, không chèn target hoặc secret vào span name.

Metadata diagnostic khác raw task transcript. Diagnostic logs không chứa prompts, full command, payload, target credentials, cookie, file body hoặc evidence raw. Owner có thể xem raw artifact qua authenticated evidence UI riêng; hành động đó được audit. Không external telemetry mặc định.

## 2. Metrics có ích

Active/queued runs; state transition count; task lease expiry; unknown outcomes; duplicate result ACK; stale-fence rejects; pending approvals age; worker heartbeat age; provider requests/error/latency; tokens observed/usage unknown; budget reserved/spent; artifact finalize failures; storage free bytes; SSE reconnect/buffer overflow; backup created/verified age. Không high-cardinality target URL/user prompt làm label.

Phân biệt provider latency với queue startup; tool runtime với artifact upload. Run total gồm chờ approval phải phân tích riêng active time. Không lấy metric thiếu completion events để kết luận mọi run nhanh.

## 3. Error catalog

| Code | HTTP/Domain | UI và recovery |
|---|---|---|
| `AUTH_REQUIRED` | 401 | Đăng nhập lại, không mất draft |
| `CSRF_INVALID` | 403 | Tải session token mới; không replay mutation không idempotent |
| `REVISION_CONFLICT` | 409 | Hiển thị version mới để owner đối chiếu |
| `IDEMPOTENCY_CONFLICT` | 409 | Không retry với body khác cùng key |
| `REQUEST_IN_PROGRESS` | 409 | Retry cùng key sau delay bounded |
| `ACTIVE_RUN_EXISTS` | 409 | Mở run hiện có |
| `SCOPE_DENIED` | 403/domain blocked | Nêu mục tiêu ngoài grant; owner chỉnh Project nếu có quyền |
| `GRANT_REVOKED` | 403/domain blocked | Dừng, không tự verify lại |
| `APPROVAL_EXPIRED` | 409 | Tạo approval mới khi action còn phù hợp |
| `APPROVAL_STALE` | 409 | Thông báo fingerprint thay đổi |
| `WORKER_UNAVAILABLE` | 503/waiting_worker | Giữ worker được chọn, có reconnect |
| `STALE_FENCE` | 409 | Worker reconcile, không resend effect |
| `RESULT_CONFLICT` | 409 | Quarantine/review integrity |
| `EFFECT_UNKNOWN` | needs_attention | Owner xem evidence/reconcile, không blind retry |
| `PROVIDER_UNAVAILABLE` | 503/run fail | Retry same permitted config theo policy |
| `MODEL_OUTPUT_INVALID` | run failed | Giữ partial text, không dispatch tools |
| `DATA_POLICY_DENIED` | 403/domain blocked | Chọn local/nguồn phù hợp, không fallback cloud |
| `BUDGET_EXHAUSTED` | run blocked | Hiển thị reserved/observed/unknown |
| `CONTEXT_LIMIT` | run partial/blocked | Giữ history; owner thu hẹp mục tiêu |
| `LOOP_DETECTED` | run partial/blocked | Tóm tắt không tiến triển |
| `STORAGE_FULL` | 507/domain blocked | Dọn bằng owner policy, không xóa tự động evidence |
| `ARTIFACT_HASH_MISMATCH` | 422 | Quarantine file, upload lại |
| `EVENT_CURSOR_EXPIRED` | 410 | Snapshot+replay, không chạy lại Run |
| `RUNTIME_GUARD_UNAVAILABLE` | 503/domain blocked | Doctor runtime/proxy, không downgrade |
| `CLOCK_UNSAFE` | 409 worker | Sửa đồng hồ, không bỏ check expiry |
| `UPGRADE_REQUIRED` | 426 worker | Cập nhật compatible version |

## 4. Diagnostics export

Owner tải bundle logs safe/config versions/health/manifest, không secrets/evidence mặc định. Trước export hiển thị phạm vi và warning có thể chứa metadata nhạy cảm. Redaction applied, checksum manifest. Không tự upload diagnostics lên dịch vụ bên ngoài. Error IDs cho phép tìm trace nội bộ mà không phơi dữ liệu trong screenshot.

## 5. Alerts cá nhân

UI banner khi backup chưa verified, key missing, disk dưới ngưỡng, worker revoked, unknown effect hoặc provider budget blocked. Không tích hợp email/Telegram scheduler v1; owner tự đọc Operations. Không gọi cloud monitoring chỉ để đánh dấu app healthy. Alert thresholds và units trong config/schema, không rải magic numbers qua components.
