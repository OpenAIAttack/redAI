# ADR-004 — Local ObjectStore và hợp đồng typed

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

Trạng thái: Accepted. File bytes ở Local ObjectStore interface; metadata PostgreSQL; export/import hash manifest. Không thêm S3 server/Redis/vector DB bắt buộc. JSON Schema2020-12 là payload contract; OpenAPI3.1 cho REST; SQL migration rõ ràng cho persistence.

Hệ quả: control-plane API/runtime chia mount storage, backup phải đồng bộ DB+files và key recovery. Adapter S3 tương lai không đổi artifact domain ID. Contracts generation phải có cross-language fixture tests; generated types không thay runtime validation. DDL reference cần apply vào PostgreSQL thật trước release.
