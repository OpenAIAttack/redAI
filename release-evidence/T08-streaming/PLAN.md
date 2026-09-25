# T08 streaming continuation — 2026-09-24

Dependencies T03/T05 recorded complete; existing changes preserved. No commit.
Implement bounded incremental SSE decoding, text/refusal deltas, tool assembly
with strict index/identity checks, required finish + DONE, trailing usage,
cancellation and interruption failure. Only completed validated calls may escape.
Write negative tests first, then implementation; run scoped and broader checks.
Capability probe/persistence and Settings wiring remain separate T08 work.
Protocol reference: https://developers.openai.com/cookbook/examples/how_to_stream_completions
