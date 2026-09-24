# 06 — REST API, SSE và hợp đồng lỗi

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

## 1. Quy ước chung

Owner API base `/api/v1`; worker API base `/worker/v1`. JSON UTF-8, snake_case. UUID/RFC3339 và MoneyString theo schema. Response resource có `id`, `revision`, timestamps nơi thích hợp. Collection `{items, next_cursor}`; cursor opaque, signed hoặc encoded validated, bound to filter/sort. Mặc định limit 50, max 100. Không offset cho timeline lớn.

OpenAPI ở `contracts/` là route contract. JSON Schema là nguồn type dùng chung; generate TypeScript/Go types nhưng vẫn runtime validation ở boundary. Domain validation (FK cùng Project, grant live, invariant) không được thay bằng JSON Schema đơn thuần.

## 2. Xác thực và request integrity

Owner dùng secure HttpOnly SameSite=Strict cookie, server-side session; mutation yêu cầu CSRF token và Origin hợp lệ. GET không được đổi state, trừ tạo network connection chỉ đọc. CORS không wildcard. Worker dùng bearer credential riêng, không owner session. TLS bắt buộc ngoài loopback test; deployment private vẫn có auth.

Resource sai owner/project trả 404 để tránh enumeration. 401 cho session thiếu/hết hạn, 403 cho hành động trên resource thuộc owner nhưng policy không cho phép. Không dựa hidden button ở UI để bảo vệ endpoint.

## 3. API nhóm chức năng

| Nhóm | Use cases chính |
|---|---|
| Auth | login, logout, session introspection; password recovery qua CLI |
| Projects | list/create/get/update/archive/delete, notes và worker bindings |
| Scope | tạo challenge, verify, tạo scope version/grant, revoke |
| Chats | list/create, read messages, append note/message |
| Runs | create/get, pause/resume/cancel, approval decision |
| Files | initiate upload, stream content, finalize, download metadata/content |
| Findings | list/create/version update, evidence links, retest |
| Reports | create snapshot, status, download artifacts |
| Workers | enrollment token, list/get, revoke, drain |
| Settings | provider config, secret create/delete, budget/data settings |
| Operations | health, diagnostic summary, backup job |
| Realtime | Workspace event stream có filter nhưng cursor toàn Workspace |

Không cung cấp owner endpoint execute-command không có Run/Project. Manual action trong UI vẫn tạo tool_call có actor owner và qua cùng policy/execution path.

## 4. Idempotency

Các mutation tạo Run, quyết định approval, tạo report, finalize upload, enrollment và dispatch-sensitive actions yêu cầu `Idempotency-Key` UUID. Scope key là `(actor identity, method, normalized route, key)`, không chỉ key toàn hệ thống. Lưu digest body chuẩn hóa, response status/body và expiry 24h trong transaction của nghiệp vụ. Request cùng key/body trả response cũ; cùng key/body khác trả 409 `IDEMPOTENCY_CONFLICT`.

Concurrent duplicate: unique reservation key, loser đợi transaction ngắn hoặc trả 409 `REQUEST_IN_PROGRESS` kèm retry_after; không chạy use case lần hai. Nếu owner retry sau thời gian lưu key, active-run unique và client_message_id vẫn giúp chống trùng nhưng không hứa dedup vô hạn. Tool attempts/result có ID riêng tồn tại suốt retention, không phụ thuộc HTTP key 24h.

## 5. Optimistic concurrency

Edit resource dùng `If-Match: "<revision>"`. Không khớp trả 409 `REVISION_CONFLICT`, chứa current revision và safe fields để UI reload/merge. Không sửa grant snapshot hoặc evidence bytes; sửa tạo version. Approval decision không merge. Client không tự retry edit với revision mới mà ghi đè thay đổi ở tab khác.

## 6. Error envelope

```json
{
  "error": {
    "code": "WORKER_UNAVAILABLE",
    "message": "Worker đã chọn hiện chưa sẵn sàng.",
    "request_id": "00000000-0000-4000-8000-000000000001",
    "retryable": true,
    "details": {"worker_id": "00000000-0000-4000-8000-000000000002"}
  }
}
```

`details` chỉ allowlisted safe keys. Không stack trace, credential, full command hoặc arbitrary upstream body. 422 schema/domain input; 409 conflict; 429 rate/budget throttle; 503 dependency unavailable; 500 unexpected bug. Một business blocked state của Run có thể trả 200 cho GET; không mọi failed run đều HTTP500.

## 7. SSE protocol

Endpoint `GET /api/v1/events?project_id=...&after=...`. Cookie-authenticated; header `Last-Event-ID` khi reconnect, `after` cho initial navigation. Chỉ chấp nhận một cursor thực tế: header ưu tiên nếu có và hợp lệ. Payload envelope có schema_version, event_id, workspace_id, project_id optional, run_id optional, type, created_at, data. Cursor/event_id là **decimal string per Workspace**.

```text
id: 1204
event: run.state_changed
data: {"schema_version":"1.0","event_id":"1204","workspace_id":"...","project_id":"...","run_id":"...","type":"run.state_changed","created_at":"2026-09-24T03:00:00Z","data":{"from":"queued","to":"running"}}

```

SSE có `id`/`Last-Event-ID` theo HTML Standard [SRC05]. Giao lặp là bình thường; client dedup theo event_id. Proxy tắt buffering và cache. Heartbeat comment mỗi 15s. Slow consumer có buffer tối đa 1 MiB, vượt thì đóng connection và để client replay từ cursor; không block domain transaction vì một tab chậm.

## 8. Không mất event do sequence/commit race

Trong transaction mutation, lock `event_counters` row của Workspace (`FOR UPDATE`); lấy/increment counter cho events cần ghi; insert events; commit cùng mutation. Row lock giữ tới commit, nên transaction sau không thể cấp cursor cao rồi commit trước transaction đang giữ cursor thấp. Không dùng `bigserial` làm bằng chứng thứ tự commit.

API subscribe theo vòng: query committed events `event_id > cursor` order asc limit; flush; update cursor; wait notification hoặc timeout; query lại. `LISTEN/NOTIFY` chỉ wake-up. Filter Project vẫn cần tiến cursor qua các event không match: server có thể gửi `stream.cursor` chứa cursor mới để không replay scan vô hạn; không tiết lộ payload Project khác.

Snapshot endpoint trả `snapshot_cursor` được lấy cùng consistent transaction với data. Nếu cursor cũ đã purge, trả 410 `EVENT_CURSOR_EXPIRED`; client fetch snapshot rồi stream after cursor. Nếu future cursor hoặc Workspace sai trả 400/404. Không reset cursor về 0 mà xóa local UI state khi network error.

## 9. Provisional model tokens và durable message

Không cần ghi DB mỗi token. API/runtime gom text delta tối đa mỗi 250ms hoặc 4KiB. Delta event gắn `(message_id, generation_id, delta_seq)` và là provisional. Final message commit có full text/hash và trạng thái completed. Reconnect nhận persisted partial snapshot hoặc final message. Nếu model request chết, partial message giữ nhãn interrupted; không biến nó thành tool instruction. Tool call chỉ hiển thị executable sau boundary commit.

V1 có thể ghi grouped deltas vào events để replay đơn giản, quota/retention có giới hạn. Không gửi private model reasoning event. Structured output chỉ dùng khi validate thành công.

## 10. File upload protocol

Create metadata pending với expected size/type → PUT bytes theo upload session owner-bound → server hash bytes và enforce hard length → finalize idempotent → metadata ready. Không nhận path filesystem từ request. Finalize trước đủ bytes trả 409; sai hash trả 422 và quarantine. Download qua authenticated API, `Content-Disposition: attachment` cho loại nguy hiểm; preview HTML render sandboxed hoặc dưới dạng text.

Worker artifacts dùng cùng nguyên tắc nhưng credential/capability chỉ được tạo artifact cho attempt của mình, TTL bounded; không cho list toàn ObjectStore. Upload fail không được báo tool hoàn tất với evidence giả. Result chỉ link artifact ready hoặc nêu evidence_missing.

## 11. Compatibility

Version major trong path; schema_version minor trong events/worker messages. Additive optional field có thể tương thích; enum mới phải kiểm tra consumer tolerant behavior trước rollout. Worker quá cũ thiếu policy schema mới không claim task; API trả UPGRADE_REQUIRED. Không fallback sang unsigned legacy task format.

## 12. Các API hỗ trợ không được bỏ quên

`GET /snapshot?project_id=...` trả compact Workspace/Project snapshot và commit-consistent cursor; Run chi tiết dùng `/runs/:id/snapshot`. Snapshot có giới hạn100 Chat gần nhất; lịch sử cũ tiếp tục phân trang. Settings/session/password APIs nằm trong OpenAPI. Không để màn hình Security chỉ là form chưa có handler.

Owner reconciliation của unknown call có ba quyết định: close_inconclusive, accept_observed_result có evidence, hoặc confirm_quiescent_no_replay có lý do. Không quyết định nào tự replay task. Kết quả owner attestation được ghi như vậy, không giả là ACK từ worker. Emergency resume chỉ bật Run mới sau doctor/reauth; không tự hồi sinh Run từ restore.

Đối với response chứa credential/enrollment secret, idempotency cache phải mã hóa AEAD, không plaintext JSON; TTL truyền lại10 phút, ràng buộc cùng request/body/actor. Đây là một lần cấp logic với retransmission có kiểm soát, không endpoint reveal lâu dài. Hết cửa sổ hoặc không xác minh lại được actor thì trả conflict yêu cầu owner rotate/re-enroll. Các response bình thường giữ TTL24 giờ. Không log encrypted-response plaintext khi decode để trả.
