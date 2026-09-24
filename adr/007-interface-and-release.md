# ADR-007 — Chat-first, evidence-first, release theo gate

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

Trạng thái: Accepted. Sidebar Project/Chat, conversation center, Workbench context. Không dashboard enterprise trước. Finding/evidence/report là entity typed, không đoạn chat tự phong verified. Release G0–G7 bao gồm recovery/restore và Linux network lab.

Hệ quả: cần UI đầy đủ empty/error/connection states và status backend authoritative. Mock đẹp không nghiệm thu. E2E dùng component thật, reports immutable snapshots, retest separate Run. Các mốc triển khai theo dependency thay vì ước lượng ngày không có dữ liệu.
