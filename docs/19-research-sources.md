# 19 — Nguồn nghiên cứu và xuất xứ quyết định

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

## 1. Phương pháp và giới hạn

Phần tham khảo HackerAI dựa vào các file/tài liệu đã đọc ở commit `efb00b07b776737887c1856c1f11909c6d86fc7b`. Đây là khảo sát tĩnh theo vùng có liên quan, không full code audit, không chạy ứng dụng HackerAI, không có quyền truy cập metrics production. Không xác nhận mọi chức năng trong source đang bật trên website live. Các nguồn chính thức bên dưới được đối chiếu ngày24/09/2026.

Mọi cấu hình mặc định, invariant, schema, backlog và kiến trúc redAI trong gói là đề xuất thiết kế dành riêng cho personal v1, không sao chép nguyên văn source. Tài liệu không chứa source code, prompt hay asset của HackerAI. Việc đã đọc code tham khảo không tự tạo chứng nhận pháp lý “clean-room”; trước phát hành thương mại cần rà soát xuất xứ mã và giấy phép phù hợp.

## 2. HackerAI: điều học được

Repo tách web/HTTP, dữ liệu và durable Agent runtime; có Project/Chat, cloud/local execution, workflow approval và recovery. Tài liệu local identity chú ý stable installation ID, session mới, không fallback sang máy khác khi máy đã chọn offline. Tài liệu auto-review thừa nhận reviewer không thay network/scope enforcement. redAI dùng các bài học ở mức vấn đề sản phẩm, nhưng chọn stack và mô hình vận hành khác.

File LICENSE có điều kiện bổ sung hạn chế sử dụng thương mại nếu chưa có giấy phép riêng. Personal use ở bản đầu không phải lý do mặc định đủ quyền thương mại về sau. Chọn triển khai độc lập; không cần suy diễn tính pháp lý ngoài văn bản giấy phép [SRC01].

## 3. Nguồn chính thức

| ID | Nguồn/URL | Vai trò trong gói |
|---|---|---|
| SRC01 | `https://github.com/hackerai-tech/hackerai/blob/efb00b07b776737887c1856c1f11909c6d86fc7b/LICENSE` | Điều kiện giấy phép repo tham khảo |
| SRC02 | `https://github.com/hackerai-tech/hackerai/tree/efb00b07b776737887c1856c1f11909c6d86fc7b` | README.md, AGENTS.md, convex/schema.ts, lib/api/agent-stream-runner.ts, docs/local-environment-identity.md, docs/agent-auto-review.md, docs/agent-startup-compaction.md đã được đọc trong khảo sát |
| SRC03 | `https://www.postgresql.org/docs/current/sql-select.html` | SELECT/FOR UPDATE/SKIP LOCKED; nguồn tham khảo queue claim |
| SRC04 | `https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/` | Validation/serialization server; không compile schema tùy ý từ nguồn không tin cậy |
| SRC05 | `https://html.spec.whatwg.org/multipage/server-sent-events.html` | SSE, event ID và reconnect |
| SRC06 | `https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html` | Application + network checks, DNS/redirect validation |
| SRC07 | `https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html` | Untrusted content và nhiều lớp kiểm soát |
| SRC08 | `https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html` | Session cookie/token lifecycle |
| SRC09 | `https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html` | Password hashing guidance |
| SRC10 | `https://docs.docker.com/engine/security/` | Docker daemon/container trust và isolation considerations |
| SRC11 | `https://gvisor.dev/docs/user_guide/quick_start/docker/` | Docker/runsc integration; không bằng chứng tương thích mọi tool |
| SRC12 | `https://developers.openai.com/api/reference/resources/chat` | Chat/function tools reference cho compatible adapter; phải probe từng endpoint |
| SRC13 | `https://www.postgresql.org/docs/current/backup-dump.html` | DB dump/restore, không bao gồm external ObjectStore |
| SRC14 | `https://docs.temporal.io/workers` | Phương án orchestration đã xem xét, không dependency v1 |
| SRC15 | `https://www.rfc-editor.org/info/rfc8785/` | JCS canonicalization cho hash/signature consistency |
| SRC16 | `https://spec.openapis.org/oas/v3.1.0` | OpenAPI3.1 contract format |
| SRC17 | `https://json-schema.org/draft/2020-12` | JSON Schema dialect |

Các URL được giữ để coding agent tra đúng primary documentation. Với nguồn `current/latest`, agent phải pin version implementation và lưu ngày kiểm tra; không xem tên URL như immutable spec. Các dẫn chiếu `[SRCxx]` trong tài liệu trỏ bảng này.

## 4. Các điều chưa xác minh

Chưa kiểm tra nhãn hiệu/domain redAI; chưa benchmark phần cứng owner; chưa biết model/provider/key owner sẽ dùng; chưa đo precision/recall thực; chưa triển khai proxy/isolation; chưa apply DDL vào PostgreSQL thật trong bản tài liệu; chưa đánh giá toàn bộ package licenses của ứng dụng vì source chưa được viết. Những điểm này được đưa thành task/gate, không để coding agent giả vờ đã hoàn tất.
