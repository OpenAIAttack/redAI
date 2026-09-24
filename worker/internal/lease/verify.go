// Package lease verifies signed task leases and canonicalizes JSON per RFC 8785
// (docs/08 §4, §11). A lease is an Ed25519 compact JWS whose payload is the
// JCS-canonical bytes of the lease claims; the worker holds the installation's
// trusted public keys (from enrollment) and MUST verify the signature, cross-check
// every externally-presented claim against the signed payload, re-verify the tool
// input hash, and check the audience/session/time window BEFORE it acknowledges or
// runs a task. It never implements ad-hoc crypto: verification is stdlib
// crypto/ed25519 and canonicalization mirrors the server's JCS byte-for-byte.
package lease

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"time"

	"github.com/openaiattack/redai/worker/internal/contracts"
)

// VerifyKey is a trusted installation signing key: a key id and its Ed25519 public
// key. Built from the enrolled trusted_signing_keys.
type VerifyKey struct {
	KeyID     string
	PublicKey ed25519.PublicKey
}

// ParseVerifyKey decodes a base64url raw 32-byte Ed25519 public key (JWK `x`).
func ParseVerifyKey(keyID, publicKeyBase64URL string) (VerifyKey, error) {
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(publicKeyBase64URL, "="))
	if err != nil {
		return VerifyKey{}, fmt.Errorf("lease: decoding key %q: %w", keyID, err)
	}
	if len(raw) != ed25519.PublicKeySize {
		return VerifyKey{}, fmt.Errorf("lease: key %q is %d bytes, want %d", keyID, len(raw), ed25519.PublicKeySize)
	}
	return VerifyKey{KeyID: keyID, PublicKey: ed25519.PublicKey(raw)}, nil
}

// DefaultClockSkew bounds how far the lease's issued_at may be in the future
// relative to the worker's clock before the lease is rejected (docs/08 §10).
const DefaultClockSkew = 30 * time.Second

type jwsHeader struct {
	Alg string `json:"alg"`
	Kid string `json:"kid"`
	Typ string `json:"typ"`
}

// SignEd25519JWS builds a compact Ed25519 JWS (`base64url(header).base64url(payload).
// base64url(sig)`) over `payload`, pinning `alg=EdDSA` and `kid`. The server mints
// production leases; this helper exists for reconcile re-issue paths and tests, and
// keeps the header shape in one place so verification and signing never drift.
func SignEd25519JWS(priv ed25519.PrivateKey, keyID string, payload []byte) string {
	hdr, _ := json.Marshal(jwsHeader{Alg: "EdDSA", Kid: keyID, Typ: "JWS"})
	h := base64.RawURLEncoding.EncodeToString(hdr)
	p := base64.RawURLEncoding.EncodeToString(payload)
	sig := ed25519.Sign(priv, []byte(h+"."+p))
	return h + "." + p + "." + base64.RawURLEncoding.EncodeToString(sig)
}

// Verify checks a compact Ed25519 JWS against the trusted keys and returns the signed
// claims. It rejects: a malformed/tampered JWS, an unknown kid or non-EdDSA alg, a
// mismatch between the signed payload and the externally-presented envelope claims, an
// expired or not-yet-valid lease, a session/worker audience mismatch, or a tool input
// whose hash does not match the signed input_sha256. The returned claims are then safe
// for the worker to act on.
func Verify(
	jws string,
	keys []VerifyKey,
	env contracts.TaskEnvelope,
	now time.Time,
	wantWorkerID string,
	wantSessionID string,
	skew time.Duration,
) (contracts.LeaseClaims, error) {
	var zero contracts.LeaseClaims
	parts := strings.Split(jws, ".")
	if len(parts) != 3 {
		return zero, fmt.Errorf("lease: not a compact JWS")
	}
	headerBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return zero, fmt.Errorf("lease: decoding header: %w", err)
	}
	var hdr jwsHeader
	if err := json.Unmarshal(headerBytes, &hdr); err != nil {
		return zero, fmt.Errorf("lease: header: %w", err)
	}
	if hdr.Alg != "EdDSA" {
		return zero, fmt.Errorf("lease: unexpected alg %q", hdr.Alg)
	}
	var key ed25519.PublicKey
	for _, k := range keys {
		if k.KeyID == hdr.Kid {
			key = k.PublicKey
			break
		}
	}
	if key == nil {
		return zero, fmt.Errorf("lease: unknown key id %q", hdr.Kid)
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return zero, fmt.Errorf("lease: decoding signature: %w", err)
	}
	signingInput := []byte(parts[0] + "." + parts[1])
	if !ed25519.Verify(key, signingInput, sig) {
		return zero, fmt.Errorf("lease: signature verification failed")
	}

	payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return zero, fmt.Errorf("lease: decoding payload: %w", err)
	}
	var signed contracts.LeaseClaims
	dec := json.NewDecoder(bytes.NewReader(payloadBytes))
	if err := dec.Decode(&signed); err != nil {
		return zero, fmt.Errorf("lease: decoding claims: %w", err)
	}

	// The externally-presented claims (envelope.claims) must equal the SIGNED claims;
	// the worker never trusts a claims field it has not verified (docs/08 §11).
	if !reflect.DeepEqual(signed, env.Claims) {
		return zero, fmt.Errorf("lease: envelope claims do not match the signed claims")
	}
	if err := signed.Validate(); err != nil {
		return zero, fmt.Errorf("lease: invalid claims: %w", err)
	}

	// Audience: this lease must be for THIS worker and its CURRENT session.
	if string(signed.WorkerID) != wantWorkerID {
		return zero, fmt.Errorf("lease: worker_id audience mismatch")
	}
	if string(signed.WorkerSessionID) != wantSessionID {
		return zero, fmt.Errorf("lease: worker_session_id audience mismatch")
	}

	// Time window.
	issuedAt, err := time.Parse(time.RFC3339, string(signed.IssuedAt))
	if err != nil {
		return zero, fmt.Errorf("lease: issued_at: %w", err)
	}
	expiresAt, err := time.Parse(time.RFC3339, string(signed.ExpiresAt))
	if err != nil {
		return zero, fmt.Errorf("lease: expires_at: %w", err)
	}
	if !now.Before(expiresAt) {
		return zero, fmt.Errorf("lease: expired")
	}
	if now.Add(skew).Before(issuedAt) {
		return zero, fmt.Errorf("lease: issued in the future beyond allowed skew (CLOCK_UNSAFE)")
	}

	// Input hash: the tool input's JCS digest must match the signed input_sha256.
	canon, err := Canonicalize(env.Input)
	if err != nil {
		return zero, fmt.Errorf("lease: canonicalizing input: %w", err)
	}
	sum := sha256.Sum256(canon)
	if hex.EncodeToString(sum[:]) != string(signed.InputSHA256) {
		return zero, fmt.Errorf("lease: input hash mismatch")
	}
	return signed, nil
}

// Canonicalize returns the RFC 8785 (JCS) canonical bytes of a JSON value, restricted
// to the shapes that occur in tool inputs and claims — objects, arrays, strings,
// integers, booleans and null. It mirrors the server's canonicalizer exactly (object
// keys sorted by code unit, integers shortest-form, JS-style string escaping) so the
// input digest matches; a non-integer number is a divergence risk and is rejected.
func Canonicalize(raw json.RawMessage) ([]byte, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v interface{}
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	var b bytes.Buffer
	if err := writeCanonical(&b, v); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}

func writeCanonical(b *bytes.Buffer, v interface{}) error {
	switch t := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		if t {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case json.Number:
		s := t.String()
		if strings.ContainsAny(s, ".eE") {
			return fmt.Errorf("canonicalize: only integers are supported, got %q", s)
		}
		b.WriteString(s)
	case string:
		writeJSONString(b, t)
	case []interface{}:
		b.WriteByte('[')
		for i, e := range t {
			if i > 0 {
				b.WriteByte(',')
			}
			if err := writeCanonical(b, e); err != nil {
				return err
			}
		}
		b.WriteByte(']')
	case map[string]interface{}:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys) // byte order == the server's UTF-16 order for ASCII keys
		b.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				b.WriteByte(',')
			}
			writeJSONString(b, k)
			b.WriteByte(':')
			if err := writeCanonical(b, t[k]); err != nil {
				return err
			}
		}
		b.WriteByte('}')
	default:
		return fmt.Errorf("canonicalize: unsupported type %T", v)
	}
	return nil
}

// writeJSONString escapes exactly as ECMAScript JSON.stringify does: quotes, backslash
// and control characters (< 0x20), with the short forms where they exist. It does NOT
// HTML-escape (<, >, &), matching the server so the bytes are identical.
func writeJSONString(b *bytes.Buffer, s string) {
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\t':
			b.WriteString(`\t`)
		case '\n':
			b.WriteString(`\n`)
		case '\f':
			b.WriteString(`\f`)
		case '\r':
			b.WriteString(`\r`)
		default:
			if r < 0x20 {
				fmt.Fprintf(b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
}
