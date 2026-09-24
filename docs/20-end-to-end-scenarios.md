# 20 — Trace nghiệp vụ và các race condition

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

## 1. Từ Chat đến tool thành công

Owner POST Run với client_message_id/key A. API lock Chat, lưu message/run R/root session S/event E, commit, trả201 R. Runtime claim R fence7, checkpoint step1; reserve model cost; nhận tool proposal. Commit step1/call C/attempt T với fence1, event. Worker W session WS claim T, verify/signature, journal received/start_intent; tạo sandbox K label T; chạy pure fixture. Upload artifact F, API verify hash ready; W submit result digest D quiescent. API chấp nhận T fence1, call C succeeded, event. Runtime step2 đọc result F, finalize message/run/report refs. Owner mở lại browser và nhận E→final mà không tạo task mới.

Quan sát cần có: request_id→run_id→step→call→attempt→worker/container→artifact. Không có secret trong trace labels.

## 2. Double-click Run và request timeout

Hai POST cùng key/body đến hai API instances. Một transaction giữ key/chat lock. Request thứ hai nhận cùng result hoặc REQUEST_IN_PROGRESS. Nếu response đầu mất sau commit, retry trả R cũ. Nếu hai keys khác nhưng client_message_id giống, unique message ID và active run index bảo vệ. Nếu hai messages khác cùng Chat khi active, API trả ACTIVE_RUN_EXISTS; UI có thể append note qua endpoint đúng thay vì tạo Run cạnh tranh.

Không dùng frontend disable-button là cơ chế dedup duy nhất.

## 3. Model trả tool call rồi runtime crash

Crash trước boundary commit: không ToolCall authoritative, worker không thấy gì. Recovery có thể gọi model lại, usage cũ unknown/reserved. Crash sau commit: recovery nhìn thấy call C và không dispatch C2. Nếu provider trả duplicate tool IDs trong một response, server-generated IDs/index unique kiểm soát; parser reject mâu thuẫn trước dispatch.

## 4. Worker mất mạng sau external write

Lab endpoint tăng counter1. Worker chưa nhận hoặc chưa báo response thì control-plane partition. Local watchdog thu hồi egress/kill khi deadline. Server T lost/unknown, R needs_attention; W2 không được auto chạy lại cùng POST. Khi W1 quay lại, journal+proxy request evidence có thể chứng minh response; reconcile chấp nhận/quarantine theo fence. Nếu vẫn không biết, owner xác nhận theo target state hoặc kết thúc partial. Không model suy ra counter đã tăng từ câu văn “có lẽ request thành công”.

Test đạt khi counter không bị tăng lần hai bởi retry tự động và UI thể hiện uncertainty, không yêu cầu platform thần kỳ hoàn tác remote effect.

## 5. Cancel và final result tới cùng lúc

API cancel transaction trước: Run cancel_requested, stop new dispatch. Result succeeded của task đã thực sự hoàn thành trước cancel vẫn có thể lưu evidence; completion reason ghi completed_before_cancel_observed. Run chỉ terminal canceled sau reconciliation mọi task, không xóa evidence thành công. Result transaction trước: task succeeded nhưng Run finalizing chưa xong; cancel vẫn ngăn model/calls tiếp theo, finalize partial canceled đúng semantics.

Không để final message callback muộn ghi Run completed sau canceled bằng update không CAS. State transition validation server là nguồn thật.

## 6. Approval stale do revoke

Owner mở approval ở tab1. Tab2 revoke grant epoch5→6. Tab1 approve fingerprint epoch5: API reject GRANT_REVOKED/APPROVAL_STALE, không tạo task. Nếu task đã leased epoch5, renewal bị từ chối, proxy capability bị revoke, worker dừng theo deadline. UI không nói “approve thành công” chỉ vì click đã gửi.

## 7. Event commit-order race

Transaction A cập nhật Run và lock Workspace counter lấy100. A bị delay trước commit. B muốn event101 phải chờ cùng counter lock. A commit rồi B cấp101/commit, API có thể replay100→101 không skip. Test negative mô phỏng thiết kế `bigserial` naive để thấy tại sao không dùng: B có thể commit101 trước A100; client cursor101 bỏ100 vĩnh viễn. Spec yêu cầu thiết kế có counter lock hoặc cơ chế khác chứng minh không mất, không sequence thuần.

## 8. Scope matching trên CDN

Project grant exact `app.example.test`, port443. DNS trả IP cùng nơi host `other.example.test`. Adapter chỉ dial validated IP với Host/SNI của app. Browser request `other.example.test` hoặc Host mismatch bị proxy deny; không cho raw CONNECT tunnel đổi authority. Discovery lưu dependency, không tạo grant mới. Test lab mô phỏng hai vhost cùng loopback/private network được allow chỉ trong lab zone; không truy cập CDN thật.

## 9. Backup và restore

Owner request backup B. Maintenance ngừng writes, settle runs, chờ ready artifacts, capture event cursor. DB dump+file inventory+encrypted key recovery package được verify. Sau restore sạch: sessions/tokens/leases revoked, run active cũ needs_attention. Owner re-login/re-enroll, validate hash, xem report. Không worker cũ tự nối lại và chạy công việc từ thời điểm backup.
