# 03 — Đặc tả UX/UI chat-first

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

## 1. Nguyên tắc giao diện

Học mental model Chat/Agent/Project, không clone asset hoặc CSS độc quyền. Thương hiệu hiển thị chính xác `redAI`. UI tiếng Việt, identifier tiếng Anh. Dùng accent đỏ có chọn lọc cho hành động chính; destructive action khác về icon/label, không dựa màu đơn độc. Light/dark đều có token riêng. Motion nhỏ và hỗ trợ reduced-motion. Không cần ảnh nền, hiệu ứng hacker hoặc dashboard chỉ số giả.

## 2. Route và ownership của màn hình

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

## 3. Layout desktop

Sidebar 264 px, có thể collapse 64 px. Center conversation co giãn, nội dung đọc tối đa 840 px khi Workbench đóng. Workbench mặc định 420 px, kéo giãn 320–640 px. Topbar chứa tên Project/Chat, trạng thái kết nối, nút mở Workbench. Composer cố định dưới nhưng không che message cuối. Không render lại toàn transcript khi gõ mỗi ký tự.

Breakpoint: dưới 1280 px Workbench dùng overlay; dưới 768 px sidebar là drawer và Workbench là full-screen sheet; composer giữ attachment và nút Stop nhìn thấy. Bản mobile phục vụ theo dõi, duyệt và đọc; không hứa trải nghiệm terminal chuyên sâu tương đương desktop.

## 4. Sidebar

Gồm New chat, Search, danh sách Project, Chat đã pin/gần đây, Workers và Settings. Menu Chat: rename, pin/unpin, archive; không xóa ngay một chat có run active. Project archive không xóa dữ liệu. Xóa Project mở dialog với tên Project, số file/run, retention; bắt owner nhập lại tên cho purge. Drag-and-drop không cần v1; đừng thêm thư viện chỉ cho tính năng chưa có.

Danh sách tải theo cursor; vị trí scroll giữ khi đổi chat. Loading backend phải khác Project rỗng. Lỗi subscription hiển thị Retry, không thay lịch sử bằng empty state.

## 5. Composer

Hàng tùy chọn: Ask/Agent; model config; worker binding (chỉ Agent); approval mode; ngân sách collapsed. Hiển thị chip “Model bên ngoài · đã che dữ liệu” hoặc “Model local” theo route thực, không theo worker location. Tooltip mô tả dữ liệu nào vẫn ra ngoài; có link preview payload redacted trước Run khi owner bật.

Enter gửi, Shift+Enter xuống dòng; trong IME composition không gửi. Attachment có progress và lỗi từng file. Không auto gửi khi upload xong. Nút Send disabled khi nội dung và attachments đều rỗng. Trong run active, composer cho nhập note vào hàng chờ; nút gửi nói rõ “Gửi vào phiên đang chạy”. Note được áp dụng tại model boundary tiếp theo, không đột ngột thay prompt cuộc gọi đã gửi.

Khi stop được bấm, lập tức đổi label “Đang yêu cầu dừng”, nhưng chờ event server trước kết luận. Debounce không thay thế Idempotency-Key. Giữ cùng key khi retry cùng một ý định gửi.

## 6. Message types

User text; assistant markdown; tool card; approval card; plan update; artifact card; finding link; system lifecycle notice. Không hiển thị private chain-of-thought hoặc giả mô hình đang suy nghĩ thành nội dung suy luận. Hiển thị status/rationale ngắn do agent chủ động cung cấp, tool inputs redacted và kết quả có thể kiểm chứng.

Markdown tắt raw HTML mặc định; sanitize link; cấm `javascript:`. Code block có copy và language label; không nút Run trực tiếp bypass policy. External link báo rời ứng dụng. Raw HTTP/terminal text render dạng text, không giải ANSI control nguy hiểm, không tự mở OSC hyperlink. Xterm chỉ dùng read-only task output ở v1; không có host terminal.

## 7. Workbench tabs

**Plan:** step ID, mô tả, trạng thái pending/running/completed/failed/skipped, link task. Chỉnh plan từ owner tạo revision/note; không ghi đè đang thực thi mà mất history.

**Activity:** timeline tools, attempt number, worker, elapsed, policy decision. Mở chi tiết cho stdout/stderr truncated, exit status, error, evidence. Chỉ hiển thị safe summaries; raw content cần quyền owner và không gửi analytics.

**Files:** artifacts của run; preview text/image, download; đường dẫn logical, không lộ path host. Files thay đổi có version, không âm thầm ghi đè evidence.

**Findings:** title/severity/status, nguồn chứng cứ và trạng thái review. Không tự sort “confirmed” lên nếu status backend là candidate.

**Usage:** token/cost quan sát được, budget reserved, unknown cost; phân biệt measured/estimated. Con số không có usage source hiển thị “Chưa xác định”, không 0.

## 8. Approval card

Hiển thị hành động chuẩn hóa, target, effect class, sandbox/worker, thay đổi dự kiến, expiry và policy reason. Hai nút Approve once / Reject. V1 không có “Always approve this prefix” tự do. Chuyển mode thuộc Project settings; không tạo global approval từ một card.

Approval bị stale khi args/scope/worker identity thay đổi; card chuyển expired/stale với giải thích. Đồng thời có hai tab approve cùng card: một decision thành công, tab còn lại cập nhật kết quả, không tạo task thứ hai. Nếu sửa target trước approve, phải tạo tool call mới.

## 9. Empty/error states cụ thể

Chưa có worker: hướng dẫn enrollment, Ask vẫn hoạt động. Worker offline: giữ nguyên máy đã chọn, nút retry/resume sau khi online, không chọn máy khác hộ. Provider chưa sẵn sàng: mở Settings, không tự dùng provider khác. Hết budget: tóm tắt phần đã làm, cho owner thay budget rõ ràng rồi tiếp tục bằng run/continuation được ghi nhận. Scope denied: nêu target chưa nằm trong grant; không gợi ý vượt kiểm soát.

Disk full: upload/task mới blocked, dữ liệu hiện hữu vẫn đọc được nếu còn khả năng. SSE disconnected: badge reconnecting và nút manual reconnect; không xóa transcript. Cursor expired: tải snapshot rồi tiếp tục, không chạy lại task.

## 10. Design tokens và kiểm thử giao diện

Spacing theo bội số 4; base font 14–16 px, line height 1.5; monospace cho output. Focus visible; dialog trap focus, Escape đóng khi an toàn; status dùng `aria-live=polite`, lỗi form gắn input. Tất cả control có accessible label. Trạng thái lỗi không chỉ màu.

E2E cần screenshot light/dark ở 1440×900, 1024×768, 390×844; long transcript 1.000 messages fixture, long command, ký tự tiếng Việt, multiline filename, output 1 MiB truncated, approval concurrently updated. Mọi screenshot phải dùng component và CSS thật, không HTML fixture khác sản phẩm.
