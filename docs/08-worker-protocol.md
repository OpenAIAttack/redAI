# 08 — Worker đồng nhất, lease, fencing và phục hồi

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

## 1. Trust model và danh tính

Worker là trusted daemon do owner cài trên Linux; sandbox payload không tin cậy. Worker binary có toolbox manifest version/digest. Mỗi installation của worker có `worker_id` UUID lưu ổn định và bearer credential riêng; hostname chỉ display, không dùng nhận dạng hoặc authentication. Không clone file identity/token vào image dùng cho nhiều máy.

CLI mục tiêu: `redai-worker enroll`, `run`, `doctor`, `status`, `revoke-local`. Đây là lệnh cần coding agent triển khai, chưa có binary trong gói đặc tả. Credentials lưu mode 0600, state dir 0700; không truyền token vào command line/log. Worker không kết nối trực tiếp tới DB/LLM.

## 2. Enrollment và session

Owner API tạo one-use enrollment token 256-bit entropy, TTL10 phút, hash trong DB, ràng buộc Workspace và worker display name tùy chọn. CLI gửi token qua HTTPS body, identity/public metadata và manifest. Server transaction consume token, tạo worker/credential; token replay reject. Enrollment request có idempotency để retry cùng intent không tạo worker thứ hai; credential chỉ được cấp một lần logic; retransmission cùng intent tuân theo cửa sổ mã hóa ở mục11, ngoài cửa sổ cần owner rotate/re-enroll.

Worker credential 256-bit opaque, hash DB, TTL30 ngày, rotate có overlap tối đa 5 phút. `open-session` tạo session UUID và tăng generation; chỉ một active session cho worker identity. Session cũ bị thay thế nhận SESSION_SUPERSEDED, ngừng claim, không được dùng renewal để giữ task sống. Reconnect network của cùng daemon không tự mở session mới nếu session còn hợp lệ; daemon restart mở session mới và reconcile journal.

## 3. HTTPS endpoints

`POST /sessions`, `POST /heartbeat`, `POST /tasks/claim`, `POST /tasks/:attemptId/ack`, `POST /tasks/:attemptId/renew`, `POST /tasks/:attemptId/events`, `POST /tasks/:attemptId/result`, `POST /tasks/:attemptId/reconcile`, artifact upload endpoints. `contracts/worker.openapi.yaml` định nghĩa request/response. Worker tạo kết nối outbound; không cần mở port inbound để nhận lệnh.

Claim long-poll tối đa20 giây, trả một task hoặc204. Heartbeat mỗi5 giây, renewal mỗi10 giây, lease45 giây, safety margin5 giây. Worker có capacity2 mặc định; server cũng transaction-reserve slot, không tin capacity do client báo để oversubscribe. Heartbeat gồm session, free slots, runtime health, storage pressure, supported manifest, trạng thái attempt IDs không chứa command output.

## 4. Task envelope và chữ ký

Envelope chứa schema_version, tool_call_id, attempt_id, attempt_no, fencing_token, worker_id/session_id, Project/Run, tool_name, input_json, input_sha256, scope_version_id, grant_id, policy_epoch, target descriptors, image_digest, timeout/resource limits, issued_at/expires_at, policy snapshot và artifact input refs. Không raw secret trong task envelope; credential references chỉ được resolve bằng capability ngắn hạn đúng target.

Payload lease ký Ed25519 JWS bằng installation signing key; worker giữ trusted public key. JSON input canonicalization theo RFC8785 với thư viện đã kiểm tra; server lưu exact canonical bytes. Worker verify signature + hash + audience/session/time + image manifest trước acknowledge. Không tự triển khai crypto/canonicalization tùy hứng. Rotation có key_id, active/retiring public keys, hết overlap task cũ phải reconcile.

Lease là quyền thời gian ngắn cho đúng task, không owner credential. Token không được cho sandbox đọc. Renewal chỉ server cấp sau live grant/session/task/cancel check; snapshot cũ không vượt revoked grant. Thay args tạo logical call/fingerprint mới, không renew task với nội dung khác.

## 5. Trình tự nhận/chạy task

1. Verify envelope và policy compatibility; kiểm tra disk/runtime/network guard health.
2. Lưu journal entry `received` và fsync.
3. ACK accepted theo attempt/fence; server đánh leased→started chỉ khi worker báo actual start (ACK chưa đủ).
4. Tạo sandbox container với label attempt_id/worker_id, cấu hình network/policy đã chuẩn bị; journal `prepared`.
5. Fsync `start_intent` trước start; start container; ghi container ID và observed state.
6. Báo started; stream bounded output chunks có seq; renew lease độc lập.
7. Thu kết quả, dừng/quiesce container/network trước terminal result; upload/finalize artifacts.
8. Submit result digest; chỉ xóa spool sau durable ACK và retention grace.

Nếu server ACK response bị mất, retry cùng ID/digest. Không tạo container mới khi container mang attempt label đã tồn tại. Docker container không được auto-restart sau host boot; daemon reconcile trước khi chạy lại.

## 6. Journal và crash windows

Journal là thư mục state bền vững theo attempt: atomic `manifest.json`, append-only records length/checksum, fsync tại received/prepared/start_intent/started/terminal. Có single-instance lock cho worker daemon. Output spool riêng, quota64 MiB/task; vượt quota phải truncate có flag hoặc dừng theo policy, không ăn hết disk host.

| Window bị crash | Recovery |
|---|---|
| Trước received fsync | Server chưa nhận authoritative start; claim expiry, không giả đã chạy |
| Sau received trước container create | Reconcile server; chỉ tiếp tục nếu fence/lease còn hợp lệ hoặc được cấp lại cho cùng attempt |
| Sau create trước start | Tìm container label, kiểm tra state; không tạo thêm |
| Sau start trước journal started | Quan sát container/log/proxy journal; outcome có thể unknown, không start lại |
| Sau network effect trước result | Lưu evidence còn có; reconcile owner nếu không chứng minh kết quả |
| Sau result commit trước worker ACK nhận | Retry result cùng digest, server trả duplicate ACK |
| Sau server rotate/revoke | Quarantine output cần review; không tiếp tục task bằng token cũ |

Không dùng câu “lease hết thì task chưa chạy” trong code. Fencing chỉ chặn stale writes vào server; worker cũ có thể đã tạo hiệu ứng bên ngoài. Mọi reassignment sau mất kết nối phải chờ quiescence được xác nhận hoặc explicit reconciliation không replay.

## 7. Local watchdog và partition

Worker ghi deadline bằng monotonic clock dựa TTL server trả sau khi trừ round-trip và safety margin. Nếu không renew kịp, ngừng gửi request mới, thu hồi egress token, terminate process group/container, force kill sau grace5 giây. Independent watchdog/reaper phải hoạt động cả khi execution goroutine deadlock; host boot unit dừng orphan sandbox trước nhận task.

Không tuyệt đối tin daemon cooperative là security boundary chống worker host bị chiếm quyền. Worker compromised nằm ngoài bảo đảm tự động; owner phải revoke, isolate host và xem evidence là untrusted. Server không đánh canceled chỉ dựa elapsed45s; đợi worker/reaper acknowledgement hoặc owner xác nhận thủ công có audit.

## 8. Cancel và drain

Heartbeat/renew trả directive `cancel` và reason; lease không gia hạn khi cancel. Worker hủy child process/container/network tokens, flush logs, báo `canceled` với `quiescent=true`. `drain` ngừng claim mới, cho task hiện tại hoàn tất trong limits; không tương đương revoke. `revoke` chặn credential/session ngay và yêu cầu cancel mọi task.

Owner chọn worker cụ thể thì offline không fallback. Owner chọn explicit Project pool thì scheduler chỉ chọn trong pool/zone, policy/data compatible. Active stateful browser session gắn worker; không chuyển sang worker khác chỉ để tăng availability. Sau worker chết, browser state cần session mới và owner biết mất continuity.

## 9. Result contract

Result có attempt_id/fence, status, started_at/finished_at, exit_code nullable, summary bounded, artifact_ids, structured_result, output_truncated, observed_quiescent, effect_observation (`not_started`, `completed`, `unknown`), result_sha256 và worker_session_id. Model không được tự tạo result endpoint.

Server kiểm tra ownership/fence/schema/artifact readiness. Nếu stale, trả409 STALE_FENCE và lưu safe reconciliation record; không mất cơ hội phục hồi evidence nhưng không nhận kết quả như thành công. Result cùng digest trả200 ACK duplicate; khác digest409 RESULT_CONFLICT. Worker không được tự đánh `verified` cho finding; chỉ tạo dữ liệu đầu vào cho validation.

## 10. Acceptance

Hai worker có cùng manifest chạy được cùng bộ task fixture, không phụ thuộc role label. Cắt mạng giữa task và control-plane: watchdog ngừng egress/kill; không có tác vụ replay trên worker2. Restart daemon với một container còn chạy: nhận diện đúng attempt và reconcile. Clone identity phát hiện generation conflict. Token revoked không claim/upload/list metadata mới. Time skew vượt30 giây block claim với CLOCK_UNSAFE, không bỏ signature time validation.

## 11. Chi tiết digest, cấp secret và retransmission

`input_sha256` là SHA256 của exact RFC8785 canonical input UTF-8. `scope_policy_sha256` bind policy_snapshot, `tool_manifest_sha256` bind registry, resource_limits nằm trong signed claims. Worker phải decode JWS và so sánh toàn bộ claims bên ngoài với signed payload; không tin bản claims chưa đối chiếu. Result digest tính JCS của WorkerResult **bỏ field result_sha256** để tránh tự tham chiếu. Timestamp/large counters có representation cố định; Go phải reject integer overflow.

Enrollment/rotation cấp một credential logic; response có thể truyền lại cho cùng request authenticated trong10 phút bằng idempotency cache mã hóa. Không lưu plaintext response secret trong DB/log, không có list/reveal credential sau đó. Điều này làm retry khi mất response khả thi mà không tạo worker/credential thứ hai.

Input artifacts tải qua route attempt-bound với session/fence; worker không được GET artifact bất kỳ chỉ vì biết UUID. Credential capability resolve là route riêng, kiểm tra lại session/attempt/grant/origin trước trả các trường cần dùng cho trusted adapter. Plaintext chỉ ở memory của trusted handler, không task envelope/prompt/log/sandbox env chung; browser form có thể cần giá trị trong browser context, phải ghi nhận residual exposure và giới hạn origin/egress. Capability TTL≤30 giây và không dài hơn lease, không cấp khi lease sắp hết.
