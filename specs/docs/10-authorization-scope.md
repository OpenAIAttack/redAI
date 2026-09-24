# 10 — Phạm vi ủy quyền và bốn chế độ phê duyệt

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

## 1. Hai lớp quyết định

**Authorization** trả lời hành động có được phép trên tài sản này không. **Approval** trả lời hành động đã được phép có cần owner bấm duyệt ngay trước khi chạy không. Scope denial không thể được biến thành allow bằng Automatic hoặc bằng một nút approve. Xác thực DNS là bằng chứng kiểm soát DNS, không tự xác định quyền đối với mọi hạ tầng được tìm thấy.

Bản đầu dùng `automatic` mặc định để giảm hỏi lại. Owner cấu hình Project một lần, Chat/Agent/worker kế thừa cùng grant còn hiệu lực. Không yêu cầu DNS mới mỗi lệnh, mỗi chat hoặc mỗi worker. Offline tasks dùng local capability policy, không giả có domain grant; envelope scope/grant nullable và network_profile bắt buộc offline khi không có grant.

## 2. Scope representation

Scope version gồm allowed origins/domain rules, ports, path prefixes, methods/action categories, exclusions, allowed network zones và prohibited platform resources. Domain rule `exact` chỉ hostname đó; `subdomains` match nhãn DNS con đúng root và có `include_apex` rõ. Không suffix-match `badexample.test` với `example.test`. Public suffix như `com`, `co.uk` không được dùng làm organizational root.

Private IP/CIDR grants chỉ dành lab đã khai báo rõ, có zone và loại kiểm thử; DNS proof không tự tạo CIDR grant. CDN/shared IP: quyền của hostname chỉ cho tương tác hostname/ứng dụng đó, không scan toàn IP, provider tenant khác hoặc origin backend được đoán. CNAME sang provider là đường phân giải cho hostname authorized, không grant cho hostname đích của provider.

`discovered_assets` không được dùng trực tiếp làm allowlist. UI có thể gợi ý tài sản cần review; chỉ owner API tạo version/grant mới. Dependency tải nội dung bình thường cũng không được tự authorize trong v1; owner có thể ghi explicit allowed origin/use purpose, vẫn không grant test provider infrastructure.

## 3. DNS proof một lần

Challenge tên `_redai-challenge.<root>`; value ngẫu nhiên chứa opaque challenge id/token, không chứa secret khác. Challenge bind installation_id, workspace_id, project_id, root_ascii, requested_version, expires_at. Token tối thiểu256 bit entropy, TTL24 giờ. Resolver đáng tin, timeouts và retry bounded; không chỉ đọc DNS từ chính target trả về HTTP.

Sau verify, lưu timestamp, observed TXT digest, resolver metadata và attestation owner. Không cần TXT ở lại mãi cho mọi run. Proof không tự revoke khi record bị xóa sau verify; owner chịu trách nhiệm phạm vi còn được phép, và hệ thống cung cấp revoke/change review. Khi root thay đổi, owner ghi ownership transfer hoặc grant hết hạn, phải proof/grant mới. Run không tự gia hạn quyền bằng summary chat.

Lab không có DNS dùng `lab_attestation` qua owner UI, exact origins/IP trong private zone. Không dùng lab attestation để cấp quyền wildcard công cộng. Hồ sơ ủy quyền có `valid_until` optional cho công việc cá nhân lâu dài, `revoked_at` có hiệu lực ngay; default không bắt verify lại theo mỗi phiên.

## 4. Policy decision order

Authenticate actor → ensure Workspace/Project closure → check installation hard-deny → check run state/cancel → resolve current grant status/epoch → canonicalize target → apply exclusions trước includes → check action/network zone/tool manifest → check secret/data policy → enforce budget/resource → approval mode → issue signed lease. Worker và proxy kiểm tra lại input digest/policy snapshot/lease trước effect.

Kết quả schema gồm `verdict=allow|ask|deny`, machine reason_code, risk tier, matched_rule_ids, scope_version_id/grant_id, exact fingerprint và human-readable safe rationale. Không chỉ bool. Cache policy theo version/epoch rất ngắn; revoke invalidates cache/renewal. Không live-read chậm khiến proxy cứ dùng grant cached vô hạn.

## 5. Mode matrix

| Hành động | Automatic | Always ask | Ask for high-risk commands | Reject |
|---|---|---|---|---|
| Ask không execution | Cho phép | Cho phép | Cho phép | Cho phép |
| Pure/offline tool trong capability | Chạy | Hỏi | Chạy | Từ chối execution |
| Sandbox write trong roots | Chạy | Hỏi | Chạy nếu routine | Từ chối |
| External read trong grant | Chạy | Hỏi | Chạy nếu routine | Từ chối |
| External write được grant cho phép | Chạy | Hỏi | Hỏi | Từ chối |
| Unknown effect offline trong sandbox | Chạy với limits | Hỏi | Hỏi | Từ chối |
| Scope ngoài grant / hard-deny | Từ chối | Từ chối | Từ chối | Từ chối |
| Destructive/DoS/hạ bảo vệ của platform | Từ chối v1 | Từ chối | Từ chối | Từ chối |

Mode snapshot vào Run. Owner đổi default chỉ ảnh hưởng Run mới; **revoke/narrowing/cancel** là emergency control áp dụng ngay cho Run active. Không cho đổi mode giữa một approval và dispatch để né fingerprint.

## 6. Approval fingerprint và expiry

Fingerprint JCS/SHA256 gồm tool_name/version, normalized input hash, scope_version, grant epoch, worker binding/zone, secret refs/version IDs, resource limits và run_id. Approval một lần có TTL15 phút, người quyết định owner_id, decision time, audit ID. Nếu có thay đổi target/args/secret version/worker identity làm fingerprint khác, request cũ stale.

Approval chỉ cho đúng logical call. Duplicate click trả cùng decision. Approval sau cancel/expiry/revoke reject. Không reusable prefix grant do model tạo. Không để AI reviewer tạo permission mới; v1 dùng deterministic classification, model có thể giải thích nhưng không làm nguồn quyền.

## 7. Revocation và emergency stop

Owner revoke Project grant → tăng policy_epoch, event, stop new dispatch, deny lease renew, revoke proxy capabilities, cancel active affected tasks. Worker revoked tương tự; global emergency stop ngừng mọi dispatch và provider call mới, không xóa data. Server theo dõi stop confirmations; UI không hứa tức thời dừng mọi packet đã gửi hoặc hoàn tác remote state.

Nếu control-plane bị mất kết nối, local watchdog hết TTL phải dừng. Nếu worker host bị kiểm soát trái phép, cryptographic signature không bắt host tuân thủ; cần cô lập/revoke và xem lại evidence. Các giới hạn này phải có trong help UI.

## 8. Test vectors

Fixtures `tests/policy-cases.json` phải bao gồm exact domain, subdomain/apex flags, deceptive suffix, IDNA/case/trailing dot, exclusions, redirect foreign origin, CNAME/shared IP, IPv6/mapped IPv4, private lab allow, metadata hard-deny, revoked/expired grant, Automatic không override deny và Reject vẫn cho Ask. TS policy và Go proxy dùng cùng vectors; khác quyết định là lỗi release-blocking.
