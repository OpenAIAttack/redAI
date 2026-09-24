package executor

import (
	"context"
	"encoding/json"
	"net/http"
	"sync/atomic"
	"testing"
)

func TestMockExecutorDeterministic(t *testing.T) {
	req := Request{AttemptID: "a1", ToolName: "fs_read", Input: json.RawMessage(`{"echo":"hello"}`)}
	r1, err := Mock{}.Execute(context.Background(), req)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	r2, _ := Mock{}.Execute(context.Background(), req)
	if r1.Status != "succeeded" || r1.EffectObservation != "completed" {
		t.Fatalf("unexpected result: %+v", r1)
	}
	if len(r1.Artifacts) != 1 {
		t.Fatalf("want 1 artifact, got %d", len(r1.Artifacts))
	}
	// Same input ⇒ identical artifact bytes + digest (two homogeneous workers agree).
	if string(r1.Artifacts[0].Bytes) != string(r2.Artifacts[0].Bytes) {
		t.Fatal("artifact bytes are not deterministic")
	}
	if r1.Artifacts[0].SHA256 != r2.Artifacts[0].SHA256 {
		t.Fatal("artifact digest is not deterministic")
	}
}

func TestMockExecutorCancelledIsNotStarted(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r, err := Mock{}.Execute(ctx, Request{AttemptID: "a1", ToolName: "fs_read", Input: json.RawMessage(`{}`)})
	if err == nil {
		t.Fatal("expected cancellation error")
	}
	if r.EffectObservation != "not_started" {
		t.Fatalf("cancelled-before-start must be not_started, got %q", r.EffectObservation)
	}
}

// tripwire fails the test if any code makes an outbound HTTP call via the default
// transport while the mock executor runs — the executor must be strictly offline.
type tripwire struct{ hit *int32 }

func (tw tripwire) RoundTrip(*http.Request) (*http.Response, error) {
	atomic.StoreInt32(tw.hit, 1)
	return nil, http.ErrUseLastResponse
}

func TestMockExecutorOpensNoNetwork(t *testing.T) {
	var hit int32
	orig := http.DefaultTransport
	http.DefaultTransport = tripwire{hit: &hit}
	defer func() { http.DefaultTransport = orig }()

	_, err := (Mock{}).Execute(context.Background(), Request{
		AttemptID: "a1",
		ToolName:  "http_request",
		Input:     json.RawMessage(`{"url":"http://example.invalid/"}`),
	})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if atomic.LoadInt32(&hit) != 0 {
		t.Fatal("mock executor made an outbound network call")
	}
}
