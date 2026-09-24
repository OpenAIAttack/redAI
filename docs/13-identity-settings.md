# 13 — Owner identity, cấu hình và bảo vệ tài khoản

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

## 1. Một owner vẫn phải có authentication

Self-host một người không nghĩa tất cả request LAN đều tin cậy. V1 không signup hoặc mời thành viên. Owner bootstrap một lần qua CLI local; owner row unique singleton, Workspace tự tạo. Password nhập qua secure stdin, không command argument. Recovery code 256-bit random, hiển thị một lần, lưu hash; mất password dùng CLI tại host để reset và revoke sessions.

Password hashing dùng Argon2id, mức khởi điểm memory64MiB, iterations3, parallelism1; benchmark latency trên control-plane và không thấp hơn hướng dẫn OWASP hiện hành [SRC09]. Salt random riêng. Không encryption reversible cho password. Không password default hoặc bootstrap “admin/admin”.

## 2. Session

Opaque random256-bit token; DB chỉ SHA256/HMAC hash. Cookie HttpOnly Secure SameSite=Strict Path=/, tên prefix `__Host-` khi HTTPS; không Domain attribute. Idle timeout12 giờ, absolute7 ngày; login/password change rotate session. Logout revoke server-side, không chỉ clear cookie. CSRF token gắn session, Origin allowlist; session endpoint trả safe owner profile và CSRF token qua same-origin response. OWASP session guidance là nguồn nguyên tắc [SRC08].

Rate limit login theo installation/account + IP đã canonicalize, ví dụ5 failed/5 phút và exponential delay capped, không khóa vĩnh viễn tự tạo DoS. Không tin X-Forwarded-For khi request không từ trusted reverse proxy. Audit failed login metadata không mật khẩu. UI generic invalid credentials.

## 3. Worker authentication tách biệt

Worker bearer không đăng nhập owner UI, không đọc Project tùy ý, không sửa settings. Scope route worker chỉ attempt/binding server giao. Long-lived credential rotate và revoke theo tài liệu08. Enrollment token không worker token. Browser không hiển thị full credential sau enroll. Không nhúng bearer vào URL để tránh access log.

## 4. Settings groups

**Models:** configs, key refs, capability probe, prices, data modes. **Workers:** display/zone/capacity/drain/revoke, bindings. **Privacy:** default mode, log retention, artifact classifications, export policy. **Limits:** run steps/time/cost, concurrency, upload/storage caps. **Security:** password change, sessions list/revoke, emergency stop, key health. **Appearance:** theme, language, timezone. **Operations:** backup destination/config, schedule chưa tự bật v1, restore instructions.

Settings thay đổi có revision/If-Match, validation server và audit. Environment variables chỉ bootstrap/hạ tầng, không nguồn settings bí mật cạnh tranh với DB. Precedence: immutable security floors → deployment config → owner defaults → Project settings → Run snapshot trong giới hạn. Không để query parameter mở quota hoặc disable policy.

## 5. Secret ACL

Secret thuộc Workspace và optional Project; target credentials Project-bound, model key Workspace-bound nhưng chỉ runtime/provider adapter dùng. UI metadata chỉ name/type/created/last_used; không raw value. Replace tạo secret version, cũ retiring cho đang dùng theo policy; emergency revoke có hiệu lực ngay và hủy capability. Ciphertext/AAD binding chống di chuyển secret row qua Project để decrypt sai context.

Capability retrieval phía worker dùng attempt/fence/live grant và allowed origin. Không API “get all secrets”. Short-lived transport credentials không được ghi vào task input log. Terminal offline không nhận target credential mặc định; chỉ HTTP/browser trusted adapter nhận subset cần thiết.

## 6. Exposure defaults

Proxy bind loopback hoặc private interface theo owner explicit configuration, không auto mở firewall/router port. Production HTTPS ngay cả private tunnel. App không gửi telemetry ra ngoài mặc định. CSP và headers được triển khai theo UI thực; không tắt CSP để render target HTML. API size/time limits, request ID sanitization, structured logging redacted. Backup/recovery/key files không nằm trong directory static web.

## 7. Acceptance

Không thể tạo owner thứ hai qua request race. Cookie session không đọc từ JS. Foreign Origin mutation fail, worker bearer gọi owner route fail. Password reset revoke mọi session và CSRF. Settings conflict không silent overwrite. Key thiếu sau restart báo locked/secret unavailable, không tạo key mới và mất khả năng decrypt dữ liệu cũ.
