# 14 — Triển khai, nâng cấp và khôi phục

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

## 1. Hai profile, không triển khai cloud bắt buộc

Development profile có PostgreSQL, API/runtime/web, deterministic mock provider, fixture lab; bind localhost, không target ngoài lab. Personal production profile có HTTPS reverse proxy, owner auth, model do owner cấu hình, persisted data volumes, worker Linux/gVisor đạt doctor, network isolation và backup. Profile mock phải hiện rõ và không được coi là release cho công việc thật.

Gói tài liệu cung cấp `ops/config.example.env` và `ops/deployment-checklist.md`; coding agent phải tạo Compose/systemd/scripts thật trong T28. Không có compose app runnable được giả tạo bằng image chưa build.

## 2. Startup order và readiness

PostgreSQL healthy → migration job → API/runtime → web → proxy routing → worker enrollment/session. Readiness API kiểm tra DB/schema/key/storage mount; readiness runtime kiểm tra lease/reconciliation loops; worker doctor kiểm tra runtime, image digest, clock, disk, DNS/proxy guard. Liveness không gọi provider trả phí hoặc target thật. Provider health phân tách với control-plane availability.

Chưa migrated đúng schema thì không nhận mutation mới. Missing encryption key khóa các chức năng secret, không tự tạo key mới. Storage readonly/full chặn upload/task cần artifact, UI vẫn báo tình trạng. Worker không ready nếu gVisor/proxy guard fail; không degrade silently.

## 3. Cấu hình và secret files

`.env` không chứa production master key trực tiếp nếu có thể; dùng `_FILE` paths, mode0600, owner OS user riêng. Tách `DATA_ROOT`, `STATE_ROOT`, `KEY_ROOT`, backup destination. Không mount KEY_ROOT vào worker sandbox. DB user API/runtime không superuser; migration role riêng; worker không biết DB DSN. Reverse proxy chỉ exposes app/worker HTTPS, DB local/private.

Owner tạo keys qua CLI dùng crypto RNG. File sample không có key hợp lệ, chỉ placeholders rõ ràng; bootstrap từ chối placeholder values. OCI images và packages pin digest/version trong dependency baseline, không `latest`.

## 4. Nâng cấp

Backup đã xác minh → drain new runs → chờ hoặc cancel active external tasks có acknowledgement → deploy additive migration → API/runtime compatible version → web → workers theo protocol compatibility → smoke lab → un-drain. Không upgrade bằng xóa volumes. Old worker missing required policy fields bị block claim, không được nhận envelope rút gọn.

Rollback code chỉ khi schema backward-compatible; migration destructive rollback theo restore/runbook, không phỏng đoán. Run có checkpoint version cũ cần migration explicit hoặc settle trước upgrade. Preview/test môi trường dùng keys/data khác, không copy worker identities.

## 5. Backup nhất quán cho personal v1

Chọn **quiescent backup** để dễ chứng minh tính nhất quán giữa DB và local ObjectStore. Owner yêu cầu backup job; system ngừng mutation mới, drain/cancel active runs tới quiescent, chờ artifact finalize; không ép freeze khi còn unknown external effect. Ghi snapshot manifest gồm schema/app version, event cursor, DB dump checksum, artifact inventory/hash và key IDs cần có.

Tạo PostgreSQL custom-format dump; công cụ pg_dump tạo backup DB theo docs PostgreSQL [SRC13]. File store phải snapshot/copy theo đúng DB inventory khi writes đã dừng; một pg_dump riêng không backup được file payload ngoài DB. Secrets giữ dạng ciphertext, keys backup qua kênh riêng được mã hóa với recovery key owner giữ. Không backup API sessions/worker credentials như trạng thái tự kích hoạt: restore luôn revoke chúng.

Mã hóa archive bằng công cụ được duy trì và authenticated encryption; không ZIP password yếu tự chế. Tạo checksum archive và thử đọc manifest. Chỉ báo “Backup verified” khi đã giải mã/validate archive và hash sample/all theo cấu hình; chỉ upload object thành công là “Backup created”, chưa verified. Sau khi hoàn tất hoặc fail có cleanup rõ, bỏ maintenance lock an toàn.

## 6. Restore drill

Máy sạch, cùng hoặc version hỗ trợ migration; network thực thi bị disable. Verify archive/authentication/hash trước unpack, reject traversal. Restore DB/file inventory/keys, chạy migrations cần thiết trong maintenance. Revoke owner sessions, worker credentials/enrollment tokens và run leases; mọi active run trước backup chuyển needs_attention/restore_suspended, không tự phát hành lại tool. Owner login qua recovery/bootstrap recovery flow, re-enroll workers và review grants.

Chạy consistency checker: mọi artifact ready có bytes/hash, FK/domain closure, no active stale lease, no duplicate cursor, secret decrypt canary thành công. Restore thiếu key phải báo secrets_locked, không xóa ciphertext. Chỉ bật execution sau lab smoke và owner explicit acknowledgment.

## 7. RPO/RTO mục tiêu

Mục tiêu tham chiếu: owner thực hiện backup tối thiểu hằng ngày khi có công việc mới, RPO24 giờ với lịch này; restore dataset lab10GiB trong60 phút trên cấu hình test. Đây là mục tiêu kiểm thử và quy trình owner, chưa có automation tự chạy trong sản phẩm, không SLA. Nếu chưa đo restore10GiB, report “chưa benchmark”, không điền số đạt.

## 8. Sự cố và ứng phó

Provider down: giữ queue/checkpoint, không đổi data policy. DB down: không dispatch mới; worker lease hết sẽ dừng; restore control-plane rồi reconcile. Disk full: block task mới, dừng spool trước OOM/full host, không purge evidence chưa ACK. Worker suspect: revoke credential, isolate host, quarantine new evidence, rotate target secrets có thể bị lộ. Master key suspect: emergency stop, rotate credentials/key với backup, audit access.

SSE down chỉ ảnh hưởng quan sát, không tự restart Run. Owner đóng trình duyệt không dừng Agent. API restart không được xóa worker identity hoặc pending approval. Emergency stop endpoint vẫn cần owner auth, có CLI local emergency command khi web không sẵn.

## 9. Bàn giao vận hành

Phải có lệnh/scripts thật: bootstrap, doctor, backup, verify-backup, restore, migrate, reconcile-artifacts, emergency-stop, rotate-worker-token. Các lệnh destructive có dry-run và confirmation cụ thể. Script backup trả exit code khác0 nếu verify fail; không dùng `|| true` che lỗi.

Tài liệu triển khai cần ghi OS/kernel/runtime versions đã test, tài nguyên, ports, mount permissions, nơi logs và recovery keys. Không gọi “one-click install” nếu vẫn cần chỉnh thủ công mơ hồ. T28/T31 phải chạy drill trên fresh environment và lưu kết quả trong release evidence.

## Phân biệt backup hệ thống và Project export

Backup toàn bộ installation được ghi trong maintenance job nhưng không gắn với artifact của một Project: `project_id` và `artifact_id` của job backup có thể null. File backup nằm dưới backup root riêng, chỉ qua admin operation; không qua artifact download/tool filesystem thông thường. Project export thì phải gắn Project/Workspace và kiểm tra quyền như mọi artifact. Không tạo artifact "toàn hệ thống" giả dưới Inbox để bỏ qua ranh giới dữ liệu.
