# Bộ dữ liệu kiểm thử hợp đồng và hành vi

`contract-cases.json` được `scripts/validate_spec.py` chạy thực: nạp fixture, resolve JSON Schema tại local, bật FormatChecker và đối chiếu hợp lệ/không hợp lệ với dự kiến. Fixture dùng ID/domain giả, không gọi công cụ hay mạng.

`signature-vector.json` chứa **public key chỉ dùng cho test** và một JWS ký trên claims fixture. Private key không được đóng gói. Validator kiểm tra chữ ký, claims, input digest, phát hiện payload bị đổi và result digest. Timestamps cố định cần clock giả khi test lease; image/catalog digest là giả nên không được chạy trong production. Encoder trong lúc tạo fixture chỉ áp dụng bộ dữ liệu ASCII/số nguyên đơn giản; implementation phải dùng RFC 8785 đầy đủ và test vectors chính thức, không thay bằng `JSON.stringify`/`json.dumps` tổng quát.

`policy-cases.json` và `recovery-cases.json` là **đầu vào + hành vi mong đợi để coding agent viết test ứng dụng**. Kiểm tra cấu trúc các file này không có nghĩa policy engine hoặc recovery implementation đã đạt test. Test scope phải dùng fixture resolver/servers trong mạng lab, không gửi traffic tới domain/IP được ghi trong mẫu như một mục tiêu Internet.

Schema acceptance là lớp đầu: UUID tồn tại, Project ownership, bằng chứng hợp lệ, grant còn hiệu lực, đúng worker/fence và state transition vẫn phải được xác minh trong service/DB/integration tests. Một finding có evidence ID nhưng artifact không tồn tại vẫn phải bị application từ chối dù schema hợp lệ.

Chạy kiểm tra gói:

```bash
python -m pip install -r scripts/requirements-validation.txt
python scripts/validate_spec.py
```

Lệnh trên chỉ đọc/validate tài liệu và ghi báo cáo, không triển khai ứng dụng hoặc chạy pentest.
