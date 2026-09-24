# 18 — Release gates và định nghĩa hoàn tất

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

## 1. Các mức hoàn thành

Prototype chứng minh UI hoặc một luồng; developer alpha có persistence/mocks; personal release có worker thật, scope/network tests, recovery và owner acceptance. Chỉ mức cuối được gọi redAI Personal v1 sử dụng thật. Các `MUST` trong đặc tả và gate dưới đây là điều kiện release; SHOULD không bắt buộc nếu được ghi rõ ở release notes.

## 2. G0–G7

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

## 3. Owner acceptance script

Đăng nhập hệ thống mới. Cấu hình model bằng key riêng hoặc local endpoint và xem rõ data policy. Tạo Project lab, thêm file OpenAPI và notes. Enroll worker1, chọn nó, chạy Ask tóm tắt tài liệu. Chạy Agent trên fixture origin đã grant; xem plan/tool/evidence. Đóng browser, mở lại thấy đúng Run. Pause/resume, đổi sang high-risk approval trong Run mới và verify card. Revoke grant lúc task chạy và xác nhận không request mới vượt policy.

Tạo candidate với evidence, review thành verified, tạo report, sửa finding và kiểm tra report cũ không đổi. Retest fixture đã sửa, rồi fixture unavailable để thấy inconclusive. Export/import Project, kiểm tra secrets/grants không active theo import. Backup verified, restore máy sạch, re-enroll worker, đọc lại evidence và chạy task lab mới.

## 4. Mục tiêu đo lường release

Control-plane CRUD p95≤500ms và event propagation p95≤1s trên lab tham chiếu, không tính model latency. UI long history vẫn tương tác được. Cancel acknowledgment healthy worker mục tiêu≤10s, hard local lease expiry≤45s cộng kill grace5s; outage server không được giả biết quiescence. Restore10GiB target≤60 phút phải đo, không claim nếu chưa chạy.

Những số này là acceptance targets, không kết quả nghiên cứu hiện có. Nếu cần đổi ngưỡng vì hardware, ADR phải ghi hardware/measured value/trade-off và owner chấp nhận; không sửa âm thầm để CI xanh.

## 5. Release package ứng dụng cần có

Source commit/tag; immutable image digests và worker binary checksum; dependency/SBOM manifest; upgrade/rollback notes; changelog; known limitations; test/chaos/eval reports; backup/restore instructions; owner onboarding; sample `.env` không secret; license inventory. Không ship data fixture có real credential. Bản debug không bật network external test tự động.

## 6. Định nghĩa task DONE

Code có hành vi thật, tests liên quan pass, schema/docs cập nhật, no unresolved critical/high boundary bugs, manual UI verification cho phần nhìn thấy và STATUS.md ghi evidence. Chưa có environment để test là BLOCKED, không DONE. Chỉ viết endpoint trả mock JSON hoặc scaffold component không hoàn tất task domain.
