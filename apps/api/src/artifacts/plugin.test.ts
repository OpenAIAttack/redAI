/**
 * API inject tests for the artifacts plugin. A bare Fastify instance mounts
 * `registerArtifacts` with an in-memory repository + a real LocalObjectStore on a temp
 * dir, plus a header-based fake owner guard — no database, no server.ts. These prove:
 * the staged-upload → finalize → download → preview flow over HTTP, owner-auth (401),
 * the CSRF/mutation guard (403), Idempotency-Key requirement (400), hash mismatch (422),
 * media-type quarantine (422), unsafe-HTML preview refusal (415), and cross-project
 * isolation on download/preview (404 — project A's URL cannot read project B's artifact).
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ArtifactsService,
  InMemoryArtifactsRepository,
  InMemoryProjectGate,
} from '@redai/application/artifacts';
import { LocalObjectStore } from '@redai/storage';
import { registerArtifacts, type OwnerContext } from './plugin.js';

const WS = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const PROJECT_A = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const PROJECT_B = 'dddddddd-4444-4444-8444-dddddddddddd';

class FixedClock {
  now(): Date {
    return new Date(1_700_000_000_000);
  }
}
class SeqUuid {
  private n = 0;
  uuid(): string {
    this.n += 1;
    return `00000000-0000-4000-8000-${this.n.toString(16).padStart(12, '0')}`;
  }
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

interface Harness {
  app: FastifyInstance;
  root: string;
}

async function setup(opts: { authorizeMutation?: boolean } = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'redai-api-artifacts-'));
  const repo = new InMemoryArtifactsRepository(new FixedClock());
  const gate = new InMemoryProjectGate();
  gate.set(WS, PROJECT_A, 'active');
  gate.set(WS, PROJECT_B, 'active');
  const service = new ArtifactsService({
    repo,
    store: new LocalObjectStore({ root }),
    projects: gate,
    clock: new FixedClock(),
    random: new SeqUuid(),
  });
  const app = Fastify({ logger: false });
  registerArtifacts(app, {
    service,
    authenticate: (req) => {
      const ws = req.headers['x-test-workspace'];
      return Promise.resolve(
        typeof ws === 'string' && ws !== ''
          ? ({ workspaceId: ws, ownerId: 'owner' } as OwnerContext)
          : null,
      );
    },
    authorizeMutation: () => opts.authorizeMutation ?? true,
  });
  await app.ready();
  return { app, root };
}

const authHeaders = { 'x-test-workspace': WS };
const writeHeaders = { ...authHeaders, 'idempotency-key': 'k-1' };

let h: Harness;
beforeEach(async () => {
  h = await setup();
});
afterEach(async () => {
  await h.app.close();
  await rm(h.root, { recursive: true, force: true });
});

async function createAndUpload(project: string, bytes: Buffer, mediaType: string): Promise<string> {
  const create = await h.app.inject({
    method: 'POST',
    url: `/api/v1/projects/${project}/artifacts`,
    headers: { ...writeHeaders, 'content-type': 'application/json' },
    payload: {
      filename: 'f.txt',
      media_type: mediaType,
      byte_size: bytes.length,
      sha256: sha256(bytes),
      classification: 'internal',
    },
  });
  expect(create.statusCode).toBe(201);
  const id = create.json().id as string;
  const put = await h.app.inject({
    method: 'PUT',
    url: `/api/v1/projects/${project}/artifacts/${id}/content`,
    headers: { ...writeHeaders, 'content-type': 'application/octet-stream' },
    payload: bytes,
  });
  expect(put.statusCode).toBe(200);
  return id;
}

async function finalize(project: string, id: string, bytes: Buffer) {
  return h.app.inject({
    method: 'POST',
    url: `/api/v1/projects/${project}/artifacts/${id}/finalize`,
    headers: { ...writeHeaders, 'content-type': 'application/json' },
    payload: { sha256: sha256(bytes), byte_size: bytes.length },
  });
}

describe('artifacts plugin', () => {
  it('runs the full staged-upload → finalize → download → preview flow', async () => {
    const bytes = Buffer.from('# Heading\nsome evidence');
    const id = await createAndUpload(PROJECT_A, bytes, 'text/markdown');
    const fin = await finalize(PROJECT_A, id, bytes);
    expect(fin.statusCode).toBe(200);
    expect(fin.json().status).toBe('ready');

    const dl = await h.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${PROJECT_A}/artifacts/${id}/content`,
      headers: authHeaders,
    });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toBe('application/octet-stream');
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(String(dl.headers['content-disposition'])).toContain('attachment');
    expect(dl.rawPayload.equals(bytes)).toBe(true);

    const pv = await h.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${PROJECT_A}/artifacts/${id}/preview`,
      headers: authHeaders,
    });
    expect(pv.statusCode).toBe(200);
    expect(pv.json().preview.kind).toBe('text');
  });

  it('requires an authenticated owner (401)', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${PROJECT_A}/artifacts`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a mutation when the CSRF/Origin guard fails (403)', async () => {
    await h.app.close();
    h = await setup({ authorizeMutation: false });
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${PROJECT_A}/artifacts`,
      headers: { ...writeHeaders, 'content-type': 'application/json' },
      payload: {
        filename: 'f',
        media_type: 'text/plain',
        byte_size: 1,
        sha256: 'a'.repeat(64),
        classification: 'internal',
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('requires an Idempotency-Key on create (400)', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${PROJECT_A}/artifacts`,
      headers: { ...authHeaders, 'content-type': 'application/json' },
      payload: {
        filename: 'f',
        media_type: 'text/plain',
        byte_size: 1,
        sha256: 'a'.repeat(64),
        classification: 'internal',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('validates the create body (422)', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${PROJECT_A}/artifacts`,
      headers: { ...writeHeaders, 'content-type': 'application/json' },
      payload: {
        filename: '',
        media_type: 'text/plain',
        byte_size: -1,
        sha256: 'nothex',
        classification: 'internal',
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it('rejects a finalize whose digest does not match (422) and leaves it pending', async () => {
    const bytes = Buffer.from('abc');
    const id = await createAndUpload(PROJECT_A, bytes, 'text/plain');
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${PROJECT_A}/artifacts/${id}/finalize`,
      headers: { ...writeHeaders, 'content-type': 'application/json' },
      payload: { sha256: 'b'.repeat(64), byte_size: bytes.length },
    });
    expect(res.statusCode).toBe(422);
    const meta = await h.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${PROJECT_A}/artifacts/${id}`,
      headers: authHeaders,
    });
    expect(meta.json().status).toBe('pending');
  });

  it('quarantines a media-type/bytes mismatch on finalize (422)', async () => {
    const bytes = Buffer.from('not a png');
    const id = await createAndUpload(PROJECT_A, bytes, 'image/png');
    const fin = await finalize(PROJECT_A, id, bytes);
    expect(fin.statusCode).toBe(422);
    expect(fin.json().error.code).toBe('MEDIA_TYPE_MISMATCH');
    const meta = await h.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${PROJECT_A}/artifacts/${id}`,
      headers: authHeaders,
    });
    expect(meta.json().status).toBe('quarantined');
  });

  it('refuses an unsafe-HTML preview (415) — bytes are still downloadable', async () => {
    const bytes = Buffer.from('<script>alert(1)</script>');
    const id = await createAndUpload(PROJECT_A, bytes, 'text/html');
    expect((await finalize(PROJECT_A, id, bytes)).statusCode).toBe(200);
    const pv = await h.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${PROJECT_A}/artifacts/${id}/preview`,
      headers: authHeaders,
    });
    expect(pv.statusCode).toBe(415);
    expect(pv.json().error.code).toBe('PREVIEW_UNSUPPORTED');
    const dl = await h.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${PROJECT_A}/artifacts/${id}/content`,
      headers: authHeaders,
    });
    expect(dl.statusCode).toBe(200);
  });

  it("cross-project isolation: project B cannot download or preview A's artifact (404)", async () => {
    const bytes = Buffer.from('project A secret');
    const id = await createAndUpload(PROJECT_A, bytes, 'text/plain');
    expect((await finalize(PROJECT_A, id, bytes)).statusCode).toBe(200);

    const dlB = await h.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${PROJECT_B}/artifacts/${id}/content`,
      headers: authHeaders,
    });
    expect(dlB.statusCode).toBe(404);
    const pvB = await h.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${PROJECT_B}/artifacts/${id}/preview`,
      headers: authHeaders,
    });
    expect(pvB.statusCode).toBe(404);
    const metaB = await h.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${PROJECT_B}/artifacts/${id}`,
      headers: authHeaders,
    });
    expect(metaB.statusCode).toBe(404);
  });

  it('rejects an oversized upload body (413)', async () => {
    // Declare a small size but stream more than the cap through the octet-stream parser.
    const create = await h.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${PROJECT_A}/artifacts`,
      headers: { ...writeHeaders, 'content-type': 'application/json' },
      payload: {
        filename: 'f',
        media_type: 'text/plain',
        byte_size: 10,
        sha256: 'a'.repeat(64),
        classification: 'internal',
      },
    });
    const id = create.json().id as string;
    const big = Buffer.alloc(26_214_401, 0x41);
    const put = await h.app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${PROJECT_A}/artifacts/${id}/content`,
      headers: { ...writeHeaders, 'content-type': 'application/octet-stream' },
      payload: big,
    });
    expect(put.statusCode).toBe(413);
  });
});
