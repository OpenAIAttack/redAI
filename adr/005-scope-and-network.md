# ADR-005 — Automatic không tự mở scope

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

Trạng thái: Accepted security invariant. Default Automatic cho thao tác nằm trong capability/grant đã cấu hình. DNS proof giữ tại Project, không hỏi lại mỗi action. Domain quyền không mở sang shared IP/provider tenant/dependency. Offline terminal không network; HTTP/browser qua typed adapter/scoped proxy và network guard.

Alternative chỉ prompt/reviewer không đủ authority hoặc network boundary. Alternative blind HTTPS CONNECT không chặn đổi HTTP authority trên shared infrastructure. Hệ quả: browser TLS inspection có giới hạn pinning, được ghi coverage; unsupported không bypass. Test shared IP, redirects, DNS changes, revoke và proxy fail-closed.
