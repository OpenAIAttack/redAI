/**
 * DB-backed {@link AskContextBuilder}. Reads the Ask context from the CURRENT Project
 * ONLY (docs/11 §4): notes with `selected_for_context = true`, the artifacts the owner
 * attached to THIS run (a bounded manifest, not their bytes), and the recent completed
 * chat history EXCLUDING the in-flight turn. Attached-file ids are filtered to the
 * project (INV-001) so an id from another project is silently dropped, never read.
 */
import type { Executor, Pool } from '@redai/db';
import type { AskContextBuilder, AskContextInputs, MessageRole } from './ports.js';

const HISTORY_LIMIT = 40;

export function createDbAskContextBuilder(pool: Pool): AskContextBuilder {
  return new DbAskContextBuilder(pool);
}

class DbAskContextBuilder implements AskContextBuilder {
  public constructor(private readonly pool: Pool) {}

  async build(
    workspaceId: string,
    projectId: string,
    chatId: string,
    attachedArtifactIds: string[],
    excludeRunId: string,
  ): Promise<AskContextInputs> {
    const exec: Executor = this.pool;

    const notesRes = await exec.query<{ id: string; title: string; content: string }>(
      `SELECT id, title, content FROM notes
       WHERE workspace_id = $1 AND project_id = $2 AND selected_for_context = true
       ORDER BY created_at ASC`,
      [workspaceId, projectId],
    );

    let attachedFiles: { id: string; filename: string; media_type: string }[] = [];
    if (attachedArtifactIds.length > 0) {
      const filesRes = await exec.query<{ id: string; filename: string; media_type: string }>(
        `SELECT id, filename, media_type FROM artifacts
         WHERE workspace_id = $1 AND project_id = $2 AND id = ANY($3::uuid[])
           AND status = 'ready'
         ORDER BY created_at ASC`,
        [workspaceId, projectId, attachedArtifactIds],
      );
      attachedFiles = filesRes.rows;
    }

    const historyRes = await exec.query<{ role: MessageRole; text_content: string }>(
      `SELECT role, text_content FROM messages
       WHERE workspace_id = $1 AND project_id = $2 AND chat_id = $3
         AND status = 'completed' AND (run_id IS NULL OR run_id <> $4)
         AND role IN ('user', 'assistant', 'system')
       ORDER BY seq ASC
       LIMIT $5`,
      [workspaceId, projectId, chatId, excludeRunId, HISTORY_LIMIT],
    );

    return {
      selectedNotes: notesRes.rows.map((n) => ({ id: n.id, title: n.title, content: n.content })),
      attachedFiles: attachedFiles.map((f) => ({
        id: f.id,
        filename: f.filename,
        mediaType: f.media_type,
      })),
      history: historyRes.rows.map((m) => ({ role: m.role, text: m.text_content })),
    };
  }
}
