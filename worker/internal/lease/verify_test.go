package lease

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"testing"
	"time"

	"github.com/openaiattack/redai/worker/internal/contracts"
)

// signTestJWS mints a compact Ed25519 JWS the way the server does (payload = the JSON
// claims). Verify cross-checks the decoded claims against the envelope with DeepEqual,
// so the exact claims byte layout is irrelevant to the signature check.
func signTestJWS(t *testing.T, priv ed25519.PrivateKey, kid string, claims contracts.LeaseClaims) string {
	t.Helper()
	hdr, _ := json.Marshal(jwsHeader{Alg: "EdDSA", Kid: kid, Typ: "JWS"})
	payload, _ := json.Marshal(claims)
	h := base64.RawURLEncoding.EncodeToString(hdr)
	p := base64.RawURLEncoding.EncodeToString(payload)
	sig := ed25519.Sign(priv, []byte(h+"."+p))
	return h + "." + p + "." + base64.RawURLEncoding.EncodeToString(sig)
}

const (
	testWorkerID  = "00000000-0000-4000-8000-0000000000a1"
	testSessionID = "00000000-0000-4000-8000-0000000000b1"
)

func validClaims(inputSHA string) contracts.LeaseClaims {
	return contracts.LeaseClaims{
		SchemaVersion:     "1.0",
		InstallationID:    "00000000-0000-4000-8000-000000000f01",
		WorkspaceID:       "00000000-0000-4000-8000-000000000001",
		ProjectID:         "00000000-0000-4000-8000-0000000000c1",
		RunID:             "00000000-0000-4000-8000-0000000000d1",
		ToolCallID:        "00000000-0000-4000-8000-0000000000f1",
		AttemptID:         "00000000-0000-4000-8000-0000000000e1",
		AttemptNo:         1,
		FencingToken:      "1",
		WorkerID:          testWorkerID,
		WorkerSessionID:   testSessionID,
		ToolName:          "fs_read",
		InputSHA256:       contracts.SHA256(inputSHA),
		PolicyEpoch:       "1",
		ImageDigest:       "sha256:" + rep("a", 64),
		NetworkProfile:    "offline",
		TimeoutSeconds:    120,
		IssuedAt:          "2026-09-24T00:00:00Z",
		ExpiresAt:         "2026-09-24T00:00:45Z",
		ToolManifestSHA:   contracts.SHA256(rep("b", 64)),
		ResourceLimits:    contracts.ResourceLimits{CPUMillis: 1000, MemoryBytes: 536870912, Pids: 128, OutputBytes: 26214400},
		ScopeVersionID:    nil,
		GrantID:           nil,
		ScopePolicySHA256: nil,
	}
}

func rep(s string, n int) string {
	out := ""
	for i := 0; i < n; i++ {
		out += s
	}
	return out
}

func inputAndHash(t *testing.T, raw string) (json.RawMessage, string) {
	t.Helper()
	canon, err := Canonicalize(json.RawMessage(raw))
	if err != nil {
		t.Fatalf("canonicalize: %v", err)
	}
	sum := sha256.Sum256(canon)
	return json.RawMessage(raw), hex.EncodeToString(sum[:])
}

func setup(t *testing.T) (ed25519.PrivateKey, []VerifyKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("keygen: %v", err)
	}
	kid := "k1"
	pkB64 := base64.RawURLEncoding.EncodeToString(pub)
	vk, err := ParseVerifyKey(kid, pkB64)
	if err != nil {
		t.Fatalf("ParseVerifyKey: %v", err)
	}
	return priv, []VerifyKey{vk}
}

var now = time.Date(2026, 9, 24, 0, 0, 10, 0, time.UTC)

func TestVerifyAccept(t *testing.T) {
	priv, keys := setup(t)
	input, sha := inputAndHash(t, `{"echo":"hello"}`)
	claims := validClaims(sha)
	env := contracts.TaskEnvelope{Claims: claims, Input: input}
	jws := signTestJWS(t, priv, "k1", claims)
	got, err := Verify(jws, keys, env, now, testWorkerID, testSessionID, DefaultClockSkew)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.ToolName != "fs_read" {
		t.Fatalf("tool_name = %q", got.ToolName)
	}
}

func TestVerifyTamperReject(t *testing.T) {
	priv, keys := setup(t)
	input, sha := inputAndHash(t, `{"echo":"hello"}`)
	claims := validClaims(sha)
	env := contracts.TaskEnvelope{Claims: claims, Input: input}
	jws := signTestJWS(t, priv, "k1", claims)
	// Flip the last byte of the payload segment.
	parts := []byte(jws)
	// find the second '.'
	dot := 0
	idx := 0
	for i, c := range parts {
		if c == '.' {
			dot++
			if dot == 2 {
				idx = i
				break
			}
		}
	}
	parts[idx-1] ^= 0x01
	if _, err := Verify(string(parts), keys, env, now, testWorkerID, testSessionID, DefaultClockSkew); err == nil {
		t.Fatal("expected tampered JWS to be rejected")
	}
}

func TestVerifyRejections(t *testing.T) {
	priv, keys := setup(t)
	input, sha := inputAndHash(t, `{"echo":"hello"}`)

	t.Run("unknown kid", func(t *testing.T) {
		claims := validClaims(sha)
		env := contracts.TaskEnvelope{Claims: claims, Input: input}
		jws := signTestJWS(t, priv, "other", claims)
		if _, err := Verify(jws, keys, env, now, testWorkerID, testSessionID, DefaultClockSkew); err == nil {
			t.Fatal("expected unknown kid rejection")
		}
	})

	t.Run("session audience mismatch", func(t *testing.T) {
		claims := validClaims(sha)
		env := contracts.TaskEnvelope{Claims: claims, Input: input}
		jws := signTestJWS(t, priv, "k1", claims)
		if _, err := Verify(jws, keys, env, now, testWorkerID, "00000000-0000-4000-8000-000000000bbb", DefaultClockSkew); err == nil {
			t.Fatal("expected session mismatch rejection")
		}
	})

	t.Run("expired lease", func(t *testing.T) {
		claims := validClaims(sha)
		env := contracts.TaskEnvelope{Claims: claims, Input: input}
		jws := signTestJWS(t, priv, "k1", claims)
		late := time.Date(2026, 9, 24, 0, 1, 0, 0, time.UTC) // past expires_at
		if _, err := Verify(jws, keys, env, late, testWorkerID, testSessionID, DefaultClockSkew); err == nil {
			t.Fatal("expected expiry rejection")
		}
	})

	t.Run("claims mismatch with signed payload", func(t *testing.T) {
		claims := validClaims(sha)
		jws := signTestJWS(t, priv, "k1", claims)
		tampered := claims
		tampered.ToolName = "http_request" // external claims diverge from the signed set
		env := contracts.TaskEnvelope{Claims: tampered, Input: input}
		if _, err := Verify(jws, keys, env, now, testWorkerID, testSessionID, DefaultClockSkew); err == nil {
			t.Fatal("expected claims-mismatch rejection")
		}
	})

	t.Run("input hash mismatch", func(t *testing.T) {
		claims := validClaims(sha)
		jws := signTestJWS(t, priv, "k1", claims)
		env := contracts.TaskEnvelope{Claims: claims, Input: json.RawMessage(`{"echo":"tampered"}`)}
		if _, err := Verify(jws, keys, env, now, testWorkerID, testSessionID, DefaultClockSkew); err == nil {
			t.Fatal("expected input-hash rejection")
		}
	})
}

// TestCanonicalizeParity pins the canonicalization to the server's JCS: these hashes
// were produced by the TypeScript canonicalizer and MUST match byte-for-byte, or the
// input digest would diverge between server and worker.
func TestCanonicalizeParity(t *testing.T) {
	cases := []struct {
		raw  string
		want string
	}{
		{`{"echo":"hello"}`, "952408573ad379a239a2e6d349c834995420ec83fd6d942bebfeb7bf4edb87d9"},
		{`{"b":1,"a":"x","z":[3,2,1]}`, "50e3cd9a8610433e6c6e43f55e4a85eb37f7a9c7d5e6120062ed0a94542feefa"},
		{`{"n":0,"t":true,"u":null}`, "39a2430b64c1275668f0aaae61d3976bc55b47a93d0f6a3ecaaa5ce10c8d1d8a"},
	}
	for _, c := range cases {
		canon, err := Canonicalize(json.RawMessage(c.raw))
		if err != nil {
			t.Fatalf("canonicalize %s: %v", c.raw, err)
		}
		sum := sha256.Sum256(canon)
		if got := hex.EncodeToString(sum[:]); got != c.want {
			t.Fatalf("canonical hash for %s = %s, want %s (canon=%s)", c.raw, got, c.want, canon)
		}
	}
}
