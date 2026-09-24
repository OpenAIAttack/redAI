# 07 — Durable Agent runtime và vòng lặp điều phối

Phiên bản đặc tả: `1.0.0-draft.1` · Ngày: **24/09/2026** · Sản phẩm: **redAI Personal v1**

## 1. Các khái niệm

Run là yêu cầu công việc có tuổi thọ độc lập tab trình duyệt. AgentSession là coordinator hoặc subagent logic trong Run. AgentStep là một lượt gọi model cùng xử lý tool results. ToolCall là ý định đã được chốt; TaskAttempt là lần worker thực thi. Một Run có thể tạo nhiều AgentSession nhưng dùng chung scope snapshot, worker binding và budget root.

Ask đi qua cùng provider/context/persistence nhưng **tool set rỗng**, không tạo execution attempts. Report rendering server là maintenance task không phải quyền shell của model. Agent không được tự mở task root mới để vượt step/budget limit.

## 2. Một vòng xử lý

1. Claim run bằng row lock ngắn, tăng `runtime_fence`, đặt lease.
2. Đọc checkpoint, live grant, cancel/pause intent, notes mới, kết quả task đã commit.
3. Nếu còn ambiguous effect, chờ/reconcile; không gọi model để tự đoán task đã chạy hay chưa.
4. Tạo context manifest bằng nguồn có ID/hash; tính token/cost reservation.
5. Lưu step `calling_model` và provider request attempt ID trước network call.
6. Gọi model có timeout/cancel; stream provisional text, nhưng không thực thi tool-call chunk chưa hoàn chỉnh.
7. Validate full response và persist model boundary bằng runtime_fence CAS.
8. Với mỗi tool call: normalize, schema validate, tool registry classify, scope/policy/budget check; tạo approval hoặc queued attempt.
9. Đợi task results, update plan/checkpoint; lặp trong step/time/budget limit.
10. Finalize sau khi không còn task active/unknown: summary có coverage, evidence, unresolved items và usage trạng thái.

Không giữ DB transaction qua bước 6 hoặc lúc worker thực thi. Lease renewal là loop riêng, bounded; nếu mất lease, runtime bỏ quyền commit mới và abort provider request khi có thể.

## 3. Checkpoint tối thiểu

`run_id`, `runtime_fence`, `agent_session_id`, `step_no`, `state`, `objective`, `plan_revision`, `pending_tool_call_ids`, `last_consumed_event_id`, `last_consumed_message_seq`, `context_manifest`, `summary_artifact_id`, `retained_tail_message_ids`, `provider_request_id`, `budget_reservation_id`, `stop_reason`, timestamps. Secrets không xuất hiện trong checkpoint; dùng secret_ref.

Lịch sử Chat, context model và domain state tách biệt. Context summary không chứa “quyền mới” có hiệu lực; mọi scope từ DB đã version. Sau restart phải reconstruct bước từ checkpoint/domain entities, không replay toàn transcript thành tools.

## 4. Model response schema

Model có thể trả text hoặc tool calls theo provider adapter. Tool arguments phải parse được một lần và validate exact schema; duplicate JSON keys reject; unknown tool name reject. Registry cố định cho Run từ manifest version. Không dùng một tool `execute_anything` trên host.

Tool call ID từ provider không được tin làm primary ID toàn hệ thống. Server tạo UUID cho ToolCall, lưu provider index/id dưới dạng metadata. Unique `(agent_step_id, provider_tool_index)` chống tạo trùng khi callback lặp. Tool descriptions/prompt được versioned và ghi manifest hash.

Khi structured output lỗi, cho tối đa một repair request chỉ sửa cấu trúc dựa trên dữ liệu có sẵn; request đó cũng tính budget/step. Không chạy tool dựa trên JSON “gần đúng”. Repair thất bại trả MODEL_OUTPUT_INVALID, giữ partial output.

## 5. Retry matrix

| Tình huống | Hành động |
|---|---|
| Model 429 trước response và không có tool commit | Tối đa 2 retries có jitter/Retry-After, cùng provider cho phép, budget theo attempt |
| Model timeout sau partial text | Đánh dấu generation interrupted; chỉ retry nếu không có boundary tools commit; ghi usage_unknown nếu thiếu billing |
| Runtime chết sau model response nhưng trước commit | Không có tool được dispatch; model có thể gọi lại, chi phí có thể lặp; ghi reconciliation flag |
| Runtime chết sau tool_call commit | Dùng tool_call đã có, không tạo call mới |
| Tool pure thất bại rõ trước start | Có thể retry 1 lần nếu lease cũ quiescent và live policy còn hợp lệ |
| Task mất kết nối trong external operation | unknown/needs_attention; không automatic replay |
| Provider bị chính sách dữ liệu chặn | Không fallback ra provider khác hoặc model không được phép |
| Approval rejected | Nêu bị từ chối, có thể sửa kế hoạch không lặp cùng hành động |

Library retry phải được cấu hình rõ; không để SDK retry công cụ hoặc model vô hạn phía dưới application policy. Provider fallback là cấu hình owner explicit cùng policy/data region, không route tự động chỉ vì một nhà cung cấp từ chối nội dung.

## 6. Pause, notes, resume và cancel

Pause là cooperative: ngừng tạo tác vụ mới sau bước hiện tại; tool đang chạy được cho hoàn thành trong timeout nếu owner chỉ pause. UI hiển thị “Đang chờ bước hiện tại dừng tại ranh giới”. Không giữ approval hoạt động vô hạn: expiry 15 phút; khi resume tạo approval mới cho fingerprint hiện tại nếu cần.

Note gửi trong run active được append message, runtime lấy ở boundary tiếp theo và đánh dấu consumed. Note không tự đổi authorization. Nếu note yêu cầu scope rộng hơn, runtime tạo blocked item và owner dùng Project settings.

Resume paused/waiting_worker yêu cầu live grant/budget/provider/worker check; absolute deadline 24 giờ từ create không bị kéo dài bằng retry. Đã expired/completed/failed tạo Run mới tham chiếu trước, không chỉnh history. Budget tăng là owner action được audit và cập nhật ledger giới hạn, không thay chi phí quá khứ.

Cancel lập tức ngừng dispatch/model turn mới; abort provider và gửi worker directives. Parent chỉ canceled khi mọi child/session/task quiescent. Nếu worker mất liên lạc, cancellation_pending; local watchdog phải kill sau lease TTL, nhưng server cần acknowledgement/reconciliation trước tuyên bố biết chắc đã dừng. Không dùng ảnh screenshot “Stop” làm bằng chứng cancel hoạt động.

## 7. Subagent bounded

Coordinator có tool `agent.delegate` ở control-plane, không chạy trong sandbox. Input có objective cụ thể, context refs, allowed tools subset, budget share, acceptance output. Child không thể delegate tiếp. Tối đa 2 active children và tổng 3 model requests đồng thời toàn Run. Scheduler transaction giữ slot/budget chung.

Child output là dữ liệu chưa xác minh, không instruction cấp quyền. Coordinator phải kiểm tra artifact readiness và finding statuses; không viết “child xác minh thành công” khi child failed/inconclusive. Shared workspace filesystem không được child ghi đè: mỗi child có run-local thư mục riêng, promote artifact bằng explicit link.

Không có worker `recon`, `web`, `report`. Cùng binary toolset, task selection dựa binding, health, capacity, supported manifest và network zone. Agent role không gắn hostname.

## 8. Context compaction

Ngưỡng đề xuất 70% context window đã cấu hình; giữ system/task instructions, live policy snapshot structured, plan/current work, critical evidence refs và tail hoàn chỉnh. Large output chuyển artifact + bounded excerpt, không bỏ hash/provenance. Summary dùng schema `summary.schema.json`; phải giữ objective, completed/pending, evidence IDs, uncertainties và active task IDs.

Compaction chỉ thay context derivative, không xóa Chat/Evidence. Summary fail thì giữ context cũ, prune deterministic phần không thiết yếu hoặc dừng với CONTEXT_LIMIT; không lưu summary rỗng đè dữ liệu tốt. Không để message tool-result mất cặp tool-call theo protocol provider. Summary không trở thành nguồn authorization [thiết kế redAI; tham khảo vấn đề compaction SRC02].

## 9. Chống vòng lặp và runaway

Fingerprint action gồm tool name + normalized args + target + input versions. Ba lần cùng fingerprint không tiến triển → nudge một lần rồi stop reason LOOP_DETECTED. “Không tiến triển” là không artifact/result/plan state mới, không đơn giản số message giống nhau. Child loops tính chung budget. Hạn mức step 40, active time 30 phút, absolute time 24 giờ, calls concurrent theo SPEC_LOCK.

Không dùng model tự báo “tôi đã xong” làm điều kiện duy nhất. Finalization gate: không pending tool, không approval pending cần xử lý, mọi finding final có status/evidence hợp lệ, report refs ready, coverage/incomplete fields có mặt.

## 10. Acceptance riêng runtime

Restart tại từng boundary của loop với deterministic provider fixture phải không nhân tool call. Hai runtime processes claim cùng run chỉ một fence commit. Old runtime tỉnh lại sau GC/network delay không được commit response. Mất model cost metadata phải thấy unknown/reserved, không 0. Cancel child cùng lúc parent finalizing không thể xuất report “completed” bỏ qua child chưa dừng.
