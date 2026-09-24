# 01 — Baseline và giới hạn bản đầu

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

## 1. Tuyên bố sản phẩm

redAI là bàn làm việc kiểm thử bảo mật cá nhân, hỗ trợ trao đổi, lập kế hoạch, thực thi công cụ trong sandbox, giữ bằng chứng và kiểm tra lại bản sửa. Công cụ phục vụ công việc được chủ sở hữu ủy quyền; không phải dịch vụ tự kiểm thử toàn Internet. “Chính thức” ở v1 nghĩa là có thể dùng ổn định cho công việc cá nhân và khôi phục dữ liệu, không phải có đủ mọi tính năng enterprise.

## 2. Phân biệt yêu cầu đã xác nhận và quyết định thiết kế

| ID | Quyết định | Nguồn quyết định |
|---|---|---|
| B01 | Một owner sử dụng trước; không SaaS onboarding | Người dùng xác nhận 24/09/2026 |
| B02 | Trải nghiệm Chat–Project–Agent gần HackerAI | Yêu cầu người dùng trước đó |
| B03 | Nhiều worker cùng phần mềm/toolbox; không hard-code chuyên môn | Yêu cầu người dùng trước đó |
| B04 | Automatic, Always ask, Ask for high-risk commands, Reject | Yêu cầu người dùng trước đó |
| B05 | Xác thực Project một lần; không hỏi lại từng Chat/lệnh trong grant còn hiệu lực | Yêu cầu người dùng trước đó |
| B06 | Triển khai độc lập, không copy code/asset/prompt HackerAI | Quyết định thiết kế để chủ động sản phẩm |
| B07 | Next.js UI; Fastify API; TypeScript runtime; Go worker | Baseline kỹ thuật của gói đặc tả |
| B08 | PostgreSQL queue + checkpoint; chưa dùng Temporal/Redis | Giảm thành phần vận hành ở personal v1; ADR-002 |
| B09 | Local ObjectStore bắt buộc; S3 adapter sau v1 | Giảm dịch vụ bắt buộc; API storage vẫn tách biệt |
| B10 | Linux worker; desktop native/Windows native không thuộc v1 | Giảm ma trận kiểm thử; có thể dùng Linux VM trên máy cá nhân |
| B11 | Web/API và phân tích file là phạm vi công cụ v1 | Phân kỳ triển khai; raw TCP/network tools thuộc mở rộng |
| B12 | Hạn chế mạng tại execution boundary, không tự kế thừa quyền bên thứ ba | Invariant của thiết kế |

Các B06–B12 là quyết định baseline, không diễn đạt rằng người dùng đã duyệt từng thư viện. Coding agent triển khai theo chúng để có đường đi rõ ràng; thay đổi bằng ADR, không im lặng thay stack.

## 3. Phần có trong v1

Một owner, một Workspace tự tạo, nhiều Project. Project có file, ghi chú, scope, credential references, worker bindings, Chat, Run, Finding, Evidence và Report. Ask phân tích ngữ cảnh; Agent dùng tools theo policy. Chủ sở hữu chọn model endpoint/key của mình, chọn worker và theo dõi chi phí. Phiên tồn tại khi đóng trình duyệt. Có pause ở ranh giới, cancel, tiếp tục khi có lỗi phục hồi được, export/import Project và backup/restore toàn hệ thống.

V1 có một coordinator và tối đa hai subagent logic song song, depth tối đa một. Tất cả dùng cùng worker pool đã được binding. Có thể tắt delegation và chạy tuần tự mà không đổi data model. Không cần model riêng để huấn luyện; model adapter được kiểm thử bằng capability probe.

## 4. Phần cố ý chưa làm

Không public signup, subscription, billing, team invitation, SSO, enterprise RBAC, marketplace, arbitrary remote MCP, Telegram, auto scheduling, native desktop, agent chạy trực tiếp host, Kali GUI stream, chứng nhận tuân thủ, huấn luyện model, graph database hoặc vector database riêng. Không tự tải và thực thi plugin do model tìm trên web. Không tự cài package từ Internet lúc một task chạy.

Chưa hỗ trợ raw packet/SYN scan, mạng nội bộ toàn dải, shell truy cập Internet tự do, tự sửa hệ thống đích, khai thác phá hoại hoặc thu thập dữ liệu ngoài nhu cầu xác minh. Mở rộng TCP/IP tools cần ADR riêng, explicit target grants và bộ test mạng; không mô phỏng hỗ trợ bằng cách mở firewall toàn bộ.

## 5. Cấu hình mặc định có chủ đích

| Thiết lập | Mặc định v1 | Ghi chú |
|---|---|---|
| Ngôn ngữ UI | Tiếng Việt; khóa i18n chuẩn bị English | Không đổi identifier/schema sang tiếng Việt |
| Theme | Dark mặc định, light có sẵn | Accent đỏ; không bắt chước logo HackerAI |
| Approval | `automatic` | Chỉ sau khi có scope grant phù hợp |
| Project data policy | `redacted_cloud` khi owner đã cấu hình cloud provider | Setup phải thông báo dữ liệu ra ngoài; chưa cấu hình thì Ask/Agent blocked |
| Max active runs | 2/Workspace, 1/Chat | Giảm cạnh tranh context |
| Max child agents | 2, depth 1 | Chung run budget, không tự nhân budget |
| Worker capacity | 2 tasks/worker | Có thể giảm theo tài nguyên |
| Agent steps | 40 | Mỗi model turn sau tools là một step |
| Run active wall time | 30 phút | Wait approval/pause không tính; absolute expiry 24 giờ |
| Tool timeout | 120 giây | Trần owner cấu hình 600 giây |
| Per-run model budget | 2,000,000 micro-USD | Đây là hạn mức cấu hình 2 USD, không phải dự báo chi phí thực |
| File upload | 25 MiB/file; 200 MiB/batch | Workspace storage quota cấu hình riêng |
| Report | Markdown + JSON + HTML độc lập | PDF/DOCX không bắt buộc bản đầu |
| Search | PostgreSQL full-text + lọc metadata | Không embeddings tự động |

`SPEC_LOCK.json` là nguồn hằng số. Các ngưỡng là mục tiêu thiết kế chưa benchmark; owner có thể đổi các giá trị cho phép qua Settings, không đổi invariant.

## 6. Tiêu chí thành công cá nhân

Owner tạo Project và đưa vào luồng Ask được mà không phải tạo tài khoản dịch vụ phụ ngoài model đã chọn. Một worker mới đăng ký từ Linux khác chạy được task lab và vẫn giữ danh tính sau restart. Một công việc web/API có ngữ cảnh, evidence và report hoàn thành end-to-end. Restore sang máy sạch có thể đọc lại Project, đối chiếu hash file và chạy task mới; worker token cũ không tự được tái kích hoạt.

Không đo thành công bằng số agent/tool call. Báo cáo rõ tỉ lệ công việc hoàn tất, finding có đủ chứng cứ, false positive trên lab, chi phí quan sát được và lỗi chưa phục hồi. Không tuyên bố benchmark thương mại dựa trên fixture nhỏ.
