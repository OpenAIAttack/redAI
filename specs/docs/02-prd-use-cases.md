# 02 — PRD, user stories và phạm vi chức năng

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

## 1. Người dùng và công việc

Persona duy nhất là owner có kỹ năng lập trình/bảo mật, muốn trợ lý làm việc trên dự án của mình và môi trường được phép. Owner không muốn lặp lại kiến trúc, tài khoản thử nghiệm, ghi chú và kết quả mỗi phiên; cần quyền kiểm soát model, worker, ngân sách và dữ liệu. Không thiết kế thêm vai trò admin/buyer/operator trong v1. Quyền app vẫn bắt buộc để website đích hoặc người khác trên LAN không điều khiển hộ owner.

## 2. Mô hình sử dụng

### UC-01 — Khởi tạo hệ thống

Owner chạy bootstrap CLI tại host, đặt mật khẩu qua stdin và tạo recovery code. Trình duyệt đăng nhập qua HTTPS, thấy setup cho model endpoint, policy dữ liệu, storage health và worker. Không có public `/register`. Cấu hình có lỗi không được đánh dấu Ready. Setup có thể lưu từng bước; lần đăng nhập sau tiếp tục đúng trạng thái.

**Nghiệm thu:** hai request bootstrap cạnh tranh chỉ tạo một owner; setup không log mật khẩu/key; thiếu model chỉ chặn phần AI, vẫn cho quản lý Project; không tự gửi nội dung Project trong provider health check.

### UC-02 — Project và phạm vi

Owner tạo Project, mô tả mục tiêu, chọn mode Automatic, khai báo root domain hoặc lab origin. Domain proof dùng challenge DNS có token ngẫu nhiên gắn installation/Project/root; sau verify lưu proof. Owner lưu grant về mục tiêu, loại hành động, exclusions và validity. Nội dung grant không được suy từ kết quả crawl. Thay đổi quyền phải tạo version mới, không sửa lịch sử của run đã chạy.

**Nghiệm thu:** tạo Chat thứ hai không đòi verify lại; dependency khác domain chỉ thành discovered asset; revoke chặn dispatch mới và hủy grant đang dùng; wildcard có semantics cụ thể, không match chuỗi suffix tùy ý.

### UC-03 — Ask với file

Owner upload tài liệu text/Markdown/OpenAPI/JSON/CSV và ảnh PNG/JPEG. File được kiểm tra kích thước, type, hash, lưu và lập chỉ mục text. Không chạy macro, không mở URL nhúng trong file để tải thêm dữ liệu. Ask trả lời dựa trên attachment và ghi chú được chọn; các đoạn trích có source ID. Trong Ask không có execution tools. File không đọc được hiển thị lỗi cụ thể, vẫn giữ khả năng tải bản gốc nếu owner chọn giữ.

**Nghiệm thu:** Ask không khởi tạo sandbox; HTML trong attachment không chạy script ở UI; server chỉ gửi các nguồn được chọn tới model; câu trả lời thiếu căn cứ nêu chưa có dữ liệu.

### UC-04 — Agent có thực thi

Owner nêu mục tiêu, chọn worker/worker pool đã binding và bấm Run. Server snapshot scope/model/policy/budget/attachment. Agent tạo kế hoạch có step; tool calls được schema validation, policy và budget kiểm tra trước khi tạo job. Owner xem progress, stdout có giới hạn, artifacts, request approval khi cần. Kết thúc lưu summary, unresolved items, finding và usage.

**Nghiệm thu:** nút Run double-click không tạo hai run; đóng/mở trang không tạo tool call mới; từ model output không thể giả worker registration hoặc grant. Model timeout không khiến cả Project bị mất.

### UC-05 — Chờ duyệt, pause và cancel

Always ask tạo approval cho mỗi actionable call; high-risk mode chỉ tạo khi effect class cần review; automatic không bật dialog cho hành động vốn được grant cho phép. Reject không thực thi. Pause ngừng phát hành tool/model turn mới sau boundary, giữ output công việc đang chạy. Cancel đánh dấu intent ngay, truyền xuống mọi child/task, theo dõi xác nhận. Owner thấy `cancellation_pending` nếu chưa chứng minh đã dừng.

**Nghiệm thu:** approve cùng request hai lần chỉ tạo một task; quyết định đến sau expiry không có tác dụng; hủy lúc chờ approval vô hiệu approval; không báo canceled khi tiến trình còn được biết là đang chạy.

### UC-06 — Finding và report

Agent có thể tạo candidate. Owner hoặc quy trình xác minh đề xuất trạng thái với evidence bắt buộc. Owner xem request/response đã che secret, thời điểm và command/tool metadata, sửa wording, severity với rationale. Report chọn phiên bản finding và evidence snapshot, tạo Markdown/JSON/HTML, ghi coverage và giới hạn. Export HTML offline không kéo asset ngoài.

**Nghiệm thu:** verified không có evidence bị API reject; raw evidence hash không bị thay sau edit; severity không tự suy từ model confidence; report chạy lại cùng snapshot không âm thầm lấy finding mới hơn.

### UC-07 — Retest

Owner chọn finding, xem scope hiện tại và chạy retest. Hệ thống tạo Run mới liên kết finding cũ, không sửa evidence gốc. Retest có kết luận observed_fixed/still_present/inconclusive. Mất credentials hoặc target unavailable là inconclusive, không phải fixed.

### UC-08 — Khôi phục và xuất dữ liệu

Owner export Project hoặc backup installation. Export Project mặc định loại bỏ secrets, worker tokens và sessions. Import xác minh manifest/hash, tạo ID mới, không kích hoạt grant/worker tự động. Backup installation có mã hóa và backup key riêng; restore kiểm tra khóa, schema, hash và revoked sessions.

## 3. Module và mức ưu tiên

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

## 4. Các thông báo không được đánh tráo ý nghĩa

“Không có finding được xác minh” không đồng nghĩa “không có lỗ hổng”. “Task đã nhận” khác “task đã bắt đầu”. “Run completed” nghĩa thực hiện xong kế hoạch trong coverage ghi nhận, không chứng minh hệ thống đích an toàn. “Local worker” không có nghĩa model chạy local. “File deleted” chỉ dùng khi payload được purge theo chính sách; trước đó dùng “Đã đưa vào hàng chờ xóa”.

## 5. Ràng buộc phi chức năng

Dữ liệu nghiệp vụ phải còn sau restart. Chỉ owner đã xác thực được gọi API quản trị. Browser và worker chỉ thấy tài nguyên đúng Workspace/Project/binding. Không đưa secret vào error response. Nội dung log bounded, backpressure có thiết kế. Các mục tiêu latency/RPO/RTO nằm ở tài liệu 18, là target nghiệm thu lab, chưa phải SLA.
