# Phân công AI coding agents hoàn thiện redAI

Ngày: **24/09/2026**. Đọc cùng [kế hoạch sản phẩm](product-completion-plan.md) và [backlog gốc](../specs/implementation/tasks.json).

Người dùng chọn nhiều AI coding agents phát triển phối hợp. Kế hoạch này tổ chức triển khai theo dependency và bằng chứng nghiệm thu. Các đợt dưới đây là công việc sắp làm; chưa có task ứng dụng nào hoàn thành trong lượt lập kế hoạch.

## 1. Đội hình và trách nhiệm

Trong phiên hiện tại có tối đa **4 agents đồng thời**, gồm coordinator. Giữ một coordinator và tối đa ba vị trí coding/review; không tạo thêm tầng agent tự chia việc.

| Vai trò | Trách nhiệm | Sản phẩm bàn giao |
|---|---|---|
| C — Coordinator/integrator | Chọn task đủ dependency, giao file ownership, chốt thay đổi contracts, tích hợp, chạy kiểm tra chung, cập nhật tiến độ và handoff | Baseline chung, decision log, trạng thái Txx/gates, bằng chứng tích hợp |
| A — Coding slot 1 | Thường phụ trách domain/API/runtime; nhiệm vụ đổi theo đợt | Thay đổi trong phạm vi được giao, tests, bằng chứng và handoff |
| B — Coding slot 2 | Thường phụ trách contracts/UI/provider/results; nhiệm vụ đổi theo đợt | Thay đổi trong phạm vi được giao, tests, bằng chứng và handoff |
| D — Coding/review slot 3 | Thường phụ trách worker/ops hoặc review độc lập | Thay đổi và tests, hoặc review có lỗi tái hiện và tiêu chí kiểm chứng |

A/B/D là **vị trí phân công AI phát triển phần mềm**, không phải loại worker của sản phẩm. redAI vẫn dùng worker đồng nhất.

Khi cả ba vị trí coding đang bận, chờ một vị trí hoàn tất rồi dùng lượt tiếp theo để review phần do agent khác viết. Có thể tạo reviewer mới với context gọn ở vị trí vừa trống. Coordinator vẫn kiểm tra tích hợp; kết quả “PASS” do coder tự báo chưa đủ để đóng task.

Owner tham gia ở phản hồi UX, cấu hình provider/secret trong giao diện, opt-in live-model eval nếu muốn và nghiệm thu T34. Agents xử lý các lựa chọn kỹ thuật thông thường theo baseline, không hỏi lại quyết định đã chốt.

## 2. Quy tắc làm việc đồng thời

1. **Dependency đã đạt mới dispatch.** Chuẩn bị test plan hoặc đọc spec có thể làm sớm; không coi stub của task cha là dependency DONE.
2. **Mỗi vùng file chỉ có một writer ở một thời điểm.** Coordinator ghi task, agent và phạm vi file trước khi mở việc. Nếu cần sửa file ngoài phạm vi, coder gửi đề xuất cho coordinator để chuyển ownership hoặc tích hợp tuần tự.
3. **Contracts là điểm tích hợp chung.** `SPEC_LOCK`, OpenAPI/schema, migrations nền, package manifests, workspace lockfiles và cấu hình CI gốc chỉ có một owner tại một thời điểm. Coordinator có thể giao độc quyền cho T02/T03; mọi consumer dùng chung baseline.
4. **Cách ly khi có thể.** Dùng checkout/worktree riêng cho task nếu môi trường cho phép. Khi dùng workspace chung, cấm hai agent sửa cùng file hoặc chạy formatter toàn repo trong lúc agent khác đang sửa. Agents không reset, clean hoặc xóa thay đổi của nhau.
5. **Môi trường test riêng.** DB/schema, cổng dịch vụ, thư mục ObjectStore/spool, container labels và network lab mang tên task. Test cleanup chỉ tác động tài nguyên của task đó; không dùng chung sandbox/DB mutable giữa hai suite.
6. **Một người tích hợp.** Nếu chưa được yêu cầu commit, bàn giao diff cùng danh mục file mới và evidence. Coordinator tích hợp tuần tự, kiểm tra file untracked và không tự commit/push/deploy. Không giả định lịch sử Git đã tồn tại cho mọi thay đổi.
7. **Review bằng hành vi.** Reviewer kiểm tra invariants, race, auth, cross-project closure, secret, lease và recovery tương ứng; ghi issue có file/line, tình huống tái hiện, ảnh hưởng và test cần chạy.
8. **Chốt trên source tích hợp.** Các checks liên quan phải chạy trên cây nguồn sau tích hợp. Chỉ chạy lại hoặc mở rộng suite khi thay đổi/failure/rủi ro mới yêu cầu; không lặp toàn bộ kiểm thử vô ích sau mỗi sửa wording.

## 3. Lịch dispatch theo dependency

Đây là một lịch hợp lệ để khởi đầu, gồm **21 đợt D00–D20**. Một đợt không tương đương một ngày hoặc một phiên chat. Task dài có thể kéo dài nhiều lượt coding/review. Các cột coding ghi task ứng dụng; ô còn trống dùng cho review hoặc chuẩn bị fixtures, không tự mở thêm phạm vi.

| Đợt | Agent A | Agent B | Agent D | Coordinator cần chốt trước đợt sau |
|---|---|---|---|---|
| D00 | T00 — toolchain, versions, license | Đọc baseline/kiểm tra đầu ra T00 | Kiểm kê điều kiện Linux lab | Dependency baseline, blockers và phạm vi nguồn |
| D01 | T01 — monorepo/quality commands | Review cấu trúc/import boundary | Review hướng dẫn dev | Skeleton và nguồn canonical; trạng thái ban đầu |
| D02 | T02 — DB/migration | T03 — contracts TS/Go | Review schema/DB consistency | Migration thật + fixtures chung + drift check |
| D03 | T04 — owner/session | Review auth/CSRF | Chuẩn bị worker protocol test plan | Owner API/session boundary đạt |
| D04 | T05 — vault/Settings | T06 — Project/Chat metadata | T15 — worker identity | Ranh giới API/schema dùng chung và test identity |
| D05 | T07 — storage/upload | T08 — provider adapters | T16 — journal/supervisor | File integrity, provider protocol, worker crash windows |
| D06 | T09 — durable Ask | T12 — scope/grants | Review policy vectors/recovery | Ask persistence và grant lifecycle |
| D07 | Review backend/UI integration | T10 — Chat/Workbench | Review UI/IME/responsive | UI nối backend thật |
| D08 | T11 — SSE/reconnect | Review reconnect từ UI | Review commit-order race | Demo M2 và event replay |
| D09 | T13 — Agent checkpoints | Review state transitions | Review runtime/worker contract | Durable runtime trước scheduler |
| D10 | T14 — privacy/budget | Review budget và payload canary | T17 — scheduler/leases/results | Budget và dispatch tích hợp, không xung đột runtime |
| D11 | Review boundary/lease | T22 — approval API/UI | T18 — sandbox offline | Approval transaction và Linux isolation |
| D12 | Review provenance/runtime | Review artifacts UI | T19 — offline tools/artifacts | Demo M3 offline trên worker thật |
| D13 | T23 — pause/cancel/reconcile | T28 — deployment/doctor | T20 — HTTP adapter | Đường dừng/đối soát trước demo mạng; lab deploy và HTTP counter đạt |
| D14 | T24 — bounded subagents/context | T25 — finding/evidence | T21 — browser/proxy | Child budget, browser boundary và findings có provenance |
| D15 | T26 — report/retest | T32 — observability/diagnostics | T29 — security integration lab | Security findings được xử lý, report và diagnostics tích hợp |
| D16 | T27 — search/export/import | Review import/secret/grant behavior | Review security fixes; chuẩn bị chaos/restore | Demo M5 và dữ liệu roundtrip |
| D17 | T30 — chaos/performance/UX | Review lỗi/timing, kiểm tra UI | T31 — backup/verify/restore | G6/G7 evidence đo thật, restore máy sạch |
| D18 | T33 — CI/release hardening | Review source/license/manifests | Review execution/restore evidence | Gate matrix và gói candidate nhất quán |
| D19 | T34 — hỗ trợ owner UAT, sửa lỗi | Review UX/docs sau sửa | Review hồi quy phần vừa sửa | Owner acceptance và gate còn thiếu |
| D20 | T36 — handoff/release package | Kiểm tra hướng dẫn/link/manifest | Cài sạch theo hướng dẫn cuối | Mọi MUST/G0–G7 đạt, bàn giao vận hành |

**T35 riêng:** chỉ dispatch khi T24/T29/T25 đạt và owner đã opt-in/cấu hình provider, với budget được chốt. Có thể dùng một slot sau D15; không chiếm runner đang dùng cho security suite và không chặn phần core nếu chưa chạy. Ghi `NOT_RUN` khi chưa thực hiện. Các bước kiểm chứng model cần thiết trong owner acceptance T34 vẫn giữ nguyên.

Lịch này tận dụng việc T15 và T28 có thể làm sớm hơn thứ tự milestone trình bày trong kế hoạch sản phẩm. Mỗi task vẫn giữ milestone và dependency gốc. M2 có bản Chat thử sớm; ở D08 một phần worker đã chuẩn bị nhưng chưa đủ để gọi M3 hoàn thành.

Coordinator có thể dispatch một task đủ điều kiện ngay khi nhánh cha được tích hợp, không bắt mọi nhánh chậm của cùng đợt hoàn tất nếu chúng độc lập. Tuy nhiên, khi task cùng đụng file, migration hoặc test lab, ưu tiên tuần tự để giữ khả năng kiểm chứng.

## 4. Những vùng dễ xung đột và cách chia

| Giao điểm | Quy tắc ownership |
|---|---|
| T02/T03: DDL và API types | A sở hữu migrations/repositories; B sở hữu canonical contracts và generated TS/Go. Thay invariant cần coordinator cùng đối chiếu trước khi đổi hai phía |
| T05/T06/T15: API routes và bootstrap | Chia thư mục routes/use cases theo settings, projects, worker identity. Coordinator tích hợp route registration, container/dependency wiring và migration chung |
| T07/T08/T16: dependencies/build | Mỗi agent đề xuất dependency; một owner cập nhật manifest/lockfile chung tuần tự. Go dependencies do worker owner quản lý |
| T14/T17: runtime/budget/dispatch | Chia module privacy/budget và scheduler/worker protocol. Runtime entrypoint và transaction wiring do coordinator tích hợp; có test không dispatch khi thiếu budget/quyền |
| T22/T18: lease/authorization | Approval owner không sửa signed-envelope semantics; sandbox owner không tự thay policy. Thay shared contract theo vòng review riêng |
| T23/T28: worker/service lifecycle | T23 sở hữu cancellation/runtime/worker behavior; T28 sở hữu ops manifests/scripts. Entrypoint hoặc shutdown hooks sửa tuần tự |
| T23/T20: cancellation/HTTP | T20 dùng interface lease/cancel đã có; T23 sửa orchestration, không sửa HTTP adapter đang có owner. Coordinator ghép hooks và chạy cancel/result tests trên bản tích hợp trước demo mạng |
| T21/T25: artifact/provenance | Giữ contract artifacts đã có từ T19; browser thêm producer, findings dùng consumer. Schema change phải cập nhật và test hai phía |
| T26/T32/T29: observability/tests | T26 sở hữu reports/retest; T32 sở hữu observability/diagnostics. Instrumentation vào file của agent khác gửi coordinator; lab test không tự sửa product code đang có owner |
| T30/T31: DB/storage/fault injection | Dùng môi trường độc lập; không restore vào DB hay ObjectStore mà chaos suite đang dùng |

Nếu task cần sửa file dùng chung nhiều đến mức không thể phân tách, giảm xuống hai hoặc một coder trong đợt đó. Tăng số agent không phải mục tiêu; giảm thời gian tích hợp và lỗi mới là mục tiêu.

## 5. Mẫu giao việc cho coding agent

Coordinator điền thông tin thực tế, không gửi yêu cầu chung kiểu “làm hết backend”.

```text
Task: Txx — tên từ backlog.
Baseline: commit nếu có; nếu chưa, ghi revision/manifest của working tree.
Dependencies đã được kiểm chứng: ...; evidence: ...
Đọc: AGENTS, task card, invariant/ADR/schema liên quan.
File/module được sửa: ...
File chung chỉ được đề xuất thay đổi: ...
Đầu ra hành vi người dùng hoặc protocol: ...
Acceptance và test bắt buộc: ...
Môi trường test riêng: DB/schema/ports/object root/container labels...
Ngoài phạm vi task: ...
Không tự spawn thêm agents hoặc commit/push/deploy.
Bàn giao: file changes, tests/commands/results, evidence, blockers và bước tiếp theo.
```

Mẫu yêu cầu reviewer:

```text
Review Txx trên source đã tích hợp ở baseline ...
Đọc acceptance, invariants và diff; kiểm tra tình huống lỗi/race quan trọng.
Không sửa code trong lượt review.
Tách issue chứng minh được khỏi nghi vấn hoặc test còn thiếu.
Mỗi issue có file:line, bước tái hiện, ảnh hưởng, test xác minh và sửa nhỏ nhất.
Nêu rõ phần đã kiểm tra/chưa kiểm tra; không suy PASS từ lời coder.
```

## 6. Bằng chứng, bàn giao và tiếp tục phiên sau

Sau T01, coordinator quản lý:

- `implementation/STATUS.md`: task state, baseline, checks, blockers.
- `implementation/ASSIGNMENTS.md`: agent, task, file ownership, môi trường test và trạng thái tích hợp.
- `implementation/HANDOFF.md`: snapshot ngắn cho lần tiếp tục, task đang mở, lỗi tái hiện, lệnh đã chạy, bước tiếp theo.
- `docs/implementation-decisions.md`: mâu thuẫn spec và quyết định cần giữ lại; thay đổi kiến trúc có ADR.
- `release-evidence/Txx/` và gate matrix: bằng chứng không chứa secret.

Đây là các file cần tạo hoặc nhập ở T01, không phải tuyên bố chúng đã tồn tại. Task card và backlog là nguồn tiêu chí; các sổ trên chỉ phản ánh tiến độ và phân công.

Một task kết thúc lượt coding cần báo:

1. Hành vi đã thực hiện và file thay đổi, gồm file mới chưa được Git quản lý.
2. Lệnh thực chạy, kết quả, số test/skips nếu có và đường dẫn evidence.
3. Hợp đồng hoặc migration thay đổi và các consumer đã cập nhật.
4. Lỗi/rủi ro còn mở, điều kiện tái hiện và phần không kiểm tra được.
5. Bước tiếp theo; có cần review hoặc tích hợp trước khi dispatch task con hay không.

Coordinator chỉ đóng `DONE` sau review, integration checks liên quan và acceptance. Nếu một agent hết context, agent tiếp theo đọc handoff rồi xác minh source/tests, không làm lại từ đầu và không tin trạng thái chỉ vì chat trước nói đã xong.

## 7. Kiểm soát tiến độ và mốc quyết định

Chưa có dữ liệu năng suất nên không đưa lịch ngày giả định cho toàn bộ 37 task. Ghi thời gian coding, thời gian test/lab, review và rework theo từng đợt; dùng kết quả M0 để dự báo M1–M2, rồi cập nhật khi đã chạy sandbox/browser thật.

| Điểm kiểm tra | Quyết định cần rút ra |
|---|---|
| Sau D02 — M0 | Nguồn/hợp đồng và toolchain có tái lập; hạ tầng còn chặn những task nào |
| Sau D08 — M2 | Owner thử UX Chat; ưu tiên sửa lỗi sử dụng trước khi mở rộng màn hình |
| Sau D12 — M3 | Linux worker và recovery đủ evidence để tiến tới workflow mạng trong lab |
| Sau D15 — network/security | Browser scope, cancel, budget và bằng chứng có đủ điều kiện cho luồng tích hợp tiếp theo |
| Sau D17 — reliability/restore | Còn lỗi hoặc thiếu bằng chứng nào chặn candidate release |
| Sau D19–D20 | Owner acceptance, G0–G7 và tài liệu đủ để bàn giao Personal v1 |

Báo tiến độ bằng task/gate đạt và kịch bản người dùng đã chạy được. Không lấy số agent đang chạy, số file tạo ra hoặc số dòng code làm bằng chứng sản phẩm hoàn thành.
