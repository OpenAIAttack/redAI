# Architecture Decision Records

Các ADR dưới đây là baseline của bộ đặc tả, không phải lịch sử code đã triển khai.

| ADR | Quyết định |
|---|---|
| [001](001-personal-first-independent.md) | Personal-first, triển khai độc lập |
| [002](002-postgres-durable-runtime.md) | PostgreSQL durable loop, chưa Temporal/Redis |
| [003](003-homogeneous-go-workers.md) | Worker Go đồng nhất, outbound HTTPS, lease/journal |
| [004](004-local-storage-and-contracts.md) | Local ObjectStore, JSON Schema/OpenAPI, SQL rõ ràng |
| [005](005-scope-and-network.md) | Automatic trong grant; network enforcement ngoài model |
| [006](006-model-and-data-policy.md) | Model configurable, BYOK/local, data policy độc lập worker |
| [007](007-interface-and-release.md) | Chat-first, evidence-first, gate thay vì demo |

Mẫu ADR mới: context → decision → alternatives → consequences → security/data implications → migration → tests → owner/date. Không dùng ADR để hợp thức hóa việc bỏ test hoặc nới quyền mà không đánh giá.
