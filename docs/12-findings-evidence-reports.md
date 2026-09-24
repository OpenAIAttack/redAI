# 12 — Finding, bằng chứng, báo cáo và retest

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

## 1. Kết quả sản phẩm không chỉ là text chat

Một kết luận phải có provenance tới Run, ToolCall/Attempt, worker identity, tool/image version và bytes evidence. Chat chỉ hiển thị liên kết tới domain entity, không copy status vào text rồi dùng text làm nguồn thật. Finding do model tạo là candidate mặc định.

## 2. Artifact và evidence

Artifact metadata: id, Workspace/Project, kind, media_type, byte_size, SHA256, storage_key, created_at, source actor/tool/attempt, classification, original_artifact_id optional, redaction_transform_id optional và lifecycle pending/ready/quarantined/deleting/deleted. Payload immutable khi ready. Các bằng chứng HTTP gồm method/origin/path redacted, timestamps, status, bounded request/response body refs, header redaction và transport metadata. Screenshot cần URL logical, viewport, captured_at, browser/tool version.

Trusted API tính hash bytes nhận được, không tin hash do worker khai. Worker compromised vẫn có thể gửi bytes giả; hash và provenance là khả năng truy vết, không độc lập chứng minh target thật. Manifest ký installation key có thể thêm authenticity của export, nhưng không thay review kỹ thuật.

## 3. Finding fields

Title, summary, affected_asset_id/origin, category/CWE optional, severity, severity_rationale, confidence, verification_status, remediation_status, impact, observed_behavior, expected_behavior, safe reproduction description, remediation, evidence_refs, limitations, source_run_id, created_by, version. Không bắt CVSS ở v1; khi thêm score phải lưu vector/version/rationale, không lấy severity thành score tùy ý.

Reproduction mô tả những gì đã quan sát trong công việc được phép, không tự tạo payload/khai thác khi chưa thực thi. Template report có chỗ “Chưa xác minh” rõ. Finding không có evidence link vẫn có thể candidate, nhưng chuyển verified phải có ít nhất một artifact ready thuộc cùng Project và reviewer/result đủ tiêu chí.

## 4. Verification gate

Validate evidence tồn tại, hash khớp, source attempt có terminal known state và target match. Kiểm tra nhận định có được evidence hỗ trợ hay chỉ model đoán. Agent reviewer có thể trả proposed verdict verified/rejected/inconclusive cùng rationale và evidence IDs. Policy nghiệp vụ kiểm tra schema/provenance trước lưu; owner vẫn có nút accept/reject/edit và history.

Đối với high/critical finding, v1 yêu cầu owner confirm trước xuất như “verified bởi owner”; technical auto-verification có label khác. Không dùng confidence high thay owner review. Owner manual finding phải khai source_external và upload evidence; không gán fake tool call.

## 5. Dedup

Fingerprint gợi ý từ Project, normalized asset/origin, category, location và normalized title key. Fingerprint không unique tuyệt đối để không merge hai lỗi khác. UI gợi ý duplicate; owner chọn merge/split. Merge giữ mọi evidence/history và link supersedes; không xóa finding gốc không thể truy ngược. Hai runs cùng endpoint nhưng bản build khác có observed_at và target_version để phân biệt.

## 6. Report snapshot

Owner chọn Project, Run(s), finding versions, ngôn ngữ, classification và bao gồm raw evidence hay không. Server tạo report snapshot immutable chứa input version IDs, coverage, scopes, template version và generator version trước render. Renderer deterministic trong mức có thể: timestamp dùng snapshot time, ID/name stable, sort explicit. Output Markdown, JSON và HTML offline; không external CSS/font/CDN/scripts. HTML sanitize, escape target content; evidence link relative trong bundle.

Các mục report: executive summary; mục tiêu/phạm vi/ủy quyền; phương pháp ở mức công việc thực tế; môi trường/công cụ/phiên bản; coverage đã làm/chưa làm; findings theo trạng thái; limitations; remediation; retest; evidence index/hash. Không gắn nhãn “pentest đầy đủ” nếu chỉ check subset. Khi không có verified finding, câu mẫu: “Không có phát hiện được xác minh trong phạm vi thao tác đã ghi nhận; kết quả không loại trừ vấn đề ngoài coverage.”

## 7. Retest

Tạo Run mới `kind=retest`, link finding_version và baseline evidence. Dùng grant/current target config mới, không reuse grant đã revoked. Kết quả observed_fixed/still_present/inconclusive, evidence mới, thời điểm và build/version nếu owner có. Có thể giữ finding verified lịch sử nhưng remediation fixed hiện tại. Nếu lỗi không tái hiện do thiếu quyền đăng nhập, đổi route hoặc timeout, inconclusive.

## 8. Export/import Project

Bundle ZIP gồm manifest.json, Project metadata redacted, scope snapshots inactive, chats selected, finding versions, reports và payloads theo artifact ID/hash. Không secrets, sessions, worker credentials, live enrollment token hoặc provider key. Archive paths chỉ server tạo; import reject absolute paths, traversal, symlink entries, decompression bomb, quá quota và duplicate manifest IDs.

Import validate manifest schema + all hashes trước commit; staging, remap UUID, preserve external_source_id, grants disabled và worker binding unset. Owner xem summary số files và quyền cần thiết trước activation. Import không chạy scripts/macros, không cho target content tạo task. Nếu thiếu payload, import partial chỉ khi owner chọn rõ, status evidence_missing chứ không ready.

## 9. Acceptance

Editing title không đổi evidence hash. Report snapshot không thay khi finding sau đó sửa. Verified không artifact bị reject. Report HTML có text từ target chứa script không chạy. Export/import không giữ quyền worker/grant. Retest target timeout không marked fixed. Raw secret canary không vào report preview hoặc default export.
