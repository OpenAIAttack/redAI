# 16 — Threat model và giới hạn bảo đảm

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

## 1. Assets và trust boundaries

Assets quan trọng: model/target credentials, worker tokens, owner session, source files, raw evidence, Project scope, installation signing/master keys, worker host, network của owner và hóa đơn model. Trust boundaries: browser↔API, API↔DB/storage, runtime↔provider, control-plane↔worker, worker↔sandbox, sandbox↔proxy↔target, export↔import.

Owner và host administrator được tin về ý định cấu hình nhưng vẫn có thể mắc lỗi. Model, website đích, uploaded document, package/plugin từ Internet và sandbox process không tin cậy. Worker daemon là trusted component nhưng có thể bị compromise; provenance của worker bị compromise phải được đánh dấu xem xét lại.

## 2. Threat register

| ID | Threat | Control bắt buộc | Bằng chứng kiểm thử |
|---|---|---|---|
| TH01 | Target prompt injection cấp quyền mới | Authority ngoài model; typed tools; live policy | Hostile content fixture không tạo grant |
| TH02 | Agent shell lấy dữ liệu host | No host mounts/socket; sandbox runtime | Filesystem/network lab |
| TH03 | Task giả hoặc sửa args | TLS, worker auth, signed envelope/input hash | Signature tamper fixture |
| TH04 | Worker credential bị dùng ở máy khác | Stable identity + session generation, revoke | Clone identity test |
| TH05 | Domain scope biến thành shared IP authorization | Origin-aware proxy, no raw network v1 | Hai vhost cùng IP |
| TH06 | DNS rebind/redirect bypass | Validate+pin dial, each redirect check | Resolver/redirect lab |
| TH07 | Replay side effect khi mất ACK | Durable journal, idempotent result, unknown reconcile | Harmless POST counter |
| TH08 | Scope grant revoked nhưng run tiếp tục | Live epoch checks, no renewal, watchdog | Revoke during browser traffic |
| TH09 | Secret vào provider/log/report | Secret refs, redaction, payload filter | Canary suite |
| TH10 | File upload/export traversal | Logical roots, no-follow, archive validation | Symlink/archive tests |
| TH11 | CSRF/LAN attacker điều khiển owner | Session/Origin/CSRF/TLS | Foreign origin tests |
| TH12 | Finding giả/unsupported confidence | Evidence ready+provenance gate, owner review | Missing artifact negative |
| TH13 | Budget runaway qua child agents | Shared reservations, limits, unknown held | Parallel child budget test |
| TH14 | Backup chỉ DB mất file hoặc khóa | Quiescent manifest backup, restore drill | Fresh-machine restore |
| TH15 | SSE sequence race bỏ event | Commit-ordered counter transaction | Commit inversion integration test |
| TH16 | Output flood/zip bomb/disk full | Hard caps, backpressure, quarantine | Bounded stress fixtures |
| TH17 | Tool supply chain | Pinned versions/digests, SBOM, no install-at-run | Build provenance review |
| TH18 | LLM endpoint config trở thành SSRF | Owner-only endpoint allowlist, no chat override | Provider route tests |

## 3. Những điều thiết kế không hứa

Không chống được host root cố ý phá nền tảng; không bảo đảm model không bị ảnh hưởng bởi mọi prompt injection; không xác minh pháp lý quyền chỉ bằng DNS; không bảo đảm upstream provider không giữ dữ liệu ngoài hợp đồng của họ; không cam kết rollback remote side effect; không exactly-once execution xuyên mạng; không xác minh tính chân thật bằng hash đơn thuần.

“Không hứa” không phải bỏ kiểm soát. Phải giảm blast radius, ghi nhận uncertainty, fail closed khi mất guard và cung cấp owner controls. Bản production phải nêu residual risks trong help/release note, không gắn nhãn “enterprise-grade” chưa được kiểm chứng.

## 4. Incident response tối thiểu

Emergency stop → revoke affected worker/provider/secret capabilities → cô lập host nghi vấn → giữ evidence/audit liên quan có hash → rotate credentials → phục hồi từ known-good state → chạy consistency/security lab → owner chủ động bật execution. Không purge log chứng cứ chỉ để hết cảnh báo. Không log raw credential trong incident report.

## 5. Review trước mở rộng

Raw TCP, remote MCP, shared users, cloud sandbox, public sharing và auto scheduled runs đều đổi trust model. Bắt buộc ADR + abuse cases + auth/scope/retention tests trước khi thêm. Không coi extension chỉ là thêm một icon/tool description.
