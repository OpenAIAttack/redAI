# 09 — Sandbox, tool adapters và giới hạn mạng

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

## 1. Hai profile thực thi, không host shell

**Offline sandbox:** terminal, đọc/ghi file, parse dữ liệu; `network=none`, root filesystem read-only, input mount read-only, output/workspace giới hạn quota. **Scoped web sandbox:** HTTP/browser thao tác qua gateway ràng buộc origin/port/path và grant, firewall chặn mọi egress khác. Cả hai chạy trong runtime cô lập trên worker host do owner kiểm soát.

V1 production profile yêu cầu Docker Engine với `runsc`/gVisor được cấu hình và vượt doctor/tests; Docker có thể tích hợp runtime gVisor theo docs chính thức [SRC10, SRC11]. Không hứa gVisor hỗ trợ mọi syscall/tool; tool incompatibility phải báo UNSUPPORTED_RUNTIME, không tự fallback sang host/runc. Profile lab runc có thể tồn tại chỉ cho fixture offline tin cậy, nhãn rõ và không đạt release gate execution.

## 2. Sandbox cấu hình bắt buộc

Non-root UID/GID cố định; cap-drop ALL; no-new-privileges; seccomp/AppArmor nơi runtime hỗ trợ; PID/memory/CPU/output quota; read-only image; `/tmp` tmpfs bounded; không host PID/network/IPC; không privileged; không mount `/`, `/home`, `/var/run/docker.sock`, cloud credential directory hoặc SSH agent. Image được pin digest và có SBOM/tool manifest. Worker trusted giữ quyền quản lý Docker, sandbox không có quyền đó.

Mặc định task 1 vCPU, memory1 GiB, PID128; browser2 GiB nếu worker capacity đủ; output25 MiB artifact, stdout/stderr tổng1 MiB preview và64 MiB spool. Đây là giới hạn cấu hình ban đầu, phải đo và điều chỉnh trong T30, không lời hứa performance. Vượt memory/time trả trạng thái cụ thể, không retry vô hạn.

## 3. File paths và lifecycle

Logical roots `/inputs` read-only, `/workspace` task/agent-local, `/outputs` export. API nhận path logical và artifact refs, không path host. Normalize theo POSIX, reject NUL, traversal, absolute ngoài roots; chống symlink/hardlink race bằng directory FD/openat-style no-follow và final boundary check. Kiểm tra khi export, không chỉ khi tạo file. Không follow symlink để tải file ngoài sandbox.

Mỗi AgentSession có workspace riêng; child không ghi trực tiếp workspace coordinator. Promote file là tạo artifact có hash/link, không shared mutable mount toàn Project. Cleanup sau ACK+grace, nhưng không purge payload chưa upload thành công. Restart worker không mount lại state vào run khác.

## 4. Tool registry

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

## 5. Scoped HTTP adapter

Adapter nhận components chuẩn hóa `scheme`, `host`, `port`, `path`, `method`, bounded headers/body; không chấp nhận raw URL parser tùy ý qua nhiều tầng. Reject userinfo, fragment làm target, backslash, ambiguous encoding hoặc parser disagreement. Canonical host IDNA ASCII lower-case, trim một trailing dot hợp lệ, port explicit/default được chuẩn hóa.

Resolve host bởi trusted resolver; kiểm tra tất cả A/AAAA against policy, không chỉ địa chỉ đầu. Dùng IP đã validate để dial, đồng thời giữ đúng Host và TLS SNI; verify cert upstream. Không resolve lần hai sau check bằng library khác. Redirect disabled mặc định; adapter xử lý từng hop tối đa5, kiểm tra target mới, không chuyển Authorization/Cookie sang origin khác. Proxy env hệ thống bị ignore; không cho target override proxy.

Chặn loopback, link-local, multicast, metadata, control-plane/storage/worker-management endpoints. Private lab target chỉ được phép qua explicit lab grant/zone, không mở toàn private range. IPv4-mapped IPv6 normalize trước compare. TLS lỗi được báo, không tự `insecure_skip_verify`. Các nguyên tắc application + network validation và redirect checking tham khảo OWASP SSRF [SRC06]; quy tắc chi tiết trên là đặc tả redAI.

## 6. Browser và HTTPS proxy: không dùng blind CONNECT làm scope guard

Playwright controller là trusted adapter, page content không tin cậy. Browser sandbox chỉ kết nối tới scoped proxy trên private bridge; firewall deny mọi đường ra trực tiếp, DNS tùy ý, UDP/QUIC/WebRTC egress. Proxy token bind run/session/grant/expiry; token không được page JavaScript đọc. Network interception trong Playwright là lớp phụ, không lớp duy nhất.

Để giới hạn HTTPS theo origin/path trên IP dùng chung, proxy phải terminate TLS phía sandbox với CA ephemeral được cài **chỉ vào browser sandbox**, rồi tạo TLS upstream có verify. Validate CONNECT authority, SNI, Host hoặc `:authority` nhất quán cho mọi request; không cho arbitrary raw tunnel. HTTP2 multiplexed requests phải kiểm tra từng authority/path. Redirect và subresource cùng đi policy. Chặn foreign dependency và hiển thị coverage gap, không tự authorize vì trang nhúng link.

Nếu chỉ triển khai CONNECT passthrough, không chứng minh scope ở lớp HTTP; không được đánh T21/G3 hoàn tất. Nếu certificate pinning hoặc client cert khiến interception không tương thích, báo unsupported/coverage-limited; không bypass. Evidence ghi `transport=inspected_proxy` để owner biết traffic đã đi qua proxy, không giả là capture trực tiếp không biến đổi.

Session cookies ở browser sandbox là dữ liệu nhạy cảm; không export mặc định. Cấm website tải file tự do vào host. Download vào quarantine artifact, không tự mở/chạy. Clipboard, camera, mic, geolocation, local filesystem access mặc định deny. Browser session timeout và lease watchdog dừng mọi background page request khi grant hết hạn.

## 7. Tool cài đặt và nguồn cung ứng

Toolbox build offline/reproducible khi có thể; package download chỉ lúc build/owner maintenance, không lúc model yêu cầu trong run. Pin digest/checksum. Không chạy `curl | sh`, auto apt/pip/npm từ text target. Bản đầu có Python/Node/shell trong sandbox offline để xử lý file nhưng không mount package registry credentials. Danh sách phiên bản tool ghi vào mỗi run manifest.

Không cần cài toàn bộ Kali. Ưu tiên bộ tool nhỏ có use case và parser rõ. Công cụ network bổ sung phải đi typed adapter, không vượt scope proxy bằng terminal network.

## 8. Acceptance bắt buộc

Trong lab, sandbox không truy cập host filesystem, Docker socket, metadata, API owner, DB hoặc Internet không cấp quyền. Browser gọi subresource ngoài scope bị block ngay cả khi JS tạo request/fetch/WebSocket/WebRTC. Hai vhost chia IP vẫn không truy cập vhost không grant. DNS đổi sau validate không đổi địa chỉ dial. Grant revoked giữa phiên browser khiến request tiếp theo bị chặn và task dừng theo lease.

Test process timeout/cancel với child process và background loop; không để zombie. Disk-full không làm worker ghi đè evidence cũ. Image missing/signature mismatch fail closed. Test nền tảng này trên Linux VM thật; mock unit test không đủ chứng minh cô lập.
