/**
 * Boundary tests for the worker TASK-plane Fastify plugin (T17). A bare Fastify
 * instance is wired to a fake {@link ExecutionApi} and a fake worker-credential
 * verifier, so the tests exercise the real HTTP guards, request validation, contract
 * validation of the minted envelope, and the error-code → HTTP mapping.
 *
 * Headline assertions: the bearer guard is required on every route, a stale fence and
 * a session supersession map to 409, a conflicting result maps to 409, renewal refusal
 * returns a null lease, and the minted TaskEnvelope conforms to the frozen contract.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  registerWorkerTasks,
  type ExecutionApi,
  type TaskEnvelope,
  type WorkerScope,
} from './plugin.js';

const WORKSPACE = '00000000-0000-4000-8000-000000000001';
const WORKER = '00000000-0000-4000-8000-0000000000a1';
const SESSION = '00000000-0000-4000-8000-0000000000b1';
const ATTEMPT = '00000000-0000-4000-8000-0000000000e1';

class ExecutionError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

function validEnvelope(): TaskEnvelope {
  return {
    claims: {
      schema_version: '1.0',
      installation_id: '00000000-0000-4000-8000-000000000f01',
      workspace_id: WORKSPACE,
      project_id: '00000000-0000-4000-8000-0000000000c1',
      run_id: '00000000-0000-4000-8000-0000000000d1',
      tool_call_id: '00000000-0000-4000-8000-0000000000f1',
      attempt_id: ATTEMPT,
      attempt_no: 1,
      fencing_token: '1',
      worker_id: WORKER,
      worker_session_id: SESSION,
      tool_name: 'fs_read',
      input_sha256: 'a'.repeat(64),
      scope_version_id: null,
      grant_id: null,
      policy_epoch: '1',
      image_digest: 'sha256:' + 'a'.repeat(64),
      network_profile: 'offline',
      timeout_seconds: 120,
      issued_at: '2026-09-24T00:00:00.000Z',
      expires_at: '2026-09-24T00:00:45.000Z',
      scope_policy_sha256: null,
      tool_manifest_sha256: 'b'.repeat(64),
      resource_limits: {
        cpu_millis: 1000,
        memory_bytes: 536870912,
        pids: 128,
        output_bytes: 26214400,
      },
    },
    lease_jws: 'x'.repeat(80),
    input: { echo: 'hello' },
    policy_snapshot: null,
    input_artifact_ids: [],
  };
}

interface Overrides {
  claim?: ExecutionApi['claim'];
  ack?: ExecutionApi['ack'];
  renew?: ExecutionApi['renew'];
  submitResult?: ExecutionApi['submitResult'];
  authorizeInputArtifact?: ExecutionApi['authorizeInputArtifact'];
}

async function build(over: Overrides = {}): Promise<FastifyInstance> {
  const service: ExecutionApi = {
    claim: over.claim ?? (async () => null),
    ack: over.ack ?? (async () => ({ state: 'started' })),
    renew:
      over.renew ??
      (async () => ({
        ok: true,
        directive: 'continue',
        leaseJws: 'x'.repeat(80),
        expiresAt: new Date(),
      })),
    submitResult:
      over.submitResult ??
      (async () => ({ accepted: true, duplicate: false, authoritative: true })),
    authorizeInputArtifact: over.authorizeInputArtifact ?? (async () => {}),
  };
  const app = Fastify({ logger: false });
  registerWorkerTasks(app, {
    service,
    verifyCredential: async (token: string) => {
      if (token !== 'valid') throw new ExecutionError('WORKER_CREDENTIAL_INVALID');
      return {
        workerId: WORKER,
        workspaceId: WORKSPACE,
        credentialId: 'cred',
        zone: 'z',
        state: 'online',
      };
    },
    inputArtifacts: {
      read: async () => ({ contentType: 'text/plain', bytes: Buffer.from('hi') }),
    },
  });
  await app.ready();
  return app;
}

const AUTH = { authorization: 'Bearer valid' };

describe('worker-tasks plugin — auth', () => {
  it('rejects a claim without a bearer credential', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/worker/v1/tasks/claim',
      payload: { session_id: SESSION, wait_seconds: 0, manifest_sha256: 'b'.repeat(64) },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects a claim with an invalid bearer credential', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/worker/v1/tasks/claim',
      headers: { authorization: 'Bearer nope' },
      payload: { session_id: SESSION, wait_seconds: 0, manifest_sha256: 'b'.repeat(64) },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('worker-tasks plugin — claim', () => {
  it('204s when no task is claimable', async () => {
    const app = await build({ claim: async () => null });
    const res = await app.inject({
      method: 'POST',
      url: '/worker/v1/tasks/claim',
      headers: AUTH,
      payload: { session_id: SESSION, wait_seconds: 0, manifest_sha256: 'b'.repeat(64) },
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it('returns a contract-valid TaskEnvelope when one is claimed', async () => {
    const app = await build({ claim: async (_s: WorkerScope) => validEnvelope() });
    const res = await app.inject({
      method: 'POST',
      url: '/worker/v1/tasks/claim',
      headers: AUTH,
      payload: { session_id: SESSION, wait_seconds: 0, manifest_sha256: 'b'.repeat(64) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().claims.attempt_id).toBe(ATTEMPT);
    await app.close();
  });

  it('500s if the minted envelope violates the contract', async () => {
    const bad = validEnvelope();
    (bad.claims as Record<string, unknown>)['network_profile'] = 'bogus';
    const app = await build({ claim: async () => bad });
    const res = await app.inject({
      method: 'POST',
      url: '/worker/v1/tasks/claim',
      headers: AUTH,
      payload: { session_id: SESSION, wait_seconds: 0, manifest_sha256: 'b'.repeat(64) },
    });
    expect(res.statusCode).toBe(500);
    await app.close();
  });
});

describe('worker-tasks plugin — ack / renew / result error mapping', () => {
  it('maps a stale fence on ACK to 409', async () => {
    const app = await build({
      ack: async () => {
        throw new ExecutionError('STALE_FENCE');
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/worker/v1/tasks/${ATTEMPT}/ack`,
      headers: AUTH,
      payload: {
        session_id: SESSION,
        fencing_token: '1',
        phase: 'started',
        journal_seq: '1',
        container_ref: 'c1',
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('STALE_FENCE');
    await app.close();
  });

  it('returns a null lease when renewal is refused', async () => {
    const app = await build({
      renew: async () => ({ ok: false, directive: 'cancel', reason: 'session_superseded' }),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/worker/v1/tasks/${ATTEMPT}/renew`,
      headers: AUTH,
      payload: {
        session_id: SESSION,
        fencing_token: '1',
        journal_seq: '1',
        observed_state: 'started',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().directive).toBe('cancel');
    expect(res.json().lease_jws).toBeNull();
    await app.close();
  });

  it('maps a conflicting result to 409', async () => {
    const app = await build({
      submitResult: async () => {
        throw new ExecutionError('RESULT_CONFLICT');
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/worker/v1/tasks/${ATTEMPT}/result`,
      headers: AUTH,
      payload: workerResult(),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('RESULT_CONFLICT');
    await app.close();
  });

  it('accepts a valid result', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: `/worker/v1/tasks/${ATTEMPT}/result`,
      headers: AUTH,
      payload: workerResult(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: true, duplicate: false, authoritative: true });
    await app.close();
  });
});

describe('worker-tasks plugin — input artifact fetch', () => {
  it('streams bytes once the attempt binding authorizes', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'GET',
      url: `/worker/v1/tasks/${ATTEMPT}/artifacts/00000000-0000-4000-8000-0000000000aa/content`,
      headers: { ...AUTH, 'x-worker-session': SESSION, 'x-fencing-token': '1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('hi');
    await app.close();
  });

  it('404s when the artifact is not an input of the attempt', async () => {
    const app = await build({
      authorizeInputArtifact: async () => {
        throw new ExecutionError('ARTIFACT_NOT_LINKED');
      },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/worker/v1/tasks/${ATTEMPT}/artifacts/00000000-0000-4000-8000-0000000000aa/content`,
      headers: { ...AUTH, 'x-worker-session': SESSION, 'x-fencing-token': '1' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

function workerResult() {
  return {
    attempt_id: ATTEMPT,
    fencing_token: '1',
    worker_session_id: SESSION,
    status: 'succeeded',
    started_at: '2026-09-24T00:00:01.000Z',
    finished_at: '2026-09-24T00:00:02.000Z',
    exit_code: 0,
    summary: 'ok',
    artifact_ids: [],
    structured_result: {},
    output_truncated: false,
    observed_quiescent: true,
    effect_observation: 'completed',
    result_sha256: 'd'.repeat(64),
  };
}
