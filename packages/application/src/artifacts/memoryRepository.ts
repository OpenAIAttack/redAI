/**
 * In-memory {@link ArtifactsRepository} + {@link ProjectGate} for the service unit
 * tests. Mirrors the DB adapter's SEMANTICS — cross-project filtering on the composite
 * key, `pending`-only finalize transitions, created_at keyset pagination — without a
 * database. The DB adapter's own integration test proves the SQL matches.
 */
import { encodeCursor } from './cursor.js';
import type {
  ArtifactRecord,
  ArtifactsRepository,
  CreateArtifactFields,
  Page,
  PageQuery,
  ProjectGate,
  ProjectStatus,
  VerifiedBytes,
} from './ports.js';

interface Clocklike {
  now(): Date;
}

export class InMemoryProjectGate implements ProjectGate {
  private readonly projects = new Map<string, ProjectStatus>();
  private static key(workspaceId: string, projectId: string): string {
    return `${workspaceId}:${projectId}`;
  }
  public set(workspaceId: string, projectId: string, status: ProjectStatus): void {
    this.projects.set(InMemoryProjectGate.key(workspaceId, projectId), status);
  }
  async status(workspaceId: string, projectId: string): Promise<ProjectStatus | null> {
    return this.projects.get(InMemoryProjectGate.key(workspaceId, projectId)) ?? null;
  }
}

export class InMemoryArtifactsRepository implements ArtifactsRepository {
  private artifacts = new Map<string, ArtifactRecord>();
  private seq = 0;

  public constructor(private readonly clock: Clocklike) {}

  private tick(): Date {
    this.seq += 1;
    return new Date(this.clock.now().getTime() + this.seq);
  }

  async createArtifact(
    workspaceId: string,
    projectId: string,
    id: string,
    storageKey: string,
    fields: CreateArtifactFields,
  ): Promise<ArtifactRecord> {
    const now = this.tick();
    const rec: ArtifactRecord = {
      id,
      workspaceId,
      projectId,
      filename: fields.filename,
      mediaType: fields.mediaType,
      kind: fields.kind ?? 'upload',
      byteSize: fields.byteSize,
      sha256: fields.sha256,
      storageKey,
      status: 'pending',
      classification: fields.classification,
      sourceRunId: fields.sourceRunId ?? null,
      readyAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.artifacts.set(id, rec);
    return { ...rec };
  }

  async getArtifact(
    workspaceId: string,
    projectId: string,
    artifactId: string,
  ): Promise<ArtifactRecord | null> {
    const a = this.artifacts.get(artifactId);
    return a && a.workspaceId === workspaceId && a.projectId === projectId ? { ...a } : null;
  }

  async listArtifacts(
    workspaceId: string,
    projectId: string,
    page: PageQuery,
  ): Promise<Page<ArtifactRecord>> {
    const all = [...this.artifacts.values()]
      .filter(
        (a) => a.workspaceId === workspaceId && a.projectId === projectId && a.status !== 'deleted',
      )
      .sort((x, y) => {
        const dt = y.createdAt.getTime() - x.createdAt.getTime();
        if (dt !== 0) return dt;
        return x.id < y.id ? 1 : x.id > y.id ? -1 : 0;
      });
    let start = 0;
    if (page.cursor) {
      const raw = Buffer.from(page.cursor, 'base64url').toString('utf8');
      const sep = raw.indexOf('|');
      const t = new Date(raw.slice(0, sep)).getTime();
      const id = raw.slice(sep + 1);
      start = all.findIndex((r) => {
        const rt = r.createdAt.getTime();
        return rt < t || (rt === t && r.id < id);
      });
      if (start < 0) start = all.length;
    }
    const slice = all.slice(start, start + page.limit);
    const last = slice[slice.length - 1];
    const more = start + page.limit < all.length;
    return {
      items: slice.map((r) => ({ ...r })),
      nextCursor: more && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
    };
  }

  async markReady(
    workspaceId: string,
    projectId: string,
    artifactId: string,
    verified: VerifiedBytes,
  ): Promise<ArtifactRecord | 'not-found' | 'not-pending'> {
    const a = this.artifacts.get(artifactId);
    if (!a || a.workspaceId !== workspaceId || a.projectId !== projectId) return 'not-found';
    if (a.status !== 'pending') return 'not-pending';
    a.status = 'ready';
    a.sha256 = verified.sha256;
    a.byteSize = verified.byteSize;
    a.readyAt = this.tick();
    a.updatedAt = a.readyAt;
    return { ...a };
  }

  async markQuarantined(
    workspaceId: string,
    projectId: string,
    artifactId: string,
  ): Promise<ArtifactRecord | 'not-found' | 'not-pending'> {
    const a = this.artifacts.get(artifactId);
    if (!a || a.workspaceId !== workspaceId || a.projectId !== projectId) return 'not-found';
    if (a.status !== 'pending') return 'not-pending';
    a.status = 'quarantined';
    a.updatedAt = this.tick();
    return { ...a };
  }

  async listStorageKeysByReadiness(
    workspaceId: string,
  ): Promise<{ readyKeys: string[]; liveNonReadyKeys: string[] }> {
    const readyKeys: string[] = [];
    const liveNonReadyKeys: string[] = [];
    for (const a of this.artifacts.values()) {
      if (a.workspaceId !== workspaceId) continue;
      if (a.status === 'ready') readyKeys.push(a.storageKey);
      else if (a.status === 'pending' || a.status === 'quarantined')
        liveNonReadyKeys.push(a.storageKey);
    }
    return { readyKeys, liveNonReadyKeys };
  }
}
