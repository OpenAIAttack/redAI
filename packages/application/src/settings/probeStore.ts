import { createHash } from 'node:crypto';
import { withTransaction, type Pool } from '@redai/db';
import type { ProbeResult } from '@redai/llm';
import { ProviderConfigNotFoundError, RevisionConflictError, SettingsError } from './errors.js';

export interface ProbeIdentity {
  workspaceId: string;
  ownerId: string;
  id: string;
  expectedRevision: number;
  idempotencyKey: string;
  confirmed: true;
}
export interface ProbeStore {
  claim(input: ProbeIdentity): Promise<ProbeResult | null>;
  finish(input: ProbeIdentity, result: ProbeResult): Promise<void>;
}
const routeFor = (id: string) => `/providers/${id}/probe`;
const fingerprint = (input: ProbeIdentity) =>
  createHash('sha256')
    .update(JSON.stringify([input.expectedRevision, input.confirmed]))
    .digest('hex');

export function createDbProbeStore(pool: Pool): ProbeStore {
  return {
    async claim(input) {
      return withTransaction(pool, async (tx) => {
        // Serialize claims and config edits. Never hold a transaction during HTTP.
        const config = await tx.query<{ revision: string | number; enabled: boolean }>(
          'SELECT revision, enabled FROM provider_configs WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
          [input.id, input.workspaceId],
        );
        const row = config.rows[0];
        if (!row) throw new ProviderConfigNotFoundError();
        const previous = await tx.query<{
          body_sha256: string;
          state: string;
          response_json: ProbeResult;
        }>(
          `SELECT body_sha256, state, response_json FROM idempotency_keys WHERE workspace_id=$1 AND actor_key=$2 AND method='POST' AND route=$3 AND idempotency_key=$4`,
          [input.workspaceId, input.ownerId, routeFor(input.id), input.idempotencyKey],
        );
        const old = previous.rows[0];
        if (old) {
          if (old.body_sha256 !== fingerprint(input))
            throw new SettingsError(
              'IDEMPOTENCY_CONFLICT',
              'Idempotency key was already used with another request.',
            );
          if (old.state === 'completed') return old.response_json;
          throw new SettingsError(
            'PROBE_IN_PROGRESS',
            'Probe outcome is pending or unknown; this request will not be replayed.',
          );
        }
        if (Number(row.revision) !== input.expectedRevision)
          throw new RevisionConflictError(input.expectedRevision, Number(row.revision));
        if (!row.enabled) throw new SettingsError('INVALID_SETTINGS', 'Provider is disabled.');
        const pending = await tx.query(
          `SELECT 1 FROM idempotency_keys WHERE workspace_id=$1 AND method='POST' AND route=$2 AND state='in_progress' AND expires_at > now() LIMIT 1`,
          [input.workspaceId, routeFor(input.id)],
        );
        if (pending.rowCount)
          throw new SettingsError('PROBE_IN_PROGRESS', 'A probe is already in progress.');
        await tx.query(
          `INSERT INTO idempotency_keys (workspace_id,actor_key,method,route,idempotency_key,body_sha256,expires_at) VALUES ($1,$2,'POST',$3,$4,$5,now()+interval '2 minutes')`,
          [
            input.workspaceId,
            input.ownerId,
            routeFor(input.id),
            input.idempotencyKey,
            fingerprint(input),
          ],
        );
        await tx.query(
          "UPDATE provider_configs SET probe_attempt_id=$3,probe_status='not_tested',probe_result=NULL,last_probe_at=NULL WHERE id=$1 AND workspace_id=$2",
          [input.id, input.workspaceId, input.idempotencyKey],
        );
        return null;
      });
    },
    async finish(input, result) {
      await withTransaction(pool, async (tx) => {
        // Same lock order as claim; old completions cannot validate an edited config.
        await tx.query(
          'SELECT id FROM provider_configs WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
          [input.id, input.workspaceId],
        );
        const updated = await tx.query(
          `UPDATE idempotency_keys SET state='completed', response_status=200, response_json=$5::jsonb WHERE workspace_id=$1 AND actor_key=$2 AND method='POST' AND route=$3 AND idempotency_key=$4 AND state='in_progress' RETURNING idempotency_key`,
          [
            input.workspaceId,
            input.ownerId,
            routeFor(input.id),
            input.idempotencyKey,
            JSON.stringify(result),
          ],
        );
        if (!updated.rowCount) return;
        await tx.query(
          `UPDATE provider_configs p SET probe_status=$4,last_probe_at=$5,probe_result=$6::jsonb WHERE p.id=$1 AND p.workspace_id=$2 AND p.revision=$3 AND p.probe_attempt_id=$7 AND p.enabled AND (p.credential_ref IS NULL OR EXISTS (SELECT 1 FROM secrets s WHERE s.id=p.credential_ref AND s.workspace_id=p.workspace_id AND s.kind='model_api_key' AND s.project_id IS NULL AND s.revoked_at IS NULL))`,
          [
            input.id,
            input.workspaceId,
            input.expectedRevision,
            result.status,
            result.checked_at,
            JSON.stringify(result),
            input.idempotencyKey,
          ],
        );
      });
    },
  };
}
