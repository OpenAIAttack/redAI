# redAI Personal v1 — Bộ đặc tả triển khai

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

## Mục tiêu của gói tài liệu

Xây một công cụ làm việc bảo mật cho **một chủ sở hữu**, self-host, có trải nghiệm **Project → Chat → Agent** gần cách sử dụng HackerAI; worker phân tán, đồng nhất; quản lý công việc và bằng chứng lâu dài. Đây là đặc tả để coding agent triển khai, **không phải mã nguồn ứng dụng đã hoàn thành**, không phải kết quả pentest hay chứng nhận an toàn.

Quyết định người dùng đã chốt: phục vụ bản thân trước; giữ Chat, Agent, Project; worker đồng nhất; cấu hình quyền tại Project; các mode Automatic, Always ask, Ask for high-risk commands, Reject. Tài liệu này chốt thêm các lựa chọn kỹ thuật để không để coding agent phải tự đoán: Next.js web, Fastify API, TypeScript runtime, Go worker, PostgreSQL, lưu file local qua ObjectStore interface, HTTPS worker protocol và SSE giao diện. Mọi lựa chọn bổ sung được ghi tại [baseline](docs/01-product-baseline.md) và [ADR](adr/README.md).

**Automatic là mặc định bên trong phạm vi đã được ủy quyền.** Xác thực DNS được lưu một lần ở Project; không hỏi lại cho mỗi Chat/lệnh. Phát hiện dependency không cấp quyền kiểm thử hạ tầng của bên thứ ba. Kiểm soát thực thi là một phần của nền tảng, không dựa duy nhất vào prompt.

## Đọc và triển khai theo thứ tự

1. Đọc [AGENTS.md](AGENTS.md), [baseline](docs/01-product-baseline.md), [PRD](docs/02-prd-use-cases.md), [quyết định kiến trúc](adr/README.md).
2. Đọc [kiến trúc/repository](docs/04-architecture-repository.md), [data model](docs/05-data-model.md), [API](docs/06-api-realtime.md), [agent](docs/07-agent-runtime.md), [worker](docs/08-worker-protocol.md).
3. Dùng `contracts/`, `db/`, `catalogs/`, `prompts/` làm hợp đồng đầu vào; dùng [kế hoạch](implementation/plan.md) và `implementation/tasks.json` để chọn task có dependency đã hoàn tất.
4. Chỉ kết thúc milestone sau khi vượt qua [bộ kiểm thử](docs/15-testing-evaluation.md) và [release gates](docs/18-release-acceptance.md). Có sẵn [prompt giao việc](IMPLEMENTATION_PROMPT.md).

## Mục lục theo trách nhiệm

| Tài liệu | Câu hỏi được giải quyết |
|---|---|
| [01 — Baseline](docs/01-product-baseline.md) | Đã chốt gì; v1 làm gì và không làm gì? |
| [02 — PRD/use cases](docs/02-prd-use-cases.md) | Ai làm việc gì; kết quả nào được chấp nhận? |
| [03 — UX/UI](docs/03-ux-ui-spec.md) | Các màn hình, hành vi, trạng thái lỗi và thao tác bàn phím |
| [04 — Architecture/repository](docs/04-architecture-repository.md) | Process, module, ranh giới và bố trí source |
| [05 — Data model](docs/05-data-model.md) | Entity, invariant, transaction, migration, xóa dữ liệu |
| [06 — API/realtime](docs/06-api-realtime.md) | REST, SSE, lỗi, phân trang, idempotency, concurrency |
| [07 — Agent runtime](docs/07-agent-runtime.md) | Lập kế hoạch, checkpoint, budget, retry, pause/cancel |
| [08 — Worker protocol](docs/08-worker-protocol.md) | Enrollment, lease, fencing, journal và phục hồi |
| [09 — Sandbox/tools](docs/09-sandbox-tool-execution.md) | Cách công cụ thực thi, mạng, filesystem và cô lập |
| [10 — Authorization/scope](docs/10-authorization-scope.md) | DNS, phạm vi, approval modes, thu hồi quyền |
| [11 — LLM/privacy](docs/11-llm-context-privacy.md) | Provider, context, secret, redaction, chi phí |
| [12 — Findings/evidence/reports](docs/12-findings-evidence-reports.md) | Kết luận, nguồn bằng chứng, report, retest |
| [13 — Identity/settings](docs/13-identity-settings.md) | Một owner nhưng vẫn có xác thực và bảo vệ dữ liệu |
| [14 — Deployment/operations](docs/14-deployment-operations.md) | Cài đặt, nâng cấp, backup, restore, disaster recovery |
| [15 — Testing/evaluation](docs/15-testing-evaluation.md) | Unit, integration, chaos, E2E, đánh giá chất lượng |
| [16 — Threat model](docs/16-threat-model.md) | Tài sản cần bảo vệ, tác nhân và cách xử lý |
| [17 — Observability/errors](docs/17-observability-errors.md) | Trace, log, metric, mã lỗi và thông báo |
| [18 — Release acceptance](docs/18-release-acceptance.md) | Thế nào là bản dùng thật thay vì demo? |
| [19 — Research/sources](docs/19-research-sources.md) | Nguồn tham khảo, giấy phép, giới hạn khảo sát |
| [20 — E2E scenarios](docs/20-end-to-end-scenarios.md) | Trace mẫu từ đầu đến cuối và các race condition |
| [21 — Decisions/limits](docs/21-decisions-limitations.md) | Các giới hạn chủ đích và trigger mở rộng |

## Bản đọc liên tục

[HANDBOOK.md](HANDBOOK.md) tập hợp tài liệu thiết kế, ADR và task cards trong một file để chủ sở hữu đọc. Coding agent nên đọc tài liệu theo task, không nạp toàn bộ handbook vào mỗi lượt. Các file gốc theo module và hợp đồng máy đọc được vẫn là nguồn triển khai.

## Hợp đồng máy đọc được

- `contracts/public.openapi.yaml`: các API owner; `contracts/worker.openapi.yaml`: API worker.
- `contracts/schemas/`: schema JSON dùng cho API, Agent, worker và event.
- `db/001_reference_schema.sql`: DDL PostgreSQL nền tảng; phải kiểm tra trên DB thật trước migration production.
- `catalogs/tools.json`: danh mục tool ban đầu, effect class, hạn mức và schema liên quan.
- `contracts/examples/`, `tests/`: fixtures có đầu ra dự kiến; chỉ dùng domain/IP tài liệu hoặc mạng test.
- `SPEC_LOCK.json`: các quyết định và hằng số liên module. Không được để schema, tài liệu và mã sinh ra khác nhau.
- `scripts/validate_spec.py`: kiểm tra cấu trúc gói; không thay thế các test ứng dụng.

## Phạm vi nguồn và giấy phép

Tham khảo HackerAI ở commit `efb00b07b776737887c1856c1f11909c6d86fc7b`, không tuyên bố đã audit toàn bộ hoặc chạy production của họ. Repo có điều kiện bổ sung về sử dụng thương mại; gói này yêu cầu triển khai độc lập, không chứa source, logo hoặc prompt của HackerAI. Tên `redAI` là tên làm việc do người dùng chọn; chưa kiểm tra nhãn hiệu hoặc tên miền. Nguồn chính thức và ngày kiểm tra nằm ở tài liệu 19.

## Trạng thái kiểm tra gói

Xem `VALIDATION_REPORT.md` để biết chính xác những kiểm tra đã thực hiện trên **tài liệu/hợp đồng**. Không diễn giải kết quả đó thành việc ứng dụng, cô lập mạng hay cơ chế backup đã được kiểm chứng.
