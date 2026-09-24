/**
 * Unit + boundary tests for the task-scheduler / signed-lease / result service (T17),
 * driven by the in-memory repository (no DB, no sockets). They assert the security
 * invariants of docs/08:
 *   - a minted lease is a valid Ed25519 JWS over the JCS claims, and a tampered JWS is
 *     rejected;
 *   - renewal refuses on a superseded session, a bumped policy epoch and an expired
 *     lease;
 *   - a claim gives an attempt to exactly one worker and never oversubscribes capacity;
 *   - ACK and result are idempotent, a conflicting digest quarantines, and a stale
 *     fence's write is refused;
 *   - an unknown outcome settles `unknown` (never reported success) and a lost op is
 *     re-attempted only on an explicit reconcile, never auto-reassigned.
 */
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ExecutionService,
  InMemoryExecutionRepository,
  ResultConflictError,
  StaleFenceError,
  canonicalSha256Hex,
  createEd25519LeaseSigner,
  ed25519PublicKeyFromBase64Url,
  verifyLeaseJws,
  type Clock,
} from './index.js';

const WS = '00000000-0000-4000-8000-000000000001';
const WORKER = '00000000-0000-4000-8000-0000000000a1';
const SESSION = '00000000-0000-4000-8000-0000000000b1';
const PROJECT = '00000000-0000-4000-8000-0000000000c1';
const RUN = '00000000-0000-4000-8000-0000000000d1';
const CALL = '00000000-0000-4000-8000-0000000000e1';
const INSTALL = '00000000-0000-4000-8000-0000000000f1';
const IMAGE = 'sha256:' + 'a'.repeat(64);
const MANIFEST = 'b'.repeat(64);
const INPUT = { echo: 'hello', n: 3 };

function keyMaterial() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  const signer = createEd25519LeaseSigner(privateKey, 'k-test');
  const trusted = new Map([['k-test', ed25519PublicKeyFromBase64Url(jwk.x)]]);
  return { signer, trusted };
}

class MutableClock implements Clock {
  public current: Date;
  constructor(base: Date) {
    this.current = base;
  }
  now(): Date {
    return this.current;
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

interface Setup {
  repo: InMemoryExecutionRepository;
  svc: ExecutionService;
  clock: MutableClock;
  trusted: Map<string, ReturnType<typeof ed25519PublicKeyFromBase64Url>>;
}

function setup(opts: { scoped?: boolean; capacity?: number } = {}): Setup {
  const repo = new InMemoryExecutionRepository();
  const { signer, trusted } = keyMaterial();
  const clock = new MutableClock(new Date('2026-09-24T00:00:00.000Z'));
  const svc = new ExecutionService({
    repo,
    signer,
    clock,
    config: { imageDigest: IMAGE, toolManifestSha256: MANIFEST },
  });
  repo.seedWorkspace(WS, INSTALL);
  repo.seedWorker(WORKER, {
    workspaceId: WS,
    capacity: opts.capacity ?? 2,
    sessionId: SESSION,
    revoked: false,
  });
  repo.bindProject(WORKER, PROJECT);
  if (opts.scoped) {
    repo.seedGrant('grant-1', { status: 'active', policyEpoch: '5' });
    repo.seedRun(RUN, {
      workspaceId: WS,
      projectId: PROJECT,
      selectedWorkerId: null,
      scopeVersionId: '00000000-0000-4000-8000-000000000aa1',
      grantId: 'grant-1',
      scopePolicySha256: 'c'.repeat(64),
      policySnapshot: { version: 1, rules: [] },
    });
    repo.seedToolCall(CALL, {
      workspaceId: WS,
      projectId: PROJECT,
      runId: RUN,
      toolName: 'http_request',
      toolInput: INPUT,
      inputSha256: canonicalSha256Hex(INPUT),
      effectClass: 'external_read',
      timeoutSeconds: null,
    });
  } else {
    repo.seedRun(RUN, {
      workspaceId: WS,
      projectId: PROJECT,
      selectedWorkerId: null,
      scopeVersionId: null,
      grantId: null,
      scopePolicySha256: null,
      policySnapshot: null,
    });
    repo.seedToolCall(CALL, {
      workspaceId: WS,
      projectId: PROJECT,
      runId: RUN,
      toolName: 'fs_read',
      toolInput: INPUT,
      inputSha256: canonicalSha256Hex(INPUT),
      effectClass: 'sandbox_write',
      timeoutSeconds: null,
    });
  }
  return { repo, svc, clock, trusted };
}

const scope = { workspaceId: WS, workerId: WORKER };

async function enqueue(svc: ExecutionService): Promise<string> {
  const a = await svc.enqueueAttempt({
    workspaceId: WS,
    projectId: PROJECT,
    runId: RUN,
    toolCallId: CALL,
  });
  return a.id;
}

describe('ExecutionService — signed lease', () => {
  it('mints a valid Ed25519 JWS over the JCS claims with the input hash', async () => {
    const { svc, trusted } = setup();
    await enqueue(svc);
    const env = await svc.claim(scope, SESSION);
    expect(env).not.toBeNull();
    const claims = verifyLeaseJws(env!.lease_jws, trusted);
    expect(claims['tool_name']).toBe('fs_read');
    expect(claims['input_sha256']).toBe(canonicalSha256Hex(INPUT));
    expect(claims['network_profile']).toBe('offline');
    expect(claims['image_digest']).toBe(IMAGE);
    expect(env!.input).toEqual(INPUT);
    // The external claims echoed in the envelope equal the signed claims.
    expect(env!.claims).toEqual(claims);
  });

  it('rejects a tampered JWS (signature verification fails)', async () => {
    const { svc, trusted } = setup();
    await enqueue(svc);
    const env = await svc.claim(scope, SESSION);
    const jws = env!.lease_jws;
    const [h, p, s] = jws.split('.');
    // Flip a byte in the payload segment; the signature no longer verifies.
    const flipped = p!.slice(0, -1) + (p!.endsWith('A') ? 'B' : 'A');
    expect(() => verifyLeaseJws(`${h}.${flipped}.${s}`, trusted)).toThrow();
  });
});

describe('ExecutionService — claim capacity & concurrency', () => {
  it('gives one queued attempt to exactly one concurrent claimer', async () => {
    const { svc } = setup();
    await enqueue(svc);
    const [a, b] = await Promise.all([svc.claim(scope, SESSION), svc.claim(scope, SESSION)]);
    const won = [a, b].filter((x) => x !== null);
    expect(won).toHaveLength(1);
  });

  it('never leases more than worker_capacity attempts', async () => {
    const { svc } = setup({ capacity: 2 });
    await enqueue(svc);
    await enqueue(svc);
    await enqueue(svc);
    const e1 = await svc.claim(scope, SESSION);
    const e2 = await svc.claim(scope, SESSION);
    const e3 = await svc.claim(scope, SESSION);
    expect(e1).not.toBeNull();
    expect(e2).not.toBeNull();
    expect(e3).toBeNull(); // no free slot
  });
});

describe('ExecutionService — ACK', () => {
  it('is idempotent for a repeated started ACK on the same fence', async () => {
    const { svc } = setup();
    const id = await enqueue(svc);
    const env = await svc.claim(scope, SESSION);
    const fence = env!.claims['fencing_token'] as string;
    const first = await svc.ack(scope, id, {
      sessionId: SESSION,
      fencingToken: fence,
      phase: 'started',
      journalSeq: '1',
      containerRef: 'c1',
    });
    const second = await svc.ack(scope, id, {
      sessionId: SESSION,
      fencingToken: fence,
      phase: 'started',
      journalSeq: '2',
      containerRef: 'c1',
    });
    expect(first.state).toBe('started');
    expect(second.state).toBe('started');
  });
});

describe('ExecutionService — renewal refusals', () => {
  it('refuses when the worker session was superseded', async () => {
    const { repo, svc } = setup();
    const id = await enqueue(svc);
    const env = await svc.claim(scope, SESSION);
    const fence = env!.claims['fencing_token'] as string;
    repo.setWorkerSession(WORKER, 'ffffffff-0000-4000-8000-000000000000');
    const r = await svc.renew(scope, id, {
      sessionId: SESSION,
      fencingToken: fence,
      journalSeq: '1',
      observedState: 'started',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('session_superseded');
  });

  it('refuses when the grant policy epoch was bumped', async () => {
    const { repo, svc } = setup({ scoped: true });
    const id = await enqueue(svc);
    const env = await svc.claim(scope, SESSION);
    expect(env!.claims['network_profile']).toBe('scoped_web');
    const fence = env!.claims['fencing_token'] as string;
    repo.setGrant('grant-1', { policyEpoch: '6' });
    const r = await svc.renew(scope, id, {
      sessionId: SESSION,
      fencingToken: fence,
      journalSeq: '1',
      observedState: 'started',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('policy_epoch_stale');
  });

  it('refuses when the lease has already expired', async () => {
    const { svc, clock } = setup();
    const id = await enqueue(svc);
    const env = await svc.claim(scope, SESSION);
    const fence = env!.claims['fencing_token'] as string;
    clock.advance(46_000); // past the 45s lease
    const r = await svc.renew(scope, id, {
      sessionId: SESSION,
      fencingToken: fence,
      journalSeq: '1',
      observedState: 'started',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('lease_expired');
  });

  it('renews a healthy lease, minting a fresh signed lease', async () => {
    const { svc, trusted } = setup();
    const id = await enqueue(svc);
    const env = await svc.claim(scope, SESSION);
    const fence = env!.claims['fencing_token'] as string;
    const r = await svc.renew(scope, id, {
      sessionId: SESSION,
      fencingToken: fence,
      journalSeq: '1',
      observedState: 'started',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const claims = verifyLeaseJws(r.leaseJws, trusted);
      expect(claims['attempt_id']).toBe(id);
    }
  });
});

describe('ExecutionService — result dedup / conflict / fencing', () => {
  const baseResult = (digest: string) => ({
    sessionId: SESSION,
    fencingToken: '',
    status: 'succeeded' as const,
    startedAt: new Date('2026-09-24T00:00:01.000Z'),
    finishedAt: new Date('2026-09-24T00:00:02.000Z'),
    exitCode: 0,
    summary: 'ok',
    artifactIds: [],
    structuredResult: {},
    outputTruncated: false,
    observedQuiescent: true,
    effectObservation: 'completed' as const,
    resultSha256: digest,
    resultJson: { status: 'succeeded' },
  });

  it('treats a repeated result with the same digest as an idempotent duplicate', async () => {
    const { svc } = setup();
    const id = await enqueue(svc);
    const env = await svc.claim(scope, SESSION);
    const fence = env!.claims['fencing_token'] as string;
    const digest = 'd'.repeat(64);
    const first = await svc.submitResult(scope, id, { ...baseResult(digest), fencingToken: fence });
    const second = await svc.submitResult(scope, id, {
      ...baseResult(digest),
      fencingToken: fence,
    });
    expect(first).toEqual({ accepted: true, duplicate: false, authoritative: true });
    expect(second).toEqual({ accepted: true, duplicate: true, authoritative: true });
  });

  it('quarantines on a conflicting result digest (RESULT_CONFLICT)', async () => {
    const { svc } = setup();
    const id = await enqueue(svc);
    const env = await svc.claim(scope, SESSION);
    const fence = env!.claims['fencing_token'] as string;
    await svc.submitResult(scope, id, { ...baseResult('a'.repeat(64)), fencingToken: fence });
    await expect(
      svc.submitResult(scope, id, { ...baseResult('e'.repeat(64)), fencingToken: fence }),
    ).rejects.toBeInstanceOf(ResultConflictError);
  });

  it("rejects a stale attempt's write after an explicit reconcile re-attempt", async () => {
    const { repo, svc } = setup();
    const id1 = await enqueue(svc);
    const env = await svc.claim(scope, SESSION);
    const fence1 = env!.claims['fencing_token'] as string;
    // Explicit, reconciliation-gated re-attempt (NOT automatic): attempt #1 → lost.
    const a2 = await repo.reattemptAfterReconcile(
      WS,
      id1,
      '00000000-0000-4000-8000-0000000000e2',
      'unproven_outcome',
    );
    expect(a2.attemptNo).toBe(2);
    // The old worker (fence #1) tries to submit on the superseded attempt #1.
    await expect(
      svc.submitResult(scope, id1, { ...baseResult('a'.repeat(64)), fencingToken: fence1 }),
    ).rejects.toBeInstanceOf(StaleFenceError);
    // The prior op was NOT auto-reassigned: it is terminally settled by the explicit
    // reconcile, and the fresh attempt #2 is merely queued (no other worker took it).
    expect(repo.attempt(id1)!.state).toBe('canceled');
    expect(a2.state).toBe('queued');
  });

  it('settles an unproven outcome as unknown, never reported success', async () => {
    const { repo, svc } = setup();
    const id = await enqueue(svc);
    const env = await svc.claim(scope, SESSION);
    const fence = env!.claims['fencing_token'] as string;
    await svc.submitResult(scope, id, {
      ...baseResult('f'.repeat(64)),
      fencingToken: fence,
      status: 'unknown',
      effectObservation: 'unknown',
    });
    const a = repo.attempt(id)!;
    expect(a.state).toBe('unknown');
    expect(a.effectObservation).toBe('unknown');
  });
});
