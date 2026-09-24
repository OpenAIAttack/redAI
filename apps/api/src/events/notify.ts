/**
 * Postgres LISTEN/NOTIFY wake source for the event stream (T11).
 *
 * `redai_append_event` runs `pg_notify('redai_events', workspace_id)` after inserting
 * an event. This holds ONE dedicated connection on `LISTEN redai_events` and fans each
 * notification out to the subscribers for that workspace, so an idle stream wakes
 * promptly instead of polling hard.
 *
 * NOTIFY is only a wake hint (docs/06 §8): it is delivered at-most-once and a missed
 * notify (dropped connection, notify emitted before LISTEN, coalesced duplicates) must
 * never lose an event. Correctness therefore does NOT depend on this source — the
 * transport also polls the journal on a timer, and the pull read is the source of
 * truth. If the listen connection cannot be established or drops, subscribers simply
 * fall back to that poll.
 */
import type { Pool, PoolClient } from '@redai/db';

const CHANNEL = 'redai_events';

export interface NotifySource {
  /** Register a wake callback for a workspace. Returns an unsubscribe function. */
  subscribe(workspaceId: string, onWake: () => void): () => void;
  /** Release the listen connection. Idempotent. */
  close(): Promise<void>;
}

export function createPgNotifySource(pool: Pool): NotifySource {
  const waiters = new Map<string, Set<() => void>>();
  let client: PoolClient | null = null;
  let starting: Promise<void> | null = null;
  let closed = false;

  function wake(workspaceId: string): void {
    const set = waiters.get(workspaceId);
    if (!set) return;
    for (const cb of set) {
      try {
        cb();
      } catch {
        /* a waiter throwing must not break notify fan-out */
      }
    }
  }

  async function ensureListening(): Promise<void> {
    if (closed || client) return;
    if (!starting) {
      starting = (async () => {
        const c = await pool.connect();
        c.on('notification', (msg) => {
          if (msg.channel !== CHANNEL || !msg.payload) return;
          wake(msg.payload);
        });
        c.on('error', () => {
          // Connection dropped: forget it so the next subscribe re-establishes LISTEN.
          // In-flight streams keep working via the poll fallback in the meantime.
          if (client === c) client = null;
          try {
            c.release(new Error('listen connection error'));
          } catch {
            /* ignore */
          }
        });
        await c.query(`LISTEN ${CHANNEL}`);
        if (closed) {
          try {
            c.release();
          } catch {
            /* ignore */
          }
          return;
        }
        client = c;
      })().finally(() => {
        starting = null;
      });
    }
    await starting;
  }

  return {
    subscribe(workspaceId, onWake) {
      let set = waiters.get(workspaceId);
      if (!set) {
        set = new Set();
        waiters.set(workspaceId, set);
      }
      set.add(onWake);
      // Best-effort: a listen failure is non-fatal because the caller also polls.
      void ensureListening().catch(() => {});
      return () => {
        const current = waiters.get(workspaceId);
        if (!current) return;
        current.delete(onWake);
        if (current.size === 0) waiters.delete(workspaceId);
      };
    },

    async close() {
      closed = true;
      waiters.clear();
      const c = client;
      client = null;
      if (c) {
        try {
          await c.query(`UNLISTEN ${CHANNEL}`);
        } catch {
          /* ignore */
        }
        try {
          c.release();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
