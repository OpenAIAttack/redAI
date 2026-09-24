# ADR-006 — Model route và data policy riêng

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

Trạng thái: Accepted. Owner chọn endpoint/model/key; mock deterministic cho CI; local_only/redacted_cloud/cloud_full có semantics rõ. Worker local không suy ra model local. Secret refs, server-side keys, payload filtering và budget reservation chung.

Alternative hard-code một nhà cung cấp dễ setup nhưng khóa chi phí/dữ liệu. Alternative tự tìm model thay khi bị từ chối có thể vi phạm data policy và mất dự đoán. Hệ quả: capability probe, price config/version, unknown usage và explicit fallback cần UI. Test canary/local-only/parallel child budget.
