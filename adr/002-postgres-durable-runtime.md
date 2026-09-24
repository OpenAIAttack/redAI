# ADR-002 — Durable loop bằng PostgreSQL

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

Trạng thái: Accepted for personal v1. API và TypeScript runtime là process riêng; PostgreSQL lưu Run/Step/Task/Event/Budget. Claim dùng transaction ngắn, lease/fence và SKIP LOCKED. Không Temporal, Redis hoặc in-memory queue làm nguồn thật.

Alternative Temporal cung cấp mô hình workflow/worker chuyên dụng nhưng thêm vận hành; không cần ở baseline một loại Agent loop bounded. Alternative web request chạy toàn agent không bền khi tab/request/service mất. Hệ quả: redAI tự chịu trách nhiệm state machine, retries, cancellation, commit-order event và unknown effects; các test chaos là bắt buộc.

Migration tương lai: freeze dispatch, map checkpoints sang workflow IDs, một nguồn authority duy nhất, không chạy hai queue cùng claim. Trigger xem lại là nhiều workflow dài ngày hoặc nhu cầu scale quan sát được, không vì xu hướng framework.
