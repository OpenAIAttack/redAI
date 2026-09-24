# ADR-001 — Personal-first và triển khai độc lập

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

Trạng thái: Accepted for spec baseline. Một owner dùng công cụ cho công việc cá nhân. Không dựng billing/team/SSO và không fork source HackerAI vào sản phẩm. Giữ các pattern trải nghiệm phổ biến, tự viết code/assets/prompts. Alternative fork có thể nhanh nhưng cần xem giấy phép và nghĩa vụ về sau; chưa có giấy phép thương mại riêng nên không chọn.

Hệ quả: giảm module kinh doanh, tăng phần tự xây runtime/UX. Vẫn giữ workspace/project boundary để tránh rò dữ liệu giữa dự án và chuẩn bị mở rộng mà không hứa multi-tenant. Test: singleton owner, no signup routes, no copied brand assets, dependency provenance review.
