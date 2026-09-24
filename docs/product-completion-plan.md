# Kế hoạch hoàn thiện redAI Personal v1

Ngày lập: **24/09/2026**. Cơ sở: đặc tả **1.0.0-draft.1** trong `specs/`.

Đây là kế hoạch triển khai và nghiệm thu, chưa phải báo cáo đã hoàn thành ứng dụng. Giữ nguyên mã **T00–T36**, dependency và phạm vi trong backlog gốc để có thể giao việc từng task, theo dõi tiến độ và đối chiếu bằng chứng.

**Cách triển khai đã chọn:** nhiều AI coding agents phối hợp, có một agent điều phối và tích hợp. [Kế hoạch phân công agents](agent-execution-plan.md) quy định từng đợt, phạm vi file, review và bàn giao; tối đa bốn agents hoạt động đồng thời trong phiên hiện tại, tính cả điều phối.

## 1. Điểm xuất phát và đích đến

Qua kiểm tra workspace hiện tại:

- Repository chưa có `apps/`, `packages/`, `worker/`, manifest ứng dụng hoặc bộ test ứng dụng. `README.md` ở root đang rỗng.
- Có bộ đặc tả sản phẩm, kiến trúc, API/schema, dữ liệu, worker, UI, kiểm thử và release gates.
- Backlog có **37 task: 36 MUST và 1 OPTIONAL là T35**. Trạng thái trong bộ đặc tả đều là `NOT_STARTED`.
- Báo cáo validation có sẵn chỉ xác nhận kiểm tra tĩnh bộ đặc tả; không chứng minh DB, ứng dụng, sandbox hoặc restore hoạt động. Lần lập kế hoạch này chưa chạy lại validator đó.
- Khi chốt kế hoạch, `specs/` hiện là thư mục untracked. Tài liệu/hợp đồng cần thiết cho triển khai phải được đưa vào cấu trúc nguồn được quản lý ở M0; không để CI hoặc người phát triển mới phụ thuộc vào thư mục chỉ có trên máy hiện tại. Thao tác commit chỉ thực hiện khi được owner yêu cầu.

**Đích hoàn thành:** một owner tự cài đặt, cấu hình model, quản lý Project, dùng Ask/Agent với worker thật, kiểm soát phạm vi và chi phí, giữ bằng chứng, tạo report/retest, rồi backup và khôi phục trên máy sạch.

Luồng nghiệm thu xuyên suốt:

`Cài đặt → đăng nhập → Project + file/notes → Ask → gắn worker → cấp scope → Agent → evidence → finding → report → retest → export → backup/restore`.

Giữ kiến trúc đã chốt: Next.js/React cho web; Fastify cho API; TypeScript runtime; Go worker trên Linux; PostgreSQL cho trạng thái và hàng đợi; Local ObjectStore cho file; SSE cho cập nhật UI. T00 mới xác minh và pin phiên bản cụ thể từ tài liệu chính thức hiện hành.

Phạm vi v1 là một owner, self-host, Chat–Project–Agent, worker đồng nhất và bốn approval modes. Team/billing, marketplace, MCP tùy ý, lịch chạy tự động, desktop native, shell có Internet tự do, raw TCP scanning và cloud bắt buộc nằm ngoài v1 theo baseline.

## 2. Các mốc bàn giao

| Mốc | Task | Kết quả người dùng hoặc người phát triển nhận được | Bằng chứng chính |
|---|---|---|---|
| M0 — Nền tảng | T00–T03 | Repo dựng lại được; migration chạy thật; contracts TS/Go nhất quán | Version manifest, build, DB migration, contract fixtures |
| M1 — Dữ liệu cá nhân | T04–T07 | Đăng nhập, Settings, Project, notes, file hoạt động và tồn tại sau restart | Auth/CSRF, cách ly Project, secret vault, checksum file |
| M2 — Chat dùng thử | T08–T11 | Ask với tài liệu; UI Chat/Workbench; tải lại trang vẫn giữ hội thoại | Browser E2E, DB persistence, SSE reconnect |
| M3 — Agent offline | T12–T19 | Agent thực thi công cụ offline trên worker thật, sinh artifact và phục hồi tác vụ | Lease/journal, restart, gVisor, offline isolation |
| M4 — Agent web có kiểm soát | T20–T24 | HTTP/browser trong phạm vi được cấp, duyệt lệnh, pause/cancel, subagent giới hạn | Lab trace, request counters, budget và cancellation |
| M5 — Kết quả công việc | T25–T27 | Evidence → finding → report → retest; tìm kiếm và export/import | Report snapshot, hash, roundtrip dữ liệu |
| M6 — Vận hành và độ bền | T28–T32 | Cài mới, nâng cấp, quan sát lỗi, backup/restore và chịu sự cố | Security/chaos suite, restore máy sạch, số đo thực |
| M7 — Bản cá nhân hoàn chỉnh | T33–T36 | Gói phát hành tái lập được; owner hoàn tất kịch bản sử dụng | G0–G7, owner acceptance, hướng dẫn và manifest |

M2 là bản **developer alpha** có thể thử trải nghiệm bằng mock model được ghi nhãn. M3 bổ sung thực thi offline thật. M5 là bản tích hợp đủ luồng chức năng để nghiệm thu trong lab. Chỉ gọi **Personal v1 dùng thật** sau M7 và toàn bộ gate bắt buộc đạt.

Mốc triển khai và release gate không tương đương một-một. Ví dụ G2 có bằng chứng từ T13 và T30, G0 còn cần provenance ở T33. Mỗi mốc tích lũy bằng chứng; chỉ đánh dấu một gate `PASS` khi đạt cả điều kiện trực tiếp trong bảng G0–G7 của tài liệu release và các requirement liên quan trong traceability. Không chỉ kiểm tra một trong hai nguồn.

## 3. M0 — Chốt nền tảng và nguồn hợp đồng

**Điều kiện bắt đầu:** bộ đặc tả hiện có. Mục tiêu là tạo nền có thể chạy và kiểm chứng trên máy khác.

| Task | Phụ thuộc | Công việc và đầu ra cụ thể | Điều kiện hoàn thành |
|---|---|---|---|
| T00 — Dependency/môi trường | — | Kiểm kê toolchain, Linux/runtime; xác minh phiên bản hỗ trợ; ghi `docs/dependency-baseline.md`, nguồn/license và chiến lược lockfile/image digest | Version cụ thể có nguồn và ngày kiểm tra; thiếu gVisor được ghi đúng là blocker execution lab |
| T01 — Monorepo/checks | T00 | Tạo pnpm workspace, Go module, env validation, health trạng thái thật, lint/format/typecheck/test/build; đưa tài liệu điều hành và nguồn hợp đồng từ gói spec vào vị trí được quản lý | Clean install/build tái lập được; domain không phụ thuộc UI/provider/Docker; hướng dẫn dev không cần model key |
| T02 — PostgreSQL | T01 | Chuyển DDL tham chiếu thành migration versioned; repository/transaction; composite FK, immutable data, active-run constraints và event counter | Apply trên PostgreSQL thật; fresh/upgrade smoke; chặn truy cập chéo Project và kiểm thử concurrent transaction |
| T03 — Contracts | T01 | Canonical schemas/OpenAPI ở `contracts/`; sinh TS/Go types; strict validation, formats và drift check; giữ `SPEC_LOCK` đồng bộ | Fixtures hợp lệ/sai cho kết quả nhất quán ở TS/Go; generated client/stub không trả thành công giả |

**Tổ chức nguồn:** theo tài liệu kiến trúc, đưa phần cần thiết của gói spec về root (`AGENTS.md`, `SPEC_LOCK.json`, `contracts/`, `docs/`, `adr/`, `implementation/`...). Ghi nguồn/phiên bản nhập và chuyển liên kết tương ứng. `specs/` hiện tại là gói tham chiếu đầu vào; sau nhập chỉ có một nguồn hợp đồng đang được chỉnh sửa. `packages/contracts/` chứa code sinh ra/adapter, không có bản schema sửa tay thứ hai. Giữ nguyên các thay đổi đang có của owner khi thực hiện việc nhập gói.

**Demo cuối mốc:** từ checkout sạch, cài bằng lockfile, khởi động DB, apply migration, chạy contract checks và build các process. Các lệnh cụ thể phải được tạo, chạy và ghi lại trong T01; hiện chúng chưa tồn tại.

## 4. M1 — Owner, Project và dữ liệu đáng tin cậy

**Điều kiện bắt đầu:** T02 và T03 đạt. Module chính: `apps/api`, `apps/web`, `packages/application`, `packages/db`, `packages/storage`.

| Task | Phụ thuộc | Công việc và đầu ra cụ thể | Điều kiện hoàn thành |
|---|---|---|---|
| T04 — Owner/session | T02, T03 | Bootstrap CLI một owner/Workspace/Inbox; mật khẩu qua stdin; recovery; login/logout, cookie/session, CSRF/Origin, rate limit | Bootstrap đồng thời chỉ tạo một owner; session hết hạn/reset bị thu hồi; worker token không dùng được owner API |
| T05 — Secrets/Settings | T04 | Vault mã hóa AEAD, master key file, credential references; provider/data mode/pricing configs có version; Settings có conflict handling | Sai key/AAD bị từ chối; mất key sau restart không tự tạo key thay thế; API/log không lộ secret |
| T06 — Project/Chat/notes | T04, T03 | CRUD/archive, Inbox, notes được chọn vào context, Chat metadata, pagination/revision, cấu hình worker binding | Thay UUID không đọc được Project khác; archive giữ dữ liệu; state loading/empty/error/saved phản ánh backend |
| T07 — File/ObjectStore | T06 | Upload staging → kiểm size/type/hash → atomic finalize; authenticated download; parser có giới hạn; safe preview và xử lý orphan | Sai hash/traversal/symlink/disk full bị xử lý; crash không tạo artifact ready thiếu bytes; không tải external references |

**Demo cuối mốc:** đăng nhập, tạo hai Project, thêm ghi chú và file, restart dịch vụ rồi đọc lại. Kiểm tra một request cố truy cập file Project khác bị từ chối. Chưa có model vẫn quản lý dữ liệu được; UI giải thích phần AI chưa sẵn sàng.

**Đầu ra UX:** `/login`, phần đầu `/setup`, Project overview/files/settings và Settings bảo mật/provider.

## 5. M2 — Chat/Ask dùng được từ đầu đến cuối

**Điều kiện bắt đầu:** dữ liệu M1 sẵn sàng. Đây là mốc thử trải nghiệm sớm đầu tiên.

| Task | Phụ thuộc | Công việc và đầu ra cụ thể | Điều kiện hoàn thành |
|---|---|---|---|
| T08 — Provider | T05, T03 | Scripted mock và compatible adapter cho text/tools/stream/cancel/usage; synthetic capability probe; mapping timeout/rate limit | CI chạy không cần key; malformed output không dispatch; local_only không tự chuyển cloud; unknown usage được giữ rõ |
| T09 — Durable Ask | T06, T07, T08 | Transaction tạo message/run; context từ file/notes được chọn; persist partial/final output, generation ID, pagination và idempotency | Double-click/retry tạo một run; đóng browser/restart API không mất lịch sử; Ask không tạo task thực thi |
| T10 — Chat/Workbench | T06, T09 | Sidebar Project/Chat, composer Ask/Agent, attachments, theme/i18n; tabs Plan/Activity/Files/Findings/Usage nối state thật; keyboard/IME | UI sử dụng API thật; Markdown được sanitize; responsive và long transcript không phá thao tác |
| T11 — SSE/reconnect | T02, T09, T10 | Event journal cùng transaction; workspace cursor theo commit; replay/dedup, snapshot recovery, slow-client handling | Disconnect/reconnect và commit đảo thứ tự không bỏ event; retry không tạo run mới; lịch sử không biến thành rỗng |

**Demo cuối mốc:** chọn file OpenAPI và notes, Ask tóm tắt, đóng tab giữa stream, mở lại đúng hội thoại. Thử provider lỗi, SSE rớt và gửi lặp; UI hiển thị kết quả thực. Mock provider luôn có nhãn; adapter thật được kiểm thử protocol mà không buộc gọi dịch vụ trả phí.

**Nghiệm thu giao diện:** 1440×900, 1024×768, 390×844; dark/light; tiếng Việt và IME; focus/keyboard; output dài; 1.000 messages fixture. T30 đo và hồi quy lại trên sản phẩm tích hợp.

**Phản hồi owner cần ở mốc này:** việc tìm Project/Chat, đính kèm nguồn, đọc trả lời và mở Workbench có thuận tiện hay không. Ghi vấn đề UX để sửa, không mở thêm module ngoài baseline.

## 6. M3 — Agent bền vững và worker offline thật

**Điều kiện bắt đầu:** Chat/persistence/contracts ổn định. Đây là phần nền khó nhất của runtime; hoàn thành luồng offline trước khi nghiệm thu công cụ mạng.

| Task | Phụ thuộc | Công việc và đầu ra cụ thể | Điều kiện hoàn thành |
|---|---|---|---|
| T12 — Scope/grants | T06, T03 | Normalize domain, exclusions/lab zones, DNS proof một lần/Project, grant version và revoke epoch; policy reason codes | Policy vectors TS/Go thống nhất; Chat mới tái dùng proof còn hiệu lực; dependency discovery không cấp quyền |
| T13 — Agent/checkpoint | T09, T11, T12 | Runtime claim lease/fence; plan/step, stable tool_call_id, checkpoint, CAS commit, step/time/loop limits | Restart tại boundary không tạo logical call mới; runtime cũ không commit bằng fence hết hiệu lực |
| T14 — Budget/privacy | T13, T05 | Context manifest, redaction, token cap; reservation trước model request; ledger chung; measured/estimated/unknown usage | Requests cạnh tranh không vượt reservation; mất usage không thành cost=0; canary không vào model/log |
| T15 — Worker identity | T04, T03 | Enrollment token một lần; stable identity, rotation, session generation/heartbeat; list/bind/drain/revoke | Restart giữ identity; bản sao identity và token hết hạn bị xử lý; lost-response retry đúng intent |
| T16 — Journal/supervisor | T15 | Journal/spool bền vững, single-instance lock, container labels/start intent, watchdog và orphan reconciliation | Crash sau start không chạy container thứ hai; spool full được chặn; kết quả chưa rõ giữ unknown |
| T17 — Scheduler/lease/results | T12, T13, T15, T16 | Claim transaction/capacity/binding; signed leases và input hash; renewal; ACK/result dedup; quarantine conflict | Chữ ký/session/fence/grant cũ bị từ chối; result lặp không tạo effect mới; không chuyển task mơ hồ sang worker khác |
| T18 — Offline sandbox | T16, T17 | Docker/runsc, non-root, resource limits, filesystem isolation, network none, doctor checks | Linux lab chứng minh không truy cập host/socket/metadata; thiếu runsc hoặc image sai thì từ chối thực thi |
| T19 — Offline tools/artifacts | T18, T07 | File tools, terminal offline, OpenAPI parser, typed input/output, registry effects, provenance upload/finalize | Agent → worker → tool → artifact → summary chạy thật; hai worker cùng toolbox chạy fixtures nhất quán |

**Chia thành ba đợt kiểm chứng nhỏ:**

1. Runtime/policy: T12 → T13 → T14; recovery bằng mock transport.
2. Worker: T15 → T16; kiểm chứng identity, journal, watchdog độc lập với model.
3. Tích hợp: T17 → T18 → T19; kiểm chứng sandbox và artifacts trên Linux thật.

Hai nhánh đầu có thể phân công riêng khi có người phụ trách và không sửa chồng contracts. Mốc chỉ hoàn thành khi cả hai được tích hợp, không lấy việc một nhánh đã chạy làm bằng chứng toàn luồng.

**Demo cuối mốc:** Agent phân tích bộ file fixture offline, tạo artifact, dừng/restart runtime và worker ở các điểm kiểm thử rồi đọc lại trạng thái. Kiểm tra không chạy lặp tác vụ và không có mạng ra ngoài. Nếu thiếu Linux/gVisor, phần execution ghi `BLOCKED`; code/mocks đã chạy vẫn ghi bằng chứng riêng.

## 7. M4 — HTTP/browser, quyền thực thi và điều khiển phiên

**Điều kiện bắt đầu:** luồng M3 đạt; có lab target riêng và evidence về isolation. Module chính: worker adapters/proxy, policy/runtime và UI điều khiển Run.

| Task | Phụ thuộc | Công việc và đầu ra cụ thể | Điều kiện hoàn thành |
|---|---|---|---|
| T20 — HTTP adapter | T17, T19 | Typed request; URL normalization, DNS pinning, TLS verification, redirect từng hop; secret injection đúng origin; size/time caps | DNS/redirect/Host/SNI sai bị chặn; POST counter không tăng hai lần khi mất result ACK |
| T21 — Browser/proxy | T20 | Run-local CA, proxy kiểm tra authority/path từng request; browser chỉ đi qua proxy; session affinity; screenshot/DOM evidence | Hai vhost chung IP vẫn cách ly; subresource/WS/WebRTC/direct egress bị kiểm soát; proxy lỗi thì không có đường mạng thay thế |
| T22 — Approval | T12, T13, T17, T10 | Bốn modes; fingerprint hành động, expiry, approve/reject một lần; card đủ target/effect/worker và trạng thái stale | Hai tab approve chỉ tạo một attempt; grant/worker/args thay đổi làm approval cũ vô hiệu; deny không bị biến thành allow |
| T23 — Pause/cancel/reconcile | T17, T19, T22 | Pause tại boundary; cancel tới worker/children/proxy; theo dõi dừng thật; xử lý unknown effects và continuation | Stop không chỉ ngắt stream; mất worker giữ cancellation_pending khi phù hợp; cancel/result race không báo dừng sai |
| T24 — Subagents/context | T14, T23 | Tối đa hai child, depth một; tools subset, workspace riêng, budget chung; compaction có schema và giữ context cần thiết | Không delegation đệ quy hoặc nhân budget; parent không kết thúc khi child chưa xử lý; summary không thay trạng thái quyền |

**Thứ tự thực hiện khuyến nghị trong M4:** hoàn thành T22 trước, sau đó cho T23 và T20 phát triển song song theo file ownership; T21 theo T20, T24 theo T23/T14. Chỉ chạy demo mạng tích hợp khi đường duyệt, dừng và đối soát đã đạt. Đây là thứ tự theo dependency gốc, không lấy sự hoàn thành một adapter làm bằng chứng toàn workflow.

T23 kiểm chứng cancellation fan-out bằng fixtures/transport doubles cho thành phần chưa có. Khi browser và subagents được tích hợp, T21/T29 phải chứng minh revoke proxy thật; T24/T30 phải chứng minh child cancellation và budget thật. Bằng chứng giả lập ở task sớm không thay cho kiểm thử toàn luồng đến sau.

**Kiểm chứng sớm T21:** khi T18 xong, chuẩn bị một thử nghiệm tương thích Chromium–runsc–proxy trong lab. Kết quả thử nghiệm dùng để phát hiện blocker môi trường; không thay tiêu chí DONE của T21 và không bật browser execution ngoài lab.

**Demo cuối mốc:** với fixture origin đã grant, Agent chạy HTTP và browser, gặp yêu cầu approval, pause/resume, rồi cancel. Thu hồi grant lúc trang có background requests; request tiếp theo phải bị từ chối. Chạy hai child cạnh tranh ngân sách và quan sát ledger.

## 8. M5 — Biến kết quả thành hồ sơ công việc

**Điều kiện bắt đầu:** tool/evidence paths có dữ liệu thật và cancellation/reconciliation hoạt động.

| Task | Phụ thuộc | Công việc và đầu ra cụ thể | Điều kiện hoàn thành |
|---|---|---|---|
| T25 — Findings/evidence | T19, T20, T07 | Candidate, revisions/status/severity/confidence; provenance; evidence gate; review high/critical; gợi ý trùng lặp | Verified phải có evidence ready đúng Project và nguồn; sửa wording không sửa bytes/hash evidence; confidence không tự đổi severity |
| T26 — Report/retest | T25, T23 | Chụp finding versions/coverage/scope thành snapshot; xuất Markdown/JSON/HTML offline; retest tạo Run mới | Report cũ không đổi sau edit; HTML không chạy nội dung đích; target unavailable hoặc thiếu credential thành inconclusive |
| T27 — Search/export/import | T26, T07 | Full-text theo Project; ZIP manifest/hash; bỏ secret/session/quyền active; UUID remap và staged import | Search không rò Project/secret; chặn archive path/bomb/hash sai; roundtrip giữ nội dung, grant nhập về chưa active |

**Demo cuối mốc:** từ evidence lab tạo finding, review, xuất report; sửa finding và đối chiếu report cũ. Retest fixture đã sửa và fixture mất kết nối. Export Project, import thành Project mới, kiểm hash/provenance và quyền chưa được kích hoạt.

**Đầu ra người dùng:** Findings, report download, retest workflow và search có thể dùng cho hồ sơ công việc thật khi toàn bộ release gates đã đạt.

## 9. M6 — Cài đặt, khôi phục và vận hành

**Điều kiện bắt đầu:** đủ luồng lõi cho test tích hợp. Logging an toàn, migrations và unit tests được làm từ task đầu; M6 hoàn thiện công cụ vận hành và kiểm chứng toàn hệ thống.

| Task | Phụ thuộc | Công việc và đầu ra cụ thể | Điều kiện hoàn thành |
|---|---|---|---|
| T28 — Deploy/doctor | T19, T05 | Compose control plane/volumes/proxy, worker service; migration order; doctor, drain, upgrade/rollback/emergency stop; private HTTPS | Cài sạch bằng hướng dẫn và image build thực; missing key/config/runtime bị báo rõ; DB không mở công khai |
| T29 — Security lab | T20, T21, T22, T23, T28 | Resolver/vhosts/counters/canaries và fixture storage; chạy policy, isolation, signature, session và secret tests | Có Linux-runtime evidence; không scope bypass, secret canary leak hoặc verified claim thiếu chứng cứ trong suite |
| T30 — Chaos/performance/UX | T24, T27, T29, T11 | Fault injection API/runtime/worker/DB/storage; concurrency; benchmark phần mềm tích hợp; responsive/IME/a11y regression | Không replay unsafe effect; công bố số đo/hardware/skips; xử lý gap hoặc ADR thay đổi target có chấp nhận |
| T31 — Backup/restore | T28, T27, T23 | Quiescent backup DB + files + vật liệu khôi phục key đã mã hóa; verify archive; restore máy sạch; revoke phiên/token/lease cũ | Restore đọc đúng file/hash, không tự chạy lại Run; re-enroll worker và chạy lab task mới; có thời gian đo thật |
| T32 — Quan sát/chẩn đoán | T13, T17, T25 | Correlation IDs, safe logs/metrics/reason codes; Operations health; diagnostic bundle đã lọc | Truy request → attempt → artifact bằng IDs; diagnostics không lộ raw content/secrets; không telemetry ngoài mặc định |

T28 có thể bắt đầu sau M3 khi dependencies đã đạt; T32 có thể bắt đầu sau T25. Chuẩn bị runner Linux, đĩa backup và máy/VM restore sớm để tránh chờ đến cuối mới phát hiện thiếu hạ tầng. Security cases được thêm theo từng boundary từ M1–M4; T29 gom bằng chứng tích hợp, không phải lần đầu kiểm tra bảo mật.

**Targets từ đặc tả, chưa phải số đo đã đạt:**

| Chỉ tiêu | Mục tiêu nghiệm thu |
|---|---|
| API CRUD | p95 ≤ 500 ms; tách provider latency và upload |
| Event tới UI | p95 ≤ 1 giây sau commit |
| Cancel với worker khỏe | ACK mục tiêu ≤ 10 giây |
| Local lease khi mất kết nối | Expiry tối đa 45 giây + kill grace 5 giây; server vẫn không giả biết tác vụ đã dừng |
| Lịch sử | Pagination 10.000 messages; UI tương tác với fixture dài, không tải toàn bộ |
| Restore | Bộ dữ liệu 10 GiB, mục tiêu ≤ 60 phút trên cấu hình ghi nhận |
| Phạm vi và bằng chứng | 0 scope bypass; 0 canary leak; 0 verified finding thiếu evidence; 0 unsafe auto-replay trong bộ test |

**Demo cuối mốc:** cài trên môi trường sạch, chạy công việc lab, chèn lỗi có kiểm soát, backup/verify, restore ở môi trường mới, đọc evidence và chạy task mới bằng worker được enroll lại.

## 10. M7 — Nghiệm thu và bàn giao

**Điều kiện bắt đầu:** các suite bắt buộc có bằng chứng; lỗi critical/high ở ranh giới thực thi đã được xử lý.

| Task | Phụ thuộc | Công việc và đầu ra cụ thể | Điều kiện hoàn thành |
|---|---|---|---|
| T33 — CI/release | T29, T30, T31, T32 | CI contracts/lint/typecheck/unit/DB/Go race/E2E/security; lockfile, digests, SBOM/license, checksum/signing; release notes/known limits | Build sạch tái lập; gate matrix có evidence và trạng thái thật, kể cả mục còn chờ owner; production không fallback mock |
| T34 — Owner acceptance | T33, T10, T26 | Owner chạy hành trình đầy đủ, hai Project, worker offline, dữ liệu/usage labels; sửa lỗi thao tác và tài liệu | Owner xác nhận luồng dùng được; không TODO trong critical happy/error paths; chốt bằng chứng G7 liên quan owner |
| T35 — Live-model eval | T24, T29, T25 | **OPTIONAL, opt-in:** provider đã cấu hình, synthetic/lab 20 cases, budget cap, lưu model/config/prompt hashes và usage | Ground truth độc lập; số đếm và giới hạn rõ; chưa chạy ghi NOT_RUN, không PASS |
| T36 — Bàn giao | T34 | README/user guide, changelog, version/images/binary checksums, config, upgrade/backup/recovery/known limits; traceability cuối | Mọi MUST và G0–G7 đạt; cài theo hướng dẫn trên máy sạch; owner tự vận hành/khôi phục được |

T35 là đánh giá chất lượng model mở rộng, không phải điều kiện để hoàn thành các core suite deterministic. Tuy vậy bước cấu hình/probe model và trải nghiệm AI của owner trong T34 vẫn phải được kiểm chứng, không dùng việc T35 tùy chọn để gọi một bản chỉ có mock là Personal v1 hoàn chỉnh.

Gói bàn giao được chuẩn bị và kiểm tra trong repository. Commit/push/tag/publish/deploy bên ngoài là hành động riêng theo yêu cầu của owner; kế hoạch này không tự thực hiện các hành động đó.

## 11. Tiến độ giao diện theo chức năng thật

| Khu vực | Lần đầu hoàn thiện luồng | Phần bổ sung/hồi quy |
|---|---|---|
| Login/Setup/Settings | T04–T05 | Health provider T08, worker T15, Operations T32 |
| Project/Chat navigation | T06, T09–T10 | Search/archive/import T27, UX T30 |
| Files/notes | T06–T07 | Artifacts T19, evidence T25 |
| Composer/Ask/streaming | T09–T11 | Agent/budget T13–T14, controls T22–T23 |
| Workbench Plan/Activity/Files | Shell T10 | Dữ liệu thực thi T13, T17, T19, T23 |
| Workbench Usage | Shell T10 | Reservation/unknown usage T14, child budget T24 |
| Workers/Project scope | T12, T15 | Doctor T18/T28, binding/revoke/lease T17 |
| Approval và Stop | T22–T23 | Network/subagent races T24/T29–T30 |
| Findings/Reports/Retest | T25–T26 | Export/import T27, owner review T34 |
| Operations/Backup/Diagnostics | T28, T31–T32 | Restore drill, release và owner guide T33–T36 |

Mỗi luồng có loading, empty, error, success và trạng thái chưa đủ điều kiện khi thích hợp. Success phải theo backend commit. Tên gọi phản ánh đúng thực tế: local worker khác local model; no verified finding không kết luận target an toàn; cancel_requested khác canceled.

## 12. Cách giao và theo dõi từng phần

**Đơn vị giao việc là task Txx.** Task dài chia thành các lát triển khai nhưng giữ nguyên tiêu chí DONE của task cha. Ví dụ T21 có thể chia thành proxy/policy, browser routing, evidence/session và integration lab; hoàn thành một lát chưa hoàn thành T21.

Quy trình cho mỗi task:

1. Đọc task card, invariants, schema và ADR liên quan; xác minh dependencies đã đạt bằng code/evidence.
2. Ghi kế hoạch ngắn: module/file ownership, hành vi người dùng, tình huống lỗi/race và bằng chứng cần có.
3. Viết test cho boundary/race quan trọng; triển khai luồng có persistence và UI nếu task yêu cầu.
4. Chạy checks nhỏ trước, rồi integration/E2E/lab tương ứng. Lưu command, commit hoặc trạng thái working tree, môi trường, kết quả và artifact path.
5. Review thay đổi, cập nhật contracts/docs/traceability nếu cần; ghi điều còn thiếu. Chỉ chuyển DONE khi đạt toàn bộ tiêu chí.

**Checks theo loại thay đổi**, áp dụng trong quá trình triển khai và trước PR/milestone theo chỉ dẫn đặc tả:

| Loại thay đổi | Kiểm chứng cần có |
|---|---|
| Nền chung | Contract lint, format/typecheck và unit/integration suite liên quan |
| Go/worker | Test module liên quan và `go test -race ./...` tại Go module trước PR/milestone |
| API | Auth, strict schema, idempotency và concurrent requests |
| State machine | Transition, duplicate, reordering và race/recovery phù hợp |
| UI | Browser E2E, responsive và kiểm tra giao diện trực tiếp bằng component/CSS thật |
| Sandbox/policy | Fail-closed và egress thực tế trong Linux lab; fixtures đơn thuần chưa đủ |

Chỉ ghi PASS cho lệnh đã chạy thành công. Thiếu hạ tầng thì ghi BLOCKED với lệnh và điều kiện cần, không dùng skipped test để đóng task.

Sau khi nhập bộ spec ở M0, dùng `implementation/STATUS.md` làm sổ tiến độ duy nhất của ứng dụng. Không ghi task ứng dụng DONE chỉ vì đã lập kế hoạch này.

Mẫu một dòng tiến độ:

| Task | State | Phần đã làm | Checks/evidence | Blocker/bước tiếp theo |
|---|---|---|---|---|
| Txx | NOT_STARTED / IN_PROGRESS / BLOCKED / DONE | Hành vi đã có, commit nếu có | Lệnh thực chạy + đường dẫn kết quả | Điều kiện còn thiếu + cách tháo gỡ |

Đề xuất lưu bằng chứng vào `release-evidence/Txx/` và gate matrix ở `release-evidence/gates.md`. Lưu log đã che secret, screenshot UI thật, manifest/hash và số đo; chỉ định artifact CI nếu file quá lớn cho repository. Test bị skip, chưa có hạ tầng hoặc chưa chạy phải được ghi riêng. T35 chưa opt-in dùng `NOT_RUN`.

**Phân công AI agents:** một coordinator quản lý DAG, file ownership, tích hợp và gate evidence; tối đa ba agents còn lại nhận task coding hoặc review độc lập. Sau T01 tách DB T02 và contracts T03; sau T04 mở các nhánh Settings/Project/worker; sau T13 tách budget và scheduler nếu ownership không chồng nhau. Agent vừa viết phần nào không tự làm reviewer độc lập cho phần đó. [Lịch phân công chi tiết](agent-execution-plan.md) là thứ tự khởi đầu; chỉ dispatch khi dependencies thực tế đã đạt.

## 13. Rủi ro và cách giảm chờ đợi

| Rủi ro | Phát hiện sớm ở đâu | Việc cần làm | Điều kiện chặn |
|---|---|---|---|
| Spec chỉ có ở workspace, chưa vào nguồn quản lý | T00–T01 | Nhập nguồn cần thiết, giữ mapping và kiểm tra checkout sạch khi có bản nguồn được ghi nhận | T03/CI không được phụ thuộc file ngoài nguồn quản lý |
| DDL/API/schema khác nhau | T02–T03 | Apply DB thật, fixtures TS/Go, contract drift; ghi quyết định nhỏ nhất nếu mâu thuẫn | Không nới invariant để làm test xanh |
| Chromium/runsc/proxy không tương thích | Chuẩn bị sau T18 | Thử nghiệm lab sớm, ghi versions và lỗi tái hiện | Chặn T21 và các gate execution phụ thuộc |
| Crash làm lặp HTTP effect | T16–T17, T20, T23 | Journal/fence, result dedup, unknown state; harmless POST counter | Không tự retry effect chưa rõ kết quả |
| Secret ra model/log/report | T05, T07–T08, T14, T26 | Canary tests ở mọi đường serialize/preview/export | Chặn gate tương ứng cho tới khi sửa |
| Chi phí không có usage hoặc chạy song song | T14, T24 | Reservation, shared ledger, trạng thái unknown có giữ ngân sách | Không hiển thị chi phí 0 giả hoặc bỏ budget |
| Backup thiếu bytes/key | Thiết kế từ T07/T28; drill T31 | Inventory/hash, key recovery, restore máy sạch | G7 chưa đạt dù backup command thành công |
| Giao diện đẹp nhưng chưa dùng được | M2 và mỗi mốc | Demo qua API/DB/runtime thật với error paths | Không DONE bằng screenshot/mock success |
| Mở rộng phạm vi quá sớm | Review mỗi mốc | Giữ danh sách ngoài v1, đề xuất ADR khi có nhu cầu thực | Không làm trễ core bằng billing/plugin/team |

Khi một nhánh bị chặn hạ tầng, tiếp tục các task độc lập có dependencies đã đạt. Không đánh dấu milestone hoặc gate phụ thuộc là hoàn thành.

## 14. Gói việc khởi động ngay sau kế hoạch

**Lượt triển khai đầu tiên nên tập trung M0, theo thứ tự:**

1. T00: kiểm kê môi trường; xác minh/pin versions; ghi baseline, license inventory và execution-lab blockers.
2. T01: nhập tài liệu điều hành/hợp đồng cần quản lý; dựng workspace/process skeleton; tạo quality commands và hướng dẫn dev.
3. T02 và T03: migration thật và TS/Go contract checks; độc lập sau T01, tích hợp trên cùng baseline trước chốt mốc.
4. Tổng kết M0 bằng log thực chạy, file thay đổi, gate evidence còn thiếu và task tiếp theo T04.

**Đầu ra tối thiểu của M0:** source layout chạy được; migration apply trên DB thật; contracts kiểm thử được; baseline/lockfiles; README dev; `implementation/STATUS.md` có bằng chứng. Không kéo UI trang trí, công cụ mạng hoặc live model vào lượt khởi động này.

**Lập lịch:** dùng các đợt dependency trong kế hoạch agents, không ước lượng bằng cách chia số task cho số agents. Sau M0 ghi thời gian thực của coding, test, review và sửa lỗi để dự báo M1–M2; cập nhật dự báo sau M2 và thử nghiệm browser/gVisor. Hiện chưa có năng suất hoặc môi trường execution đã đo để cam kết ngày phát hành.

## 15. Tài liệu nguồn để thực hiện

Các liên kết dưới dùng vị trí gói spec hiện có trên workspace; T01 cập nhật sang vị trí canonical sau khi nhập gói.

- [Baseline và phạm vi v1](../specs/docs/01-product-baseline.md).
- [PRD và user stories](../specs/docs/02-prd-use-cases.md).
- [UX/UI](../specs/docs/03-ux-ui-spec.md) và [kiến trúc/repository](../specs/docs/04-architecture-repository.md).
- [Backlog/dependency đầy đủ](../specs/implementation/tasks.json) và [task cards](../specs/implementation/task-cards.md).
- [Requirements và traceability](../specs/implementation/traceability.md).
- [Chiến lược kiểm thử](../specs/docs/15-testing-evaluation.md), [release gates](../specs/docs/18-release-acceptance.md), [deployment checklist](../specs/ops/deployment-checklist.md).
- [Chỉ dẫn triển khai](../specs/AGENTS.md), [SPEC_LOCK](../specs/SPEC_LOCK.json) và [trạng thái ban đầu](../specs/implementation/STATUS.md).
