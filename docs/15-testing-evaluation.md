# 15 — Chiến lược kiểm thử và đánh giá Agent

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

## 1. Tách ba loại bằng chứng

**Contract validation** chứng minh schema/DDL/refs hợp lệ về cấu trúc. **Application tests** chứng minh code xử lý use case/race theo đặc tả. **Execution lab tests** chứng minh sandbox/mạng/cancel thực sự hoạt động trên Linux/runtime đã chọn. Không lấy loại đầu thay cho hai loại sau. Gói đặc tả hiện chỉ được kiểm tra theo báo cáo `VALIDATION_REPORT.md`, không có kết quả thực thi sản phẩm.

## 2. Test pyramid

Unit tests cho domain transition, normalization, policy, money arithmetic, context construction và redaction. Integration tests dùng PostgreSQL thật/Local ObjectStore thật, không mock repository khi kiểm tra transaction/constraint. Contract tests dùng cùng fixture cho TypeScript và Go. E2E dùng browser thật với API/runtime thật và mock model deterministic. Execution suite dùng worker Linux thật với gVisor, network lab và fake targets; không mục tiêu ngoài phạm vi.

Mock model phải scripted: lượt1 tạo plan/tool call, lượt2 đọc result, lượt3 candidate/summary; có variant malformed JSON, duplicate provider_tool_index, timeout, refusal, partial stream và unknown usage. Không dùng output stochastic của LLM thật để quyết định CI pass cơ bản. Live-model eval là suite opt-in riêng có budget cap.

## 3. Các test nhóm core

AUTH: singleton owner race; password reset revokes; CSRF; session expiry; worker bearer không có owner privileges. DATA: composite FK closure; revision conflict; scope immutable; artifact immutable; Project delete batch resume. API: strict schema/unknown fields; body caps; idempotency duplicate/inflight/body conflict; cursor/filter mismatch. SSE: commit-order inversion simulation, duplicate delivery, slow client, disconnect, cursor purge, snapshot/replay race.

RUN: two runtimes same run; stale fence; model output before commit; restart every boundary; maximum active run; paused/expired lifecycle; child budgets shared. WORKER: envelope tamper; stale session; expired lease; duplicate result; conflicting result; disk full; journal crash; no replay after network effect; manual selected worker no fallback.

## 4. Security execution tests

Filesystem: traversal, symlink at export, unsafe archive paths, host mount absence, no Docker socket. Network: direct egress denied; loopback/metadata/control-plane denied; IPv6 path blocked consistently; DNS rebind; redirect chain; two virtual hosts same IP; hostile browser page requests foreign origin; QUIC/WebRTC attempts; proxy failure means deny. Auth: target content cannot access worker bearer, target secret limited origin. TLS upstream invalid cert fails, browser pinning unsupported flagged.

Chỉ đưa payload fixture tối thiểu để chứng minh policy, không cần xây exploit thực tế. Lab endpoints có thể ghi request counter và harmless side-effect counter để phát hiện duplicate POST. Tests không gửi traffic tới production/company domains. Bất kỳ test tạo tải đều bounded và chỉ fixture-local.

## 5. Chaos matrix và kết quả mong đợi

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

## 6. Đánh giá chất lượng nhận định

Dataset lab tối thiểu20 tình huống:8 có vấn đề cấu hình quan sát được,8 negative gần giống,4 không đủ dữ liệu/không truy cập được. Dữ liệu ground truth phải owner/reviewer kiểm tra độc lập; model không sinh cả đề và nhãn rồi tự chấm. Không dùng số này làm benchmark thị trường.

Đo finding precision/recall khi ground truth phù hợp, false-positive count, tỷ lệ evidence_supported, unsupported verification claims, task_completion, coverage completeness, median/p95 latency và measured/unknown cost. Inconclusive là một lớp kết quả có ích, không luôn tính như failure. Precision có mẫu nhỏ phải hiển thị numerator/denominator, không chỉ phần trăm đẹp.

Release gate bắt buộc:0 scope bypass;0 secret canary leak trong fixture;0 verified finding thiếu evidence;0 duplicate unsafe side effect do auto replay trong suite. Chất lượng model trên lab cần owner review và lưu nhận xét; không tự chọn ngưỡng90% rồi giả đã đạt. Các ngưỡng độ chính xác định lượng chỉ được chốt sau có baseline thật.

## 7. Performance target, không benchmark đã có

Trên cấu hình lab tham chiếu tài liệu04: API CRUD p95≤500ms khi không tính provider/upload; event visible p95≤1s sau commit;10.000 messages có pagination không tải toàn bộ;1.000 timeline rows không làm composer lag rõ. Hai active Runs và hai workers có thể chạy fixture đồng thời không oversubscribe. Đo UI bằng tooling, không dùng cảm giác hoặc synthetic mock page khác component thật.

Các target có thể cần điều chỉnh sau benchmark; nếu không đạt, ghi numbers/hardware và ADR thay đổi chứ không sửa report thành “đạt”. Không target latency cho LLM provider ngoài quyền kiểm soát mà không tách riêng.

## 8. CI mục tiêu

Stage contracts → lint/typecheck → unit → DB integration → Go race tests → browser E2E → security lab trên runner chuyên biệt → build/SBOM. Không mọi PR cần live-model eval. Integration DB lên/down bằng isolated test database; migration fresh và upgrade path đều test. Network policy suite chỉ runner Linux đã chuẩn bị, job không có production credentials.

CI report ghi lệnh, git commit, versions, test count, skipped tests và artifacts. Flaky test được quarantine có owner/issue, không âm thầm bỏ khỏi release gate. Coverage là chỉ dấu tìm vùng chưa test, không yêu cầu tỷ lệ cao để thay việc test invariants.
