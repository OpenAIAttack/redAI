# 21 — Quyết định còn lại và giới hạn chủ đích

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

## 1. Không còn câu hỏi sản phẩm bắt buộc trước khi viết code

Đã có owner-first, self-host, UI model, stack, persistence, worker protocol, approval modes, storage và release gates. Coding agent không cần hỏi có billing/team/cloud hay không. Không cần biết domain thật để build; dùng fixtures. Không cần API key thật để hoàn thành đa số integration/E2E; dùng mock provider. Khi live smoke cần provider/target, cấu hình do owner nhập, không hard-code vào source.

## 2. Các điều agent phải xác minh kỹ thuật trong task

T00 pin versions và license inventory. T21 thử browser/proxy/gVisor compatibility trên Linux. T30 đo tài nguyên/latency để điều chỉnh capacity. T31 restore drill và key recovery. T35 chạy opt-in model capability/quality eval khi owner cung cấp endpoint. Đây là công việc triển khai, không lý do để hỏi lại persona hoặc trì hoãn toàn bộ.

## 3. Giới hạn v1 và trigger mở rộng

| Giới hạn | Lý do | Chỉ mở rộng khi |
|---|---|---|
| Một owner/Workspace | Công cụ cá nhân trước | Có nhu cầu người dùng thứ hai thực tế và auth model mới |
| Linux worker | Cô lập và test matrix rõ | Linux flow ổn định rồi thêm desktop/client khác |
| PostgreSQL durable loop | Ít dịch vụ | Workflow đa dạng/scale tạo gánh vận hành rõ |
| Local ObjectStore | Đơn giản và chủ động dữ liệu | Cần backup remote/đa host lớn, thêm S3 adapter với test |
| HTTP/API tools; shell offline | Scope enforcement có thể kiểm thử | Raw network cần explicit IP rights, network policy spec riêng |
| TLS inspected browser | Enforce HTTP authority/path | Cần pinning/client-cert use case có thiết kế thay thế rõ |
| Không MCP tùy ý | Supply chain/authority boundary | Có registry, signing, approval và secret sandbox model |
| Không schedule tự chạy | Giảm tác vụ unattended trong bản đầu | Manual run ổn định và grant expiry/budget alert đầy đủ |
| Không PDF/DOCX report bắt buộc | Markdown/JSON/HTML đủ công việc lõi | Owner có yêu cầu format và renderer được sandbox/test |

## 4. Rủi ro lớn nhất cần theo dõi

Egress proxy triển khai sai, recovery dẫn tới duplicate external effect, LLM cost unknown không được giữ reservation, evidence bị gắn status vượt bằng chứng, và backup thiếu key/file. Vì vậy task security/durability không được dồn hết xuống “phase cuối sau khi ship”. Offline vertical slice phải chứng minh journal/lease trước scoped network.

## 5. Không thay đổi âm thầm

Không tự chuyển Project data policy, worker zone, model provider, live scope, budget ceiling hoặc image digest trong Run đang chạy. Không tự mở quyền khi phát hiện target mới. Không tự hạ runtime security khi môi trường thiếu dependency. Thay đổi cấu hình quan trọng có owner action/audit/version và run mới hoặc emergency narrowing đúng invariant.
