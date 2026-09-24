# redAI Personal v1 — Sổ tay thiết kế và triển khai


**Bản đọc liên tục · 24/09/2026 · 1.0.0-draft.1**


Công cụ self-host cho một owner. Đây là tài liệu thiết kế, không phải ứng dụng đã triển khai. Schema, OpenAPI, SQL, fixtures và validator nằm riêng trong ZIP; đọc file gốc theo module khi triển khai.


## Mục lục


- [Chỉ dẫn bắt buộc cho coding agent](#file-agents-md)

- [Prompt khởi động coding agent](#file-implementation-prompt-md)

- [01 — Baseline và giới hạn bản đầu](#file-docs-01-product-baseline-md)

- [02 — PRD, user stories và phạm vi chức năng](#file-docs-02-prd-use-cases-md)

- [03 — Đặc tả UX/UI chat-first](#file-docs-03-ux-ui-spec-md)

- [04 — Kiến trúc và bố trí repository](#file-docs-04-architecture-repository-md)

- [05 — Domain model, persistence và invariants](#file-docs-05-data-model-md)

- [06 — REST API, SSE và hợp đồng lỗi](#file-docs-06-api-realtime-md)

- [07 — Durable Agent runtime và vòng lặp điều phối](#file-docs-07-agent-runtime-md)

- [08 — Worker đồng nhất, lease, fencing và phục hồi](#file-docs-08-worker-protocol-md)

- [09 — Sandbox, tool adapters và giới hạn mạng](#file-docs-09-sandbox-tool-execution-md)

- [10 — Phạm vi ủy quyền và bốn chế độ phê duyệt](#file-docs-10-authorization-scope-md)

- [11 — Model gateway, ngữ cảnh, dữ liệu và ngân sách](#file-docs-11-llm-context-privacy-md)

- [12 — Finding, bằng chứng, báo cáo và retest](#file-docs-12-findings-evidence-reports-md)

- [13 — Owner identity, cấu hình và bảo vệ tài khoản](#file-docs-13-identity-settings-md)

- [14 — Triển khai, nâng cấp và khôi phục](#file-docs-14-deployment-operations-md)

- [15 — Chiến lược kiểm thử và đánh giá Agent](#file-docs-15-testing-evaluation-md)

- [16 — Threat model và giới hạn bảo đảm](#file-docs-16-threat-model-md)

- [17 — Quan sát hệ thống, mã lỗi và chẩn đoán](#file-docs-17-observability-errors-md)

- [18 — Release gates và định nghĩa hoàn tất](#file-docs-18-release-acceptance-md)

- [19 — Nguồn nghiên cứu và xuất xứ quyết định](#file-docs-19-research-sources-md)

- [20 — Trace nghiệp vụ và các race condition](#file-docs-20-end-to-end-scenarios-md)

- [21 — Quyết định còn lại và giới hạn chủ đích](#file-docs-21-decisions-limitations-md)

- [ADR-001 — Personal-first và triển khai độc lập](#file-adr-001-personal-first-independent-md)

- [ADR-002 — Durable loop bằng PostgreSQL](#file-adr-002-postgres-durable-runtime-md)

- [ADR-003 — Go worker đồng nhất](#file-adr-003-homogeneous-go-workers-md)

- [ADR-004 — Local ObjectStore và hợp đồng typed](#file-adr-004-local-storage-and-contracts-md)

- [ADR-005 — Automatic không tự mở scope](#file-adr-005-scope-and-network-md)

- [ADR-006 — Model route và data policy riêng](#file-adr-006-model-and-data-policy-md)

- [ADR-007 — Chat-first, evidence-first, release theo gate](#file-adr-007-interface-and-release-md)

- [Kế hoạch triển khai redAI Personal v1](#file-implementation-plan-md)

- [Task cards — redAI Personal v1](#file-implementation-task-cards-md)

- [Traceability yêu cầu → triển khai → nghiệm thu](#file-implementation-traceability-md)


---


<a id="file-agents-md"></a>


*Nguồn: `AGENTS.md`*


## Chỉ dẫn bắt buộc cho coding agent

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

### Nhiệm vụ

Triển khai redAI Personal v1 từ đặc tả này. Xây luồng thật, có persistence và test; không chỉ dựng giao diện giả. Chủ sở hữu là người dùng duy nhất. Không thêm billing, organization onboarding, đăng ký công khai, marketplace, plugin chạy tùy ý hoặc cloud execution bắt buộc.

### Thứ tự ưu tiên khi có mâu thuẫn

1. Ranh giới quyền/thực thi và invariant được đánh số `INV-*`.
2. `SPEC_LOCK.json` và các ADR đã chấp nhận.
3. JSON Schema/OpenAPI/SQL sau khi đã đối chiếu với invariant.
4. Tài liệu domain và tiêu chí nghiệm thu.
5. Mockup chữ, ví dụ và ghi chú.

Mâu thuẫn là bug của spec: ghi issue vào `docs/implementation-decisions.md`, đề xuất sửa nhỏ nhất, thêm test, cập nhật hợp đồng liên quan trước khi code. Không chọn diễn giải nới rộng quyền hoặc bỏ kiểm tra để chạy được demo. Không tự coi API sketch là triển khai bảo mật hoàn chỉnh.

### Quy trình mỗi task

Đọc task tương ứng trong `implementation/tasks.json`, xác nhận dependency, ghi kế hoạch ngắn vào nhật ký triển khai. Chỉ sửa các module liên quan. Viết test cho hành vi lỗi/race quan trọng rồi triển khai. Chạy checks nhỏ trước, sau đó suite liên quan. Báo cáo file thay đổi, test đã chạy, kết quả và việc chưa hoàn tất. Không ghi “passed” cho lệnh chưa chạy, bị skip hoặc thiếu hạ tầng.

Không hỏi lại các lựa chọn đã chốt trong baseline. Version patch, tên thư mục phụ và thư viện hỗ trợ có thể quyết định theo docs chính thức hiện hành; pin version và ghi lý do. Không cài `latest` trong manifest production. Không tự commit/push/deploy lên hệ thống bên ngoài hoặc chạy với mục tiêu thật nếu chủ sở hữu chưa yêu cầu.

### Quy tắc kiến trúc

Web không truy cập DB trực tiếp. Core API và runtime dùng domain service chung. Worker không giữ khóa LLM hoặc credentials DB. Model không tự gọi Docker, không cấp quyền, không tự đăng ký worker, không sửa policy. Worker chỉ nhận task có lease hợp lệ; effect được phân loại từ registry/server, không tin giá trị do model khai.

Một tool call có `tool_call_id` ổn định; mỗi lần cấp thực thi có `attempt_id` và `fencing_token`. Không dùng retry của thư viện HTTP để chạy lại hiệu ứng không rõ kết quả. Đầu ra từ target, file upload và model là dữ liệu không tin cậy. Không thực thi text tool result như chỉ dẫn hệ thống.

Không mount Docker socket vào sandbox. Không chạy lệnh Agent trên host. Không tự downgrade runtime cô lập khi gVisor không sẵn sàng. Không mở network toàn phần chỉ vì proxy lỗi. Không tắt TLS verification. Không đưa secret vào log, URL, browser localStorage hoặc prompt.

### Quy tắc sản phẩm

Giữ trải nghiệm chat-first: Project, Chat, Ask/Agent, panel Workbench. Dùng thương hiệu redAI, không sao chép asset/wording HackerAI. Mọi nút quan trọng phải có trạng thái loading/error/success và hành vi thật. Không có toast “thành công” khi backend chưa commit. Mock provider chỉ xuất hiện trong profile test/development, hiển thị nhãn rõ; release không được âm thầm fallback về mock.

Pause chỉ dừng ở ranh giới hành động, không hứa đóng băng tùy ý một tiến trình hoặc LLM request. Cancel là yêu cầu dừng có theo dõi xác nhận. Phân biệt task failed, run incomplete, canceled và kết luận kiểm thử an toàn. Tuyệt đối không biến tool failure thành “không phát hiện lỗ hổng”.

### Kiểm tra tối thiểu trước PR/milestone

Contract lint, typecheck, format, unit/integration test; với Go có `go test -race ./...`. Thay đổi state machine phải có transition/duplicate/reordering test. Thay đổi API phải có auth, schema, idempotency và concurrent request test. Thay đổi UI phải có E2E và kiểm tra responsive. Thay đổi sandbox/policy phải có kiểm thử fail-closed và egress thực tế trong lab.

Một task chỉ DONE khi test và tiêu chí nghiệm thu đã đạt. Để TODO, giả lập response hoặc tài liệu thay cho hành vi không được tính là DONE. Test không thực hiện được phải được báo là BLOCKED, kèm lệnh và điều kiện cần. Không xóa test khó để làm xanh CI.

### Giao tiếp và bàn giao

Ghi tiến độ vào `implementation/STATUS.md` với task ID, commit, checks, blockers. Không dựa vào ký ức chat cho quyết định kiến trúc. Khi context gần đầy, cập nhật handoff gồm trạng thái repo, task đang làm, lỗi tái hiện, lệnh test, bước tiếp theo. Không lưu secret trong handoff.


---


<a id="file-implementation-prompt-md"></a>


*Nguồn: `IMPLEMENTATION_PROMPT.md`*


## Prompt khởi động coding agent

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

### Prompt tiếp tục sau khi hết context

```text
Tiếp tục redAI theo AGENTS.md và SPEC_LOCK.json. Đọc implementation/STATUS.md,
kiểm tra git diff và test failure gần nhất. Xác nhận các task DONE bằng code
và test, không chỉ dựa trên lời bàn giao. Hoàn tất task đang dở trước khi mở
phạm vi mới. Giữ nguyên hợp đồng công khai trừ khi có ADR và migration.
```

### Prompt review độc lập

```text
Review redAI Personal v1 như reviewer độc lập. Không sửa ngay. Đối chiếu
INV-* trong data/runtime/worker/scope với source và test. Ưu tiên duplicate
side effect, stale lease, cancel race, scope bypass, cross-project access,
secret leak, evidence giả và restore lỗi. Với mỗi issue ghi path:line,
kịch bản tái hiện, ảnh hưởng, test thiếu và đề xuất sửa nhỏ nhất. Phân biệt
issue đã chứng minh với nghi vấn. Không tính mock hoặc skipped test là bằng
chứng triển khai thật. Sau đó đối chiếu các G0–G7 release gate.
```


---


<a id="file-docs-01-product-baseline-md"></a>


*Nguồn: `docs/01-product-baseline.md`*


## 01 — Baseline và giới hạn bản đầu

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

### 1. Tuyên bố sản phẩm

redAI là bàn làm việc kiểm thử bảo mật cá nhân, hỗ trợ trao đổi, lập kế hoạch, thực thi công cụ trong sandbox, giữ bằng chứng và kiểm tra lại bản sửa. Công cụ phục vụ công việc được chủ sở hữu ủy quyền; không phải dịch vụ tự kiểm thử toàn Internet. “Chính thức” ở v1 nghĩa là có thể dùng ổn định cho công việc cá nhân và khôi phục dữ liệu, không phải có đủ mọi tính năng enterprise.

### 2. Phân biệt yêu cầu đã xác nhận và quyết định thiết kế

| ID | Quyết định | Nguồn quyết định |
|---|---|---|
| B01 | Một owner sử dụng trước; không SaaS onboarding | Người dùng xác nhận 24/09/2026 |
| B02 | Trải nghiệm Chat–Project–Agent gần HackerAI | Yêu cầu người dùng trước đó |
| B03 | Nhiều worker cùng phần mềm/toolbox; không hard-code chuyên môn | Yêu cầu người dùng trước đó |
| B04 | Automatic, Always ask, Ask for high-risk commands, Reject | Yêu cầu người dùng trước đó |
| B05 | Xác thực Project một lần; không hỏi lại từng Chat/lệnh trong grant còn hiệu lực | Yêu cầu người dùng trước đó |
| B06 | Triển khai độc lập, không copy code/asset/prompt HackerAI | Quyết định thiết kế để chủ động sản phẩm |
| B07 | Next.js UI; Fastify API; TypeScript runtime; Go worker | Baseline kỹ thuật của gói đặc tả |
| B08 | PostgreSQL queue + checkpoint; chưa dùng Temporal/Redis | Giảm thành phần vận hành ở personal v1; ADR-002 |
| B09 | Local ObjectStore bắt buộc; S3 adapter sau v1 | Giảm dịch vụ bắt buộc; API storage vẫn tách biệt |
| B10 | Linux worker; desktop native/Windows native không thuộc v1 | Giảm ma trận kiểm thử; có thể dùng Linux VM trên máy cá nhân |
| B11 | Web/API và phân tích file là phạm vi công cụ v1 | Phân kỳ triển khai; raw TCP/network tools thuộc mở rộng |
| B12 | Hạn chế mạng tại execution boundary, không tự kế thừa quyền bên thứ ba | Invariant của thiết kế |

Các B06–B12 là quyết định baseline, không diễn đạt rằng người dùng đã duyệt từng thư viện. Coding agent triển khai theo chúng để có đường đi rõ ràng; thay đổi bằng ADR, không im lặng thay stack.

### 3. Phần có trong v1

Một owner, một Workspace tự tạo, nhiều Project. Project có file, ghi chú, scope, credential references, worker bindings, Chat, Run, Finding, Evidence và Report. Ask phân tích ngữ cảnh; Agent dùng tools theo policy. Chủ sở hữu chọn model endpoint/key của mình, chọn worker và theo dõi chi phí. Phiên tồn tại khi đóng trình duyệt. Có pause ở ranh giới, cancel, tiếp tục khi có lỗi phục hồi được, export/import Project và backup/restore toàn hệ thống.

V1 có một coordinator và tối đa hai subagent logic song song, depth tối đa một. Tất cả dùng cùng worker pool đã được binding. Có thể tắt delegation và chạy tuần tự mà không đổi data model. Không cần model riêng để huấn luyện; model adapter được kiểm thử bằng capability probe.

### 4. Phần cố ý chưa làm

Không public signup, subscription, billing, team invitation, SSO, enterprise RBAC, marketplace, arbitrary remote MCP, Telegram, auto scheduling, native desktop, agent chạy trực tiếp host, Kali GUI stream, chứng nhận tuân thủ, huấn luyện model, graph database hoặc vector database riêng. Không tự tải và thực thi plugin do model tìm trên web. Không tự cài package từ Internet lúc một task chạy.

Chưa hỗ trợ raw packet/SYN scan, mạng nội bộ toàn dải, shell truy cập Internet tự do, tự sửa hệ thống đích, khai thác phá hoại hoặc thu thập dữ liệu ngoài nhu cầu xác minh. Mở rộng TCP/IP tools cần ADR riêng, explicit target grants và bộ test mạng; không mô phỏng hỗ trợ bằng cách mở firewall toàn bộ.

### 5. Cấu hình mặc định có chủ đích

| Thiết lập | Mặc định v1 | Ghi chú |
|---|---|---|
| Ngôn ngữ UI | Tiếng Việt; khóa i18n chuẩn bị English | Không đổi identifier/schema sang tiếng Việt |
| Theme | Dark mặc định, light có sẵn | Accent đỏ; không bắt chước logo HackerAI |
| Approval | `automatic` | Chỉ sau khi có scope grant phù hợp |
| Project data policy | `redacted_cloud` khi owner đã cấu hình cloud provider | Setup phải thông báo dữ liệu ra ngoài; chưa cấu hình thì Ask/Agent blocked |
| Max active runs | 2/Workspace, 1/Chat | Giảm cạnh tranh context |
| Max child agents | 2, depth 1 | Chung run budget, không tự nhân budget |
| Worker capacity | 2 tasks/worker | Có thể giảm theo tài nguyên |
| Agent steps | 40 | Mỗi model turn sau tools là một step |
| Run active wall time | 30 phút | Wait approval/pause không tính; absolute expiry 24 giờ |
| Tool timeout | 120 giây | Trần owner cấu hình 600 giây |
| Per-run model budget | 2,000,000 micro-USD | Đây là hạn mức cấu hình 2 USD, không phải dự báo chi phí thực |
| File upload | 25 MiB/file; 200 MiB/batch | Workspace storage quota cấu hình riêng |
| Report | Markdown + JSON + HTML độc lập | PDF/DOCX không bắt buộc bản đầu |
| Search | PostgreSQL full-text + lọc metadata | Không embeddings tự động |

`SPEC_LOCK.json` là nguồn hằng số. Các ngưỡng là mục tiêu thiết kế chưa benchmark; owner có thể đổi các giá trị cho phép qua Settings, không đổi invariant.

### 6. Tiêu chí thành công cá nhân

Owner tạo Project và đưa vào luồng Ask được mà không phải tạo tài khoản dịch vụ phụ ngoài model đã chọn. Một worker mới đăng ký từ Linux khác chạy được task lab và vẫn giữ danh tính sau restart. Một công việc web/API có ngữ cảnh, evidence và report hoàn thành end-to-end. Restore sang máy sạch có thể đọc lại Project, đối chiếu hash file và chạy task mới; worker token cũ không tự được tái kích hoạt.

Không đo thành công bằng số agent/tool call. Báo cáo rõ tỉ lệ công việc hoàn tất, finding có đủ chứng cứ, false positive trên lab, chi phí quan sát được và lỗi chưa phục hồi. Không tuyên bố benchmark thương mại dựa trên fixture nhỏ.


---


<a id="file-docs-02-prd-use-cases-md"></a>


*Nguồn: `docs/02-prd-use-cases.md`*


## 02 — PRD, user stories và phạm vi chức năng

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

### 1. Người dùng và công việc

Persona duy nhất là owner có kỹ năng lập trình/bảo mật, muốn trợ lý làm việc trên dự án của mình và môi trường được phép. Owner không muốn lặp lại kiến trúc, tài khoản thử nghiệm, ghi chú và kết quả mỗi phiên; cần quyền kiểm soát model, worker, ngân sách và dữ liệu. Không thiết kế thêm vai trò admin/buyer/operator trong v1. Quyền app vẫn bắt buộc để website đích hoặc người khác trên LAN không điều khiển hộ owner.

### 2. Mô hình sử dụng

#### UC-01 — Khởi tạo hệ thống

Owner chạy bootstrap CLI tại host, đặt mật khẩu qua stdin và tạo recovery code. Trình duyệt đăng nhập qua HTTPS, thấy setup cho model endpoint, policy dữ liệu, storage health và worker. Không có public `/register`. Cấu hình có lỗi không được đánh dấu Ready. Setup có thể lưu từng bước; lần đăng nhập sau tiếp tục đúng trạng thái.

**Nghiệm thu:** hai request bootstrap cạnh tranh chỉ tạo một owner; setup không log mật khẩu/key; thiếu model chỉ chặn phần AI, vẫn cho quản lý Project; không tự gửi nội dung Project trong provider health check.

#### UC-02 — Project và phạm vi

Owner tạo Project, mô tả mục tiêu, chọn mode Automatic, khai báo root domain hoặc lab origin. Domain proof dùng challenge DNS có token ngẫu nhiên gắn installation/Project/root; sau verify lưu proof. Owner lưu grant về mục tiêu, loại hành động, exclusions và validity. Nội dung grant không được suy từ kết quả crawl. Thay đổi quyền phải tạo version mới, không sửa lịch sử của run đã chạy.

**Nghiệm thu:** tạo Chat thứ hai không đòi verify lại; dependency khác domain chỉ thành discovered asset; revoke chặn dispatch mới và hủy grant đang dùng; wildcard có semantics cụ thể, không match chuỗi suffix tùy ý.

#### UC-03 — Ask với file

Owner upload tài liệu text/Markdown/OpenAPI/JSON/CSV và ảnh PNG/JPEG. File được kiểm tra kích thước, type, hash, lưu và lập chỉ mục text. Không chạy macro, không mở URL nhúng trong file để tải thêm dữ liệu. Ask trả lời dựa trên attachment và ghi chú được chọn; các đoạn trích có source ID. Trong Ask không có execution tools. File không đọc được hiển thị lỗi cụ thể, vẫn giữ khả năng tải bản gốc nếu owner chọn giữ.

**Nghiệm thu:** Ask không khởi tạo sandbox; HTML trong attachment không chạy script ở UI; server chỉ gửi các nguồn được chọn tới model; câu trả lời thiếu căn cứ nêu chưa có dữ liệu.

#### UC-04 — Agent có thực thi

Owner nêu mục tiêu, chọn worker/worker pool đã binding và bấm Run. Server snapshot scope/model/policy/budget/attachment. Agent tạo kế hoạch có step; tool calls được schema validation, policy và budget kiểm tra trước khi tạo job. Owner xem progress, stdout có giới hạn, artifacts, request approval khi cần. Kết thúc lưu summary, unresolved items, finding và usage.

**Nghiệm thu:** nút Run double-click không tạo hai run; đóng/mở trang không tạo tool call mới; từ model output không thể giả worker registration hoặc grant. Model timeout không khiến cả Project bị mất.

#### UC-05 — Chờ duyệt, pause và cancel

Always ask tạo approval cho mỗi actionable call; high-risk mode chỉ tạo khi effect class cần review; automatic không bật dialog cho hành động vốn được grant cho phép. Reject không thực thi. Pause ngừng phát hành tool/model turn mới sau boundary, giữ output công việc đang chạy. Cancel đánh dấu intent ngay, truyền xuống mọi child/task, theo dõi xác nhận. Owner thấy `cancellation_pending` nếu chưa chứng minh đã dừng.

**Nghiệm thu:** approve cùng request hai lần chỉ tạo một task; quyết định đến sau expiry không có tác dụng; hủy lúc chờ approval vô hiệu approval; không báo canceled khi tiến trình còn được biết là đang chạy.

#### UC-06 — Finding và report

Agent có thể tạo candidate. Owner hoặc quy trình xác minh đề xuất trạng thái với evidence bắt buộc. Owner xem request/response đã che secret, thời điểm và command/tool metadata, sửa wording, severity với rationale. Report chọn phiên bản finding và evidence snapshot, tạo Markdown/JSON/HTML, ghi coverage và giới hạn. Export HTML offline không kéo asset ngoài.

**Nghiệm thu:** verified không có evidence bị API reject; raw evidence hash không bị thay sau edit; severity không tự suy từ model confidence; report chạy lại cùng snapshot không âm thầm lấy finding mới hơn.

#### UC-07 — Retest

Owner chọn finding, xem scope hiện tại và chạy retest. Hệ thống tạo Run mới liên kết finding cũ, không sửa evidence gốc. Retest có kết luận observed_fixed/still_present/inconclusive. Mất credentials hoặc target unavailable là inconclusive, không phải fixed.

#### UC-08 — Khôi phục và xuất dữ liệu

Owner export Project hoặc backup installation. Export Project mặc định loại bỏ secrets, worker tokens và sessions. Import xác minh manifest/hash, tạo ID mới, không kích hoạt grant/worker tự động. Backup installation có mã hóa và backup key riêng; restore kiểm tra khóa, schema, hash và revoked sessions.

### 3. Module và mức ưu tiên

| Module | MUST ở v1 | SHOULD sau luồng lõi | Không v1 |
|---|---|---|---|
| Project | CRUD, archive, scope, files, notes | Import/export có manifest | Chia sẻ public |
| Chat | Lịch sử, pagination, Ask, Agent | Search, pin, rename | Branch chat sâu, collaboration |
| Agent | Durable run, kế hoạch, typed tools | Hai child agents bounded | Agent tự sửa platform |
| Worker | Enrollment, lease, journal, cancel | Nhiều worker được binding | Loại worker chuyên môn cố định |
| Evidence | Immutable bytes, hash, provenance | Redacted preview, filters | Xác nhận pháp lý chuỗi bằng chứng |
| Findings | Candidate/review/retest | Dedup gợi ý | Auto-CVSS không có rationale |
| Settings | Provider, budget, data policy | Nhiều model configs | Billing/subscription |
| Operations | Health, backup/restore, audit | Signed export manifests | Multi-region HA |

### 4. Các thông báo không được đánh tráo ý nghĩa

“Không có finding được xác minh” không đồng nghĩa “không có lỗ hổng”. “Task đã nhận” khác “task đã bắt đầu”. “Run completed” nghĩa thực hiện xong kế hoạch trong coverage ghi nhận, không chứng minh hệ thống đích an toàn. “Local worker” không có nghĩa model chạy local. “File deleted” chỉ dùng khi payload được purge theo chính sách; trước đó dùng “Đã đưa vào hàng chờ xóa”.

### 5. Ràng buộc phi chức năng

Dữ liệu nghiệp vụ phải còn sau restart. Chỉ owner đã xác thực được gọi API quản trị. Browser và worker chỉ thấy tài nguyên đúng Workspace/Project/binding. Không đưa secret vào error response. Nội dung log bounded, backpressure có thiết kế. Các mục tiêu latency/RPO/RTO nằm ở tài liệu 18, là target nghiệm thu lab, chưa phải SLA.


---


<a id="file-docs-03-ux-ui-spec-md"></a>


*Nguồn: `docs/03-ux-ui-spec.md`*


## 03 — Đặc tả UX/UI chat-first

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

### 1. Nguyên tắc giao diện

Học mental model Chat/Agent/Project, không clone asset hoặc CSS độc quyền. Thương hiệu hiển thị chính xác `redAI`. UI tiếng Việt, identifier tiếng Anh. Dùng accent đỏ có chọn lọc cho hành động chính; destructive action khác về icon/label, không dựa màu đơn độc. Light/dark đều có token riêng. Motion nhỏ và hỗ trợ reduced-motion. Không cần ảnh nền, hiệu ứng hacker hoặc dashboard chỉ số giả.

### 2. Route và ownership của màn hình

| Route | Nội dung | Trạng thái bắt buộc |
|---|---|---|
| `/login` | Đăng nhập owner | submitting, invalid, rate limited |
| `/setup` | Provider, dữ liệu, worker | partial, health failure, complete |
| `/` | Project gần đây, New chat trong Inbox | empty, loading, connection failure |
| `/p/:projectId` | Overview nhẹ, Chat gần đây, findings | archived, not found, error |
| `/p/:projectId/c/:chatId` | Hội thoại + Workbench | streaming, waiting, incomplete |
| `/p/:projectId/findings` | Danh sách/chi tiết finding | no findings, filter, pagination |
| `/p/:projectId/files` | File/notes | upload progress, rejected, indexed |
| `/p/:projectId/settings` | Scope, worker binding, policy | dirty, conflict, saved |
| `/workers` | Máy của owner | online, stale, revoked, draining |
| `/settings` | Provider, security, budget, storage | secret saved, validation error |
| `/operations` | Health, backup, diagnostics | degraded; không log raw content |

Inbox là Project hệ thống không có network grants mặc định; Ask dùng được, Agent offline có thể dùng sau worker binding. Không hỗ trợ Chat không có Project để tránh ngữ cảnh mơ hồ.

### 3. Layout desktop

Sidebar 264 px, có thể collapse 64 px. Center conversation co giãn, nội dung đọc tối đa 840 px khi Workbench đóng. Workbench mặc định 420 px, kéo giãn 320–640 px. Topbar chứa tên Project/Chat, trạng thái kết nối, nút mở Workbench. Composer cố định dưới nhưng không che message cuối. Không render lại toàn transcript khi gõ mỗi ký tự.

Breakpoint: dưới 1280 px Workbench dùng overlay; dưới 768 px sidebar là drawer và Workbench là full-screen sheet; composer giữ attachment và nút Stop nhìn thấy. Bản mobile phục vụ theo dõi, duyệt và đọc; không hứa trải nghiệm terminal chuyên sâu tương đương desktop.

### 4. Sidebar

Gồm New chat, Search, danh sách Project, Chat đã pin/gần đây, Workers và Settings. Menu Chat: rename, pin/unpin, archive; không xóa ngay một chat có run active. Project archive không xóa dữ liệu. Xóa Project mở dialog với tên Project, số file/run, retention; bắt owner nhập lại tên cho purge. Drag-and-drop không cần v1; đừng thêm thư viện chỉ cho tính năng chưa có.

Danh sách tải theo cursor; vị trí scroll giữ khi đổi chat. Loading backend phải khác Project rỗng. Lỗi subscription hiển thị Retry, không thay lịch sử bằng empty state.

### 5. Composer

Hàng tùy chọn: Ask/Agent; model config; worker binding (chỉ Agent); approval mode; ngân sách collapsed. Hiển thị chip “Model bên ngoài · đã che dữ liệu” hoặc “Model local” theo route thực, không theo worker location. Tooltip mô tả dữ liệu nào vẫn ra ngoài; có link preview payload redacted trước Run khi owner bật.

Enter gửi, Shift+Enter xuống dòng; trong IME composition không gửi. Attachment có progress và lỗi từng file. Không auto gửi khi upload xong. Nút Send disabled khi nội dung và attachments đều rỗng. Trong run active, composer cho nhập note vào hàng chờ; nút gửi nói rõ “Gửi vào phiên đang chạy”. Note được áp dụng tại model boundary tiếp theo, không đột ngột thay prompt cuộc gọi đã gửi.

Khi stop được bấm, lập tức đổi label “Đang yêu cầu dừng”, nhưng chờ event server trước kết luận. Debounce không thay thế Idempotency-Key. Giữ cùng key khi retry cùng một ý định gửi.

### 6. Message types

User text; assistant markdown; tool card; approval card; plan update; artifact card; finding link; system lifecycle notice. Không hiển thị private chain-of-thought hoặc giả mô hình đang suy nghĩ thành nội dung suy luận. Hiển thị status/rationale ngắn do agent chủ động cung cấp, tool inputs redacted và kết quả có thể kiểm chứng.

Markdown tắt raw HTML mặc định; sanitize link; cấm `javascript:`. Code block có copy và language label; không nút Run trực tiếp bypass policy. External link báo rời ứng dụng. Raw HTTP/terminal text render dạng text, không giải ANSI control nguy hiểm, không tự mở OSC hyperlink. Xterm chỉ dùng read-only task output ở v1; không có host terminal.

### 7. Workbench tabs

**Plan:** step ID, mô tả, trạng thái pending/running/completed/failed/skipped, link task. Chỉnh plan từ owner tạo revision/note; không ghi đè đang thực thi mà mất history.

**Activity:** timeline tools, attempt number, worker, elapsed, policy decision. Mở chi tiết cho stdout/stderr truncated, exit status, error, evidence. Chỉ hiển thị safe summaries; raw content cần quyền owner và không gửi analytics.

**Files:** artifacts của run; preview text/image, download; đường dẫn logical, không lộ path host. Files thay đổi có version, không âm thầm ghi đè evidence.

**Findings:** title/severity/status, nguồn chứng cứ và trạng thái review. Không tự sort “confirmed” lên nếu status backend là candidate.

**Usage:** token/cost quan sát được, budget reserved, unknown cost; phân biệt measured/estimated. Con số không có usage source hiển thị “Chưa xác định”, không 0.

### 8. Approval card

Hiển thị hành động chuẩn hóa, target, effect class, sandbox/worker, thay đổi dự kiến, expiry và policy reason. Hai nút Approve once / Reject. V1 không có “Always approve this prefix” tự do. Chuyển mode thuộc Project settings; không tạo global approval từ một card.

Approval bị stale khi args/scope/worker identity thay đổi; card chuyển expired/stale với giải thích. Đồng thời có hai tab approve cùng card: một decision thành công, tab còn lại cập nhật kết quả, không tạo task thứ hai. Nếu sửa target trước approve, phải tạo tool call mới.

### 9. Empty/error states cụ thể

Chưa có worker: hướng dẫn enrollment, Ask vẫn hoạt động. Worker offline: giữ nguyên máy đã chọn, nút retry/resume sau khi online, không chọn máy khác hộ. Provider chưa sẵn sàng: mở Settings, không tự dùng provider khác. Hết budget: tóm tắt phần đã làm, cho owner thay budget rõ ràng rồi tiếp tục bằng run/continuation được ghi nhận. Scope denied: nêu target chưa nằm trong grant; không gợi ý vượt kiểm soát.

Disk full: upload/task mới blocked, dữ liệu hiện hữu vẫn đọc được nếu còn khả năng. SSE disconnected: badge reconnecting và nút manual reconnect; không xóa transcript. Cursor expired: tải snapshot rồi tiếp tục, không chạy lại task.

### 10. Design tokens và kiểm thử giao diện

Spacing theo bội số 4; base font 14–16 px, line height 1.5; monospace cho output. Focus visible; dialog trap focus, Escape đóng khi an toàn; status dùng `aria-live=polite`, lỗi form gắn input. Tất cả control có accessible label. Trạng thái lỗi không chỉ màu.

E2E cần screenshot light/dark ở 1440×900, 1024×768, 390×844; long transcript 1.000 messages fixture, long command, ký tự tiếng Việt, multiline filename, output 1 MiB truncated, approval concurrently updated. Mọi screenshot phải dùng component và CSS thật, không HTML fixture khác sản phẩm.


---


<a id="file-docs-04-architecture-repository-md"></a>


*Nguồn: `docs/04-architecture-repository.md`*


## 04 — Kiến trúc và bố trí repository

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

### 1. Hệ thống gồm những process nào?

`web`: Next.js render UI. `api`: Fastify quản lý owner API, worker endpoints, authorization, streaming events, upload/download. `runtime`: TypeScript tiến trình chạy durable Agent state machine và maintenance jobs. `worker`: Go daemon trên máy Linux, nhận task qua HTTPS outbound; chạy sandbox và trusted tool adapters. PostgreSQL lưu trạng thái bền vững. ObjectStore local lưu bytes, chia sẻ mount chỉ giữa API/runtime, không đưa host path sang sandbox.

Một reverse proxy đưa `/api/*` tới API và phần còn lại tới web, cùng origin. Worker dùng `/worker/v1/*` ở origin được owner cấu hình. Không cần NATS, Redis, Temporal, E2B, Convex, WorkOS hoặc S3 cloud để bản đầu hoạt động. Đây là lựa chọn riêng của redAI, không mô tả stack của HackerAI.

### 2. Data flow

Browser → API (session/CSRF) → domain transaction (message/run/events) → runtime claim → model adapter → schema/policy/budget → execution task → worker claim/lease → sandbox → evidence upload/finalize → task result → runtime → finding/report → SSE. Tool network traffic không đi từ API vào target; đi từ worker execution plane qua scoped proxy. API chỉ có network tới provider do owner cấu hình và các dịch vụ control-plane cần thiết.

Worker không truy cập PostgreSQL. Worker không đưa bearer token vào sandbox env. Model API key chỉ ở trusted runtime. ObjectStore và DB không lắng nghe trực tiếp trên network sandbox. Browser không gọi model provider trực tiếp.

### 3. Vì sao chưa dùng workflow engine riêng?

Personal v1 có một loại workflow chính, bounded Agent loop. Dùng bảng trạng thái, row lock/lease, checkpoint và event journal giảm dịch vụ phải vận hành. PostgreSQL mô tả `SKIP LOCKED` có thể phục vụ consumer của queue-like table; không dùng tính chất này như snapshot nhất quán cho báo cáo [SRC03]. Ta vẫn phải tự thiết kế retry/idempotency/cancellation; queue không giải quyết side effect bên ngoài.

Temporal là phương án nâng cấp, không một dependency bị quên. Chỉ mở ADR chuyển khi có nhiều loại workflow độc lập, orchestration nhiều ngày hoặc yêu cầu scale/operability khiến native loop khó duy trì. Không giữ hai hệ thống queue cùng làm chủ cùng task.

### 4. Module ownership

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

### 5. Repository mục tiêu

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

### 6. Runtime scheduler và durable events

Runtime claim một run bằng compare-and-set lease; không giữ transaction trong khi gọi model. Sau mỗi boundary lưu checkpoint đủ khôi phục. Tool task lưu trước dispatch. Tất cả mutation nghiệp vụ tạo event trong cùng transaction. `events` là durable journal kiêm outbox đọc bởi API; `NOTIFY` chỉ là tín hiệu đánh thức, mất notify không mất event.

SSE cursor **theo Workspace** và thứ tự commit được bảo vệ bằng row counter lock, không dùng một global `bigserial` mà tưởng thứ tự cấp sequence bằng thứ tự commit. Chi tiết ở tài liệu 06. Scheduler query và dashboard query khác nhau; job claim có thể bỏ qua locked rows, còn dashboard cần snapshot đúng.

### 7. Topology cá nhân

Máy control-plane chạy proxy/web/api/runtime/PostgreSQL/ObjectStore. Worker có thể cùng máy cho offline development; dùng VM Linux riêng là topology nghiệm thu khuyến nghị cho thực thi nội dung không tin cậy. Máy ảo không chứa khóa DB/model. Một worker thứ hai cùng binary dùng network zone khác nhưng chỉ được chọn khi Project binding cho phép. Không cần Kubernetes.

Không hứa cấu hình RAM tối thiểu tuyệt đối trước benchmark. Lab tham chiếu: control-plane 4 vCPU/8 GiB RAM; worker 4 vCPU/8 GiB RAM, 2 task slots. Đây là cấu hình thử nghiệm để đo, không phải đảm bảo mọi trình duyệt/tool chạy được với mức này.

### 8. Dependency/version discipline

T00 đọc docs hiện hành của Next.js/Fastify/Go/PostgreSQL và ghi `docs/dependency-baseline.md`: version cụ thể, lifecycle, license, platform support. Chọn bản stable đang được hỗ trợ; pin package lock, OCI image digest và tool version. PostgreSQL schema nhắm major 18; test thực tế ở version được pin. Không sao chép version từ repo tham khảo hoặc máy của người viết tài liệu rồi coi là tương thích.

### 9. Ranh giới testability

Clock, random ID, provider, worker transport, storage và policy được inject bằng interface nhỏ. Mock clock cho TTL; mock provider cho tool-call sequence; lab worker cho crash tests. Không tạo abstract factory đa provider khi mới có một triển khai; interface tập trung vào contract có hành vi thay đổi thật. Thiết kế monolith theo module trước; tách process vì vòng đời, không chia service để trang trí sơ đồ.

### 10. Đặt bộ đặc tả vào repository mà không tạo hai nguồn hợp đồng

Giải nén nội dung thư mục gói vào root repository `redai/`, giữ `docs/`, `contracts/`, `implementation/` và `AGENTS.md`. `contracts/` tại root là nguồn JSON Schema/OpenAPI chính. `packages/contracts/` là package code được sinh/adapter và đọc nguồn đó; không duy trì bản schema thứ hai bằng tay. `db/001_reference_schema.sql` là DDL tham chiếu; T02 đưa migration đã kiểm tra vào `packages/db/` và ghi mapping phiên bản. Khi sửa thiết kế DB, cập nhật reference và migration tương ứng, không để ORM tự sửa schema live. README ứng dụng sau này có thể thay trang bìa, nhưng giữ liên kết đến đặc tả và không xóa baseline/ADR.


---


<a id="file-docs-05-data-model-md"></a>


*Nguồn: `docs/05-data-model.md`*


## 05 — Domain model, persistence và invariants

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

### 1. Quy ước

ID dùng UUID do application tạo; không chứa tên mục tiêu. Thời gian DB `timestamptz` UTC, API RFC 3339 UTC, UI chuyển theo timezone Settings (`Asia/Bangkok` ban đầu). Thời gian lease server là authoritative; worker dùng monotonic timer và safety margin. Số tiền dùng integer micro-USD, truyền JSON dưới dạng chuỗi thập phân để không mất chính xác JavaScript. Không dùng float cho ledger.

Mọi row thuộc owner data đều có `workspace_id`; thực thể cấp Project có `project_id`. V1 chỉ một Workspace không phải lý do bỏ predicate hoặc foreign key cùng Workspace. `revision` tăng khi edit với optimistic concurrency. JSONB dùng cho snapshot/typed payload, không dùng thay tất cả quan hệ.

### 2. Entity và nguồn sự thật

| Entity | Vai trò và liên kết |
|---|---|
| `workspaces`, `owners`, `sessions` | Installation chứa một Workspace/owner; session chỉ lưu hash token |
| `projects` | Hồ sơ công việc; Inbox là Project hệ thống |
| `dns_proofs` | Bằng chứng DNS có challenge và timestamp; không tự là grant vô hạn |
| `scope_versions` | Phạm vi immutable, mỗi version liên kết một Project |
| `authorization_grants` | Cho phép sử dụng scope version; actor, attestation, trạng thái, epoch, expiry |
| `assets` | Tài sản đã khai báo/phát hiện; trạng thái discovered/authorized là view theo grant, không boolean tự cấp quyền |
| `workers`, `worker_credentials`, `enrollment_tokens` | Máy thực thi, phiên kết nối và credentials tách biệt |
| `project_workers` | Binding Project → worker/zone được cho phép |
| `provider_configs`, `secrets` | Model config và ciphertext secret, không lưu secret trong JSON snapshot |
| `chats`, `messages` | Conversation; mỗi Chat có thứ tự message riêng |
| `runs`, `agent_sessions`, `agent_steps` | Phiên công việc, coordinator/child logic, durable model boundary |
| `tool_calls`, `task_attempts` | Ý định công cụ ổn định và các lần thực thi cụ thể |
| `approvals` | Quyết định một lần cho fingerprint chính xác |
| `artifacts`, `artifact_links` | Metadata bytes immutable và liên kết provenance |
| `findings`, `finding_versions`, `finding_evidence`, `retests` | Nhận định và lịch sử kiểm chứng |
| `reports` | Snapshot phiên bản finding và artifact đầu ra |
| `notes`, `document_chunks` | Ngữ cảnh Project được chọn/trích xuất |
| `events`, `event_counters` | Journal sự kiện có cursor commit-ordered trong Workspace |
| `budget_reservations`, `usage_entries` | Dự trù và chi phí quan sát được, không tự bỏ mất khoản unknown |
| `idempotency_keys`, `audit_events`, `maintenance_jobs` | Dedup requests, nhật ký bảo mật, cleanup/backup |

DDL cụ thể ở `db/001_reference_schema.sql`. Các JSON payload được kiểm tra theo schema trước persist; DB cũng check enum, unique và FK quan trọng.

### 3. Invariants không được phá

**INV-001 — Ownership closure.** Run, Chat, scope version, grant, worker binding và artifact link phải cùng Workspace/Project nơi quan hệ yêu cầu. Một UUID hợp lệ không đủ cho authorization. Composite FK bảo vệ quan hệ Project; server vẫn kiểm tra session/binding.

**INV-002 — Một run active trên một Chat.** Active gồm queued, running, waiting_approval, waiting_worker, paused, cancel_requested, cancellation_pending, needs_attention. Partial unique index bảo vệ khi hai tab gửi cùng lúc. Terminal run gồm completed, failed, canceled, expired. Tiếp tục terminal run tạo run mới `resumes_run_id`, không sửa history.

**INV-003 — Versioned authority.** Scope version immutable. Grant có thể revoked ngay; run snapshot không được giữ quyền sống sau revoke. Mọi dispatch/renewal kiểm tra live grant epoch và worker status. Owner mở rộng scope tạo version mới và áp dụng cho run mới; không âm thầm mở rộng run đang chạy.

**INV-004 — Durable before effect.** Logical call + attempt + input digest + event được commit trước worker dispatch. Worker journal `start_intent` trước container start. Không lưu ý định quan trọng chỉ trong RAM.

**INV-005 — Một kết quả authoritative.** Chỉ attempt/fence đang được công nhận có thể chuyển logical tool call sang succeeded/failed. Duplicate submit cùng result digest trả cùng ACK. Submit digest khác cùng attempt là conflict/security event. Late result stale được quarantined, không ghi đè authoritative state.

**INV-006 — Không giả exactly-once.** Lease/fencing ngăn stale worker commit vào control-plane, không chứng minh tác động ngoài mạng chỉ xảy ra một lần. Outcome unknown phải reconcile hoặc yêu cầu owner review; không auto replay external_write/unknown/destructive.

**INV-007 — Bằng chứng immutable.** Payload artifact đã finalize không bị overwrite. Redaction, parsing hoặc report tạo artifact/version mới với link nguồn. Hash chứng minh tính toàn vẹn bytes trong hệ thống, không tự chứng minh tính trung thực của target/worker.

**INV-008 — Budget chung.** Child agents dùng cùng run ledger. Reservation được tạo transaction trước model request. Unknown usage giữ reservation chưa reconcile, không tính 0. Owner có thể tăng hạn mức bằng một audit action, không model.

**INV-009 — Event nhất quán.** Business mutation và durable event cùng transaction. Cursor cấp theo Workspace bằng row counter được khóa đến commit. SSE được phép giao lặp, không được bỏ vĩnh viễn event đã commit vì thứ tự sequence/commit đảo nhau.

**INV-010 — Tắt không đồng nghĩa dừng.** Grant revoked, cancel requested hoặc lease expired ngăn hoạt động mới; trạng thái canceled chỉ khi mọi active attempt đã xác nhận dừng hoặc đã được đối soát quiescent. Không biết thì cancellation_pending/needs_attention.

**INV-011 — Model không cấp quyền.** AI output không tạo live grant, binding, provider config, secret grant hoặc approval decision. Các use case đó chỉ owner API/session được phép.

**INV-012 — Xuất/nhập không cấp quyền.** Import tạo identifiers mới, đánh dấu grants inactive, worker bindings unset, secrets absent. Không import session/token để đăng nhập hoặc điều khiển worker.

### 4. State model

#### Run

`queued → running`; `running → waiting_approval | waiting_worker | paused | completed | failed | needs_attention | cancel_requested`. Waiting/paused có thể về running sau kiểm tra live policy, absolute expiry và input note. Mọi trạng thái active có thể vào cancel_requested. `cancel_requested → canceled` khi đã quiescent, nếu chưa biết vào cancellation_pending. `cancellation_pending → canceled | needs_attention`. `needs_attention` chỉ trở lại running sau reconciliation minh bạch; không nút Retry mù.

`outcome` tách với lifecycle: `none | complete | partial | blocked`. completed/partial cho phép khi Agent chủ động kết thúc với coverage thiếu và unresolved items rõ; không dùng chữ “đã kiểm tra đầy đủ”. failed có thể giữ partial evidence. expiry khi có task đang chạy trước hết phải đi cancel path; không đổi thẳng expired làm mất theo dõi task.

#### Tool call và attempt

Call: requested, blocked, waiting_approval, queued, executing, succeeded, failed, canceled, unknown. Attempt: queued, leased, started, uploading, succeeded, failed, cancel_requested, canceled, lost, unknown. `lost` nghĩa mất liên lạc; `unknown` nghĩa chưa xác định outcome của hiệu ứng. Không dùng `lost` như bằng chứng tool chưa chạy.

#### Finding

Đánh giá kỹ thuật (`candidate`, `needs_review`, `verified`, `rejected`, `inconclusive`) tách remediation (`open`, `fixed`, `accepted_risk`). Retest có result riêng `observed_fixed`, `still_present`, `inconclusive`; finding `fixed` không làm mất verification ban đầu. Severity `info | low | medium | high | critical`, confidence `low | medium | high` độc lập.

### 5. Transaction quan trọng

**Create run:** check owner/Project/chat; lock Chat; check active unique; snapshot settings/scope; insert user message nếu atomic send; insert run/agent_session; update message_seq; append event; persist idempotency response; commit. API response chỉ sau commit. Một endpoint mutation không vừa gửi message lại vừa tạo run không gắn message rõ ràng.

**Model boundary commit:** compare run lease/fence; store model response artifact/parsed plan; insert tool_calls với unique `(agent_step_id, provider_tool_index)`; update step checkpoint; append events. Không dispatch tool_calls nằm trong response chưa commit. Streaming text trước commit được đánh dấu provisional, không trở thành kế hoạch authoritative.

**Approve:** lock approval, verify pending/expires/fingerprint/live grant; set decision; create attempt duy nhất với unique call attempt_no; event; commit. Policy denial không thể được override bằng approval card.

**Finalize artifact:** check upload pending/owner/attempt; verify size/digest bằng bytes server quan sát; atomic rename; transaction metadata ready + event. DB/file không atomic cùng hệ thống: staging và reconciliation xử lý crash giữa hai thao tác. File final tồn tại mà DB chưa ready là orphan candidate, không tự public.

**Cancel:** lock run; mark intent; invalidate pending approvals; mark queued attempts canceled, started attempts cancel_requested; append event. Sau đó worker heartbeat/lease renewal nhận directive. Request transaction không chờ tất cả tiến trình chết.

### 6. Deletion và retention

Archive khác delete. Delete Project yêu cầu không run active hoặc chấp nhận cancel trước; tombstone Project ngay và tạo maintenance job. Revoke grants/bindings, chặn reads mới trừ owner recovery view. Purge theo batch có checkpoint; xóa artifact link trước, xóa payload khi không còn reference hợp lệ và retention hết. Audit ghi đối tượng đã xóa bằng ID/timestamp không cần giữ target content.

V1 đề xuất raw task logs 30 ngày, artifacts/finding/report giữ đến khi owner xóa, SSE events 30 ngày; job spool worker tối đa 24 giờ sau ACK. Owner có thể đặt dài hơn. Secret deletion xóa ciphertext và mapping; backup cũ vẫn có dữ liệu tới expiry của backup, UI không hứa xóa xuyên mọi bản sao.

### 7. Index, search và migration

Index cho Chat message cursor, Project updated_at, active run, claimable attempts, worker heartbeat, grant trạng thái và artifact references. Full-text index trên title/notes/redacted extracted text; không index secrets hoặc raw sensitive dump. Mọi query search có Workspace/Project predicate trước pagination.

Migration additive trước code dùng field; backfill bounded; cutover; cleanup ở release sau. Không drop field đang có run active. Backup trước migration destructive. SQL reference chưa là chứng cứ chạy thành công trên PostgreSQL; T02 phải apply/test constraints và generate rollback/runbook.


---


<a id="file-docs-06-api-realtime-md"></a>


*Nguồn: `docs/06-api-realtime.md`*


## 06 — REST API, SSE và hợp đồng lỗi

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

### 1. Quy ước chung

Owner API base `/api/v1`; worker API base `/worker/v1`. JSON UTF-8, snake_case. UUID/RFC3339 và MoneyString theo schema. Response resource có `id`, `revision`, timestamps nơi thích hợp. Collection `{items, next_cursor}`; cursor opaque, signed hoặc encoded validated, bound to filter/sort. Mặc định limit 50, max 100. Không offset cho timeline lớn.

OpenAPI ở `contracts/` là route contract. JSON Schema là nguồn type dùng chung; generate TypeScript/Go types nhưng vẫn runtime validation ở boundary. Domain validation (FK cùng Project, grant live, invariant) không được thay bằng JSON Schema đơn thuần.

### 2. Xác thực và request integrity

Owner dùng secure HttpOnly SameSite=Strict cookie, server-side session; mutation yêu cầu CSRF token và Origin hợp lệ. GET không được đổi state, trừ tạo network connection chỉ đọc. CORS không wildcard. Worker dùng bearer credential riêng, không owner session. TLS bắt buộc ngoài loopback test; deployment private vẫn có auth.

Resource sai owner/project trả 404 để tránh enumeration. 401 cho session thiếu/hết hạn, 403 cho hành động trên resource thuộc owner nhưng policy không cho phép. Không dựa hidden button ở UI để bảo vệ endpoint.

### 3. API nhóm chức năng

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

### 4. Idempotency

Các mutation tạo Run, quyết định approval, tạo report, finalize upload, enrollment và dispatch-sensitive actions yêu cầu `Idempotency-Key` UUID. Scope key là `(actor identity, method, normalized route, key)`, không chỉ key toàn hệ thống. Lưu digest body chuẩn hóa, response status/body và expiry 24h trong transaction của nghiệp vụ. Request cùng key/body trả response cũ; cùng key/body khác trả 409 `IDEMPOTENCY_CONFLICT`.

Concurrent duplicate: unique reservation key, loser đợi transaction ngắn hoặc trả 409 `REQUEST_IN_PROGRESS` kèm retry_after; không chạy use case lần hai. Nếu owner retry sau thời gian lưu key, active-run unique và client_message_id vẫn giúp chống trùng nhưng không hứa dedup vô hạn. Tool attempts/result có ID riêng tồn tại suốt retention, không phụ thuộc HTTP key 24h.

### 5. Optimistic concurrency

Edit resource dùng `If-Match: "<revision>"`. Không khớp trả 409 `REVISION_CONFLICT`, chứa current revision và safe fields để UI reload/merge. Không sửa grant snapshot hoặc evidence bytes; sửa tạo version. Approval decision không merge. Client không tự retry edit với revision mới mà ghi đè thay đổi ở tab khác.

### 6. Error envelope

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

### 7. SSE protocol

Endpoint `GET /api/v1/events?project_id=...&after=...`. Cookie-authenticated; header `Last-Event-ID` khi reconnect, `after` cho initial navigation. Chỉ chấp nhận một cursor thực tế: header ưu tiên nếu có và hợp lệ. Payload envelope có schema_version, event_id, workspace_id, project_id optional, run_id optional, type, created_at, data. Cursor/event_id là **decimal string per Workspace**.

```text
id: 1204
event: run.state_changed
data: {"schema_version":"1.0","event_id":"1204","workspace_id":"...","project_id":"...","run_id":"...","type":"run.state_changed","created_at":"2026-09-24T03:00:00Z","data":{"from":"queued","to":"running"}}

```

SSE có `id`/`Last-Event-ID` theo HTML Standard [SRC05]. Giao lặp là bình thường; client dedup theo event_id. Proxy tắt buffering và cache. Heartbeat comment mỗi 15s. Slow consumer có buffer tối đa 1 MiB, vượt thì đóng connection và để client replay từ cursor; không block domain transaction vì một tab chậm.

### 8. Không mất event do sequence/commit race

Trong transaction mutation, lock `event_counters` row của Workspace (`FOR UPDATE`); lấy/increment counter cho events cần ghi; insert events; commit cùng mutation. Row lock giữ tới commit, nên transaction sau không thể cấp cursor cao rồi commit trước transaction đang giữ cursor thấp. Không dùng `bigserial` làm bằng chứng thứ tự commit.

API subscribe theo vòng: query committed events `event_id > cursor` order asc limit; flush; update cursor; wait notification hoặc timeout; query lại. `LISTEN/NOTIFY` chỉ wake-up. Filter Project vẫn cần tiến cursor qua các event không match: server có thể gửi `stream.cursor` chứa cursor mới để không replay scan vô hạn; không tiết lộ payload Project khác.

Snapshot endpoint trả `snapshot_cursor` được lấy cùng consistent transaction với data. Nếu cursor cũ đã purge, trả 410 `EVENT_CURSOR_EXPIRED`; client fetch snapshot rồi stream after cursor. Nếu future cursor hoặc Workspace sai trả 400/404. Không reset cursor về 0 mà xóa local UI state khi network error.

### 9. Provisional model tokens và durable message

Không cần ghi DB mỗi token. API/runtime gom text delta tối đa mỗi 250ms hoặc 4KiB. Delta event gắn `(message_id, generation_id, delta_seq)` và là provisional. Final message commit có full text/hash và trạng thái completed. Reconnect nhận persisted partial snapshot hoặc final message. Nếu model request chết, partial message giữ nhãn interrupted; không biến nó thành tool instruction. Tool call chỉ hiển thị executable sau boundary commit.

V1 có thể ghi grouped deltas vào events để replay đơn giản, quota/retention có giới hạn. Không gửi private model reasoning event. Structured output chỉ dùng khi validate thành công.

### 10. File upload protocol

Create metadata pending với expected size/type → PUT bytes theo upload session owner-bound → server hash bytes và enforce hard length → finalize idempotent → metadata ready. Không nhận path filesystem từ request. Finalize trước đủ bytes trả 409; sai hash trả 422 và quarantine. Download qua authenticated API, `Content-Disposition: attachment` cho loại nguy hiểm; preview HTML render sandboxed hoặc dưới dạng text.

Worker artifacts dùng cùng nguyên tắc nhưng credential/capability chỉ được tạo artifact cho attempt của mình, TTL bounded; không cho list toàn ObjectStore. Upload fail không được báo tool hoàn tất với evidence giả. Result chỉ link artifact ready hoặc nêu evidence_missing.

### 11. Compatibility

Version major trong path; schema_version minor trong events/worker messages. Additive optional field có thể tương thích; enum mới phải kiểm tra consumer tolerant behavior trước rollout. Worker quá cũ thiếu policy schema mới không claim task; API trả UPGRADE_REQUIRED. Không fallback sang unsigned legacy task format.

### 12. Các API hỗ trợ không được bỏ quên

`GET /snapshot?project_id=...` trả compact Workspace/Project snapshot và commit-consistent cursor; Run chi tiết dùng `/runs/:id/snapshot`. Snapshot có giới hạn100 Chat gần nhất; lịch sử cũ tiếp tục phân trang. Settings/session/password APIs nằm trong OpenAPI. Không để màn hình Security chỉ là form chưa có handler.

Owner reconciliation của unknown call có ba quyết định: close_inconclusive, accept_observed_result có evidence, hoặc confirm_quiescent_no_replay có lý do. Không quyết định nào tự replay task. Kết quả owner attestation được ghi như vậy, không giả là ACK từ worker. Emergency resume chỉ bật Run mới sau doctor/reauth; không tự hồi sinh Run từ restore.

Đối với response chứa credential/enrollment secret, idempotency cache phải mã hóa AEAD, không plaintext JSON; TTL truyền lại10 phút, ràng buộc cùng request/body/actor. Đây là một lần cấp logic với retransmission có kiểm soát, không endpoint reveal lâu dài. Hết cửa sổ hoặc không xác minh lại được actor thì trả conflict yêu cầu owner rotate/re-enroll. Các response bình thường giữ TTL24 giờ. Không log encrypted-response plaintext khi decode để trả.


---


<a id="file-docs-07-agent-runtime-md"></a>


*Nguồn: `docs/07-agent-runtime.md`*


## 07 — Durable Agent runtime và vòng lặp điều phối

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

### 1. Các khái niệm

Run là yêu cầu công việc có tuổi thọ độc lập tab trình duyệt. AgentSession là coordinator hoặc subagent logic trong Run. AgentStep là một lượt gọi model cùng xử lý tool results. ToolCall là ý định đã được chốt; TaskAttempt là lần worker thực thi. Một Run có thể tạo nhiều AgentSession nhưng dùng chung scope snapshot, worker binding và budget root.

Ask đi qua cùng provider/context/persistence nhưng **tool set rỗng**, không tạo execution attempts. Report rendering server là maintenance task không phải quyền shell của model. Agent không được tự mở task root mới để vượt step/budget limit.

### 2. Một vòng xử lý

1. Claim run bằng row lock ngắn, tăng `runtime_fence`, đặt lease.
2. Đọc checkpoint, live grant, cancel/pause intent, notes mới, kết quả task đã commit.
3. Nếu còn ambiguous effect, chờ/reconcile; không gọi model để tự đoán task đã chạy hay chưa.
4. Tạo context manifest bằng nguồn có ID/hash; tính token/cost reservation.
5. Lưu step `calling_model` và provider request attempt ID trước network call.
6. Gọi model có timeout/cancel; stream provisional text, nhưng không thực thi tool-call chunk chưa hoàn chỉnh.
7. Validate full response và persist model boundary bằng runtime_fence CAS.
8. Với mỗi tool call: normalize, schema validate, tool registry classify, scope/policy/budget check; tạo approval hoặc queued attempt.
9. Đợi task results, update plan/checkpoint; lặp trong step/time/budget limit.
10. Finalize sau khi không còn task active/unknown: summary có coverage, evidence, unresolved items và usage trạng thái.

Không giữ DB transaction qua bước 6 hoặc lúc worker thực thi. Lease renewal là loop riêng, bounded; nếu mất lease, runtime bỏ quyền commit mới và abort provider request khi có thể.

### 3. Checkpoint tối thiểu

`run_id`, `runtime_fence`, `agent_session_id`, `step_no`, `state`, `objective`, `plan_revision`, `pending_tool_call_ids`, `last_consumed_event_id`, `last_consumed_message_seq`, `context_manifest`, `summary_artifact_id`, `retained_tail_message_ids`, `provider_request_id`, `budget_reservation_id`, `stop_reason`, timestamps. Secrets không xuất hiện trong checkpoint; dùng secret_ref.

Lịch sử Chat, context model và domain state tách biệt. Context summary không chứa “quyền mới” có hiệu lực; mọi scope từ DB đã version. Sau restart phải reconstruct bước từ checkpoint/domain entities, không replay toàn transcript thành tools.

### 4. Model response schema

Model có thể trả text hoặc tool calls theo provider adapter. Tool arguments phải parse được một lần và validate exact schema; duplicate JSON keys reject; unknown tool name reject. Registry cố định cho Run từ manifest version. Không dùng một tool `execute_anything` trên host.

Tool call ID từ provider không được tin làm primary ID toàn hệ thống. Server tạo UUID cho ToolCall, lưu provider index/id dưới dạng metadata. Unique `(agent_step_id, provider_tool_index)` chống tạo trùng khi callback lặp. Tool descriptions/prompt được versioned và ghi manifest hash.

Khi structured output lỗi, cho tối đa một repair request chỉ sửa cấu trúc dựa trên dữ liệu có sẵn; request đó cũng tính budget/step. Không chạy tool dựa trên JSON “gần đúng”. Repair thất bại trả MODEL_OUTPUT_INVALID, giữ partial output.

### 5. Retry matrix

| Tình huống | Hành động |
|---|---|
| Model 429 trước response và không có tool commit | Tối đa 2 retries có jitter/Retry-After, cùng provider cho phép, budget theo attempt |
| Model timeout sau partial text | Đánh dấu generation interrupted; chỉ retry nếu không có boundary tools commit; ghi usage_unknown nếu thiếu billing |
| Runtime chết sau model response nhưng trước commit | Không có tool được dispatch; model có thể gọi lại, chi phí có thể lặp; ghi reconciliation flag |
| Runtime chết sau tool_call commit | Dùng tool_call đã có, không tạo call mới |
| Tool pure thất bại rõ trước start | Có thể retry 1 lần nếu lease cũ quiescent và live policy còn hợp lệ |
| Task mất kết nối trong external operation | unknown/needs_attention; không automatic replay |
| Provider bị chính sách dữ liệu chặn | Không fallback ra provider khác hoặc model không được phép |
| Approval rejected | Nêu bị từ chối, có thể sửa kế hoạch không lặp cùng hành động |

Library retry phải được cấu hình rõ; không để SDK retry công cụ hoặc model vô hạn phía dưới application policy. Provider fallback là cấu hình owner explicit cùng policy/data region, không route tự động chỉ vì một nhà cung cấp từ chối nội dung.

### 6. Pause, notes, resume và cancel

Pause là cooperative: ngừng tạo tác vụ mới sau bước hiện tại; tool đang chạy được cho hoàn thành trong timeout nếu owner chỉ pause. UI hiển thị “Đang chờ bước hiện tại dừng tại ranh giới”. Không giữ approval hoạt động vô hạn: expiry 15 phút; khi resume tạo approval mới cho fingerprint hiện tại nếu cần.

Note gửi trong run active được append message, runtime lấy ở boundary tiếp theo và đánh dấu consumed. Note không tự đổi authorization. Nếu note yêu cầu scope rộng hơn, runtime tạo blocked item và owner dùng Project settings.

Resume paused/waiting_worker yêu cầu live grant/budget/provider/worker check; absolute deadline 24 giờ từ create không bị kéo dài bằng retry. Đã expired/completed/failed tạo Run mới tham chiếu trước, không chỉnh history. Budget tăng là owner action được audit và cập nhật ledger giới hạn, không thay chi phí quá khứ.

Cancel lập tức ngừng dispatch/model turn mới; abort provider và gửi worker directives. Parent chỉ canceled khi mọi child/session/task quiescent. Nếu worker mất liên lạc, cancellation_pending; local watchdog phải kill sau lease TTL, nhưng server cần acknowledgement/reconciliation trước tuyên bố biết chắc đã dừng. Không dùng ảnh screenshot “Stop” làm bằng chứng cancel hoạt động.

### 7. Subagent bounded

Coordinator có tool `agent.delegate` ở control-plane, không chạy trong sandbox. Input có objective cụ thể, context refs, allowed tools subset, budget share, acceptance output. Child không thể delegate tiếp. Tối đa 2 active children và tổng 3 model requests đồng thời toàn Run. Scheduler transaction giữ slot/budget chung.

Child output là dữ liệu chưa xác minh, không instruction cấp quyền. Coordinator phải kiểm tra artifact readiness và finding statuses; không viết “child xác minh thành công” khi child failed/inconclusive. Shared workspace filesystem không được child ghi đè: mỗi child có run-local thư mục riêng, promote artifact bằng explicit link.

Không có worker `recon`, `web`, `report`. Cùng binary toolset, task selection dựa binding, health, capacity, supported manifest và network zone. Agent role không gắn hostname.

### 8. Context compaction

Ngưỡng đề xuất 70% context window đã cấu hình; giữ system/task instructions, live policy snapshot structured, plan/current work, critical evidence refs và tail hoàn chỉnh. Large output chuyển artifact + bounded excerpt, không bỏ hash/provenance. Summary dùng schema `summary.schema.json`; phải giữ objective, completed/pending, evidence IDs, uncertainties và active task IDs.

Compaction chỉ thay context derivative, không xóa Chat/Evidence. Summary fail thì giữ context cũ, prune deterministic phần không thiết yếu hoặc dừng với CONTEXT_LIMIT; không lưu summary rỗng đè dữ liệu tốt. Không để message tool-result mất cặp tool-call theo protocol provider. Summary không trở thành nguồn authorization [thiết kế redAI; tham khảo vấn đề compaction SRC02].

### 9. Chống vòng lặp và runaway

Fingerprint action gồm tool name + normalized args + target + input versions. Ba lần cùng fingerprint không tiến triển → nudge một lần rồi stop reason LOOP_DETECTED. “Không tiến triển” là không artifact/result/plan state mới, không đơn giản số message giống nhau. Child loops tính chung budget. Hạn mức step 40, active time 30 phút, absolute time 24 giờ, calls concurrent theo SPEC_LOCK.

Không dùng model tự báo “tôi đã xong” làm điều kiện duy nhất. Finalization gate: không pending tool, không approval pending cần xử lý, mọi finding final có status/evidence hợp lệ, report refs ready, coverage/incomplete fields có mặt.

### 10. Acceptance riêng runtime

Restart tại từng boundary của loop với deterministic provider fixture phải không nhân tool call. Hai runtime processes claim cùng run chỉ một fence commit. Old runtime tỉnh lại sau GC/network delay không được commit response. Mất model cost metadata phải thấy unknown/reserved, không 0. Cancel child cùng lúc parent finalizing không thể xuất report “completed” bỏ qua child chưa dừng.


---


<a id="file-docs-08-worker-protocol-md"></a>


*Nguồn: `docs/08-worker-protocol.md`*


## 08 — Worker đồng nhất, lease, fencing và phục hồi

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

### 1. Trust model và danh tính

Worker là trusted daemon do owner cài trên Linux; sandbox payload không tin cậy. Worker binary có toolbox manifest version/digest. Mỗi installation của worker có `worker_id` UUID lưu ổn định và bearer credential riêng; hostname chỉ display, không dùng nhận dạng hoặc authentication. Không clone file identity/token vào image dùng cho nhiều máy.

CLI mục tiêu: `redai-worker enroll`, `run`, `doctor`, `status`, `revoke-local`. Đây là lệnh cần coding agent triển khai, chưa có binary trong gói đặc tả. Credentials lưu mode 0600, state dir 0700; không truyền token vào command line/log. Worker không kết nối trực tiếp tới DB/LLM.

### 2. Enrollment và session

Owner API tạo one-use enrollment token 256-bit entropy, TTL10 phút, hash trong DB, ràng buộc Workspace và worker display name tùy chọn. CLI gửi token qua HTTPS body, identity/public metadata và manifest. Server transaction consume token, tạo worker/credential; token replay reject. Enrollment request có idempotency để retry cùng intent không tạo worker thứ hai; credential chỉ được cấp một lần logic; retransmission cùng intent tuân theo cửa sổ mã hóa ở mục11, ngoài cửa sổ cần owner rotate/re-enroll.

Worker credential 256-bit opaque, hash DB, TTL30 ngày, rotate có overlap tối đa 5 phút. `open-session` tạo session UUID và tăng generation; chỉ một active session cho worker identity. Session cũ bị thay thế nhận SESSION_SUPERSEDED, ngừng claim, không được dùng renewal để giữ task sống. Reconnect network của cùng daemon không tự mở session mới nếu session còn hợp lệ; daemon restart mở session mới và reconcile journal.

### 3. HTTPS endpoints

`POST /sessions`, `POST /heartbeat`, `POST /tasks/claim`, `POST /tasks/:attemptId/ack`, `POST /tasks/:attemptId/renew`, `POST /tasks/:attemptId/events`, `POST /tasks/:attemptId/result`, `POST /tasks/:attemptId/reconcile`, artifact upload endpoints. `contracts/worker.openapi.yaml` định nghĩa request/response. Worker tạo kết nối outbound; không cần mở port inbound để nhận lệnh.

Claim long-poll tối đa20 giây, trả một task hoặc204. Heartbeat mỗi5 giây, renewal mỗi10 giây, lease45 giây, safety margin5 giây. Worker có capacity2 mặc định; server cũng transaction-reserve slot, không tin capacity do client báo để oversubscribe. Heartbeat gồm session, free slots, runtime health, storage pressure, supported manifest, trạng thái attempt IDs không chứa command output.

### 4. Task envelope và chữ ký

Envelope chứa schema_version, tool_call_id, attempt_id, attempt_no, fencing_token, worker_id/session_id, Project/Run, tool_name, input_json, input_sha256, scope_version_id, grant_id, policy_epoch, target descriptors, image_digest, timeout/resource limits, issued_at/expires_at, policy snapshot và artifact input refs. Không raw secret trong task envelope; credential references chỉ được resolve bằng capability ngắn hạn đúng target.

Payload lease ký Ed25519 JWS bằng installation signing key; worker giữ trusted public key. JSON input canonicalization theo RFC8785 với thư viện đã kiểm tra; server lưu exact canonical bytes. Worker verify signature + hash + audience/session/time + image manifest trước acknowledge. Không tự triển khai crypto/canonicalization tùy hứng. Rotation có key_id, active/retiring public keys, hết overlap task cũ phải reconcile.

Lease là quyền thời gian ngắn cho đúng task, không owner credential. Token không được cho sandbox đọc. Renewal chỉ server cấp sau live grant/session/task/cancel check; snapshot cũ không vượt revoked grant. Thay args tạo logical call/fingerprint mới, không renew task với nội dung khác.

### 5. Trình tự nhận/chạy task

1. Verify envelope và policy compatibility; kiểm tra disk/runtime/network guard health.
2. Lưu journal entry `received` và fsync.
3. ACK accepted theo attempt/fence; server đánh leased→started chỉ khi worker báo actual start (ACK chưa đủ).
4. Tạo sandbox container với label attempt_id/worker_id, cấu hình network/policy đã chuẩn bị; journal `prepared`.
5. Fsync `start_intent` trước start; start container; ghi container ID và observed state.
6. Báo started; stream bounded output chunks có seq; renew lease độc lập.
7. Thu kết quả, dừng/quiesce container/network trước terminal result; upload/finalize artifacts.
8. Submit result digest; chỉ xóa spool sau durable ACK và retention grace.

Nếu server ACK response bị mất, retry cùng ID/digest. Không tạo container mới khi container mang attempt label đã tồn tại. Docker container không được auto-restart sau host boot; daemon reconcile trước khi chạy lại.

### 6. Journal và crash windows

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

### 7. Local watchdog và partition

Worker ghi deadline bằng monotonic clock dựa TTL server trả sau khi trừ round-trip và safety margin. Nếu không renew kịp, ngừng gửi request mới, thu hồi egress token, terminate process group/container, force kill sau grace5 giây. Independent watchdog/reaper phải hoạt động cả khi execution goroutine deadlock; host boot unit dừng orphan sandbox trước nhận task.

Không tuyệt đối tin daemon cooperative là security boundary chống worker host bị chiếm quyền. Worker compromised nằm ngoài bảo đảm tự động; owner phải revoke, isolate host và xem evidence là untrusted. Server không đánh canceled chỉ dựa elapsed45s; đợi worker/reaper acknowledgement hoặc owner xác nhận thủ công có audit.

### 8. Cancel và drain

Heartbeat/renew trả directive `cancel` và reason; lease không gia hạn khi cancel. Worker hủy child process/container/network tokens, flush logs, báo `canceled` với `quiescent=true`. `drain` ngừng claim mới, cho task hiện tại hoàn tất trong limits; không tương đương revoke. `revoke` chặn credential/session ngay và yêu cầu cancel mọi task.

Owner chọn worker cụ thể thì offline không fallback. Owner chọn explicit Project pool thì scheduler chỉ chọn trong pool/zone, policy/data compatible. Active stateful browser session gắn worker; không chuyển sang worker khác chỉ để tăng availability. Sau worker chết, browser state cần session mới và owner biết mất continuity.

### 9. Result contract

Result có attempt_id/fence, status, started_at/finished_at, exit_code nullable, summary bounded, artifact_ids, structured_result, output_truncated, observed_quiescent, effect_observation (`not_started`, `completed`, `unknown`), result_sha256 và worker_session_id. Model không được tự tạo result endpoint.

Server kiểm tra ownership/fence/schema/artifact readiness. Nếu stale, trả409 STALE_FENCE và lưu safe reconciliation record; không mất cơ hội phục hồi evidence nhưng không nhận kết quả như thành công. Result cùng digest trả200 ACK duplicate; khác digest409 RESULT_CONFLICT. Worker không được tự đánh `verified` cho finding; chỉ tạo dữ liệu đầu vào cho validation.

### 10. Acceptance

Hai worker có cùng manifest chạy được cùng bộ task fixture, không phụ thuộc role label. Cắt mạng giữa task và control-plane: watchdog ngừng egress/kill; không có tác vụ replay trên worker2. Restart daemon với một container còn chạy: nhận diện đúng attempt và reconcile. Clone identity phát hiện generation conflict. Token revoked không claim/upload/list metadata mới. Time skew vượt30 giây block claim với CLOCK_UNSAFE, không bỏ signature time validation.

### 11. Chi tiết digest, cấp secret và retransmission

`input_sha256` là SHA256 của exact RFC8785 canonical input UTF-8. `scope_policy_sha256` bind policy_snapshot, `tool_manifest_sha256` bind registry, resource_limits nằm trong signed claims. Worker phải decode JWS và so sánh toàn bộ claims bên ngoài với signed payload; không tin bản claims chưa đối chiếu. Result digest tính JCS của WorkerResult **bỏ field result_sha256** để tránh tự tham chiếu. Timestamp/large counters có representation cố định; Go phải reject integer overflow.

Enrollment/rotation cấp một credential logic; response có thể truyền lại cho cùng request authenticated trong10 phút bằng idempotency cache mã hóa. Không lưu plaintext response secret trong DB/log, không có list/reveal credential sau đó. Điều này làm retry khi mất response khả thi mà không tạo worker/credential thứ hai.

Input artifacts tải qua route attempt-bound với session/fence; worker không được GET artifact bất kỳ chỉ vì biết UUID. Credential capability resolve là route riêng, kiểm tra lại session/attempt/grant/origin trước trả các trường cần dùng cho trusted adapter. Plaintext chỉ ở memory của trusted handler, không task envelope/prompt/log/sandbox env chung; browser form có thể cần giá trị trong browser context, phải ghi nhận residual exposure và giới hạn origin/egress. Capability TTL≤30 giây và không dài hơn lease, không cấp khi lease sắp hết.


---


<a id="file-docs-09-sandbox-tool-execution-md"></a>


*Nguồn: `docs/09-sandbox-tool-execution.md`*


## 09 — Sandbox, tool adapters và giới hạn mạng

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

### 1. Hai profile thực thi, không host shell

**Offline sandbox:** terminal, đọc/ghi file, parse dữ liệu; `network=none`, root filesystem read-only, input mount read-only, output/workspace giới hạn quota. **Scoped web sandbox:** HTTP/browser thao tác qua gateway ràng buộc origin/port/path và grant, firewall chặn mọi egress khác. Cả hai chạy trong runtime cô lập trên worker host do owner kiểm soát.

V1 production profile yêu cầu Docker Engine với `runsc`/gVisor được cấu hình và vượt doctor/tests; Docker có thể tích hợp runtime gVisor theo docs chính thức [SRC10, SRC11]. Không hứa gVisor hỗ trợ mọi syscall/tool; tool incompatibility phải báo UNSUPPORTED_RUNTIME, không tự fallback sang host/runc. Profile lab runc có thể tồn tại chỉ cho fixture offline tin cậy, nhãn rõ và không đạt release gate execution.

### 2. Sandbox cấu hình bắt buộc

Non-root UID/GID cố định; cap-drop ALL; no-new-privileges; seccomp/AppArmor nơi runtime hỗ trợ; PID/memory/CPU/output quota; read-only image; `/tmp` tmpfs bounded; không host PID/network/IPC; không privileged; không mount `/`, `/home`, `/var/run/docker.sock`, cloud credential directory hoặc SSH agent. Image được pin digest và có SBOM/tool manifest. Worker trusted giữ quyền quản lý Docker, sandbox không có quyền đó.

Mặc định task 1 vCPU, memory1 GiB, PID128; browser2 GiB nếu worker capacity đủ; output25 MiB artifact, stdout/stderr tổng1 MiB preview và64 MiB spool. Đây là giới hạn cấu hình ban đầu, phải đo và điều chỉnh trong T30, không lời hứa performance. Vượt memory/time trả trạng thái cụ thể, không retry vô hạn.

### 3. File paths và lifecycle

Logical roots `/inputs` read-only, `/workspace` task/agent-local, `/outputs` export. API nhận path logical và artifact refs, không path host. Normalize theo POSIX, reject NUL, traversal, absolute ngoài roots; chống symlink/hardlink race bằng directory FD/openat-style no-follow và final boundary check. Kiểm tra khi export, không chỉ khi tạo file. Không follow symlink để tải file ngoài sandbox.

Mỗi AgentSession có workspace riêng; child không ghi trực tiếp workspace coordinator. Promote file là tạo artifact có hash/link, không shared mutable mount toàn Project. Cleanup sau ACK+grace, nhưng không purge payload chưa upload thành công. Restart worker không mount lại state vào run khác.

### 4. Tool registry

`catalogs/tools.json` là manifest ban đầu. Mỗi tool có name/version, input/output schema, executor kind, effect class, network profile, timeout, resource caps, replay policy và redaction policy. Server lấy manifest đã pin, worker xác nhận digest giống; model chỉ thấy subset được cho phép trong Run.

Effect classes: `pure`, `sandbox_write`, `external_read`, `external_write`, `destructive`, `unknown`. Risk tier routine/high/forbidden được suy theo registry + normalized operation. Model không có field risk để tự hạ quyền. HTTP method không tự chứng minh không side effect; external_read mặc định vẫn cần reconcile trước replay.

| Tool | Chức năng v1 | Network và replay |
|---|---|---|
| `file.list` / `file.read` | Danh sách/trích xuất file trong roots | Offline; pure, safe khi input hash không đổi |
| `file.write` | Tạo phiên bản file trong workspace | Offline; sandbox_write; idempotent theo content hash |
| `terminal.execute` | Chạy chương trình/script trong sandbox | Offline; unknown/high, không replay outcome mơ hồ |
| `analysis.parse_openapi` | Parse/validate tài liệu, tạo inventory | Offline; pure; không tự gọi endpoint trong spec |
| `http.request` | Request HTTP có cấu trúc, evidence | Scoped web; kiểm tra mỗi request/redirect |
| `browser.navigate` | Mở origin được grant cho phép | Scoped web; stateful, after_reconcile |
| `browser.snapshot` | Screenshot/DOM snapshot | Scoped web; evidence, không grant mới |
| `browser.action` | Thao tác có cấu trúc trên trang | Scoped web; high nếu gửi dữ liệu/thay state |
| `agent.delegate` | Child agent logic giới hạn | Control-plane; không tạo loại worker mới |

`report.render` là application maintenance operation, không tool shell tùy ý cho model. Plugin/MCP tùy ý chưa hỗ trợ v1. Thêm tool phải có ADR nhỏ, schema, fixture, license/SBOM, egress và cancel tests.

### 5. Scoped HTTP adapter

Adapter nhận components chuẩn hóa `scheme`, `host`, `port`, `path`, `method`, bounded headers/body; không chấp nhận raw URL parser tùy ý qua nhiều tầng. Reject userinfo, fragment làm target, backslash, ambiguous encoding hoặc parser disagreement. Canonical host IDNA ASCII lower-case, trim một trailing dot hợp lệ, port explicit/default được chuẩn hóa.

Resolve host bởi trusted resolver; kiểm tra tất cả A/AAAA against policy, không chỉ địa chỉ đầu. Dùng IP đã validate để dial, đồng thời giữ đúng Host và TLS SNI; verify cert upstream. Không resolve lần hai sau check bằng library khác. Redirect disabled mặc định; adapter xử lý từng hop tối đa5, kiểm tra target mới, không chuyển Authorization/Cookie sang origin khác. Proxy env hệ thống bị ignore; không cho target override proxy.

Chặn loopback, link-local, multicast, metadata, control-plane/storage/worker-management endpoints. Private lab target chỉ được phép qua explicit lab grant/zone, không mở toàn private range. IPv4-mapped IPv6 normalize trước compare. TLS lỗi được báo, không tự `insecure_skip_verify`. Các nguyên tắc application + network validation và redirect checking tham khảo OWASP SSRF [SRC06]; quy tắc chi tiết trên là đặc tả redAI.

### 6. Browser và HTTPS proxy: không dùng blind CONNECT làm scope guard

Playwright controller là trusted adapter, page content không tin cậy. Browser sandbox chỉ kết nối tới scoped proxy trên private bridge; firewall deny mọi đường ra trực tiếp, DNS tùy ý, UDP/QUIC/WebRTC egress. Proxy token bind run/session/grant/expiry; token không được page JavaScript đọc. Network interception trong Playwright là lớp phụ, không lớp duy nhất.

Để giới hạn HTTPS theo origin/path trên IP dùng chung, proxy phải terminate TLS phía sandbox với CA ephemeral được cài **chỉ vào browser sandbox**, rồi tạo TLS upstream có verify. Validate CONNECT authority, SNI, Host hoặc `:authority` nhất quán cho mọi request; không cho arbitrary raw tunnel. HTTP2 multiplexed requests phải kiểm tra từng authority/path. Redirect và subresource cùng đi policy. Chặn foreign dependency và hiển thị coverage gap, không tự authorize vì trang nhúng link.

Nếu chỉ triển khai CONNECT passthrough, không chứng minh scope ở lớp HTTP; không được đánh T21/G3 hoàn tất. Nếu certificate pinning hoặc client cert khiến interception không tương thích, báo unsupported/coverage-limited; không bypass. Evidence ghi `transport=inspected_proxy` để owner biết traffic đã đi qua proxy, không giả là capture trực tiếp không biến đổi.

Session cookies ở browser sandbox là dữ liệu nhạy cảm; không export mặc định. Cấm website tải file tự do vào host. Download vào quarantine artifact, không tự mở/chạy. Clipboard, camera, mic, geolocation, local filesystem access mặc định deny. Browser session timeout và lease watchdog dừng mọi background page request khi grant hết hạn.

### 7. Tool cài đặt và nguồn cung ứng

Toolbox build offline/reproducible khi có thể; package download chỉ lúc build/owner maintenance, không lúc model yêu cầu trong run. Pin digest/checksum. Không chạy `curl | sh`, auto apt/pip/npm từ text target. Bản đầu có Python/Node/shell trong sandbox offline để xử lý file nhưng không mount package registry credentials. Danh sách phiên bản tool ghi vào mỗi run manifest.

Không cần cài toàn bộ Kali. Ưu tiên bộ tool nhỏ có use case và parser rõ. Công cụ network bổ sung phải đi typed adapter, không vượt scope proxy bằng terminal network.

### 8. Acceptance bắt buộc

Trong lab, sandbox không truy cập host filesystem, Docker socket, metadata, API owner, DB hoặc Internet không cấp quyền. Browser gọi subresource ngoài scope bị block ngay cả khi JS tạo request/fetch/WebSocket/WebRTC. Hai vhost chia IP vẫn không truy cập vhost không grant. DNS đổi sau validate không đổi địa chỉ dial. Grant revoked giữa phiên browser khiến request tiếp theo bị chặn và task dừng theo lease.

Test process timeout/cancel với child process và background loop; không để zombie. Disk-full không làm worker ghi đè evidence cũ. Image missing/signature mismatch fail closed. Test nền tảng này trên Linux VM thật; mock unit test không đủ chứng minh cô lập.


---


<a id="file-docs-10-authorization-scope-md"></a>


*Nguồn: `docs/10-authorization-scope.md`*


## 10 — Phạm vi ủy quyền và bốn chế độ phê duyệt

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

### 1. Hai lớp quyết định

**Authorization** trả lời hành động có được phép trên tài sản này không. **Approval** trả lời hành động đã được phép có cần owner bấm duyệt ngay trước khi chạy không. Scope denial không thể được biến thành allow bằng Automatic hoặc bằng một nút approve. Xác thực DNS là bằng chứng kiểm soát DNS, không tự xác định quyền đối với mọi hạ tầng được tìm thấy.

Bản đầu dùng `automatic` mặc định để giảm hỏi lại. Owner cấu hình Project một lần, Chat/Agent/worker kế thừa cùng grant còn hiệu lực. Không yêu cầu DNS mới mỗi lệnh, mỗi chat hoặc mỗi worker. Offline tasks dùng local capability policy, không giả có domain grant; envelope scope/grant nullable và network_profile bắt buộc offline khi không có grant.

### 2. Scope representation

Scope version gồm allowed origins/domain rules, ports, path prefixes, methods/action categories, exclusions, allowed network zones và prohibited platform resources. Domain rule `exact` chỉ hostname đó; `subdomains` match nhãn DNS con đúng root và có `include_apex` rõ. Không suffix-match `badexample.test` với `example.test`. Public suffix như `com`, `co.uk` không được dùng làm organizational root.

Private IP/CIDR grants chỉ dành lab đã khai báo rõ, có zone và loại kiểm thử; DNS proof không tự tạo CIDR grant. CDN/shared IP: quyền của hostname chỉ cho tương tác hostname/ứng dụng đó, không scan toàn IP, provider tenant khác hoặc origin backend được đoán. CNAME sang provider là đường phân giải cho hostname authorized, không grant cho hostname đích của provider.

`discovered_assets` không được dùng trực tiếp làm allowlist. UI có thể gợi ý tài sản cần review; chỉ owner API tạo version/grant mới. Dependency tải nội dung bình thường cũng không được tự authorize trong v1; owner có thể ghi explicit allowed origin/use purpose, vẫn không grant test provider infrastructure.

### 3. DNS proof một lần

Challenge tên `_redai-challenge.<root>`; value ngẫu nhiên chứa opaque challenge id/token, không chứa secret khác. Challenge bind installation_id, workspace_id, project_id, root_ascii, requested_version, expires_at. Token tối thiểu256 bit entropy, TTL24 giờ. Resolver đáng tin, timeouts và retry bounded; không chỉ đọc DNS từ chính target trả về HTTP.

Sau verify, lưu timestamp, observed TXT digest, resolver metadata và attestation owner. Không cần TXT ở lại mãi cho mọi run. Proof không tự revoke khi record bị xóa sau verify; owner chịu trách nhiệm phạm vi còn được phép, và hệ thống cung cấp revoke/change review. Khi root thay đổi, owner ghi ownership transfer hoặc grant hết hạn, phải proof/grant mới. Run không tự gia hạn quyền bằng summary chat.

Lab không có DNS dùng `lab_attestation` qua owner UI, exact origins/IP trong private zone. Không dùng lab attestation để cấp quyền wildcard công cộng. Hồ sơ ủy quyền có `valid_until` optional cho công việc cá nhân lâu dài, `revoked_at` có hiệu lực ngay; default không bắt verify lại theo mỗi phiên.

### 4. Policy decision order

Authenticate actor → ensure Workspace/Project closure → check installation hard-deny → check run state/cancel → resolve current grant status/epoch → canonicalize target → apply exclusions trước includes → check action/network zone/tool manifest → check secret/data policy → enforce budget/resource → approval mode → issue signed lease. Worker và proxy kiểm tra lại input digest/policy snapshot/lease trước effect.

Kết quả schema gồm `verdict=allow|ask|deny`, machine reason_code, risk tier, matched_rule_ids, scope_version_id/grant_id, exact fingerprint và human-readable safe rationale. Không chỉ bool. Cache policy theo version/epoch rất ngắn; revoke invalidates cache/renewal. Không live-read chậm khiến proxy cứ dùng grant cached vô hạn.

### 5. Mode matrix

| Hành động | Automatic | Always ask | Ask for high-risk commands | Reject |
|---|---|---|---|---|
| Ask không execution | Cho phép | Cho phép | Cho phép | Cho phép |
| Pure/offline tool trong capability | Chạy | Hỏi | Chạy | Từ chối execution |
| Sandbox write trong roots | Chạy | Hỏi | Chạy nếu routine | Từ chối |
| External read trong grant | Chạy | Hỏi | Chạy nếu routine | Từ chối |
| External write được grant cho phép | Chạy | Hỏi | Hỏi | Từ chối |
| Unknown effect offline trong sandbox | Chạy với limits | Hỏi | Hỏi | Từ chối |
| Scope ngoài grant / hard-deny | Từ chối | Từ chối | Từ chối | Từ chối |
| Destructive/DoS/hạ bảo vệ của platform | Từ chối v1 | Từ chối | Từ chối | Từ chối |

Mode snapshot vào Run. Owner đổi default chỉ ảnh hưởng Run mới; **revoke/narrowing/cancel** là emergency control áp dụng ngay cho Run active. Không cho đổi mode giữa một approval và dispatch để né fingerprint.

### 6. Approval fingerprint và expiry

Fingerprint JCS/SHA256 gồm tool_name/version, normalized input hash, scope_version, grant epoch, worker binding/zone, secret refs/version IDs, resource limits và run_id. Approval một lần có TTL15 phút, người quyết định owner_id, decision time, audit ID. Nếu có thay đổi target/args/secret version/worker identity làm fingerprint khác, request cũ stale.

Approval chỉ cho đúng logical call. Duplicate click trả cùng decision. Approval sau cancel/expiry/revoke reject. Không reusable prefix grant do model tạo. Không để AI reviewer tạo permission mới; v1 dùng deterministic classification, model có thể giải thích nhưng không làm nguồn quyền.

### 7. Revocation và emergency stop

Owner revoke Project grant → tăng policy_epoch, event, stop new dispatch, deny lease renew, revoke proxy capabilities, cancel active affected tasks. Worker revoked tương tự; global emergency stop ngừng mọi dispatch và provider call mới, không xóa data. Server theo dõi stop confirmations; UI không hứa tức thời dừng mọi packet đã gửi hoặc hoàn tác remote state.

Nếu control-plane bị mất kết nối, local watchdog hết TTL phải dừng. Nếu worker host bị kiểm soát trái phép, cryptographic signature không bắt host tuân thủ; cần cô lập/revoke và xem lại evidence. Các giới hạn này phải có trong help UI.

### 8. Test vectors

Fixtures `tests/policy-cases.json` phải bao gồm exact domain, subdomain/apex flags, deceptive suffix, IDNA/case/trailing dot, exclusions, redirect foreign origin, CNAME/shared IP, IPv6/mapped IPv4, private lab allow, metadata hard-deny, revoked/expired grant, Automatic không override deny và Reject vẫn cho Ask. TS policy và Go proxy dùng cùng vectors; khác quyết định là lỗi release-blocking.


---


<a id="file-docs-11-llm-context-privacy-md"></a>


*Nguồn: `docs/11-llm-context-privacy.md`*


## 11 — Model gateway, ngữ cảnh, dữ liệu và ngân sách

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

### 1. Model không bị hard-code theo thương hiệu

Provider config gồm display_name, adapter_kind, base_url, model_id, credential_ref, context_window, max_output_tokens, supports_tools/structured_output/vision/streaming, pricing và allowed_data_modes. V1 có deterministic mock adapter cho test và Chat-Completions-compatible adapter cho endpoint owner cấu hình. Đây là khả năng tương thích cần probe, không bảo đảm mọi endpoint có chữ compatible đều hoạt động. Hợp đồng Chat/tool calling tham khảo API reference chính thức [SRC12].

Không nhúng danh sách giá/model marketing trong mã. Không dùng tài khoản ChatGPT web/session cookie làm backend. Model endpoint mới chỉ owner cấu hình; agent/target content không sửa base_url. Local endpoint có allowlist chính xác; không mở unrestricted SSRF cho URL người dùng nhập trong chat. Provider health dùng prompt synthetic không có Project data.

### 2. Capability probe

Khi lưu config, chạy optional probe với confirmation hiển thị có thể tiêu thụ usage nhỏ: text response, streaming termination, typed tool call giả, structured JSON, cancellation behavior, token usage metadata. Probe không thực thi tool thật. Kết quả timestamps và capability flags, lỗi parse rõ. Nếu Agent yêu cầu tools mà provider không đạt, UI disabled Agent config đó; không tự parse câu văn thành tool execution.

Các model configs có vai trò coordinator/reviewer/summarizer tùy chọn nhưng mặc định một config cho tất cả để đơn giản. Fallback explicit list với data mode tương thích. Refusal không phải trigger để tìm model “bỏ mọi bảo vệ”; owner chọn nhà cung cấp hợp lệ, hệ thống không tự bypass chính sách provider.

### 3. Data modes

| Mode | Dữ liệu gửi model | Ràng buộc |
|---|---|---|
| `local_only` | Chỉ endpoint local do owner approve | Không fallback cloud; DNS/egress allowlist provider riêng |
| `redacted_cloud` | Context chọn lọc + dữ liệu đã che | Mặc định sau setup cloud, có payload preview |
| `cloud_full` | Nội dung Project được chọn, trừ secrets/hard excluded | Owner explicit opt-in, cảnh báo dữ liệu rời installation |

Dù mode cloud_full, master key, API key, cookie session, worker credential, secret value và private key không vào prompt. “Full” ở đây không nghĩa mọi bytes tự động gửi. Owner chọn attachments/context và policy có deny types. Không tuyên bố encryption at rest che dữ liệu khỏi provider khi runtime đã decrypt để gửi.

### 4. Context construction

Layer 1 platform instructions cố định; layer2 Run goal từ owner; layer3 authority snapshot structured chỉ để model hiểu, enforcement bên ngoài; layer4 approved Project notes/files; layer5 recent conversation; layer6 tool/evidence excerpts gắn untrusted label. Mọi source có ID/version/hash/offset, original classification và redaction transform ID. System và owner-authored scope config không lấy từ webpage.

Context budget phân chia: reserved system/goal/policy; completed summary; recent complete message pairs; selected evidence excerpts. Large logs đưa artifact ref + bounded excerpt. File upload không đồng nghĩa đưa toàn bộ vào mọi request. Retrieval dùng full-text Project-bound v1; embeddings không tự bật hoặc gọi external vector API.

### 5. Redaction và secret references

Token hóa ổn định trong phạm vi Run: `[HOST_1]`, `[EMAIL_1]`, `[SECRET_REF_1]`; mapping nằm local và không log. Secret value không cần model biết để gọi adapter; model dùng credential_ref, trusted executor inject đúng allowed origin/header. Authorization/Cookie headers và password input loại bỏ trong previews/log. Query strings/bodies có thể chứa secret nên không chỉ che header.

Không khẳng định regex che hết dữ liệu nhạy cảm. Có explicit field allow/deny, recognizers, owner classification và payload preview. Khi rule không chắc với file nhạy cảm, block cloud route và yêu cầu owner đổi policy/nguồn, không im lặng gửi raw. Mapping pseudonym có thể làm giảm chất lượng model; giữ original domain chỉ trong execution target descriptor mà model tham chiếu ID.

Target có thể phản chiếu secret vào response; cần redact output trước model/logs. Secret canary tests phải kiểm tra nested JSON, base64-like echoes khi detector hỗ trợ, terminal stderr và HTML attribute. Không hứa chống mọi covert exfiltration; bảo vệ chính là không trao secret/egress không cần thiết.

### 6. Prompt injection

Web/file/tool output có thể chứa lời yêu cầu thay chỉ dẫn hoặc gửi dữ liệu. Không xem chúng là authority. Policy/worker enrollment/secret retrieval không nằm trong model tool set. Tool output phải bounded, tagged, không concatenate thành system instruction. Model content action vẫn qua schema/target checks. Review không dùng chính untrusted content làm bằng chứng owner đã cấp quyền. Thiết kế defense-in-depth này dựa trên nguyên tắc prompt-injection prevention của OWASP [SRC07].

Prompt templates riêng của redAI ở `prompts/`; không sao chép prompt HackerAI. Runtime lưu template version/hash cho repro. Không lưu hoặc hiển thị hidden chain-of-thought; UI chỉ công bố concise task status, kế hoạch, tool actions và evidence.

### 7. Chi phí và reservations

Model cost tính theo pricing config version có provenance (manual/official import). Unit `micro_usd_per_million_tokens`. Reservation trước request = conservative input upper bound × input rate + max_output_tokens × output rate + fixed fee nếu có. Làm tròn lên integer microUSD. Nếu không có tokenizer tương thích, reserve theo context cap đã cấu hình thay vì guess thấp. Local provider có thể khai model_api_cost=0 nhưng compute cost chưa đo, UI ghi rõ.

Transaction khóa run budget: `committed_observed + unresolved_reserved + new_reservation <= limit`. Child agents dùng cùng ledger. Response có usage/cost provider thì reconcile với reservation. Response thiếu usage hoặc timeout sau gửi request: reservation trạng thái unknown, vẫn giữ đến đối soát; không refund về0. Failed pre-send có bằng chứng chưa gửi có thể release.

Hạn mức chi phí không phải bảo đảm hóa đơn tuyệt đối khi provider đổi giá, billing metadata chậm hoặc tokenization khác. UI nói “ngân sách kiểm soát theo cấu hình”, ghi overrun nếu thực tế cao hơn reservation; dừng request mới, không giấu phần vượt. Token/output/time caps vẫn enforced độc lập. Không tự tăng run budget vì model muốn tiếp tục.

### 8. Credentials lưu trữ

Secrets mã hóa AEAD bằng key ngoài DB, key ID và nonce ngẫu nhiên mỗi ciphertext; AAD gồm Workspace/Project/secret ID/version. Dùng thư viện chuẩn AES-256-GCM, không tự crypto. Master key nằm secret file mode0600 ngoài git và không cùng plaintext backup. Rotate key bằng rewrap/re-encrypt có journal; không xóa key cũ trước xác minh toàn secret đã đổi.

Secret refs bind Project và allowed origin/use purpose. API không có read-secret-value chung cho Agent. UI cho replace/delete, reveal owner có re-auth và audit nếu thực sự cần; v1 có thể không có reveal để giảm bề mặt. Worker token khác model/target secret, không dùng chung.

### 9. Acceptance

Payload-capture mock endpoint chứng minh local_only không ra cloud, redacted_cloud không chứa canary, fallback không vượt data policy. Structured output thiếu required field không dispatch tool. Unknown usage không giảm reserved total. Provider config đổi trong Run không âm thầm đổi model snapshot; runtime vẫn kiểm tra emergency revoke config live. Template injection fixture không thể tạo policy mutation hoặc đọc secret.


---


<a id="file-docs-12-findings-evidence-reports-md"></a>


*Nguồn: `docs/12-findings-evidence-reports.md`*


## 12 — Finding, bằng chứng, báo cáo và retest

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

### 1. Kết quả sản phẩm không chỉ là text chat

Một kết luận phải có provenance tới Run, ToolCall/Attempt, worker identity, tool/image version và bytes evidence. Chat chỉ hiển thị liên kết tới domain entity, không copy status vào text rồi dùng text làm nguồn thật. Finding do model tạo là candidate mặc định.

### 2. Artifact và evidence

Artifact metadata: id, Workspace/Project, kind, media_type, byte_size, SHA256, storage_key, created_at, source actor/tool/attempt, classification, original_artifact_id optional, redaction_transform_id optional và lifecycle pending/ready/quarantined/deleting/deleted. Payload immutable khi ready. Các bằng chứng HTTP gồm method/origin/path redacted, timestamps, status, bounded request/response body refs, header redaction và transport metadata. Screenshot cần URL logical, viewport, captured_at, browser/tool version.

Trusted API tính hash bytes nhận được, không tin hash do worker khai. Worker compromised vẫn có thể gửi bytes giả; hash và provenance là khả năng truy vết, không độc lập chứng minh target thật. Manifest ký installation key có thể thêm authenticity của export, nhưng không thay review kỹ thuật.

### 3. Finding fields

Title, summary, affected_asset_id/origin, category/CWE optional, severity, severity_rationale, confidence, verification_status, remediation_status, impact, observed_behavior, expected_behavior, safe reproduction description, remediation, evidence_refs, limitations, source_run_id, created_by, version. Không bắt CVSS ở v1; khi thêm score phải lưu vector/version/rationale, không lấy severity thành score tùy ý.

Reproduction mô tả những gì đã quan sát trong công việc được phép, không tự tạo payload/khai thác khi chưa thực thi. Template report có chỗ “Chưa xác minh” rõ. Finding không có evidence link vẫn có thể candidate, nhưng chuyển verified phải có ít nhất một artifact ready thuộc cùng Project và reviewer/result đủ tiêu chí.

### 4. Verification gate

Validate evidence tồn tại, hash khớp, source attempt có terminal known state và target match. Kiểm tra nhận định có được evidence hỗ trợ hay chỉ model đoán. Agent reviewer có thể trả proposed verdict verified/rejected/inconclusive cùng rationale và evidence IDs. Policy nghiệp vụ kiểm tra schema/provenance trước lưu; owner vẫn có nút accept/reject/edit và history.

Đối với high/critical finding, v1 yêu cầu owner confirm trước xuất như “verified bởi owner”; technical auto-verification có label khác. Không dùng confidence high thay owner review. Owner manual finding phải khai source_external và upload evidence; không gán fake tool call.

### 5. Dedup

Fingerprint gợi ý từ Project, normalized asset/origin, category, location và normalized title key. Fingerprint không unique tuyệt đối để không merge hai lỗi khác. UI gợi ý duplicate; owner chọn merge/split. Merge giữ mọi evidence/history và link supersedes; không xóa finding gốc không thể truy ngược. Hai runs cùng endpoint nhưng bản build khác có observed_at và target_version để phân biệt.

### 6. Report snapshot

Owner chọn Project, Run(s), finding versions, ngôn ngữ, classification và bao gồm raw evidence hay không. Server tạo report snapshot immutable chứa input version IDs, coverage, scopes, template version và generator version trước render. Renderer deterministic trong mức có thể: timestamp dùng snapshot time, ID/name stable, sort explicit. Output Markdown, JSON và HTML offline; không external CSS/font/CDN/scripts. HTML sanitize, escape target content; evidence link relative trong bundle.

Các mục report: executive summary; mục tiêu/phạm vi/ủy quyền; phương pháp ở mức công việc thực tế; môi trường/công cụ/phiên bản; coverage đã làm/chưa làm; findings theo trạng thái; limitations; remediation; retest; evidence index/hash. Không gắn nhãn “pentest đầy đủ” nếu chỉ check subset. Khi không có verified finding, câu mẫu: “Không có phát hiện được xác minh trong phạm vi thao tác đã ghi nhận; kết quả không loại trừ vấn đề ngoài coverage.”

### 7. Retest

Tạo Run mới `kind=retest`, link finding_version và baseline evidence. Dùng grant/current target config mới, không reuse grant đã revoked. Kết quả observed_fixed/still_present/inconclusive, evidence mới, thời điểm và build/version nếu owner có. Có thể giữ finding verified lịch sử nhưng remediation fixed hiện tại. Nếu lỗi không tái hiện do thiếu quyền đăng nhập, đổi route hoặc timeout, inconclusive.

### 8. Export/import Project

Bundle ZIP gồm manifest.json, Project metadata redacted, scope snapshots inactive, chats selected, finding versions, reports và payloads theo artifact ID/hash. Không secrets, sessions, worker credentials, live enrollment token hoặc provider key. Archive paths chỉ server tạo; import reject absolute paths, traversal, symlink entries, decompression bomb, quá quota và duplicate manifest IDs.

Import validate manifest schema + all hashes trước commit; staging, remap UUID, preserve external_source_id, grants disabled và worker binding unset. Owner xem summary số files và quyền cần thiết trước activation. Import không chạy scripts/macros, không cho target content tạo task. Nếu thiếu payload, import partial chỉ khi owner chọn rõ, status evidence_missing chứ không ready.

### 9. Acceptance

Editing title không đổi evidence hash. Report snapshot không thay khi finding sau đó sửa. Verified không artifact bị reject. Report HTML có text từ target chứa script không chạy. Export/import không giữ quyền worker/grant. Retest target timeout không marked fixed. Raw secret canary không vào report preview hoặc default export.


---


<a id="file-docs-13-identity-settings-md"></a>


*Nguồn: `docs/13-identity-settings.md`*


## 13 — Owner identity, cấu hình và bảo vệ tài khoản

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

### 1. Một owner vẫn phải có authentication

Self-host một người không nghĩa tất cả request LAN đều tin cậy. V1 không signup hoặc mời thành viên. Owner bootstrap một lần qua CLI local; owner row unique singleton, Workspace tự tạo. Password nhập qua secure stdin, không command argument. Recovery code 256-bit random, hiển thị một lần, lưu hash; mất password dùng CLI tại host để reset và revoke sessions.

Password hashing dùng Argon2id, mức khởi điểm memory64MiB, iterations3, parallelism1; benchmark latency trên control-plane và không thấp hơn hướng dẫn OWASP hiện hành [SRC09]. Salt random riêng. Không encryption reversible cho password. Không password default hoặc bootstrap “admin/admin”.

### 2. Session

Opaque random256-bit token; DB chỉ SHA256/HMAC hash. Cookie HttpOnly Secure SameSite=Strict Path=/, tên prefix `__Host-` khi HTTPS; không Domain attribute. Idle timeout12 giờ, absolute7 ngày; login/password change rotate session. Logout revoke server-side, không chỉ clear cookie. CSRF token gắn session, Origin allowlist; session endpoint trả safe owner profile và CSRF token qua same-origin response. OWASP session guidance là nguồn nguyên tắc [SRC08].

Rate limit login theo installation/account + IP đã canonicalize, ví dụ5 failed/5 phút và exponential delay capped, không khóa vĩnh viễn tự tạo DoS. Không tin X-Forwarded-For khi request không từ trusted reverse proxy. Audit failed login metadata không mật khẩu. UI generic invalid credentials.

### 3. Worker authentication tách biệt

Worker bearer không đăng nhập owner UI, không đọc Project tùy ý, không sửa settings. Scope route worker chỉ attempt/binding server giao. Long-lived credential rotate và revoke theo tài liệu08. Enrollment token không worker token. Browser không hiển thị full credential sau enroll. Không nhúng bearer vào URL để tránh access log.

### 4. Settings groups

**Models:** configs, key refs, capability probe, prices, data modes. **Workers:** display/zone/capacity/drain/revoke, bindings. **Privacy:** default mode, log retention, artifact classifications, export policy. **Limits:** run steps/time/cost, concurrency, upload/storage caps. **Security:** password change, sessions list/revoke, emergency stop, key health. **Appearance:** theme, language, timezone. **Operations:** backup destination/config, schedule chưa tự bật v1, restore instructions.

Settings thay đổi có revision/If-Match, validation server và audit. Environment variables chỉ bootstrap/hạ tầng, không nguồn settings bí mật cạnh tranh với DB. Precedence: immutable security floors → deployment config → owner defaults → Project settings → Run snapshot trong giới hạn. Không để query parameter mở quota hoặc disable policy.

### 5. Secret ACL

Secret thuộc Workspace và optional Project; target credentials Project-bound, model key Workspace-bound nhưng chỉ runtime/provider adapter dùng. UI metadata chỉ name/type/created/last_used; không raw value. Replace tạo secret version, cũ retiring cho đang dùng theo policy; emergency revoke có hiệu lực ngay và hủy capability. Ciphertext/AAD binding chống di chuyển secret row qua Project để decrypt sai context.

Capability retrieval phía worker dùng attempt/fence/live grant và allowed origin. Không API “get all secrets”. Short-lived transport credentials không được ghi vào task input log. Terminal offline không nhận target credential mặc định; chỉ HTTP/browser trusted adapter nhận subset cần thiết.

### 6. Exposure defaults

Proxy bind loopback hoặc private interface theo owner explicit configuration, không auto mở firewall/router port. Production HTTPS ngay cả private tunnel. App không gửi telemetry ra ngoài mặc định. CSP và headers được triển khai theo UI thực; không tắt CSP để render target HTML. API size/time limits, request ID sanitization, structured logging redacted. Backup/recovery/key files không nằm trong directory static web.

### 7. Acceptance

Không thể tạo owner thứ hai qua request race. Cookie session không đọc từ JS. Foreign Origin mutation fail, worker bearer gọi owner route fail. Password reset revoke mọi session và CSRF. Settings conflict không silent overwrite. Key thiếu sau restart báo locked/secret unavailable, không tạo key mới và mất khả năng decrypt dữ liệu cũ.


---


<a id="file-docs-14-deployment-operations-md"></a>


*Nguồn: `docs/14-deployment-operations.md`*


## 14 — Triển khai, nâng cấp và khôi phục

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

### 1. Hai profile, không triển khai cloud bắt buộc

Development profile có PostgreSQL, API/runtime/web, deterministic mock provider, fixture lab; bind localhost, không target ngoài lab. Personal production profile có HTTPS reverse proxy, owner auth, model do owner cấu hình, persisted data volumes, worker Linux/gVisor đạt doctor, network isolation và backup. Profile mock phải hiện rõ và không được coi là release cho công việc thật.

Gói tài liệu cung cấp `ops/config.example.env` và `ops/deployment-checklist.md`; coding agent phải tạo Compose/systemd/scripts thật trong T28. Không có compose app runnable được giả tạo bằng image chưa build.

### 2. Startup order và readiness

PostgreSQL healthy → migration job → API/runtime → web → proxy routing → worker enrollment/session. Readiness API kiểm tra DB/schema/key/storage mount; readiness runtime kiểm tra lease/reconciliation loops; worker doctor kiểm tra runtime, image digest, clock, disk, DNS/proxy guard. Liveness không gọi provider trả phí hoặc target thật. Provider health phân tách với control-plane availability.

Chưa migrated đúng schema thì không nhận mutation mới. Missing encryption key khóa các chức năng secret, không tự tạo key mới. Storage readonly/full chặn upload/task cần artifact, UI vẫn báo tình trạng. Worker không ready nếu gVisor/proxy guard fail; không degrade silently.

### 3. Cấu hình và secret files

`.env` không chứa production master key trực tiếp nếu có thể; dùng `_FILE` paths, mode0600, owner OS user riêng. Tách `DATA_ROOT`, `STATE_ROOT`, `KEY_ROOT`, backup destination. Không mount KEY_ROOT vào worker sandbox. DB user API/runtime không superuser; migration role riêng; worker không biết DB DSN. Reverse proxy chỉ exposes app/worker HTTPS, DB local/private.

Owner tạo keys qua CLI dùng crypto RNG. File sample không có key hợp lệ, chỉ placeholders rõ ràng; bootstrap từ chối placeholder values. OCI images và packages pin digest/version trong dependency baseline, không `latest`.

### 4. Nâng cấp

Backup đã xác minh → drain new runs → chờ hoặc cancel active external tasks có acknowledgement → deploy additive migration → API/runtime compatible version → web → workers theo protocol compatibility → smoke lab → un-drain. Không upgrade bằng xóa volumes. Old worker missing required policy fields bị block claim, không được nhận envelope rút gọn.

Rollback code chỉ khi schema backward-compatible; migration destructive rollback theo restore/runbook, không phỏng đoán. Run có checkpoint version cũ cần migration explicit hoặc settle trước upgrade. Preview/test môi trường dùng keys/data khác, không copy worker identities.

### 5. Backup nhất quán cho personal v1

Chọn **quiescent backup** để dễ chứng minh tính nhất quán giữa DB và local ObjectStore. Owner yêu cầu backup job; system ngừng mutation mới, drain/cancel active runs tới quiescent, chờ artifact finalize; không ép freeze khi còn unknown external effect. Ghi snapshot manifest gồm schema/app version, event cursor, DB dump checksum, artifact inventory/hash và key IDs cần có.

Tạo PostgreSQL custom-format dump; công cụ pg_dump tạo backup DB theo docs PostgreSQL [SRC13]. File store phải snapshot/copy theo đúng DB inventory khi writes đã dừng; một pg_dump riêng không backup được file payload ngoài DB. Secrets giữ dạng ciphertext, keys backup qua kênh riêng được mã hóa với recovery key owner giữ. Không backup API sessions/worker credentials như trạng thái tự kích hoạt: restore luôn revoke chúng.

Mã hóa archive bằng công cụ được duy trì và authenticated encryption; không ZIP password yếu tự chế. Tạo checksum archive và thử đọc manifest. Chỉ báo “Backup verified” khi đã giải mã/validate archive và hash sample/all theo cấu hình; chỉ upload object thành công là “Backup created”, chưa verified. Sau khi hoàn tất hoặc fail có cleanup rõ, bỏ maintenance lock an toàn.

### 6. Restore drill

Máy sạch, cùng hoặc version hỗ trợ migration; network thực thi bị disable. Verify archive/authentication/hash trước unpack, reject traversal. Restore DB/file inventory/keys, chạy migrations cần thiết trong maintenance. Revoke owner sessions, worker credentials/enrollment tokens và run leases; mọi active run trước backup chuyển needs_attention/restore_suspended, không tự phát hành lại tool. Owner login qua recovery/bootstrap recovery flow, re-enroll workers và review grants.

Chạy consistency checker: mọi artifact ready có bytes/hash, FK/domain closure, no active stale lease, no duplicate cursor, secret decrypt canary thành công. Restore thiếu key phải báo secrets_locked, không xóa ciphertext. Chỉ bật execution sau lab smoke và owner explicit acknowledgment.

### 7. RPO/RTO mục tiêu

Mục tiêu tham chiếu: owner thực hiện backup tối thiểu hằng ngày khi có công việc mới, RPO24 giờ với lịch này; restore dataset lab10GiB trong60 phút trên cấu hình test. Đây là mục tiêu kiểm thử và quy trình owner, chưa có automation tự chạy trong sản phẩm, không SLA. Nếu chưa đo restore10GiB, report “chưa benchmark”, không điền số đạt.

### 8. Sự cố và ứng phó

Provider down: giữ queue/checkpoint, không đổi data policy. DB down: không dispatch mới; worker lease hết sẽ dừng; restore control-plane rồi reconcile. Disk full: block task mới, dừng spool trước OOM/full host, không purge evidence chưa ACK. Worker suspect: revoke credential, isolate host, quarantine new evidence, rotate target secrets có thể bị lộ. Master key suspect: emergency stop, rotate credentials/key với backup, audit access.

SSE down chỉ ảnh hưởng quan sát, không tự restart Run. Owner đóng trình duyệt không dừng Agent. API restart không được xóa worker identity hoặc pending approval. Emergency stop endpoint vẫn cần owner auth, có CLI local emergency command khi web không sẵn.

### 9. Bàn giao vận hành

Phải có lệnh/scripts thật: bootstrap, doctor, backup, verify-backup, restore, migrate, reconcile-artifacts, emergency-stop, rotate-worker-token. Các lệnh destructive có dry-run và confirmation cụ thể. Script backup trả exit code khác0 nếu verify fail; không dùng `|| true` che lỗi.

Tài liệu triển khai cần ghi OS/kernel/runtime versions đã test, tài nguyên, ports, mount permissions, nơi logs và recovery keys. Không gọi “one-click install” nếu vẫn cần chỉnh thủ công mơ hồ. T28/T31 phải chạy drill trên fresh environment và lưu kết quả trong release evidence.

### Phân biệt backup hệ thống và Project export

Backup toàn bộ installation được ghi trong maintenance job nhưng không gắn với artifact của một Project: `project_id` và `artifact_id` của job backup có thể null. File backup nằm dưới backup root riêng, chỉ qua admin operation; không qua artifact download/tool filesystem thông thường. Project export thì phải gắn Project/Workspace và kiểm tra quyền như mọi artifact. Không tạo artifact "toàn hệ thống" giả dưới Inbox để bỏ qua ranh giới dữ liệu.


---


<a id="file-docs-15-testing-evaluation-md"></a>


*Nguồn: `docs/15-testing-evaluation.md`*


## 15 — Chiến lược kiểm thử và đánh giá Agent

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

### 1. Tách ba loại bằng chứng

**Contract validation** chứng minh schema/DDL/refs hợp lệ về cấu trúc. **Application tests** chứng minh code xử lý use case/race theo đặc tả. **Execution lab tests** chứng minh sandbox/mạng/cancel thực sự hoạt động trên Linux/runtime đã chọn. Không lấy loại đầu thay cho hai loại sau. Gói đặc tả hiện chỉ được kiểm tra theo báo cáo `VALIDATION_REPORT.md`, không có kết quả thực thi sản phẩm.

### 2. Test pyramid

Unit tests cho domain transition, normalization, policy, money arithmetic, context construction và redaction. Integration tests dùng PostgreSQL thật/Local ObjectStore thật, không mock repository khi kiểm tra transaction/constraint. Contract tests dùng cùng fixture cho TypeScript và Go. E2E dùng browser thật với API/runtime thật và mock model deterministic. Execution suite dùng worker Linux thật với gVisor, network lab và fake targets; không mục tiêu ngoài phạm vi.

Mock model phải scripted: lượt1 tạo plan/tool call, lượt2 đọc result, lượt3 candidate/summary; có variant malformed JSON, duplicate provider_tool_index, timeout, refusal, partial stream và unknown usage. Không dùng output stochastic của LLM thật để quyết định CI pass cơ bản. Live-model eval là suite opt-in riêng có budget cap.

### 3. Các test nhóm core

AUTH: singleton owner race; password reset revokes; CSRF; session expiry; worker bearer không có owner privileges. DATA: composite FK closure; revision conflict; scope immutable; artifact immutable; Project delete batch resume. API: strict schema/unknown fields; body caps; idempotency duplicate/inflight/body conflict; cursor/filter mismatch. SSE: commit-order inversion simulation, duplicate delivery, slow client, disconnect, cursor purge, snapshot/replay race.

RUN: two runtimes same run; stale fence; model output before commit; restart every boundary; maximum active run; paused/expired lifecycle; child budgets shared. WORKER: envelope tamper; stale session; expired lease; duplicate result; conflicting result; disk full; journal crash; no replay after network effect; manual selected worker no fallback.

### 4. Security execution tests

Filesystem: traversal, symlink at export, unsafe archive paths, host mount absence, no Docker socket. Network: direct egress denied; loopback/metadata/control-plane denied; IPv6 path blocked consistently; DNS rebind; redirect chain; two virtual hosts same IP; hostile browser page requests foreign origin; QUIC/WebRTC attempts; proxy failure means deny. Auth: target content cannot access worker bearer, target secret limited origin. TLS upstream invalid cert fails, browser pinning unsupported flagged.

Chỉ đưa payload fixture tối thiểu để chứng minh policy, không cần xây exploit thực tế. Lab endpoints có thể ghi request counter và harmless side-effect counter để phát hiện duplicate POST. Tests không gửi traffic tới production/company domains. Bất kỳ test tạo tải đều bounded và chỉ fixture-local.

### 5. Chaos matrix và kết quả mong đợi

| Fault injection | Kết quả bắt buộc |
|---|---|
| Kill API sau create-run commit trước response | Retry cùng key trả run cũ |
| Kill runtime trước tool-call commit | Không worker task nào được chạy |
| Kill runtime sau tool-call commit | Phục hồi dùng call cũ |
| Hai runtimes gọi model cạnh tranh | Chỉ fence còn sống commit; usage lặp được ghi nhận |
| Kill worker sau container start | Reconcile container label, không start container khác |
| Drop result ACK | Result retry dedup, một authoritative effect record |
| Lease hết trong HTTP mutation | Watchdog ngừng, server unknown nếu chưa xác định; không replay |
| Revoke grant khi browser background request | Request tiếp theo denied, cancel tracking giữ chính xác |
| DB down lúc renewal | Không phát hành lease mới, worker local expiry |
| Disk full lúc evidence upload | Artifact không ready giả, tool evidence_missing/fail |
| Backup khi active task ambiguous | Không tuyên bố consistent backup complete |
| Restore active run snapshot | Needs_attention/restore suspended, không tự chạy tiếp |

### 6. Đánh giá chất lượng nhận định

Dataset lab tối thiểu20 tình huống:8 có vấn đề cấu hình quan sát được,8 negative gần giống,4 không đủ dữ liệu/không truy cập được. Dữ liệu ground truth phải owner/reviewer kiểm tra độc lập; model không sinh cả đề và nhãn rồi tự chấm. Không dùng số này làm benchmark thị trường.

Đo finding precision/recall khi ground truth phù hợp, false-positive count, tỷ lệ evidence_supported, unsupported verification claims, task_completion, coverage completeness, median/p95 latency và measured/unknown cost. Inconclusive là một lớp kết quả có ích, không luôn tính như failure. Precision có mẫu nhỏ phải hiển thị numerator/denominator, không chỉ phần trăm đẹp.

Release gate bắt buộc:0 scope bypass;0 secret canary leak trong fixture;0 verified finding thiếu evidence;0 duplicate unsafe side effect do auto replay trong suite. Chất lượng model trên lab cần owner review và lưu nhận xét; không tự chọn ngưỡng90% rồi giả đã đạt. Các ngưỡng độ chính xác định lượng chỉ được chốt sau có baseline thật.

### 7. Performance target, không benchmark đã có

Trên cấu hình lab tham chiếu tài liệu04: API CRUD p95≤500ms khi không tính provider/upload; event visible p95≤1s sau commit;10.000 messages có pagination không tải toàn bộ;1.000 timeline rows không làm composer lag rõ. Hai active Runs và hai workers có thể chạy fixture đồng thời không oversubscribe. Đo UI bằng tooling, không dùng cảm giác hoặc synthetic mock page khác component thật.

Các target có thể cần điều chỉnh sau benchmark; nếu không đạt, ghi numbers/hardware và ADR thay đổi chứ không sửa report thành “đạt”. Không target latency cho LLM provider ngoài quyền kiểm soát mà không tách riêng.

### 8. CI mục tiêu

Stage contracts → lint/typecheck → unit → DB integration → Go race tests → browser E2E → security lab trên runner chuyên biệt → build/SBOM. Không mọi PR cần live-model eval. Integration DB lên/down bằng isolated test database; migration fresh và upgrade path đều test. Network policy suite chỉ runner Linux đã chuẩn bị, job không có production credentials.

CI report ghi lệnh, git commit, versions, test count, skipped tests và artifacts. Flaky test được quarantine có owner/issue, không âm thầm bỏ khỏi release gate. Coverage là chỉ dấu tìm vùng chưa test, không yêu cầu tỷ lệ cao để thay việc test invariants.


---


<a id="file-docs-16-threat-model-md"></a>


*Nguồn: `docs/16-threat-model.md`*


## 16 — Threat model và giới hạn bảo đảm

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

### 1. Assets và trust boundaries

Assets quan trọng: model/target credentials, worker tokens, owner session, source files, raw evidence, Project scope, installation signing/master keys, worker host, network của owner và hóa đơn model. Trust boundaries: browser↔API, API↔DB/storage, runtime↔provider, control-plane↔worker, worker↔sandbox, sandbox↔proxy↔target, export↔import.

Owner và host administrator được tin về ý định cấu hình nhưng vẫn có thể mắc lỗi. Model, website đích, uploaded document, package/plugin từ Internet và sandbox process không tin cậy. Worker daemon là trusted component nhưng có thể bị compromise; provenance của worker bị compromise phải được đánh dấu xem xét lại.

### 2. Threat register

| ID | Threat | Control bắt buộc | Bằng chứng kiểm thử |
|---|---|---|---|
| TH01 | Target prompt injection cấp quyền mới | Authority ngoài model; typed tools; live policy | Hostile content fixture không tạo grant |
| TH02 | Agent shell lấy dữ liệu host | No host mounts/socket; sandbox runtime | Filesystem/network lab |
| TH03 | Task giả hoặc sửa args | TLS, worker auth, signed envelope/input hash | Signature tamper fixture |
| TH04 | Worker credential bị dùng ở máy khác | Stable identity + session generation, revoke | Clone identity test |
| TH05 | Domain scope biến thành shared IP authorization | Origin-aware proxy, no raw network v1 | Hai vhost cùng IP |
| TH06 | DNS rebind/redirect bypass | Validate+pin dial, each redirect check | Resolver/redirect lab |
| TH07 | Replay side effect khi mất ACK | Durable journal, idempotent result, unknown reconcile | Harmless POST counter |
| TH08 | Scope grant revoked nhưng run tiếp tục | Live epoch checks, no renewal, watchdog | Revoke during browser traffic |
| TH09 | Secret vào provider/log/report | Secret refs, redaction, payload filter | Canary suite |
| TH10 | File upload/export traversal | Logical roots, no-follow, archive validation | Symlink/archive tests |
| TH11 | CSRF/LAN attacker điều khiển owner | Session/Origin/CSRF/TLS | Foreign origin tests |
| TH12 | Finding giả/unsupported confidence | Evidence ready+provenance gate, owner review | Missing artifact negative |
| TH13 | Budget runaway qua child agents | Shared reservations, limits, unknown held | Parallel child budget test |
| TH14 | Backup chỉ DB mất file hoặc khóa | Quiescent manifest backup, restore drill | Fresh-machine restore |
| TH15 | SSE sequence race bỏ event | Commit-ordered counter transaction | Commit inversion integration test |
| TH16 | Output flood/zip bomb/disk full | Hard caps, backpressure, quarantine | Bounded stress fixtures |
| TH17 | Tool supply chain | Pinned versions/digests, SBOM, no install-at-run | Build provenance review |
| TH18 | LLM endpoint config trở thành SSRF | Owner-only endpoint allowlist, no chat override | Provider route tests |

### 3. Những điều thiết kế không hứa

Không chống được host root cố ý phá nền tảng; không bảo đảm model không bị ảnh hưởng bởi mọi prompt injection; không xác minh pháp lý quyền chỉ bằng DNS; không bảo đảm upstream provider không giữ dữ liệu ngoài hợp đồng của họ; không cam kết rollback remote side effect; không exactly-once execution xuyên mạng; không xác minh tính chân thật bằng hash đơn thuần.

“Không hứa” không phải bỏ kiểm soát. Phải giảm blast radius, ghi nhận uncertainty, fail closed khi mất guard và cung cấp owner controls. Bản production phải nêu residual risks trong help/release note, không gắn nhãn “enterprise-grade” chưa được kiểm chứng.

### 4. Incident response tối thiểu

Emergency stop → revoke affected worker/provider/secret capabilities → cô lập host nghi vấn → giữ evidence/audit liên quan có hash → rotate credentials → phục hồi từ known-good state → chạy consistency/security lab → owner chủ động bật execution. Không purge log chứng cứ chỉ để hết cảnh báo. Không log raw credential trong incident report.

### 5. Review trước mở rộng

Raw TCP, remote MCP, shared users, cloud sandbox, public sharing và auto scheduled runs đều đổi trust model. Bắt buộc ADR + abuse cases + auth/scope/retention tests trước khi thêm. Không coi extension chỉ là thêm một icon/tool description.


---


<a id="file-docs-17-observability-errors-md"></a>


*Nguồn: `docs/17-observability-errors.md`*


## 17 — Quan sát hệ thống, mã lỗi và chẩn đoán

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

### 1. Correlation

Log structured gồm timestamp, level, service, version, request_id, workspace_id, project_id optional, run_id, agent_step_id, tool_call_id, attempt_id, worker_id, fencing_token và reason_code. ID lấy từ server/validated input, không raw user string tùy ý. Trace xuyên HTTP/model/worker theo correlation IDs, không chèn target hoặc secret vào span name.

Metadata diagnostic khác raw task transcript. Diagnostic logs không chứa prompts, full command, payload, target credentials, cookie, file body hoặc evidence raw. Owner có thể xem raw artifact qua authenticated evidence UI riêng; hành động đó được audit. Không external telemetry mặc định.

### 2. Metrics có ích

Active/queued runs; state transition count; task lease expiry; unknown outcomes; duplicate result ACK; stale-fence rejects; pending approvals age; worker heartbeat age; provider requests/error/latency; tokens observed/usage unknown; budget reserved/spent; artifact finalize failures; storage free bytes; SSE reconnect/buffer overflow; backup created/verified age. Không high-cardinality target URL/user prompt làm label.

Phân biệt provider latency với queue startup; tool runtime với artifact upload. Run total gồm chờ approval phải phân tích riêng active time. Không lấy metric thiếu completion events để kết luận mọi run nhanh.

### 3. Error catalog

| Code | HTTP/Domain | UI và recovery |
|---|---|---|
| `AUTH_REQUIRED` | 401 | Đăng nhập lại, không mất draft |
| `CSRF_INVALID` | 403 | Tải session token mới; không replay mutation không idempotent |
| `REVISION_CONFLICT` | 409 | Hiển thị version mới để owner đối chiếu |
| `IDEMPOTENCY_CONFLICT` | 409 | Không retry với body khác cùng key |
| `REQUEST_IN_PROGRESS` | 409 | Retry cùng key sau delay bounded |
| `ACTIVE_RUN_EXISTS` | 409 | Mở run hiện có |
| `SCOPE_DENIED` | 403/domain blocked | Nêu mục tiêu ngoài grant; owner chỉnh Project nếu có quyền |
| `GRANT_REVOKED` | 403/domain blocked | Dừng, không tự verify lại |
| `APPROVAL_EXPIRED` | 409 | Tạo approval mới khi action còn phù hợp |
| `APPROVAL_STALE` | 409 | Thông báo fingerprint thay đổi |
| `WORKER_UNAVAILABLE` | 503/waiting_worker | Giữ worker được chọn, có reconnect |
| `STALE_FENCE` | 409 | Worker reconcile, không resend effect |
| `RESULT_CONFLICT` | 409 | Quarantine/review integrity |
| `EFFECT_UNKNOWN` | needs_attention | Owner xem evidence/reconcile, không blind retry |
| `PROVIDER_UNAVAILABLE` | 503/run fail | Retry same permitted config theo policy |
| `MODEL_OUTPUT_INVALID` | run failed | Giữ partial text, không dispatch tools |
| `DATA_POLICY_DENIED` | 403/domain blocked | Chọn local/nguồn phù hợp, không fallback cloud |
| `BUDGET_EXHAUSTED` | run blocked | Hiển thị reserved/observed/unknown |
| `CONTEXT_LIMIT` | run partial/blocked | Giữ history; owner thu hẹp mục tiêu |
| `LOOP_DETECTED` | run partial/blocked | Tóm tắt không tiến triển |
| `STORAGE_FULL` | 507/domain blocked | Dọn bằng owner policy, không xóa tự động evidence |
| `ARTIFACT_HASH_MISMATCH` | 422 | Quarantine file, upload lại |
| `EVENT_CURSOR_EXPIRED` | 410 | Snapshot+replay, không chạy lại Run |
| `RUNTIME_GUARD_UNAVAILABLE` | 503/domain blocked | Doctor runtime/proxy, không downgrade |
| `CLOCK_UNSAFE` | 409 worker | Sửa đồng hồ, không bỏ check expiry |
| `UPGRADE_REQUIRED` | 426 worker | Cập nhật compatible version |

### 4. Diagnostics export

Owner tải bundle logs safe/config versions/health/manifest, không secrets/evidence mặc định. Trước export hiển thị phạm vi và warning có thể chứa metadata nhạy cảm. Redaction applied, checksum manifest. Không tự upload diagnostics lên dịch vụ bên ngoài. Error IDs cho phép tìm trace nội bộ mà không phơi dữ liệu trong screenshot.

### 5. Alerts cá nhân

UI banner khi backup chưa verified, key missing, disk dưới ngưỡng, worker revoked, unknown effect hoặc provider budget blocked. Không tích hợp email/Telegram scheduler v1; owner tự đọc Operations. Không gọi cloud monitoring chỉ để đánh dấu app healthy. Alert thresholds và units trong config/schema, không rải magic numbers qua components.


---


<a id="file-docs-18-release-acceptance-md"></a>


*Nguồn: `docs/18-release-acceptance.md`*


## 18 — Release gates và định nghĩa hoàn tất

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

### 1. Các mức hoàn thành

Prototype chứng minh UI hoặc một luồng; developer alpha có persistence/mocks; personal release có worker thật, scope/network tests, recovery và owner acceptance. Chỉ mức cuối được gọi redAI Personal v1 sử dụng thật. Các `MUST` trong đặc tả và gate dưới đây là điều kiện release; SHOULD không bắt buộc nếu được ghi rõ ở release notes.

### 2. G0–G7

| Gate | Điều kiện | Evidence phải lưu |
|---|---|---|
| G0 Contracts/baseline | Dependency pin, JSON/OpenAPI hợp lệ, DDL apply DB thật, shared fixtures TS/Go | Version manifest, CI log, migration test |
| G1 Identity/data | Owner auth/CSRF, Project closure, secrets encrypted, CRUD/version | Negative auth tests + fresh setup |
| G2 Chat/durable Ask | UI thật, DB history, streaming/reconnect, model adapter/mocks | Browser E2E và DB restart |
| G3 Worker/security | Enrollment, signature, lease/watchdog, sandbox/filesystem/egress fail-closed | Linux lab logs/packet counters/doctor |
| G4 Agent/web workflow | Plan→tool→evidence với http/browser, approval/cancel/budget | End-to-end lab trace, no unauthorized traffic |
| G5 Results | Finding verification gate, report snapshot, retest, export/import | Report bundle + hash checks + owner review |
| G6 Reliability | Crash matrix, duplicate result, unknown effect, SSE ordering, child budget | Chaos suite results, no hidden skips |
| G7 Operations/owner | Backup restore fresh machine, key recovery, upgrade smoke, UX acceptance | Restore manifest, measured timings, owner sign-off |

G3 không đạt thì không chạy mục tiêu thật dù UI đã đẹp. G7 restore chưa thử thì không gọi “dữ liệu đã an toàn nhờ backup”. Một gate fail phải ghi BLOCKED/FAIL, không PASS WITH TODO.

### 3. Owner acceptance script

Đăng nhập hệ thống mới. Cấu hình model bằng key riêng hoặc local endpoint và xem rõ data policy. Tạo Project lab, thêm file OpenAPI và notes. Enroll worker1, chọn nó, chạy Ask tóm tắt tài liệu. Chạy Agent trên fixture origin đã grant; xem plan/tool/evidence. Đóng browser, mở lại thấy đúng Run. Pause/resume, đổi sang high-risk approval trong Run mới và verify card. Revoke grant lúc task chạy và xác nhận không request mới vượt policy.

Tạo candidate với evidence, review thành verified, tạo report, sửa finding và kiểm tra report cũ không đổi. Retest fixture đã sửa, rồi fixture unavailable để thấy inconclusive. Export/import Project, kiểm tra secrets/grants không active theo import. Backup verified, restore máy sạch, re-enroll worker, đọc lại evidence và chạy task lab mới.

### 4. Mục tiêu đo lường release

Control-plane CRUD p95≤500ms và event propagation p95≤1s trên lab tham chiếu, không tính model latency. UI long history vẫn tương tác được. Cancel acknowledgment healthy worker mục tiêu≤10s, hard local lease expiry≤45s cộng kill grace5s; outage server không được giả biết quiescence. Restore10GiB target≤60 phút phải đo, không claim nếu chưa chạy.

Những số này là acceptance targets, không kết quả nghiên cứu hiện có. Nếu cần đổi ngưỡng vì hardware, ADR phải ghi hardware/measured value/trade-off và owner chấp nhận; không sửa âm thầm để CI xanh.

### 5. Release package ứng dụng cần có

Source commit/tag; immutable image digests và worker binary checksum; dependency/SBOM manifest; upgrade/rollback notes; changelog; known limitations; test/chaos/eval reports; backup/restore instructions; owner onboarding; sample `.env` không secret; license inventory. Không ship data fixture có real credential. Bản debug không bật network external test tự động.

### 6. Định nghĩa task DONE

Code có hành vi thật, tests liên quan pass, schema/docs cập nhật, no unresolved critical/high boundary bugs, manual UI verification cho phần nhìn thấy và STATUS.md ghi evidence. Chưa có environment để test là BLOCKED, không DONE. Chỉ viết endpoint trả mock JSON hoặc scaffold component không hoàn tất task domain.


---


<a id="file-docs-19-research-sources-md"></a>


*Nguồn: `docs/19-research-sources.md`*


## 19 — Nguồn nghiên cứu và xuất xứ quyết định

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

### 1. Phương pháp và giới hạn

Phần tham khảo HackerAI dựa vào các file/tài liệu đã đọc ở commit `efb00b07b776737887c1856c1f11909c6d86fc7b`. Đây là khảo sát tĩnh theo vùng có liên quan, không full code audit, không chạy ứng dụng HackerAI, không có quyền truy cập metrics production. Không xác nhận mọi chức năng trong source đang bật trên website live. Các nguồn chính thức bên dưới được đối chiếu ngày24/09/2026.

Mọi cấu hình mặc định, invariant, schema, backlog và kiến trúc redAI trong gói là đề xuất thiết kế dành riêng cho personal v1, không sao chép nguyên văn source. Tài liệu không chứa source code, prompt hay asset của HackerAI. Việc đã đọc code tham khảo không tự tạo chứng nhận pháp lý “clean-room”; trước phát hành thương mại cần rà soát xuất xứ mã và giấy phép phù hợp.

### 2. HackerAI: điều học được

Repo tách web/HTTP, dữ liệu và durable Agent runtime; có Project/Chat, cloud/local execution, workflow approval và recovery. Tài liệu local identity chú ý stable installation ID, session mới, không fallback sang máy khác khi máy đã chọn offline. Tài liệu auto-review thừa nhận reviewer không thay network/scope enforcement. redAI dùng các bài học ở mức vấn đề sản phẩm, nhưng chọn stack và mô hình vận hành khác.

File LICENSE có điều kiện bổ sung hạn chế sử dụng thương mại nếu chưa có giấy phép riêng. Personal use ở bản đầu không phải lý do mặc định đủ quyền thương mại về sau. Chọn triển khai độc lập; không cần suy diễn tính pháp lý ngoài văn bản giấy phép [SRC01].

### 3. Nguồn chính thức

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

### 4. Các điều chưa xác minh

Chưa kiểm tra nhãn hiệu/domain redAI; chưa benchmark phần cứng owner; chưa biết model/provider/key owner sẽ dùng; chưa đo precision/recall thực; chưa triển khai proxy/isolation; chưa apply DDL vào PostgreSQL thật trong bản tài liệu; chưa đánh giá toàn bộ package licenses của ứng dụng vì source chưa được viết. Những điểm này được đưa thành task/gate, không để coding agent giả vờ đã hoàn tất.


---


<a id="file-docs-20-end-to-end-scenarios-md"></a>


*Nguồn: `docs/20-end-to-end-scenarios.md`*


## 20 — Trace nghiệp vụ và các race condition

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

### 1. Từ Chat đến tool thành công

Owner POST Run với client_message_id/key A. API lock Chat, lưu message/run R/root session S/event E, commit, trả201 R. Runtime claim R fence7, checkpoint step1; reserve model cost; nhận tool proposal. Commit step1/call C/attempt T với fence1, event. Worker W session WS claim T, verify/signature, journal received/start_intent; tạo sandbox K label T; chạy pure fixture. Upload artifact F, API verify hash ready; W submit result digest D quiescent. API chấp nhận T fence1, call C succeeded, event. Runtime step2 đọc result F, finalize message/run/report refs. Owner mở lại browser và nhận E→final mà không tạo task mới.

Quan sát cần có: request_id→run_id→step→call→attempt→worker/container→artifact. Không có secret trong trace labels.

### 2. Double-click Run và request timeout

Hai POST cùng key/body đến hai API instances. Một transaction giữ key/chat lock. Request thứ hai nhận cùng result hoặc REQUEST_IN_PROGRESS. Nếu response đầu mất sau commit, retry trả R cũ. Nếu hai keys khác nhưng client_message_id giống, unique message ID và active run index bảo vệ. Nếu hai messages khác cùng Chat khi active, API trả ACTIVE_RUN_EXISTS; UI có thể append note qua endpoint đúng thay vì tạo Run cạnh tranh.

Không dùng frontend disable-button là cơ chế dedup duy nhất.

### 3. Model trả tool call rồi runtime crash

Crash trước boundary commit: không ToolCall authoritative, worker không thấy gì. Recovery có thể gọi model lại, usage cũ unknown/reserved. Crash sau commit: recovery nhìn thấy call C và không dispatch C2. Nếu provider trả duplicate tool IDs trong một response, server-generated IDs/index unique kiểm soát; parser reject mâu thuẫn trước dispatch.

### 4. Worker mất mạng sau external write

Lab endpoint tăng counter1. Worker chưa nhận hoặc chưa báo response thì control-plane partition. Local watchdog thu hồi egress/kill khi deadline. Server T lost/unknown, R needs_attention; W2 không được auto chạy lại cùng POST. Khi W1 quay lại, journal+proxy request evidence có thể chứng minh response; reconcile chấp nhận/quarantine theo fence. Nếu vẫn không biết, owner xác nhận theo target state hoặc kết thúc partial. Không model suy ra counter đã tăng từ câu văn “có lẽ request thành công”.

Test đạt khi counter không bị tăng lần hai bởi retry tự động và UI thể hiện uncertainty, không yêu cầu platform thần kỳ hoàn tác remote effect.

### 5. Cancel và final result tới cùng lúc

API cancel transaction trước: Run cancel_requested, stop new dispatch. Result succeeded của task đã thực sự hoàn thành trước cancel vẫn có thể lưu evidence; completion reason ghi completed_before_cancel_observed. Run chỉ terminal canceled sau reconciliation mọi task, không xóa evidence thành công. Result transaction trước: task succeeded nhưng Run finalizing chưa xong; cancel vẫn ngăn model/calls tiếp theo, finalize partial canceled đúng semantics.

Không để final message callback muộn ghi Run completed sau canceled bằng update không CAS. State transition validation server là nguồn thật.

### 6. Approval stale do revoke

Owner mở approval ở tab1. Tab2 revoke grant epoch5→6. Tab1 approve fingerprint epoch5: API reject GRANT_REVOKED/APPROVAL_STALE, không tạo task. Nếu task đã leased epoch5, renewal bị từ chối, proxy capability bị revoke, worker dừng theo deadline. UI không nói “approve thành công” chỉ vì click đã gửi.

### 7. Event commit-order race

Transaction A cập nhật Run và lock Workspace counter lấy100. A bị delay trước commit. B muốn event101 phải chờ cùng counter lock. A commit rồi B cấp101/commit, API có thể replay100→101 không skip. Test negative mô phỏng thiết kế `bigserial` naive để thấy tại sao không dùng: B có thể commit101 trước A100; client cursor101 bỏ100 vĩnh viễn. Spec yêu cầu thiết kế có counter lock hoặc cơ chế khác chứng minh không mất, không sequence thuần.

### 8. Scope matching trên CDN

Project grant exact `app.example.test`, port443. DNS trả IP cùng nơi host `other.example.test`. Adapter chỉ dial validated IP với Host/SNI của app. Browser request `other.example.test` hoặc Host mismatch bị proxy deny; không cho raw CONNECT tunnel đổi authority. Discovery lưu dependency, không tạo grant mới. Test lab mô phỏng hai vhost cùng loopback/private network được allow chỉ trong lab zone; không truy cập CDN thật.

### 9. Backup và restore

Owner request backup B. Maintenance ngừng writes, settle runs, chờ ready artifacts, capture event cursor. DB dump+file inventory+encrypted key recovery package được verify. Sau restore sạch: sessions/tokens/leases revoked, run active cũ needs_attention. Owner re-login/re-enroll, validate hash, xem report. Không worker cũ tự nối lại và chạy công việc từ thời điểm backup.


---


<a id="file-docs-21-decisions-limitations-md"></a>


*Nguồn: `docs/21-decisions-limitations.md`*


## 21 — Quyết định còn lại và giới hạn chủ đích

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

### 1. Không còn câu hỏi sản phẩm bắt buộc trước khi viết code

Đã có owner-first, self-host, UI model, stack, persistence, worker protocol, approval modes, storage và release gates. Coding agent không cần hỏi có billing/team/cloud hay không. Không cần biết domain thật để build; dùng fixtures. Không cần API key thật để hoàn thành đa số integration/E2E; dùng mock provider. Khi live smoke cần provider/target, cấu hình do owner nhập, không hard-code vào source.

### 2. Các điều agent phải xác minh kỹ thuật trong task

T00 pin versions và license inventory. T21 thử browser/proxy/gVisor compatibility trên Linux. T30 đo tài nguyên/latency để điều chỉnh capacity. T31 restore drill và key recovery. T35 chạy opt-in model capability/quality eval khi owner cung cấp endpoint. Đây là công việc triển khai, không lý do để hỏi lại persona hoặc trì hoãn toàn bộ.

### 3. Giới hạn v1 và trigger mở rộng

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

### 4. Rủi ro lớn nhất cần theo dõi

Egress proxy triển khai sai, recovery dẫn tới duplicate external effect, LLM cost unknown không được giữ reservation, evidence bị gắn status vượt bằng chứng, và backup thiếu key/file. Vì vậy task security/durability không được dồn hết xuống “phase cuối sau khi ship”. Offline vertical slice phải chứng minh journal/lease trước scoped network.

### 5. Không thay đổi âm thầm

Không tự chuyển Project data policy, worker zone, model provider, live scope, budget ceiling hoặc image digest trong Run đang chạy. Không tự mở quyền khi phát hiện target mới. Không tự hạ runtime security khi môi trường thiếu dependency. Thay đổi cấu hình quan trọng có owner action/audit/version và run mới hoặc emergency narrowing đúng invariant.


---


<a id="file-adr-001-personal-first-independent-md"></a>


*Nguồn: `adr/001-personal-first-independent.md`*


## ADR-001 — Personal-first và triển khai độc lập

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

Trạng thái: Accepted for spec baseline. Một owner dùng công cụ cho công việc cá nhân. Không dựng billing/team/SSO và không fork source HackerAI vào sản phẩm. Giữ các pattern trải nghiệm phổ biến, tự viết code/assets/prompts. Alternative fork có thể nhanh nhưng cần xem giấy phép và nghĩa vụ về sau; chưa có giấy phép thương mại riêng nên không chọn.

Hệ quả: giảm module kinh doanh, tăng phần tự xây runtime/UX. Vẫn giữ workspace/project boundary để tránh rò dữ liệu giữa dự án và chuẩn bị mở rộng mà không hứa multi-tenant. Test: singleton owner, no signup routes, no copied brand assets, dependency provenance review.


---


<a id="file-adr-002-postgres-durable-runtime-md"></a>


*Nguồn: `adr/002-postgres-durable-runtime.md`*


## ADR-002 — Durable loop bằng PostgreSQL

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

Trạng thái: Accepted for personal v1. API và TypeScript runtime là process riêng; PostgreSQL lưu Run/Step/Task/Event/Budget. Claim dùng transaction ngắn, lease/fence và SKIP LOCKED. Không Temporal, Redis hoặc in-memory queue làm nguồn thật.

Alternative Temporal cung cấp mô hình workflow/worker chuyên dụng nhưng thêm vận hành; không cần ở baseline một loại Agent loop bounded. Alternative web request chạy toàn agent không bền khi tab/request/service mất. Hệ quả: redAI tự chịu trách nhiệm state machine, retries, cancellation, commit-order event và unknown effects; các test chaos là bắt buộc.

Migration tương lai: freeze dispatch, map checkpoints sang workflow IDs, một nguồn authority duy nhất, không chạy hai queue cùng claim. Trigger xem lại là nhiều workflow dài ngày hoặc nhu cầu scale quan sát được, không vì xu hướng framework.


---


<a id="file-adr-003-homogeneous-go-workers-md"></a>


*Nguồn: `adr/003-homogeneous-go-workers.md`*


## ADR-003 — Go worker đồng nhất

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

Trạng thái: Accepted. Cùng binary, toolbox manifest và protocol trên mọi worker. Agent roles là logical sessions, không worker type. Outbound HTTPS long-poll giảm inbound networking; stable identity tách session. Signed leases và journal trước effect; outcomes mơ hồ không replay.

Alternative dedicated-role workers dễ gắn vai trò cứng và phân bổ tài nguyên kém linh hoạt cho nhu cầu hiện tại. Alternative SSH command runner khó chuẩn hóa identity/lease/cancel/evidence. Hệ quả: worker registry/binding/capacity và compatibility checks bắt buộc. Stateful sessions gắn worker, không transparent migration. Test cùng fixture trên hai worker, offline selected machine và session-clone conflict.


---


<a id="file-adr-004-local-storage-and-contracts-md"></a>


*Nguồn: `adr/004-local-storage-and-contracts.md`*


## ADR-004 — Local ObjectStore và hợp đồng typed

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

Trạng thái: Accepted. File bytes ở Local ObjectStore interface; metadata PostgreSQL; export/import hash manifest. Không thêm S3 server/Redis/vector DB bắt buộc. JSON Schema2020-12 là payload contract; OpenAPI3.1 cho REST; SQL migration rõ ràng cho persistence.

Hệ quả: control-plane API/runtime chia mount storage, backup phải đồng bộ DB+files và key recovery. Adapter S3 tương lai không đổi artifact domain ID. Contracts generation phải có cross-language fixture tests; generated types không thay runtime validation. DDL reference cần apply vào PostgreSQL thật trước release.


---


<a id="file-adr-005-scope-and-network-md"></a>


*Nguồn: `adr/005-scope-and-network.md`*


## ADR-005 — Automatic không tự mở scope

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

Trạng thái: Accepted security invariant. Default Automatic cho thao tác nằm trong capability/grant đã cấu hình. DNS proof giữ tại Project, không hỏi lại mỗi action. Domain quyền không mở sang shared IP/provider tenant/dependency. Offline terminal không network; HTTP/browser qua typed adapter/scoped proxy và network guard.

Alternative chỉ prompt/reviewer không đủ authority hoặc network boundary. Alternative blind HTTPS CONNECT không chặn đổi HTTP authority trên shared infrastructure. Hệ quả: browser TLS inspection có giới hạn pinning, được ghi coverage; unsupported không bypass. Test shared IP, redirects, DNS changes, revoke và proxy fail-closed.


---


<a id="file-adr-006-model-and-data-policy-md"></a>


*Nguồn: `adr/006-model-and-data-policy.md`*


## ADR-006 — Model route và data policy riêng

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

Trạng thái: Accepted. Owner chọn endpoint/model/key; mock deterministic cho CI; local_only/redacted_cloud/cloud_full có semantics rõ. Worker local không suy ra model local. Secret refs, server-side keys, payload filtering và budget reservation chung.

Alternative hard-code một nhà cung cấp dễ setup nhưng khóa chi phí/dữ liệu. Alternative tự tìm model thay khi bị từ chối có thể vi phạm data policy và mất dự đoán. Hệ quả: capability probe, price config/version, unknown usage và explicit fallback cần UI. Test canary/local-only/parallel child budget.


---


<a id="file-adr-007-interface-and-release-md"></a>


*Nguồn: `adr/007-interface-and-release.md`*


## ADR-007 — Chat-first, evidence-first, release theo gate

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

Trạng thái: Accepted. Sidebar Project/Chat, conversation center, Workbench context. Không dashboard enterprise trước. Finding/evidence/report là entity typed, không đoạn chat tự phong verified. Release G0–G7 bao gồm recovery/restore và Linux network lab.

Hệ quả: cần UI đầy đủ empty/error/connection states và status backend authoritative. Mock đẹp không nghiệm thu. E2E dùng component thật, reports immutable snapshots, retest separate Run. Các mốc triển khai theo dependency thay vì ước lượng ngày không có dữ liệu.


---


<a id="file-implementation-plan-md"></a>


*Nguồn: `implementation/plan.md`*


## Kế hoạch triển khai redAI Personal v1

Đây là thứ tự theo dependency, không phải hứa hẹn số ngày. Hoàn thành vertical slice offline trước scoped network. Không triển khai tất cả màn hình rồi mới nối persistence hoặc bảo mật.

| Milestone | Kết quả phải có | Tasks | Gate chính |
|---|---|---|---|
| M0 | Repo, versions, migration thật, contracts | T00–T03 | G0 |
| M1 | Owner, Projects, secrets, storage | T04–T07 | G1 |
| M2 | Ask/Chat thật, UI và reconnect | T08–T11 | G2 |
| M3 | Scope + durable Agent + worker + offline tools | T12–T19 | G3 offline |
| M4 | HTTP/browser, approvals, cancel, subagents | T20–T24 | G3/G4 |
| M5 | Evidence/findings/report/retest/export | T25–T27 | G5 |
| M6 | Deploy/security/chaos/restore/observability | T28–T32 | G6/G7 |
| M7 | CI hardening, owner UAT, handoff | T33–T36; T35 opt-in | Tất cả |

### Công việc song song hợp lý

Sau T01, T02 và T03 có thể tách agent với ownership file rõ. Sau T06 có thể làm UI shell trong lúc provider/storage backend hoàn thiện, nhưng UI task không DONE nếu chưa nối API thật. Worker enrollment/journal có thể đi song song runtime sau contracts. Browser proxy là security-critical boundary, phải review riêng trước khi merge scoped execution.

Không cho hai coding agents sửa cùng schema/SQL migration mà không coordinator tích hợp. Người phụ trách contract thay đổi phải cập nhật both consumers TypeScript/Go và fixtures. Trước merge, chạy tests liên quan trên branch tích hợp, không chỉ mỗi nhánh riêng.

### Quy tắc quản lý công việc

Dùng `tasks.json` làm nguồn task/dependency và [task-cards.md](#file-implementation-task-cards-md) để đọc chi tiết. `STATUS.md` ghi state NOT_STARTED/IN_PROGRESS/BLOCKED/DONE, commit, commands và evidence. DONE chỉ khi tiêu chí task đạt, không dựa việc đã tạo folder. Một task tùy chọn NOT_RUN không thành PASS; mọi MUST không đạt chặn release gate tương ứng.

Lựa chọn kỹ thuật bổ sung viết ADR theo template. Bug boundary được ưu tiên hơn thêm tính năng. Không mặc định live network/model key có sẵn; các fixture đủ xây core. Mọi test dùng mục tiêu thật phải do owner cấp scope và chủ động yêu cầu, không agent suy ra từ domain tìm trong tài liệu.

### Hợp đồng phải đồng bộ

Enum/status/defaults ở SPEC_LOCK và schemas; OpenAPI với route handlers; database FK/unique với transaction tests; worker envelope với JWS/JCS fixtures; policy vectors với TS+Go; prompt version với run manifest; UI states với backend lifecycle. Không để tài liệu “cancel chờ acknowledgement” nhưng code chỉ abort fetch phía browser.

### Handoff khi hết context

Ghi task hiện tại, commit/base branch, files đang sửa, checks đã chạy và failing tests, invariant liên quan, bước tiếp theo. Không ghi secret. Agent tiếp theo đọc handoff và xác minh source/test, không coi lời agent trước là bằng chứng đã DONE.


---


<a id="file-implementation-task-cards-md"></a>


*Nguồn: `implementation/task-cards.md`*


## Task cards — redAI Personal v1

Các đường dẫn `target_modules` là đường dẫn repository ứng dụng **cần được tạo**, không phải file đã triển khai trong gói đặc tả.

### T00 — Khóa dependency và môi trường

**Milestone:** M0 · **Priority:** MUST · **Dependencies:** Không

**Đọc:** `docs/04-architecture-repository.md` và `AGENTS.md`.

**Module bàn giao:** `docs/dependency-baseline.md`, `ops/`, `package.json`, `worker/go.mod`.

#### Cách thực hiện

1. Kiểm tra toolchain hiện có; chọn các version stable đang được hỗ trợ theo docs chính thức, ghi version và ngày kiểm tra.
2. Pin Node/pnpm/Go/PostgreSQL và framework, không dùng floating latest trong release.
3. Lập license/provenance inventory và xác nhận không vendor code/asset/prompt HackerAI.

#### Kiểm thử phải có

- Version check chạy được trên máy dev và CI.
- Danh sách dependency có license và nguồn; không chứa production key.

#### Tiêu chí hoàn tất

- Baseline có version cụ thể và lockfile strategy.
- Thiếu Linux/gVisor chỉ ghi blocker cho execution suite, không chặn scaffold/DB/mocks.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

### T01 — Khởi tạo monorepo và quality commands

**Milestone:** M0 · **Priority:** MUST · **Dependencies:** T00

**Đọc:** `docs/04-architecture-repository.md` và `AGENTS.md`.

**Module bàn giao:** `apps/web`, `apps/api`, `apps/runtime`, `packages/domain`, `worker/`, `implementation/STATUS.md`.

#### Cách thực hiện

1. Tạo pnpm workspace và Go module theo architecture, dependency graph không cyclic.
2. Thiết lập lint/format/typecheck/test/build commands và environment validation.
3. Tạo health stub phân biệt chưa cấu hình với ready; cấu hình test profile có nhãn mock.

#### Kiểm thử phải có

- Clean install từ lockfile và build skeleton.
- Import boundary test: domain không import web/Docker/provider SDK.

#### Tiêu chí hoàn tất

- Một lệnh checks cho TS và Go có exit status đúng.
- README hướng dẫn chạy dev không cần model key thật.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

### T02 — Migration PostgreSQL và invariants DB

**Milestone:** M0 · **Priority:** MUST · **Dependencies:** T01

**Đọc:** `docs/05-data-model.md` và `AGENTS.md`.

**Module bàn giao:** `packages/db`, `db/001_reference_schema.sql`, `tests/integration/db`.

#### Cách thực hiện

1. Chuyển reference DDL thành migration versioned; apply trên PostgreSQL thật bản đã pin.
2. Thêm typed repositories/transaction wrapper và fixture seed owner/project.
3. Thực thi index/constraint/immutable trigger/counter helper; ghi các invariant bắt buộc ở application.

#### Kiểm thử phải có

- Fresh migration và upgrade smoke.
- Composite FK cross-project negative; active-run unique; immutable artifacts/versions.
- Event counter concurrent commit-order test.

#### Tiêu chí hoàn tất

- DDL apply không lỗi thực tế, không chỉ parse.
- Backup/rollback strategy cho schema được ghi; app không auto synchronize/drop tables.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

### T03 — Sinh type và kiểm tra API contracts

**Milestone:** M0 · **Priority:** MUST · **Dependencies:** T01

**Đọc:** `docs/06-api-realtime.md` và `AGENTS.md`.

**Module bàn giao:** `packages/contracts`, `contracts/`, `tests/contracts`.

#### Cách thực hiện

1. Copy canonical schemas vào implementation source-of-truth, sinh TS/Go types bằng tooling đã pin.
2. Tích hợp JSON Schema validation strict và format/unknown-field checks.
3. Sinh OpenAPI clients/stubs nhưng domain handler chưa có phải báo not implemented ở dev, không fake success.

#### Kiểm thử phải có

- Tất cả positive/negative fixtures trong tests/contract-cases.json.
- TS/Go parse cùng payload và từ chối cùng malformed fields.
- Contract drift check chạy trong CI.

#### Tiêu chí hoàn tất

- Không dùng TypeScript cast như runtime validation.
- Enums/defaults khớp SPEC_LOCK và schemas.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

### T04 — Bootstrap owner và sessions

**Milestone:** M1 · **Priority:** MUST · **Dependencies:** T02, T03

**Đọc:** `docs/13-identity-settings.md` và `AGENTS.md`.

**Module bàn giao:** `apps/api/auth`, `packages/application/auth`, `ops/bootstrap`, `apps/web/login`.

#### Cách thực hiện

1. Viết CLI bootstrap qua stdin, singleton owner/Workspace/Inbox, recovery code.
2. Session opaque hashed, cookie/CSRF/Origin, rate limit, logout/password reset/revoke.
3. Tạo login UI và session renewal/error states.

#### Kiểm thử phải có

- Bootstrap race, invalid password, CSRF foreign origin, idle/absolute expiry.
- Worker token không gọi owner endpoint; reset revokes sessions.

#### Tiêu chí hoàn tất

- Không public signup hoặc default credentials.
- Không password/token trong logs hoặc command args.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

### T05 — Secret vault và model/settings configs

**Milestone:** M1 · **Priority:** MUST · **Dependencies:** T04

**Đọc:** `docs/11-llm-context-privacy.md` và `AGENTS.md`.

**Module bàn giao:** `packages/application/secrets`, `packages/llm/config`, `apps/web/settings`.

#### Cách thực hiện

1. AEAD secret storage với master key file, key_id/AAD, metadata-only API.
2. Provider config version, data modes/prices/endpoint allowlist và explicit fallback config.
3. Settings If-Match/revision, locked-key/placeholder rejection, session/password UI.

#### Kiểm thử phải có

- Ciphertext khác mỗi nonce, wrong AAD/key fail; restart missing key không tự tạo key mới.
- Cross-project secret/ref denial; config revisions conflict.

#### Tiêu chí hoàn tất

- Owner nhập key qua UI, không hard-code; runtime đọc qua credential_ref.
- local_only và cloud route hiển thị đúng, chưa probe không tuyên bố ready.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

### T06 — Project, Chat metadata, notes và bindings

**Milestone:** M1 · **Priority:** MUST · **Dependencies:** T04, T03

**Đọc:** `docs/02-prd-use-cases.md` và `AGENTS.md`.

**Module bàn giao:** `packages/application/projects`, `apps/api/projects`, `apps/web/projects`.

#### Cách thực hiện

1. CRUD/archive Project, Inbox logic, Chat metadata, notes selected_for_context.
2. Mọi repository use case bind Workspace/Project; versioned settings và pagination.
3. Binding worker API chỉ owner điều khiển; phần worker cụ thể hoàn thiện sau T15.

#### Kiểm thử phải có

- Project A không truy cập note/chat Project B qua đổi UUID.
- Revision conflict, archive không delete data, pending delete active run.

#### Tiêu chí hoàn tất

- Empty/error/loading khác nhau.
- Project scope không chỉ là text trong chat.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

### T07 — Local ObjectStore và upload an toàn

**Milestone:** M1 · **Priority:** MUST · **Dependencies:** T06

**Đọc:** `docs/12-findings-evidence-reports.md` và `AGENTS.md`.

**Module bàn giao:** `packages/storage`, `apps/api/artifacts`, `tests/integration/storage`.

#### Cách thực hiện

1. Implement staged upload, server hash/size verification, atomic rename và metadata finalize.
2. Logical storage keys, authenticated download, redacted preview, quarantine.
3. Document parsing text/Markdown/JSON/YAML/CSV/PNG/JPEG bounded; không fetch external refs.

#### Kiểm thử phải có

- Hash mismatch, interrupted upload, finalize duplicate, disk full.
- Traversal/symlink/media mismatch/unsafe HTML preview.

#### Tiêu chí hoàn tất

- Artifact ready chỉ khi bytes có và verified.
- Crash giữa rename/DB commit có reconciliation path, không public orphan.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

### T08 — Mock model và compatible provider adapter

**Milestone:** M2 · **Priority:** MUST · **Dependencies:** T05, T03

**Đọc:** `docs/11-llm-context-privacy.md` và `AGENTS.md`.

**Module bàn giao:** `packages/llm`, `tests/fixtures/models`.

#### Cách thực hiện

1. Tạo scripted mock adapter, compatible adapter text/tools/stream/cancel/usage.
2. Capability probe bằng synthetic data, endpoint routing owner-only.
3. Map errors, disable hidden unbounded SDK retries, record unknown usage.

#### Kiểm thử phải có

- Malformed tool JSON, stream interrupt, duplicate indices, provider429/timeouts.
- Mock payload capture canary; no cloud fallback local_only.

#### Tiêu chí hoàn tất

- CI không cần trả phí hoặc key.
- Provider không hỗ trợ tools không được chạy Agent bằng text parsing.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

### T09 — Durable Ask và Chat persistence

**Milestone:** M2 · **Priority:** MUST · **Dependencies:** T06, T07, T08

**Đọc:** `docs/07-agent-runtime.md` và `AGENTS.md`.

**Module bàn giao:** `apps/runtime/ask`, `packages/application/messages`, `apps/api/runs`.

#### Cách thực hiện

1. Atomic create Run/message, checkpoint, persist partial/final message với generation ID.
2. Ask toolset rỗng, context chỉ notes/files được chọn và current Project.
3. Pagination lịch sử, append notes không tạo run duplicate.

#### Kiểm thử phải có

- Double-click/cùng Idempotency-Key; API crash sau commit.
- Close browser/restart API vẫn đọc Chat, Ask không tạo worker task.

#### Tiêu chí hoàn tất

- Chat hoạt động end-to-end qua DB/provider thật hoặc mock được gắn nhãn.
- Tool failure/output không bị tạo trong Ask.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

### T10 — Giao diện chat-first và Workbench shell

**Milestone:** M2 · **Priority:** MUST · **Dependencies:** T06, T09

**Đọc:** `docs/03-ux-ui-spec.md` và `AGENTS.md`.

**Module bàn giao:** `apps/web`, `packages/ui`.

#### Cách thực hiện

1. Xây sidebar Project/Chat, composer modes, attachment, theme/i18n/responsive.
2. Workbench Plan/Activity/Files/Findings/Usage gắn state API, chưa có data hiển thị empty không fake.
3. Keyboard/IME/focus/Markdown sanitize/long text handling.

#### Kiểm thử phải có

- Browser tests1440/1024/390px, dark/light, keyboard, IME enter.
- Long transcript/composer rerender/unsafe Markdown.

#### Tiêu chí hoàn tất

- Không chỉ screenshot mock; components nối API thật.
- Local worker vs local model wording không nhầm.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

### T11 — SSE commit-ordered và reconnect

**Milestone:** M2 · **Priority:** MUST · **Dependencies:** T02, T09, T10

**Đọc:** `docs/06-api-realtime.md` và `AGENTS.md`.

**Module bàn giao:** `apps/api/events`, `packages/application/events`, `apps/web/realtime`.

#### Cách thực hiện

1. Event counter row lock cùng business transaction, durable event journal, NOTIFY wake-up.
2. Snapshot cursor, Last-Event-ID replay/dedup, filtering/cursor advancement.
3. Proxy buffering off, slow consumer backpressure, cursor expiry recovery.

#### Kiểm thử phải có

- Commit inversion A delayed/B concurrent không skip.
- Disconnect after frame, duplicate IDs, expired cursor, buffer overflow.

#### Tiêu chí hoàn tất

- UI không tạo run mới hoặc xóa history khi reconnect.
- Message provisional/final được phân biệt.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

### T12 — DNS proof, scope policy và grant lifecycle

**Milestone:** M3 · **Priority:** MUST · **Dependencies:** T06, T03

**Đọc:** `docs/10-authorization-scope.md` và `AGENTS.md`.

**Module bàn giao:** `packages/policy`, `apps/api/scope`, `apps/web/project-settings`.

#### Cách thực hiện

1. Implement domain normalization/rules/exclusions/lab zones và shared test vectors.
2. One-time Project DNS challenge/proof, owner attestation/grant version/revoke epoch.
3. Policy reason codes/mode matrix; no model endpoint mutation.

#### Kiểm thử phải có

- Toàn tests/policy-cases.json, deceptive suffix, IPv6, exclusions, shared IP.
- Second Chat không verify lại; revoke active grant không giữ permission.

#### Tiêu chí hoàn tất

- Automatic không override deny; dependency explicit_only.
- Scope immutable, broadening chỉ Run mới.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

### T13 — Durable Agent loop và checkpoints

**Milestone:** M3 · **Priority:** MUST · **Dependencies:** T09, T11, T12

**Đọc:** `docs/07-agent-runtime.md` và `AGENTS.md`.

**Module bàn giao:** `apps/runtime/agent`, `packages/domain/runs`.

#### Cách thực hiện

1. Claim run lease/fence, step boundaries, parsed plan, stable logical tool IDs.
2. Checkpoint source manifests/pending tools/notes and CAS commits.
3. Loop detection, time/step limits, finalization gate chưa dispatch network thật.

#### Kiểm thử phải có

- Restart mỗi boundary bằng mock tool transport.
- Hai runtimes stale-fence commits, model response invalid không tool dispatch.

#### Tiêu chí hoàn tất

- Không agent loop trong web request.
- No duplicate logical call sau retry/restart.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

### T14 — Ngân sách và privacy pipeline

**Milestone:** M3 · **Priority:** MUST · **Dependencies:** T13, T05

**Đọc:** `docs/11-llm-context-privacy.md` và `AGENTS.md`.

**Module bàn giao:** `packages/llm/context`, `packages/application/budget`, `apps/web/usage`.

#### Cách thực hiện

1. Context manifest/redaction/token caps/summary selection; secret refs không values.
2. Budget reservations trước request, shared ledger, pricing version, unknown held.
3. Owner budget increase audit và usage UI measured/estimated/unknown.

#### Kiểm thử phải có

- Parallel reserve race; missing usage; child requests cạnh tranh budget.
- Canary trong headers/body/HTML/errors/logs/payload capture.

#### Tiêu chí hoàn tất

- Không số0 giả khi usage unknown.
- Không bật full-cloud hoặc provider khác tự động.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

### T15 — Worker enrollment và identity

**Milestone:** M3 · **Priority:** MUST · **Dependencies:** T04, T03

**Đọc:** `docs/08-worker-protocol.md` và `AGENTS.md`.

**Module bàn giao:** `worker/cmd/redai-worker`, `apps/api/worker-auth`, `apps/web/workers`.

#### Cách thực hiện

1. Enrollment token one-use, idempotent encrypted retransmission, worker credential rotation.
2. Stable UUID/local permissions, session generation, heartbeat/doctor metadata.
3. Worker list/bind/drain/revoke và no public token reveal.

#### Kiểm thử phải có

- Token replay/new identity denial, lost-response retry same intent.
- Two daemons cloned identity, expired/revoked token, path permissions.

#### Tiêu chí hoàn tất

- Worker giữ danh tính sau restart nhưng session mới được reconcile.
- Credential chỉ được phép worker API/binding.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

### T16 — Worker journal, spool và supervisor

**Milestone:** M3 · **Priority:** MUST · **Dependencies:** T15

**Đọc:** `docs/08-worker-protocol.md` và `AGENTS.md`.

**Module bàn giao:** `worker/internal/journal`, `worker/internal/executor`, `worker/internal/lease`.

#### Cách thực hiện

1. Persistent atomic manifests/fsync records, single-instance lock và bounded output spool.
2. Container labels/start_intent/state inspection và orphan reaper.
3. Watchdog độc lập execution goroutine, monotonic deadline/cancel process tree.

#### Kiểm thử phải có

- Crash windows received/create/start/result trước ACK.
- Spool full, corrupted tail record, worker daemon restart, zombie child.

#### Tiêu chí hoàn tất

- Không start container mới khi attempt container đã tồn tại.
- Outcome không biết được giữ unknown, không replay.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

### T17 — Task scheduler, signed leases và results

**Milestone:** M3 · **Priority:** MUST · **Dependencies:** T12, T13, T15, T16

**Đọc:** `docs/08-worker-protocol.md` và `AGENTS.md`.

**Module bàn giao:** `apps/api/worker-tasks`, `packages/application/execution`, `worker/internal/api`.

#### Cách thực hiện

1. Task claim txn, worker capacity/binding, Ed25519 JWS/JCS input hash, renewal live grant.
2. ACK started/result dedup/conflicting digest/quarantine, fence current attempt.
3. Input artifact download và credential capability ràng buộc attempt.

#### Kiểm thử phải có

- Signature tamper, session superseded, policy epoch stale, lease expiry.
- Concurrent claim, duplicate ACK/result, mismatched result digest, slot accounting.

#### Tiêu chí hoàn tất

- Fencing không được tuyên bố exactly-once external effect.
- Không reassign lost external operation sang worker khác.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

### T18 — Offline sandbox runtime

**Milestone:** M3 · **Priority:** MUST · **Dependencies:** T16, T17

**Đọc:** `docs/09-sandbox-tool-execution.md` và `AGENTS.md`.

**Module bàn giao:** `worker/internal/sandbox`, `tools/images`, `ops/worker-doctor`.

#### Cách thực hiện

1. Docker/runsc profile, non-root/cap-drop/read-only roots/no mounts, resource caps.
2. Offline network none, logical paths và isolated agent workspace.
3. Doctor kiểm tra runtime/image/guard; không downgrade.

#### Kiểm thử phải có

- Host filesystem/socket/metadata inaccessible; memory/PID/time caps.
- Missing runsc/image mismatch fail closed; process tree cancel.

#### Tiêu chí hoàn tất

- Linux lab thật có evidence, không chỉ mocks.
- Sandbox không nhận DB/model/worker token.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

### T19 — Offline tools và artifacts

**Milestone:** M3 · **Priority:** MUST · **Dependencies:** T18, T07

**Đọc:** `docs/09-sandbox-tool-execution.md` và `AGENTS.md`.

**Module bàn giao:** `worker/internal/tools`, `catalogs/tools.json`.

#### Cách thực hiện

1. file list/read/write, terminal offline, parse OpenAPI external refs disabled.
2. Typed input/output, effect from registry, version manifest và safe previews.
3. Artifact upload/finalize nối provenance đúng call/attempt.

#### Kiểm thử phải có

- Path traversal/symlink export, invalid args, timeout, tool binary unavailable.
- Two homogeneous workers cùng fixtures, hashes bằng nhau ở pure tools.

#### Tiêu chí hoàn tất

- Offline vertical slice Agent→tool→artifact→summary chạy thật.
- Không command thực thi trên host hoặc tự tải package.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

### T20 — HTTP typed adapter

**Milestone:** M4 · **Priority:** MUST · **Dependencies:** T17, T19

**Đọc:** `docs/09-sandbox-tool-execution.md` và `AGENTS.md`.

**Module bàn giao:** `worker/internal/http`, `packages/policy`.

#### Cách thực hiện

1. Normalize target components, resolver pinning, TLS verify, redirect từng hop.
2. Secret injection đúng origin/capability, request/body/response limits.
3. Evidence HTTP redacted/raw classification, method effect classification server-owned.

#### Kiểm thử phải có

- DNS change, redirects foreign origin, Host/SNI mismatch, IPv6, private lab.
- Harmless POST counter không duplicate khi result ACK mất.

#### Tiêu chí hoàn tất

- Không blind external network qua shell.
- HTTP lỗi không được kết luận target an toàn.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

### T21 — Browser automation và scoped inspecting proxy

**Milestone:** M4 · **Priority:** MUST · **Dependencies:** T20

**Đọc:** `docs/09-sandbox-tool-execution.md` và `AGENTS.md`.

**Module bàn giao:** `worker/internal/proxy`, `worker/internal/browser`, `tools/browser-image`.

#### Cách thực hiện

1. Run-local TLS CA/inspecting proxy, authority/path checks từng request, upstream verify.
2. Browser firewall only proxy, deny UDP/direct/DNS paths; Playwright action schema.
3. Session affinity, pinning unsupported states, screenshot/DOM evidence, lease revoke.

#### Kiểm thử phải có

- Hai vhost cùng IP; JS subresource/redirect/WS/WebRTC attempts ngoài grant.
- Proxy crash/lease expire grant revoke chặn request mới.
- Actual runsc+Chromium compatibility và no --no-sandbox shortcut.

#### Tiêu chí hoàn tất

- CONNECT passthrough đơn thuần không đạt task.
- Browser state/cookies không vào logs/default export.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

### T22 — Approval UI và exact-action decisions

**Milestone:** M4 · **Priority:** MUST · **Dependencies:** T12, T13, T17, T10

**Đọc:** `docs/10-authorization-scope.md` và `AGENTS.md`.

**Module bàn giao:** `packages/application/approvals`, `apps/web/approval-card`.

#### Cách thực hiện

1. Bốn mode snapshot, exact fingerprint/TTL, owner approve/reject one-shot.
2. Card đủ tool/target/worker/risk/time, stale/canceled visual states.
3. Transaction approve→attempt chỉ một lần, no reusable model grants.

#### Kiểm thử phải có

- Hai tab approve; scope/secret/worker thay đổi; approve sau cancel/revoke/expiry.
- Automatic routine không popup, Reject no execution but Ask works.

#### Tiêu chí hoàn tất

- Policy deny không được owner card chuyển allow.
- Nút success phản ánh committed result.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

### T23 — Pause/cancel/reconcile từ UI tới worker

**Milestone:** M4 · **Priority:** MUST · **Dependencies:** T17, T19, T22

**Đọc:** `docs/07-agent-runtime.md` và `AGENTS.md`.

**Module bàn giao:** `packages/application/run-control`, `worker/internal/lease`, `apps/web/run-controls`.

#### Cách thực hiện

1. Cooperative pause boundary, notes consumption, terminal resume tạo Run mới.
2. Cancel fan-out child/tasks, revoke proxy lease, track quiescence.
3. Owner reconciliation modal có evidence/reason, không blind retry ambiguous effects.

#### Kiểm thử phải có

- Cancel vs result race, lost worker, child active, approval pending.
- Healthy ack target và partition unknown state, no false canceled.

#### Tiêu chí hoàn tất

- Stop button không chỉ ngắt streaming UI.
- Emergency stop và revoked grant deny renewals.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

### T24 — Bounded subagents và context compaction

**Milestone:** M4 · **Priority:** MUST · **Dependencies:** T14, T23

**Đọc:** `docs/07-agent-runtime.md` và `AGENTS.md`.

**Module bàn giao:** `apps/runtime/subagents`, `packages/llm/summary`, `prompts/`.

#### Cách thực hiện

1. Coordinator delegation depth1/max2 children, allowed tools subset, shared budget.
2. Child workspace riêng và evidence handoff, parent finalization verification.
3. Schema-valid summary, retained tail, fallback không mất context cũ.

#### Kiểm thử phải có

- Child tries recursive delegation/budget escape; parent finalizes too early.
- Summary omits active task, malformed/empty output, incomplete tool pair.

#### Tiêu chí hoàn tất

- Không tạo worker role chuyên biệt.
- Summary không thay live domain/authorization state.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

### T25 — Finding workflow và evidence verification

**Milestone:** M5 · **Priority:** MUST · **Dependencies:** T19, T20, T07

**Đọc:** `docs/12-findings-evidence-reports.md` và `AGENTS.md`.

**Module bàn giao:** `packages/application/findings`, `apps/web/findings`.

#### Cách thực hiện

1. Candidate/versions/status/severity/confidence, source provenance và evidence gates.
2. Owner review/high-critical confirmation, manual external source label.
3. Dedup suggestions không destructive merge, history giữ nguyên.

#### Kiểm thử phải có

- Verified no evidence, wrong Project artifact, stale/fake result source.
- Edit text không sửa artifact hash, confidence không đổi severity.

#### Tiêu chí hoàn tất

- Mọi verified finding có evidence ready traceable.
- Không model text tự gán status vượt verification gate.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

### T26 — Report snapshot và retest

**Milestone:** M5 · **Priority:** MUST · **Dependencies:** T25, T23

**Đọc:** `docs/12-findings-evidence-reports.md` và `AGENTS.md`.

**Module bàn giao:** `packages/application/reports`, `apps/web/reports`, `prompts/report-template.md`.

#### Cách thực hiện

1. Snapshot finding versions/coverage/source scopes trước render Markdown/JSON/HTML.
2. Offline HTML escaped, artifact index/hash, report status thật.
3. Retest Run mới, current grants, observed_fixed/still_present/inconclusive.

#### Kiểm thử phải có

- Report cũ không đổi khi finding sửa, target HTML scripts escaped.
- Retest unavailable/credentials missing không fixed.

#### Tiêu chí hoàn tất

- Không hứa full pentest khi coverage partial.
- Report bytes download được và hashes khớp.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

### T27 — Search và Project export/import

**Milestone:** M5 · **Priority:** MUST · **Dependencies:** T26, T07

**Đọc:** `docs/12-findings-evidence-reports.md` và `AGENTS.md`.

**Module bàn giao:** `packages/application/export`, `packages/db/search`, `apps/web/search`.

#### Cách thực hiện

1. Project-bound full-text metadata/redacted chunks, pagination.
2. ZIP manifest/hash, no credentials/sessions/live grants, UUID remap on import.
3. Archive size/path validation và staging commit/partial import explicit.

#### Kiểm thử phải có

- Search cross-project, secret canary indexing.
- Zip traversal/symlink/bomb/hash mismatch; imported grants inactive.

#### Tiêu chí hoàn tất

- Export/import roundtrip giữ nội dung và provenance external_source_id.
- Không auto execute bất cứ file/task nhập vào.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

### T28 — Deployment scripts và doctor

**Milestone:** M6 · **Priority:** MUST · **Dependencies:** T19, T05

**Đọc:** `docs/14-deployment-operations.md` và `AGENTS.md`.

**Module bàn giao:** `ops/compose`, `ops/systemd`, `ops/scripts`, `README.md`.

#### Cách thực hiện

1. Compose control-plane/volumes/proxy và Linux worker service, migration startup order.
2. Bootstrap/doctor/key checks, private HTTPS, no exposed DB, pinned digests.
3. Upgrade/drain/rollback/emergency-stop commands có exit codes thật.

#### Kiểm thử phải có

- Fresh install từ máy sạch, missing config/key, read-only storage.
- Restart services/worker identity persistent, no orphan auto-restart.

#### Tiêu chí hoàn tất

- Không runnable compose tham chiếu image chưa build/push mà không hướng dẫn.
- Debug/mock profile không bị hiểu là personal production.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

### T29 — Security integration lab

**Milestone:** M6 · **Priority:** MUST · **Dependencies:** T20, T21, T22, T23, T28

**Đọc:** `docs/16-threat-model.md` và `AGENTS.md`.

**Module bàn giao:** `tests/security`, `tests/lab`, `release-evidence/G3`.

#### Cách thực hiện

1. Tạo lab domains/resolver/vhosts/counters/storage fixtures, không external targets.
2. Chạy toàn threat/policy/canary/isolation cases và thu evidence.
3. Review secrets, network boundary, signatures và dependency supply chain.

#### Kiểm thử phải có

- Zero scope bypass, zero secret canary leaks, zero unverified claims auto verified.
- Proxy fail-closed, session-clone, stale lease/fence and command injection inputs.

#### Tiêu chí hoàn tất

- G3/G4 có Linux-runtime evidence thật.
- Critical/high security bugs không defer qua release.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

### T30 — Chaos, performance và UX regression

**Milestone:** M6 · **Priority:** MUST · **Dependencies:** T24, T27, T29, T11

**Đọc:** `docs/15-testing-evaluation.md` và `AGENTS.md`.

**Module bàn giao:** `tests/chaos`, `tests/e2e`, `release-evidence/G6`.

#### Cách thực hiện

1. Fault injection tất cả recovery windows và concurrency race bằng deterministic fixtures.
2. Đo API/event/UI/history/capacity trên hardware ghi rõ, không giả LLM latency.
3. Long transcript/IME/mobile/theme/accessibility và source component screenshot.

#### Kiểm thử phải có

- Recovery matrix, result dedup, counter commit order, cancel vs complete.
- Target latency and long history; ghi số đo/skips/hardware.

#### Tiêu chí hoàn tất

- Không automatic replay unsafe side effect.
- Targets không đạt phải có measured gap/ADR, không sửa report giả.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

### T31 — Backup/verify/restore và key recovery

**Milestone:** M6 · **Priority:** MUST · **Dependencies:** T28, T27, T23

**Đọc:** `docs/14-deployment-operations.md` và `AGENTS.md`.

**Module bàn giao:** `ops/backup`, `ops/restore`, `tests/restore`, `release-evidence/G7`.

#### Cách thực hiện

1. Quiescent snapshot DB+ObjectStore inventory+encrypted key recovery material.
2. Verify archive/hash/decryption, recovery locks/sessions/worker tokens revoked.
3. Fresh-machine restore, consistency checker, explicit execution re-enable.

#### Kiểm thử phải có

- Missing/corrupt key, missing artifact, interrupted backup, hash mismatch.
- Active Run restore không replay, re-enroll worker + new lab task.

#### Tiêu chí hoàn tất

- Backup created khác verified; fail exit nonzero.
- Restore drill có log/version/hash và measured time, không chỉ script exists.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

### T32 — Observability và diagnostic export

**Milestone:** M6 · **Priority:** MUST · **Dependencies:** T13, T17, T25

**Đọc:** `docs/17-observability-errors.md` và `AGENTS.md`.

**Module bàn giao:** `packages/observability`, `apps/web/operations`, `apps/api/diagnostics`.

#### Cách thực hiện

1. Structured safe logs/correlation/metrics, reason codes nhất quán UI/API.
2. Operations health/unknown effects/backup/key/disk banners.
3. Diagnostics bundle default excludes raw prompts/commands/evidence/secrets.

#### Kiểm thử phải có

- Log canary, high-cardinality labels, wrong request_id data, error schema.
- Disconnected SSE vs run state, diagnostics download access control.

#### Tiêu chí hoàn tất

- Không external telemetry mặc định.
- Owner tìm được request→attempt→artifact bằng IDs mà không secret leak.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

### T33 — CI/release hardening và source provenance

**Milestone:** M7 · **Priority:** MUST · **Dependencies:** T29, T30, T31, T32

**Đọc:** `docs/18-release-acceptance.md` và `AGENTS.md`.

**Module bàn giao:** `.github/workflows`, `ops/release`, `release-evidence`, `docs/licenses`.

#### Cách thực hiện

1. CI contracts/unit/integration/Go race/E2E/security runners, lockfiles và image digests.
2. SBOM/license inventory, release notes/known limits, migration compatibility.
3. Artifact build/checksum/signing process với keys không trong repo.

#### Kiểm thử phải có

- Fresh build từ lockfile, package/release smoke, dependency audit review.
- No skipped critical gates, no mock provider fallback production.

#### Tiêu chí hoàn tất

- G0–G7 matrix có trạng thái và file evidence.
- Không tự push/deploy bên ngoài khi owner chưa yêu cầu.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

### T34 — Owner acceptance và polish luồng dùng thật

**Milestone:** M7 · **Priority:** MUST · **Dependencies:** T33, T10, T26

**Đọc:** `docs/18-release-acceptance.md` và `AGENTS.md`.

**Module bàn giao:** `apps/web`, `docs/user-guide`, `release-evidence/owner-acceptance`.

#### Cách thực hiện

1. Chạy owner script toàn chuỗi create→Ask→Agent→pause/cancel→finding→report→retest→restore.
2. Sửa friction onboarding/error/help states theo test thực, không thêm scope mới.
3. Ghi limitation và cách chạy job hằng ngày cho owner.

#### Kiểm thử phải có

- Hai Project tách biệt, worker1 offline không nhảy worker2.
- App labels/data modes/cost unknown/human review đúng semantics.

#### Tiêu chí hoàn tất

- Owner xác nhận workflow dùng được; unmet gates không che giấu.
- No TODO trong critical happy/error path.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

### T35 — Live-model capability và quality eval tùy chọn

**Milestone:** M7 · **Priority:** OPTIONAL · **Dependencies:** T24, T29, T25

**Đọc:** `docs/15-testing-evaluation.md` và `AGENTS.md`.

**Module bàn giao:** `tests/evals`, `docs/model-baseline`.

#### Cách thực hiện

1. Chỉ khi owner đã cấu hình endpoint/key, chạy synthetic capability và lab20-case eval budget-capped.
2. Lưu model/version/config/prompt hashes, measured usage, numerator/denominator.
3. So sánh ground truth độc lập và ghi uncertainty/unsupported cases.

#### Kiểm thử phải có

- Không target ngoài lab hoặc dữ liệu bí mật.
- Unknown cost được ghi nhận, provider capability không giả.

#### Tiêu chí hoàn tất

- Task opt-in; thiếu key ghi NOT_RUN, không PASS.
- Kết quả không dùng quảng cáo benchmark chung từ mẫu nhỏ.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.

### T36 — Bàn giao phiên bản cá nhân

**Milestone:** M7 · **Priority:** MUST · **Dependencies:** T34

**Đọc:** `docs/18-release-acceptance.md` và `AGENTS.md`.

**Module bàn giao:** `README.md`, `CHANGELOG.md`, `implementation/STATUS.md`, `release-evidence`.

#### Cách thực hiện

1. Tổng hợp version/images/binary checksums, config/env, setup, upgrade, backup/recovery và known limits.
2. Đối chiếu requirements traceability; mọi MUST có implementation/test evidence.
3. Chuẩn bị repository/tag/release nội bộ; chỉ commit/push/deploy khi owner yêu cầu.

#### Kiểm thử phải có

- Cài từ hướng dẫn cuối cùng trên fresh machine/VM và chạy lab smoke.
- Không link/file thiếu; package không chứa secrets hoặc private user data.

#### Tiêu chí hoàn tất

- Ứng dụng và tài liệu nhất quán, owner tự vận hành/khôi phục được.
- T35 có trạng thái riêng, không giả đã benchmark model nếu chưa chạy.

Không đánh DONE khi mới có stub/UI mock hoặc khi test critical còn skipped. Ghi lệnh và đường dẫn evidence vào STATUS.md.


---


<a id="file-implementation-traceability-md"></a>


*Nguồn: `implementation/traceability.md`*


## Traceability yêu cầu → triển khai → nghiệm thu

Test IDs dưới đây là tên cần coding agent triển khai, không phải test đã chạy trong gói.

| Requirement | Yêu cầu | Task | Gate | Test ID |
|---|---|---|---|---|
| REQ-001 | Một owner, không public signup | T04 | G1 | `AUTH-singleton-race` |
| REQ-002 | Chat–Project–Agent và UI thật | T06, T09, T10 | G2 | `UI-real-backend` |
| REQ-003 | Project ownership closure | T02, T06 | G1 | `DATA-cross-project` |
| REQ-004 | File integrity và immutable evidence | T07, T25 | G5 | `FILE-hash-immutable` |
| REQ-005 | Ask không execution tools | T09 | G2 | `ASK-zero-task` |
| REQ-006 | Durable Run độc lập browser | T13, T11 | G2 | `RUN-reconnect` |
| REQ-007 | Idempotent create/message/approval | T09, T22 | G6 | `API-duplicate-requests` |
| REQ-008 | Scope/DNS một lần Project | T12 | G4 | `SCOPE-proof-reuse` |
| REQ-009 | Bốn approval modes đúng semantics | T22 | G4 | `POLICY-mode-matrix` |
| REQ-010 | Không tự authorize dependency/shared IP | T12, T20, T21 | G3 | `NET-shared-vhost` |
| REQ-011 | Worker đồng nhất và stable identity | T15, T19 | G3 | `WORKER-two-machines` |
| REQ-012 | Signed lease/session/fencing | T17 | G3 | `LEASE-tamper-stale` |
| REQ-013 | Không host shell/mount/docker socket | T18 | G3 | `SANDBOX-host-boundary` |
| REQ-014 | Không unsafe effect replay | T16, T17, T23 | G6 | `CHAOS-post-counter` |
| REQ-015 | Cancel có quiescence acknowledgement | T23 | G6 | `CANCEL-partition-race` |
| REQ-016 | Pause boundary và notes | T23 | G4 | `RUN-pause-note` |
| REQ-017 | Budget shared và unknown held | T14, T24 | G4 | `BUDGET-parallel-unknown` |
| REQ-018 | Context summary không mất authority/state | T24 | G4 | `SUMMARY-preserve-state` |
| REQ-019 | Secret không vào model/log/report | T05, T14, T26 | G3 | `PRIVACY-canary` |
| REQ-020 | Provider local_only không cloud fallback | T08, T14 | G4 | `MODEL-local-only` |
| REQ-021 | Browser authority/path scope guard | T21 | G3 | `BROWSER-inspected-proxy` |
| REQ-022 | Typed HTTP/DNS/redirect checks | T20 | G3 | `HTTP-dns-redirect` |
| REQ-023 | Finding verified có bằng chứng | T25 | G5 | `FINDING-no-evidence-deny` |
| REQ-024 | Report snapshot và sanitize | T26 | G5 | `REPORT-immutable-html` |
| REQ-025 | Retest unavailable là inconclusive | T26 | G5 | `RETEST-inconclusive` |
| REQ-026 | Export/import không grant/secrets active | T27 | G5 | `IMPORT-no-authority` |
| REQ-027 | Backup DB+files+key và restore thật | T31 | G7 | `RESTORE-fresh-machine` |
| REQ-028 | SSE không mất vì commit ordering | T11 | G6 | `EVENT-commit-inversion` |
| REQ-029 | Version/schema contracts TS và Go | T00, T03 | G0 | `CONTRACT-cross-language` |
| REQ-030 | Ops/errors safe và observable | T32 | G7 | `LOG-redaction` |
| REQ-031 | Default không external telemetry | T28, T32 | G7 | `OPS-no-telemetry` |
| REQ-032 | Hardening không tự downgrade | T18, T21, T29 | G3 | `GUARD-fail-closed` |
| REQ-033 | UI keyboard/mobile/error states | T10, T30 | G2 | `UI-responsive-ime` |
| REQ-034 | Không copy source/assets HackerAI | T00, T33 | G0 | `LICENSE-provenance` |
| REQ-035 | Release gates không mock/skip giả | T33, T34, T36 | G7 | `RELEASE-evidence` |
| REQ-036 | Đánh giá model có ground truth và uncertainty | T35 | OPTIONAL | `EVAL-20-cases` |
