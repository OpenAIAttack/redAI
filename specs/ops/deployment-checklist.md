# Checklist vận hành personal deployment

## Trước cài đặt

Xác nhận Linux host/VM, dung lượng đĩa, thời gian hệ thống, DNS/TLS của control plane và mạng admin riêng. T00 pin supported toolchains/images; T28 ghi profile máy đã đo. Không công khai DB, object directory, worker Docker API hoặc bootstrap endpoint. Không yêu cầu credit cloud, tài khoản SaaS hay thanh toán để chạy mock/offline slice.

## Bootstrap

Chạy migration trong DB mới và test rollback/forward compatibility trước. Tạo owner bằng CLI local có xác nhận; tắt bootstrap sau thành công. Tạo master key và signing key bằng CSPRNG; ghi owner-only files, không log. Ghi recovery code một lần, chủ sở hữu lưu riêng. Backup key theo runbook, không chỉ backup DB.

## Enable execution có chủ đích

Enrollment token ngắn hạn; một worker ID cho một installation; credential mode0600. `doctor` kiểm tra image digest/tool manifest, runtime runsc, filesystem, cgroup quota, sandbox egress và lease watchdog. Chỉ bật execution khi G2/G3 tương ứng đạt. `REDAI_EXECUTION_ENABLED=false` trong mẫu để không phát lệnh chỉ vì đã khởi động control plane. Không coi offline lab/runc là đạt hardened release.

## Model và dữ liệu

Bắt đầu mock provider; cấu hình provider thật qua Settings khi owner chủ động. Probe capability endpoint/stream/tool schema trước. Thấy rõ dữ liệu nào ra ngoài và cost estimate. Không tự fallback provider trong Project local_only. Credential raw không xuất vào chat/model/report/diagnostics.

## Backup/restore

V1 dùng backup quiescent theo doc14: chặn dispatch mới, dừng/đối soát việc đang chạy, snapshot DB + objects + encrypted config/key metadata nhất quán. Backup hệ thống không phải Project artifact thông thường: maintenance job có artifact_id=null; filesystem backup path chỉ admin CLI/owner ops được quản lý và không lộ qua chat/tool file APIs. Backup encryption key được owner giữ tách biệt. Thực hiện restore drill trên DB/object root mới; revoke sessions/worker credentials/leases và không tự replay restored runs.

## Trước dùng thật

Kiểm tra owner login/logout/recovery, Project export không kèm secret/grant active, cancellation khi worker mất mạng, artifact hash fail, budget race, backup restore, cross-Project file access, browser scoped proxy. Chỉ phát hành khi G0–G7 có evidence thật và limitations được owner chấp nhận. Không tick checklist từ kết quả validator tài liệu.

## Nâng cấp

Đọc migration compatibility matrix; backup trước; drain worker; deploy thứ tự schema tương thích → API/runtime → web → worker theo version negotiation. Không rollback code cũ vào schema không tương thích. Rollback chỉ theo đã diễn tập. Dependencies và sandbox image digest phải được ghi trong release manifest/SBOM.
