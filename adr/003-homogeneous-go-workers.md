# ADR-003 — Go worker đồng nhất

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

Trạng thái: Accepted. Cùng binary, toolbox manifest và protocol trên mọi worker. Agent roles là logical sessions, không worker type. Outbound HTTPS long-poll giảm inbound networking; stable identity tách session. Signed leases và journal trước effect; outcomes mơ hồ không replay.

Alternative dedicated-role workers dễ gắn vai trò cứng và phân bổ tài nguyên kém linh hoạt cho nhu cầu hiện tại. Alternative SSH command runner khó chuẩn hóa identity/lease/cancel/evidence. Hệ quả: worker registry/binding/capacity và compatibility checks bắt buộc. Stateful sessions gắn worker, không transparent migration. Test cùng fixture trên hai worker, offline selected machine và session-clone conflict.
