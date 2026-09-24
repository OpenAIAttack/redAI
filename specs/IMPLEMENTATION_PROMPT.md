# Prompt khởi động coding agent

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

Dán nội dung khối dưới vào coding agent khi thư mục đặc tả đã nằm trong repository hoặc được gắn vào workspace:

```text
Bạn là coding agent triển khai redAI Personal v1. Đọc README.md, AGENTS.md,
SPEC_LOCK.json, docs/01-product-baseline.md và implementation/plan.md trước.
Đây là sản phẩm self-host cho một owner, không phải SaaS. Không thay đổi các
quyết định đã chốt và không yêu cầu tôi trả lời lại câu hỏi trong baseline.

Đọc và cập nhật implementation/STATUS.md hiện có (chỉ tạo nếu thiếu),
kiểm tra môi trường, rồi làm lần lượt các
task có dependency đã đạt trong implementation/tasks.json. Bắt đầu từ T00,
T01, T02, T03; phải làm luồng có DB và mock model kiểm thử trước khi kết nối model
trả phí hoặc mục tiêu ngoài lab. Không chạy lệnh kiểm thử trên domain thật.

Web Next.js, API Fastify, runtime TypeScript, worker Go. PostgreSQL là nguồn
trạng thái bền vững. File local qua ObjectStore adapter. Không thêm Temporal,
Redis, Kubernetes, billing hoặc dịch vụ cloud bắt buộc vào v1. Worker đồng
nhất; vai trò agent không được biến thành loại worker hard-code.

Hợp đồng ở contracts/, db/ và catalogs/ phải được dùng để sinh/kiểm tra type.
Tuân thủ lease/fencing/idempotency, session auth, scope, cancellation,
provenance và budget invariants. Không dùng một system prompt thay cho
execution policy. Không hạ mức cô lập hoặc mở mạng toàn phần để vượt test.

Mỗi phần phải có test, hướng dẫn chạy và trạng thái lỗi thực. Giao diện phải
chat-first và có hành vi đầy đủ, không chỉ mock đẹp. Sau mỗi milestone,
chạy acceptance gate, cập nhật STATUS.md và báo chính xác những kiểm tra đã
chạy/chưa chạy. Đừng tuyên bố production-ready trước khi G0–G7 đạt.

Nếu đặc tả mâu thuẫn, ghi quyết định kỹ thuật tối thiểu theo quy trình ADR,
cập nhật schema/tests liên quan; không tự suy ra quyền rộng hơn. Tiếp tục
những phần không bị chặn. Không tự commit, push hoặc deploy khi chưa được yêu cầu.
```

## Prompt tiếp tục sau khi hết context

```text
Tiếp tục redAI theo AGENTS.md và SPEC_LOCK.json. Đọc implementation/STATUS.md,
kiểm tra git diff và test failure gần nhất. Xác nhận các task DONE bằng code
và test, không chỉ dựa trên lời bàn giao. Hoàn tất task đang dở trước khi mở
phạm vi mới. Giữ nguyên hợp đồng công khai trừ khi có ADR và migration.
```

## Prompt review độc lập

```text
Review redAI Personal v1 như reviewer độc lập. Không sửa ngay. Đối chiếu
INV-* trong data/runtime/worker/scope với source và test. Ưu tiên duplicate
side effect, stale lease, cancel race, scope bypass, cross-project access,
secret leak, evidence giả và restore lỗi. Với mỗi issue ghi path:line,
kịch bản tái hiện, ảnh hưởng, test thiếu và đề xuất sửa nhỏ nhất. Phân biệt
issue đã chứng minh với nghi vấn. Không tính mock hoặc skipped test là bằng
chứng triển khai thật. Sau đó đối chiếu các G0–G7 release gate.
```
