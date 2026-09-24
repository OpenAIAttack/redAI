# Kế hoạch triển khai redAI Personal v1

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

## Công việc song song hợp lý

Sau T01, T02 và T03 có thể tách agent với ownership file rõ. Sau T06 có thể làm UI shell trong lúc provider/storage backend hoàn thiện, nhưng UI task không DONE nếu chưa nối API thật. Worker enrollment/journal có thể đi song song runtime sau contracts. Browser proxy là security-critical boundary, phải review riêng trước khi merge scoped execution.

Không cho hai coding agents sửa cùng schema/SQL migration mà không coordinator tích hợp. Người phụ trách contract thay đổi phải cập nhật both consumers TypeScript/Go và fixtures. Trước merge, chạy tests liên quan trên branch tích hợp, không chỉ mỗi nhánh riêng.

## Quy tắc quản lý công việc

Dùng `tasks.json` làm nguồn task/dependency và [task-cards.md](task-cards.md) để đọc chi tiết. `STATUS.md` ghi state NOT_STARTED/IN_PROGRESS/BLOCKED/DONE, commit, commands và evidence. DONE chỉ khi tiêu chí task đạt, không dựa việc đã tạo folder. Một task tùy chọn NOT_RUN không thành PASS; mọi MUST không đạt chặn release gate tương ứng.

Lựa chọn kỹ thuật bổ sung viết ADR theo template. Bug boundary được ưu tiên hơn thêm tính năng. Không mặc định live network/model key có sẵn; các fixture đủ xây core. Mọi test dùng mục tiêu thật phải do owner cấp scope và chủ động yêu cầu, không agent suy ra từ domain tìm trong tài liệu.

## Hợp đồng phải đồng bộ

Enum/status/defaults ở SPEC_LOCK và schemas; OpenAPI với route handlers; database FK/unique với transaction tests; worker envelope với JWS/JCS fixtures; policy vectors với TS+Go; prompt version với run manifest; UI states với backend lifecycle. Không để tài liệu “cancel chờ acknowledgement” nhưng code chỉ abort fetch phía browser.

## Handoff khi hết context

Ghi task hiện tại, commit/base branch, files đang sửa, checks đã chạy và failing tests, invariant liên quan, bước tiếp theo. Không ghi secret. Agent tiếp theo đọc handoff và xác minh source/test, không coi lời agent trước là bằng chứng đã DONE.
