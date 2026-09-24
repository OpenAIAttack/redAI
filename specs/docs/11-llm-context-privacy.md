# 11 — Model gateway, ngữ cảnh, dữ liệu và ngân sách

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

## 1. Model không bị hard-code theo thương hiệu

Provider config gồm display_name, adapter_kind, base_url, model_id, credential_ref, context_window, max_output_tokens, supports_tools/structured_output/vision/streaming, pricing và allowed_data_modes. V1 có deterministic mock adapter cho test và Chat-Completions-compatible adapter cho endpoint owner cấu hình. Đây là khả năng tương thích cần probe, không bảo đảm mọi endpoint có chữ compatible đều hoạt động. Hợp đồng Chat/tool calling tham khảo API reference chính thức [SRC12].

Không nhúng danh sách giá/model marketing trong mã. Không dùng tài khoản ChatGPT web/session cookie làm backend. Model endpoint mới chỉ owner cấu hình; agent/target content không sửa base_url. Local endpoint có allowlist chính xác; không mở unrestricted SSRF cho URL người dùng nhập trong chat. Provider health dùng prompt synthetic không có Project data.

## 2. Capability probe

Khi lưu config, chạy optional probe với confirmation hiển thị có thể tiêu thụ usage nhỏ: text response, streaming termination, typed tool call giả, structured JSON, cancellation behavior, token usage metadata. Probe không thực thi tool thật. Kết quả timestamps và capability flags, lỗi parse rõ. Nếu Agent yêu cầu tools mà provider không đạt, UI disabled Agent config đó; không tự parse câu văn thành tool execution.

Các model configs có vai trò coordinator/reviewer/summarizer tùy chọn nhưng mặc định một config cho tất cả để đơn giản. Fallback explicit list với data mode tương thích. Refusal không phải trigger để tìm model “bỏ mọi bảo vệ”; owner chọn nhà cung cấp hợp lệ, hệ thống không tự bypass chính sách provider.

## 3. Data modes

| Mode | Dữ liệu gửi model | Ràng buộc |
|---|---|---|
| `local_only` | Chỉ endpoint local do owner approve | Không fallback cloud; DNS/egress allowlist provider riêng |
| `redacted_cloud` | Context chọn lọc + dữ liệu đã che | Mặc định sau setup cloud, có payload preview |
| `cloud_full` | Nội dung Project được chọn, trừ secrets/hard excluded | Owner explicit opt-in, cảnh báo dữ liệu rời installation |

Dù mode cloud_full, master key, API key, cookie session, worker credential, secret value và private key không vào prompt. “Full” ở đây không nghĩa mọi bytes tự động gửi. Owner chọn attachments/context và policy có deny types. Không tuyên bố encryption at rest che dữ liệu khỏi provider khi runtime đã decrypt để gửi.

## 4. Context construction

Layer 1 platform instructions cố định; layer2 Run goal từ owner; layer3 authority snapshot structured chỉ để model hiểu, enforcement bên ngoài; layer4 approved Project notes/files; layer5 recent conversation; layer6 tool/evidence excerpts gắn untrusted label. Mọi source có ID/version/hash/offset, original classification và redaction transform ID. System và owner-authored scope config không lấy từ webpage.

Context budget phân chia: reserved system/goal/policy; completed summary; recent complete message pairs; selected evidence excerpts. Large logs đưa artifact ref + bounded excerpt. File upload không đồng nghĩa đưa toàn bộ vào mọi request. Retrieval dùng full-text Project-bound v1; embeddings không tự bật hoặc gọi external vector API.

## 5. Redaction và secret references

Token hóa ổn định trong phạm vi Run: `[HOST_1]`, `[EMAIL_1]`, `[SECRET_REF_1]`; mapping nằm local và không log. Secret value không cần model biết để gọi adapter; model dùng credential_ref, trusted executor inject đúng allowed origin/header. Authorization/Cookie headers và password input loại bỏ trong previews/log. Query strings/bodies có thể chứa secret nên không chỉ che header.

Không khẳng định regex che hết dữ liệu nhạy cảm. Có explicit field allow/deny, recognizers, owner classification và payload preview. Khi rule không chắc với file nhạy cảm, block cloud route và yêu cầu owner đổi policy/nguồn, không im lặng gửi raw. Mapping pseudonym có thể làm giảm chất lượng model; giữ original domain chỉ trong execution target descriptor mà model tham chiếu ID.

Target có thể phản chiếu secret vào response; cần redact output trước model/logs. Secret canary tests phải kiểm tra nested JSON, base64-like echoes khi detector hỗ trợ, terminal stderr và HTML attribute. Không hứa chống mọi covert exfiltration; bảo vệ chính là không trao secret/egress không cần thiết.

## 6. Prompt injection

Web/file/tool output có thể chứa lời yêu cầu thay chỉ dẫn hoặc gửi dữ liệu. Không xem chúng là authority. Policy/worker enrollment/secret retrieval không nằm trong model tool set. Tool output phải bounded, tagged, không concatenate thành system instruction. Model content action vẫn qua schema/target checks. Review không dùng chính untrusted content làm bằng chứng owner đã cấp quyền. Thiết kế defense-in-depth này dựa trên nguyên tắc prompt-injection prevention của OWASP [SRC07].

Prompt templates riêng của redAI ở `prompts/`; không sao chép prompt HackerAI. Runtime lưu template version/hash cho repro. Không lưu hoặc hiển thị hidden chain-of-thought; UI chỉ công bố concise task status, kế hoạch, tool actions và evidence.

## 7. Chi phí và reservations

Model cost tính theo pricing config version có provenance (manual/official import). Unit `micro_usd_per_million_tokens`. Reservation trước request = conservative input upper bound × input rate + max_output_tokens × output rate + fixed fee nếu có. Làm tròn lên integer microUSD. Nếu không có tokenizer tương thích, reserve theo context cap đã cấu hình thay vì guess thấp. Local provider có thể khai model_api_cost=0 nhưng compute cost chưa đo, UI ghi rõ.

Transaction khóa run budget: `committed_observed + unresolved_reserved + new_reservation <= limit`. Child agents dùng cùng ledger. Response có usage/cost provider thì reconcile với reservation. Response thiếu usage hoặc timeout sau gửi request: reservation trạng thái unknown, vẫn giữ đến đối soát; không refund về0. Failed pre-send có bằng chứng chưa gửi có thể release.

Hạn mức chi phí không phải bảo đảm hóa đơn tuyệt đối khi provider đổi giá, billing metadata chậm hoặc tokenization khác. UI nói “ngân sách kiểm soát theo cấu hình”, ghi overrun nếu thực tế cao hơn reservation; dừng request mới, không giấu phần vượt. Token/output/time caps vẫn enforced độc lập. Không tự tăng run budget vì model muốn tiếp tục.

## 8. Credentials lưu trữ

Secrets mã hóa AEAD bằng key ngoài DB, key ID và nonce ngẫu nhiên mỗi ciphertext; AAD gồm Workspace/Project/secret ID/version. Dùng thư viện chuẩn AES-256-GCM, không tự crypto. Master key nằm secret file mode0600 ngoài git và không cùng plaintext backup. Rotate key bằng rewrap/re-encrypt có journal; không xóa key cũ trước xác minh toàn secret đã đổi.

Secret refs bind Project và allowed origin/use purpose. API không có read-secret-value chung cho Agent. UI cho replace/delete, reveal owner có re-auth và audit nếu thực sự cần; v1 có thể không có reveal để giảm bề mặt. Worker token khác model/target secret, không dùng chung.

## 9. Acceptance

Payload-capture mock endpoint chứng minh local_only không ra cloud, redacted_cloud không chứa canary, fallback không vượt data policy. Structured output thiếu required field không dispatch tool. Unknown usage không giảm reserved total. Provider config đổi trong Run không âm thầm đổi model snapshot; runtime vẫn kiểm tra emergency revoke config live. Template injection fixture không thể tạo policy mutation hoặc đọc secret.
