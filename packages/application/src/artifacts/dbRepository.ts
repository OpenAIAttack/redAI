/**
 * DB-backed {@link ArtifactsRepository} + {@link ProjectGate} over `@redai/db`. Every
 * statement carries an explicit `workspace_id` predicate, and every project-level
 * statement also carries `project_id`, so a request scoped to project A can never read
 * or write project B (INV-001); the composite `(id, project_id, workspace_id)` keys back
 * this at the schema level.
 *
 * The finalize transitions (`markReady` / `markQuarantined`) are guarded by
 * `status = 'pending'` in the WHERE clause, so a concurrent finalize updates zero rows
 * and cannot double-publish (INV-007). Setting the observed digest/size and flipping to
 * `ready` in one UPDATE is permitted by the immutability trigger precisely because the
 * row was still `pending`.
 */
import type { Executor, Pool } from '@redai/db';
import { encodeCursor } from './cursor.js';
import type {
  ArtifactRecord,
  ArtifactsRepository,
  ArtifactStatus,
  Classification,
  CreateArtifactFields,
  Page,
  PageQuery,
  ProjectGate,
  ProjectStatus,
  VerifiedBytes,
} from './ports.js';

interface ArtifactDbRow {
  id: string;
  workspace_id: string;
  project_id: string;
  filename: string;
  media_type: string;
  kind: string;
  byte_size: string; // bigint → string
  sha256: string;
  storage_key: string;
  status: ArtifactStatus;
  classification: Classification;
  source_run_id: string | null;
  ready_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function toArtifact(r: ArtifactDbRow): ArtifactRecord {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    projectId: r.project_id,
    filename: r.filename,
    mediaType: r.media_type,
    kind: r.kind,
    byteSize: Number(r.byte_size),
    sha256: r.sha256,
    storageKey: r.storage_key,
    status: r.status,
    classification: r.classification,
    sourceRunId: r.source_run_id,
    readyAt: r.ready_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const COLS =
  'id, workspace_id, project_id, filename, media_type, kind, byte_size, sha256, storage_key, status, classification, source_run_id, ready_at, created_at, updated_at';

interface CursorParts {
  time: Date;
  id: string;
}
function decodeCursorParts(cursor: string | undefined): CursorParts | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const sep = raw.indexOf('|');
    if (sep <= 0) return null;
    const time = new Date(raw.slice(0, sep));
    const id = raw.slice(sep + 1);
    if (Number.isNaN(time.getTime()) || id === '') return null;
    return { time, id };
  } catch {
    return null;
  }
}

export function createDbArtifactsRepository(pool: Pool): ArtifactsRepository {
  const exec: Executor = pool;
  return {
    async createArtifact(
      workspaceId,
      projectId,
      id,
      storageKey,
      fields: CreateArtifactFields,
    ): Promise<ArtifactRecord> {
      const res = await exec.query<ArtifactDbRow>(
        `INSERT INTO artifacts
           (id, workspace_id, project_id, filename, media_type, kind, byte_size, sha256, storage_key,
            status, classification, source_run_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11)
         RETURNING ${COLS}`,
        [
          id,
          workspaceId,
          projectId,
          fields.filename,
          fields.mediaType,
          fields.kind ?? 'upload',
          String(fields.byteSize),
          fields.sha256,
          storageKey,
          fields.classification,
          fields.sourceRunId ?? null,
        ],
      );
      return toArtifact(res.rows[0]!);
    },

    async getArtifact(workspaceId, projectId, artifactId): Promise<ArtifactRecord | null> {
      const res = await exec.query<ArtifactDbRow>(
        `SELECT ${COLS} FROM artifacts WHERE id = $1 AND project_id = $2 AND workspace_id = $3`,
        [artifactId, projectId, workspaceId],
      );
      return res.rows[0] ? toArtifact(res.rows[0]) : null;
    },

    async listArtifacts(workspaceId, projectId, page: PageQuery): Promise<Page<ArtifactRecord>> {
      const cur = decodeCursorParts(page.cursor);
      const rows = cur
        ? await exec.query<ArtifactDbRow>(
            `SELECT ${COLS} FROM artifacts
             WHERE workspace_id = $1 AND project_id = $2 AND status <> 'deleted'
               AND (date_trunc('milliseconds', created_at), id) < ($3::timestamptz, $4::uuid)
             ORDER BY date_trunc('milliseconds', created_at) DESC, id DESC LIMIT $5`,
            [workspaceId, projectId, cur.time, cur.id, page.limit + 1],
          )
        : await exec.query<ArtifactDbRow>(
            `SELECT ${COLS} FROM artifacts
             WHERE workspace_id = $1 AND project_id = $2 AND status <> 'deleted'
             ORDER BY date_trunc('milliseconds', created_at) DESC, id DESC LIMIT $3`,
            [workspaceId, projectId, page.limit + 1],
          );
      const hasMore = rows.rows.length > page.limit;
      const items = rows.rows.slice(0, page.limit).map(toArtifact);
      const last = items[items.length - 1];
      return {
        items,
        nextCursor:
          hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
      };
    },

    async markReady(
      workspaceId,
      projectId,
      artifactId,
      verified: VerifiedBytes,
    ): Promise<ArtifactRecord | 'not-found' | 'not-pending'> {
      const res = await exec.query<ArtifactDbRow>(
        `UPDATE artifacts
           SET status = 'ready', sha256 = $4, byte_size = $5, ready_at = now(), updated_at = now()
         WHERE id = $1 AND project_id = $2 AND workspace_id = $3 AND status = 'pending'
         RETURNING ${COLS}`,
        [artifactId, projectId, workspaceId, verified.sha256, String(verified.byteSize)],
      );
      if (res.rows[0]) return toArtifact(res.rows[0]);
      return classifyMiss(await artifactExists(exec, workspaceId, projectId, artifactId));
    },

    async markQuarantined(
      workspaceId,
      projectId,
      artifactId,
    ): Promise<ArtifactRecord | 'not-found' | 'not-pending'> {
      const res = await exec.query<ArtifactDbRow>(
        `UPDATE artifacts
           SET status = 'quarantined', updated_at = now()
         WHERE id = $1 AND project_id = $2 AND workspace_id = $3 AND status = 'pending'
         RETURNING ${COLS}`,
        [artifactId, projectId, workspaceId],
      );
      if (res.rows[0]) return toArtifact(res.rows[0]);
      return classifyMiss(await artifactExists(exec, workspaceId, projectId, artifactId));
    },

    async listStorageKeysByReadiness(
      workspaceId,
    ): Promise<{ readyKeys: string[]; liveNonReadyKeys: string[] }> {
      const res = await exec.query<{ storage_key: string; status: ArtifactStatus }>(
        `SELECT storage_key, status FROM artifacts
         WHERE workspace_id = $1 AND status IN ('ready', 'pending', 'quarantined')`,
        [workspaceId],
      );
      const readyKeys: string[] = [];
      const liveNonReadyKeys: string[] = [];
      for (const r of res.rows) {
        if (r.status === 'ready') readyKeys.push(r.storage_key);
        else liveNonReadyKeys.push(r.storage_key);
      }
      return { readyKeys, liveNonReadyKeys };
    },
  };
}

/** DB-backed project status gate (read-only). */
export function createDbProjectGate(pool: Pool): ProjectGate {
  const exec: Executor = pool;
  return {
    async status(workspaceId, projectId): Promise<ProjectStatus | null> {
      const res = await exec.query<{ status: ProjectStatus }>(
        'SELECT status FROM projects WHERE id = $1 AND workspace_id = $2',
        [projectId, workspaceId],
      );
      return res.rows[0]?.status ?? null;
    },
  };
}

function classifyMiss(exists: boolean): 'not-found' | 'not-pending' {
  // The row exists but is not pending → a concurrent finalize advanced it. It does not
  // exist → the caller addressed a foreign/unknown id.
  return exists ? 'not-pending' : 'not-found';
}

async function artifactExists(
  exec: Executor,
  workspaceId: string,
  projectId: string,
  artifactId: string,
): Promise<boolean> {
  const res = await exec.query(
    'SELECT 1 FROM artifacts WHERE id = $1 AND project_id = $2 AND workspace_id = $3',
    [artifactId, projectId, workspaceId],
  );
  return (res.rowCount ?? 0) > 0;
}
