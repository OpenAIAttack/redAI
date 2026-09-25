# Kiểm tra khả năng model (T08)

Trong Settings, lưu provider rồi chọn **Kiểm tra model**. Việc lưu không gọi model.
Hộp xác nhận thông báo tối đa 5 request synthetic, mỗi request tối đa 64 output
tokens, có thể phát sinh usage. Probe không đọc Project và không thực thi tool.
Text, tool arguments, SSE termination, JSON schema và hủy kết nối được kiểm tra
riêng. Hủy kết nối chỉ quan sát phía client; không chứng minh provider ngừng tính
phí hoặc xử lý. Thiếu usage được hiển thị chưa xác định, không quy về 0.

API: `POST /api/v1/providers/{provider_id}/probe`, owner session + Origin/CSRF,
UUID `Idempotency-Key`, body `{"confirmed":true,"expected_revision":1}`.
Kết quả lưu trong PostgreSQL, chỉ trả thành công sau commit. Cùng key/body trả lại
kết quả cũ; key/body khác trả 409. Request chưa rõ kết quả không tự replay sau
restart. Trong 2 phút, request mới cho cùng provider bị chặn nếu probe còn pending.
Sau đó một key mới với confirmation mới có thể chạy; key cũ vẫn không replay.
Attempt ID + config revision chặn kết quả cũ ghi đè evidence mới. Sửa config làm
mất hiệu lực evidence; credential/revision/enabled được kiểm tra trước từng request.

Apply migration `0003_provider_probe.sql` bằng migration runner trước khi chạy API
đã cập nhật. Không sửa migrations 0001/0002 của installation hiện hữu.

Provider config dùng `adapter_kind: chat_completions_compatible`, `base_url`,
`model_id`, `max_output_tokens`, `allowed_data_modes`. Config lưu từ UI cũ có thể
thiếu max_output_tokens hoặc dùng adapter_kind cũ; hãy tạo lại bằng form mới.
Owner-declared capability flags không phải bằng chứng đã probe.

Endpoint cloud dùng HTTPS và public IPv4. Transport kiểm tra mọi DNS IPv4 answer,
kết nối theo chính lookup đã kiểm tra, xác minh TLS hostname, không redirect/retry
hoặc dùng ambient proxy. IPv6-only và các dải IPv4 đặc biệt bị từ chối bảo thủ.
Endpoint local phải có URL chính xác trong biến môi trường do chủ installation
quản lý: `REDAI_LOCAL_MODEL_BASE_URLS` (danh sách URL phân cách bằng dấu phẩy).
Ví dụ cho lab: `http://127.0.0.1:8790/v1`. Không lấy allowlist từ chat/model.
Chưa có fallback cloud khi local bị từ chối. Firewall/worker egress vẫn là gate
riêng của deployment/security lab; probe không thay thế những kiểm tra đó.

Evidence không sử dụng model trả phí: `release-evidence/T08-probe/`.
