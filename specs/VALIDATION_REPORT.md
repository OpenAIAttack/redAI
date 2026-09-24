# Báo cáo kiểm tra bộ đặc tả redAI

**Kết quả: PASS_STATIC_BUNDLE_CHECKS.** Kiểm tra offline trên tài liệu/hợp đồng; không phải nghiệm thu sản phẩm.

## Đã chạy thực tế

| Nhóm kiểm tra | Số phép kiểm tra |
|---|---:|
| backlog | 296 |
| behavior_vector_structure | 4 |
| cross_contract | 55 |
| ddl_structure | 479 |
| fixture_expectations | 29 |
| json_documents | 48 |
| markdown_links | 45 |
| openapi_embedded_schema | 469 |
| openapi_structure | 1022 |
| references | 658 |
| schema_metaschema | 11 |
| signature_vector | 7 |
| yaml_documents | 2 |

Fixtures: **29/29** khớp kết quả mong đợi; có cả mẫu hợp lệ và mẫu cố ý không hợp lệ. Chữ ký fixture và digest đã được kiểm tra, bao gồm dữ liệu bị sửa.

Backlog: **37 task**, DAG không chu kỳ nếu PASS; **36 yêu cầu** có mapping task/gate/test.

Hợp đồng: **11 JSON Schema**, **98 API operations**, **38 bảng** và **88 foreign key** được lint cấu trúc.

**Giới hạn quan trọng:** OpenAPI chỉ được parse YAML, kiểm tra references, operation IDs, path parameters, responses và embedded schema; không phải validator OpenAPI đầy đủ. SQL chỉ được lint tên bảng/cột/FK/PK/UNIQUE trong subset đã dùng; không được diễn giải là SQL đã biên dịch hoặc migration thành công.

**32 policy vectors và 18 recovery scenarios** là đặc tả test hành vi, chưa chạy với application.

## Chưa thực hiện

- Full OpenAPI meta-schema validation/code generation with production client generators.
- PostgreSQL grammar parsing, applying migrations, constraints/transactions on a live database.
- Application implementation, unit/integration/E2E tests, browser UI verification.
- Worker/lease/policy engine execution, live network requests, gVisor/proxy isolation tests.
- Production model calls, real cost measurements, live pentesting, performance benchmarks.
- Backup/restore drills, deployment, security audit, release gates G0-G7.

## Tái lập

```bash
python -m pip install -r scripts/requirements-validation.txt
python scripts/validate_spec.py
```

Chi tiết máy đọc được: `tests/validation-results.json`. Mọi task triển khai trong `implementation/STATUS.md` vẫn NOT_STARTED.
