# 04 — Kiến trúc và bố trí repository

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

## 1. Hệ thống gồm những process nào?

`web`: Next.js render UI. `api`: Fastify quản lý owner API, worker endpoints, authorization, streaming events, upload/download. `runtime`: TypeScript tiến trình chạy durable Agent state machine và maintenance jobs. `worker`: Go daemon trên máy Linux, nhận task qua HTTPS outbound; chạy sandbox và trusted tool adapters. PostgreSQL lưu trạng thái bền vững. ObjectStore local lưu bytes, chia sẻ mount chỉ giữa API/runtime, không đưa host path sang sandbox.

Một reverse proxy đưa `/api/*` tới API và phần còn lại tới web, cùng origin. Worker dùng `/worker/v1/*` ở origin được owner cấu hình. Không cần NATS, Redis, Temporal, E2B, Convex, WorkOS hoặc S3 cloud để bản đầu hoạt động. Đây là lựa chọn riêng của redAI, không mô tả stack của HackerAI.

## 2. Data flow

Browser → API (session/CSRF) → domain transaction (message/run/events) → runtime claim → model adapter → schema/policy/budget → execution task → worker claim/lease → sandbox → evidence upload/finalize → task result → runtime → finding/report → SSE. Tool network traffic không đi từ API vào target; đi từ worker execution plane qua scoped proxy. API chỉ có network tới provider do owner cấu hình và các dịch vụ control-plane cần thiết.

Worker không truy cập PostgreSQL. Worker không đưa bearer token vào sandbox env. Model API key chỉ ở trusted runtime. ObjectStore và DB không lắng nghe trực tiếp trên network sandbox. Browser không gọi model provider trực tiếp.

## 3. Vì sao chưa dùng workflow engine riêng?

Personal v1 có một loại workflow chính, bounded Agent loop. Dùng bảng trạng thái, row lock/lease, checkpoint và event journal giảm dịch vụ phải vận hành. PostgreSQL mô tả `SKIP LOCKED` có thể phục vụ consumer của queue-like table; không dùng tính chất này như snapshot nhất quán cho báo cáo [SRC03]. Ta vẫn phải tự thiết kế retry/idempotency/cancellation; queue không giải quyết side effect bên ngoài.

Temporal là phương án nâng cấp, không một dependency bị quên. Chỉ mở ADR chuyển khi có nhiều loại workflow độc lập, orchestration nhiều ngày hoặc yêu cầu scale/operability khiến native loop khó duy trì. Không giữ hai hệ thống queue cùng làm chủ cùng task.

## 4. Module ownership

| Module | Làm gì | Không được làm |
|---|---|---|
| `domain` | Entity/invariant/state transition | HTTP, UI, Docker, provider SDK |
| `application` | Use cases, transaction orchestration | Render UI, tự chạy shell |
| `policy` | Scope/permission/effect decision thuần | Hỏi model để cấp quyền |
| `db` | Query/migration/repository | Tạo quyền ngầm bằng row có mặt |
| `contracts` | JSON Schema/types/OpenAPI | Business side effect |
| `llm` | Provider adapter, payload filter, usage | Gọi worker trực tiếp |
| `runtime` | Step loop/checkpoint/reconciliation | Bỏ qua policy do plan yêu cầu |
| `worker` | Lease, execution, journal, artifact stream | Lập scope hoặc gọi DB |
| `web` | View state và user intent | Quyết định final authorization |

## 5. Repository mục tiêu

```text
redai/
  AGENTS.md
  SPEC_LOCK.json
  contracts/              # Canonical JSON Schema/OpenAPI từ bộ đặc tả
  apps/
    web/                  # Next.js, components, routes, i18n
    api/                  # Fastify route adapters và SSE
    runtime/              # Agent scheduler, maintenance loops
  packages/
    contracts/            # Generated TS types, validator adapters; không copy schema
    domain/               # Pure domain logic, invariants
    application/          # Use cases và transaction services
    policy/               # Scope matching/effect decision
    db/                   # SQL migrations, typed queries
    llm/                  # mock + compatible provider adapters
    storage/              # Local ObjectStore, checksum
    observability/        # log redaction, trace/metrics
    ui/                   # Shared visual primitives nếu thực sự dùng chung
  worker/
    cmd/redai-worker/
    internal/{api,journal,lease,executor,sandbox,proxy,artifacts}/
    go.mod
  tools/                  # Reproducible toolbox image + adapters
  tests/{integration,e2e,chaos,fixtures,evals}/
  ops/{compose,systemd,scripts}/
  docs/
  implementation/
```

TypeScript dùng pnpm workspace. Go module độc lập, `go.sum` được commit. Chọn SQL migration rõ ràng và typed query builder nhẹ; không để ORM schema tự đồng bộ production. Dùng JSON Schema 2020-12 làm hợp đồng; build chuyển sang validator-compatible representation nếu Fastify/Ajv config cần, kèm contract test không mất semantics [SRC04]. Không nhận schema tùy ý từ user rồi compile bằng validator trên server.

## 6. Runtime scheduler và durable events

Runtime claim một run bằng compare-and-set lease; không giữ transaction trong khi gọi model. Sau mỗi boundary lưu checkpoint đủ khôi phục. Tool task lưu trước dispatch. Tất cả mutation nghiệp vụ tạo event trong cùng transaction. `events` là durable journal kiêm outbox đọc bởi API; `NOTIFY` chỉ là tín hiệu đánh thức, mất notify không mất event.

SSE cursor **theo Workspace** và thứ tự commit được bảo vệ bằng row counter lock, không dùng một global `bigserial` mà tưởng thứ tự cấp sequence bằng thứ tự commit. Chi tiết ở tài liệu 06. Scheduler query và dashboard query khác nhau; job claim có thể bỏ qua locked rows, còn dashboard cần snapshot đúng.

## 7. Topology cá nhân

Máy control-plane chạy proxy/web/api/runtime/PostgreSQL/ObjectStore. Worker có thể cùng máy cho offline development; dùng VM Linux riêng là topology nghiệm thu khuyến nghị cho thực thi nội dung không tin cậy. Máy ảo không chứa khóa DB/model. Một worker thứ hai cùng binary dùng network zone khác nhưng chỉ được chọn khi Project binding cho phép. Không cần Kubernetes.

Không hứa cấu hình RAM tối thiểu tuyệt đối trước benchmark. Lab tham chiếu: control-plane 4 vCPU/8 GiB RAM; worker 4 vCPU/8 GiB RAM, 2 task slots. Đây là cấu hình thử nghiệm để đo, không phải đảm bảo mọi trình duyệt/tool chạy được với mức này.

## 8. Dependency/version discipline

T00 đọc docs hiện hành của Next.js/Fastify/Go/PostgreSQL và ghi `docs/dependency-baseline.md`: version cụ thể, lifecycle, license, platform support. Chọn bản stable đang được hỗ trợ; pin package lock, OCI image digest và tool version. PostgreSQL schema nhắm major 18; test thực tế ở version được pin. Không sao chép version từ repo tham khảo hoặc máy của người viết tài liệu rồi coi là tương thích.

## 9. Ranh giới testability

Clock, random ID, provider, worker transport, storage và policy được inject bằng interface nhỏ. Mock clock cho TTL; mock provider cho tool-call sequence; lab worker cho crash tests. Không tạo abstract factory đa provider khi mới có một triển khai; interface tập trung vào contract có hành vi thay đổi thật. Thiết kế monolith theo module trước; tách process vì vòng đời, không chia service để trang trí sơ đồ.

## 10. Đặt bộ đặc tả vào repository mà không tạo hai nguồn hợp đồng

Giải nén nội dung thư mục gói vào root repository `redai/`, giữ `docs/`, `contracts/`, `implementation/` và `AGENTS.md`. `contracts/` tại root là nguồn JSON Schema/OpenAPI chính. `packages/contracts/` là package code được sinh/adapter và đọc nguồn đó; không duy trì bản schema thứ hai bằng tay. `db/001_reference_schema.sql` là DDL tham chiếu; T02 đưa migration đã kiểm tra vào `packages/db/` và ghi mapping phiên bản. Khi sửa thiết kế DB, cập nhật reference và migration tương ứng, không để ORM tự sửa schema live. README ứng dụng sau này có thể thay trang bìa, nhưng giữ liên kết đến đặc tả và không xóa baseline/ADR.
