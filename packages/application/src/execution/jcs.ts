/**
 * JSON canonicalization (RFC 8785 / JCS subset) + Ed25519 compact JWS for signed
 * task leases (docs/08 §4, §11).
 *
 * The lease is an Ed25519 JWS whose payload is the JCS-canonical bytes of the lease
 * claims; the tool input hash inside those claims is `sha256(JCS(input))`. Both the
 * server (this module, minting) and the Go worker (verifying) must canonicalize
 * identically, so the canonicalizer here restricts itself to the value shapes that
 * actually occur in claims and tool input — strings, integers, booleans, null,
 * arrays and objects — with:
 *
 *   - object keys sorted by UTF-16 code unit (Array#sort default), which agrees with
 *     Go's byte-wise sort for the ASCII snake_case keys we emit;
 *   - integers serialized as the shortest decimal (no floats occur in claims/input);
 *   - standard JSON string escaping.
 *
 * We deliberately do NOT implement the full RFC 8785 number grammar (ECMAScript
 * Number formatting for non-integers): a float in a lease claim or a mock tool input
 * is a programming error and throws, rather than risk a silent server/worker
 * canonicalization divergence.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from 'node:crypto';

/** A JSON value restricted to what canonicalization supports. */
export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | CanonicalValue[]
  | { [key: string]: CanonicalValue | undefined };

/** Serialize `value` to its JCS-canonical UTF-8 string. */
export function canonicalize(value: CanonicalValue): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new Error(`canonicalize: only integers are supported, got ${String(value)}`);
    }
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v as CanonicalValue)).join(',')}]`;
  }
  const obj = value as { [key: string]: CanonicalValue | undefined };
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k] as CanonicalValue)}`);
  return `{${parts.join(',')}}`;
}

/** `sha256(JCS(value))` as lowercase hex — the tool-input digest of docs/08 §11. */
export function canonicalSha256Hex(value: CanonicalValue): string {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}

/** URL-safe base64 without padding (JWS / RFC 8785 base64url). */
export function base64url(bytes: Uint8Array | Buffer): string {
  return Buffer.from(bytes).toString('base64url');
}

/**
 * A minimal Ed25519 signer over an arbitrary signing input. It never exposes the
 * private key material; the service builds the JWS around it. The coordinator wires a
 * concrete signer from the installation signing key (see {@link createEd25519LeaseSigner}).
 */
export interface LeaseSigner {
  readonly keyId: string;
  readonly algorithm: 'EdDSA';
  /** Raw Ed25519 signature over `signingInput`. */
  sign(signingInput: Uint8Array): Uint8Array;
}

/** Build a {@link LeaseSigner} from an Ed25519 private key (a Node `KeyObject`). */
export function createEd25519LeaseSigner(
  privateKey: KeyObject | string | Buffer,
  keyId: string,
): LeaseSigner {
  const key =
    typeof privateKey === 'string' || Buffer.isBuffer(privateKey)
      ? createPrivateKey(privateKey)
      : privateKey;
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('createEd25519LeaseSigner: expected an ed25519 private key');
  }
  return {
    keyId,
    algorithm: 'EdDSA',
    sign(signingInput: Uint8Array): Uint8Array {
      // Node's one-shot `sign(null, data, edKey)` performs EdDSA (no pre-hash).
      return edSign(null, Buffer.from(signingInput), key);
    },
  };
}

/**
 * Mint an Ed25519 compact JWS whose payload is the JCS-canonical bytes of `claims`.
 * The protected header pins `alg=EdDSA` and the signer's `kid`. Returns the compact
 * serialization `base64url(header).base64url(payload).base64url(signature)`.
 */
export function mintLeaseJws(claims: CanonicalValue, signer: LeaseSigner): string {
  const header = { alg: signer.algorithm, kid: signer.keyId, typ: 'JWS' };
  const headerB64 = base64url(Buffer.from(canonicalize(header), 'utf8'));
  const payloadB64 = base64url(Buffer.from(canonicalize(claims), 'utf8'));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = signer.sign(Buffer.from(signingInput, 'utf8'));
  return `${signingInput}.${base64url(signature)}`;
}

/** Build an Ed25519 public `KeyObject` from a base64url raw 32-byte key (JWK `x`). */
export function ed25519PublicKeyFromBase64Url(publicKeyB64Url: string): KeyObject {
  return createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: publicKeyB64Url },
    format: 'jwk',
  });
}

/**
 * Verify a compact Ed25519 JWS and return its decoded claims. Rejects a tampered
 * header/payload/signature, an unknown `kid`, or a non-EdDSA `alg`. The caller is
 * responsible for the semantic checks (audience/session/time) on the returned claims.
 */
export function verifyLeaseJws(
  jws: string,
  trustedKeys: ReadonlyMap<string, KeyObject>,
): Record<string, unknown> {
  const parts = jws.split('.');
  if (parts.length !== 3) throw new Error('verifyLeaseJws: not a compact JWS');
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
  let header: { alg?: string; kid?: string };
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
  } catch {
    throw new Error('verifyLeaseJws: bad header');
  }
  if (header.alg !== 'EdDSA') throw new Error('verifyLeaseJws: unexpected alg');
  const key = header.kid ? trustedKeys.get(header.kid) : undefined;
  if (!key) throw new Error('verifyLeaseJws: unknown kid');
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
  const signature = Buffer.from(sigB64, 'base64url');
  if (!edVerify(null, signingInput, key, signature)) {
    throw new Error('verifyLeaseJws: signature verification failed');
  }
  return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}
