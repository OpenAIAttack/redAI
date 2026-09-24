/**
 * Transcript state machine for a single chat (T10b).
 *
 * This is deliberately framework-free so it can be unit-tested without React and
 * reused by the `useChatRun` hook. It owns three hard requirements from
 * docs/03 (chat) and docs/06 (SSE):
 *
 *  1. Dedup by `event_id`. SSE redelivery is normal (docs/06 §7); every envelope
 *     carries a commit-ordered decimal-string counter and we ignore a counter we
 *     have already applied. Message deltas additionally guard on `delta_seq`.
 *
 *  2. Provisional vs final. `message.delta` events accumulate text into a single
 *     PROVISIONAL assistant bubble (keyed by generation_id); `message.committed`
 *     promotes that exact bubble to FINAL exactly once (never a second bubble).
 *     If a committed arrives with no provisional bubble in hand (e.g. a reconnect
 *     replayed only the commit), we request a snapshot resync so the durable text
 *     is loaded from history rather than fabricated.
 *
 *  3. Reconnect safety. `applyHistory` MERGES server messages over local ones —
 *     it never wipes the transcript and never creates a run. Object identity of
 *     unchanged messages is preserved across every transition so a memoized bubble
 *     list does not re-render O(n) bubbles on each delta.
 */
import type { EventEnvelope, Message, MessageStatus, RunState } from '../types';

/** A message as the transcript renders it. `key` is a stable React key. */
export interface TranscriptMessage {
  key: string;
  /** Server message id once known; a client-only optimistic bubble has none. */
  id: string | null;
  role: 'user' | 'assistant' | 'system';
  text: string;
  status: MessageStatus;
  /** True while streaming a provisional (not-yet-committed) assistant reply. */
  provisional: boolean;
  /** Set on optimistic user bubbles to reconcile with the server message. */
  clientMessageId?: string;
  runId?: string | null;
  seq?: number;
  /** Highest applied delta_seq for a streaming bubble (dedup guard). */
  lastDeltaSeq?: string;
}

export interface ActivityEntry {
  eventId: string;
  type: string;
  createdAt: string;
  label: string;
}

export interface ChatState {
  messages: TranscriptMessage[];
  /** event_id values already applied (dedup). */
  seenEventIds: Set<string>;
  activeRunId: string | null;
  runState: RunState | null;
  budget: { observed: string; reserved: string; limit: string } | null;
  plan: { revision: number; stepCount: number } | null;
  activity: ActivityEntry[];
  /** Set when the store needs the caller to reload the snapshot (history + run). */
  resyncRequested: boolean;
}

export function initialChatState(): ChatState {
  return {
    messages: [],
    seenEventIds: new Set(),
    activeRunId: null,
    runState: null,
    budget: null,
    plan: null,
    activity: [],
    resyncRequested: false,
  };
}

const TERMINAL_STATES: ReadonlySet<RunState> = new Set<RunState>([
  'completed',
  'failed',
  'canceled',
  'expired',
]);

export function isTerminalRunState(state: RunState | null): boolean {
  return state !== null && TERMINAL_STATES.has(state);
}

export type ChatAction =
  | { kind: 'history'; messages: Message[] }
  | { kind: 'optimistic-user'; clientMessageId: string; text: string; artifactIds: string[] }
  | { kind: 'run-created'; runId: string; clientMessageId: string; userMessage: Message }
  | { kind: 'send-failed'; clientMessageId: string }
  | { kind: 'event'; envelope: EventEnvelope }
  | { kind: 'run-status'; runId: string; state: RunState }
  | { kind: 'resync-handled' };

let optimisticCounter = 0;
function optimisticKey(): string {
  optimisticCounter += 1;
  return `optimistic-${optimisticCounter}`;
}

function toTranscript(m: Message): TranscriptMessage {
  return {
    key: m.id,
    id: m.id,
    role: m.role,
    text: m.text,
    status: m.status,
    provisional: m.status === 'streaming' || m.status === 'pending',
    runId: m.run_id,
    seq: m.seq,
  };
}

/**
 * Merge server history over the current transcript. Server messages win for any id
 * we already hold; local optimistic bubbles not yet reflected server-side are kept
 * (so an in-flight send is not dropped on a reconnect). Never wipes the list.
 */
function applyHistory(state: ChatState, incoming: Message[]): ChatState {
  const byId = new Map<string, TranscriptMessage>();
  for (const m of state.messages) {
    if (m.id) byId.set(m.id, m);
  }
  const serverIds = new Set(incoming.map((m) => m.id));

  const merged: TranscriptMessage[] = incoming.map((m) => {
    const prev = byId.get(m.id);
    const next = toTranscript(m);
    // Preserve identity if nothing changed (keeps memoized bubbles stable).
    if (
      prev &&
      prev.id === next.id &&
      prev.text === next.text &&
      prev.status === next.status &&
      prev.provisional === next.provisional
    ) {
      return prev;
    }
    return next;
  });

  // Keep only local messages the server snapshot does not yet contain: in-flight
  // optimistic bubbles (no id) and any streaming/provisional assistant bubble not
  // yet committed to history. A local message whose id is already in `incoming` is
  // superseded by its authoritative server copy (never duplicated, never wiped).
  const localExtras = state.messages.filter((m) => m.id === null || !serverIds.has(m.id));

  return { ...state, messages: [...merged, ...localExtras] };
}

function eventLabel(env: EventEnvelope): string {
  switch (env.type) {
    case 'run.created':
      return 'Run created';
    case 'run.state_changed':
      return `Run ${env.data.from} → ${env.data.to}`;
    case 'plan.updated':
      return `Plan revised (r${env.data.plan_revision}, ${env.data.step_count} steps)`;
    case 'budget.updated':
      return 'Budget updated';
    case 'message.committed':
      return `Message committed (${env.data.status})`;
    case 'message.delta':
      return 'Streaming…';
    default:
      // Unknown-but-real event type (e.g. tool.state_changed): label it honestly.
      return (env as { type: string }).type;
  }
}

/** Replace exactly one message in-place, preserving identity of all others. */
function replaceMessage(
  messages: TranscriptMessage[],
  index: number,
  next: TranscriptMessage,
): TranscriptMessage[] {
  const out = messages.slice();
  out[index] = next;
  return out;
}

function applyEvent(state: ChatState, env: EventEnvelope): ChatState {
  // Dedup by commit-ordered counter (idempotent redelivery is normal).
  if (state.seenEventIds.has(env.event_id)) return state;
  const seenEventIds = new Set(state.seenEventIds);
  seenEventIds.add(env.event_id);
  let next: ChatState = { ...state, seenEventIds };

  switch (env.type) {
    case 'run.created': {
      next = { ...next, activeRunId: env.data.run_id };
      break;
    }
    case 'run.state_changed': {
      const toState = env.data.to;
      next = {
        ...next,
        runState: toState,
        activeRunId: isTerminalRunState(toState) ? null : (next.activeRunId ?? env.run_id),
      };
      break;
    }
    case 'message.delta': {
      const gen = env.data.generation_id;
      const idx = next.messages.findIndex(
        (m) => m.role === 'assistant' && m.provisional && m.key === `gen-${gen}`,
      );
      if (idx === -1) {
        // Start a new provisional assistant bubble.
        const bubble: TranscriptMessage = {
          key: `gen-${gen}`,
          id: env.data.message_id,
          role: 'assistant',
          text: env.data.text,
          status: 'streaming',
          provisional: true,
          runId: env.run_id,
          lastDeltaSeq: env.data.delta_seq,
        };
        next = { ...next, messages: [...next.messages, bubble] };
      } else {
        const cur = next.messages[idx]!;
        // Guard against a re-applied delta_seq (defence in depth beyond event_id).
        if (
          cur.lastDeltaSeq !== undefined &&
          compareCounter(env.data.delta_seq, cur.lastDeltaSeq) <= 0
        ) {
          break;
        }
        const updated: TranscriptMessage = {
          ...cur,
          id: cur.id ?? env.data.message_id,
          text: cur.text + env.data.text,
          lastDeltaSeq: env.data.delta_seq,
        };
        next = { ...next, messages: replaceMessage(next.messages, idx, updated) };
      }
      break;
    }
    case 'message.committed': {
      const idx = next.messages.findIndex(
        (m) => m.role === 'assistant' && m.provisional && m.id === env.data.message_id,
      );
      if (idx === -1) {
        // No provisional bubble to promote (reconnect replayed only the commit):
        // ask the caller to reload durable history rather than invent text.
        next = { ...next, resyncRequested: true };
      } else {
        const cur = next.messages[idx]!;
        const promoted: TranscriptMessage = {
          ...cur,
          key: env.data.message_id, // stabilise to the durable id
          provisional: false,
          status: env.data.status,
        };
        next = { ...next, messages: replaceMessage(next.messages, idx, promoted) };
      }
      break;
    }
    case 'budget.updated': {
      next = {
        ...next,
        budget: {
          observed: env.data.observed_micro_usd,
          reserved: env.data.reserved_micro_usd,
          limit: env.data.limit_micro_usd,
        },
      };
      break;
    }
    case 'plan.updated': {
      next = {
        ...next,
        plan: { revision: env.data.plan_revision, stepCount: env.data.step_count },
      };
      break;
    }
    default:
      break;
  }

  // Honest activity timeline (real events only).
  next = {
    ...next,
    activity: [
      ...next.activity,
      {
        eventId: env.event_id,
        type: env.type,
        createdAt: env.created_at,
        label: eventLabel(env),
      },
    ],
  };
  return next;
}

/** Compare two decimal-string counters. Returns <0, 0, or >0. */
export function compareCounter(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.kind) {
    case 'history':
      return applyHistory(state, action.messages);
    case 'optimistic-user': {
      const bubble: TranscriptMessage = {
        key: optimisticKey(),
        id: null,
        role: 'user',
        text: action.text,
        status: 'completed',
        provisional: false,
        clientMessageId: action.clientMessageId,
      };
      return { ...state, messages: [...state.messages, bubble] };
    }
    case 'run-created': {
      // Reconcile the optimistic user bubble with the durable server message
      // (match on the client_message_id we minted for the send).
      const targetIdx = state.messages.findIndex(
        (m) => m.clientMessageId === action.clientMessageId && m.id === null,
      );
      let messages = state.messages;
      if (targetIdx !== -1) {
        const cur = messages[targetIdx]!;
        messages = replaceMessage(messages, targetIdx, {
          ...cur,
          key: action.userMessage.id,
          id: action.userMessage.id,
          seq: action.userMessage.seq,
          runId: action.userMessage.run_id,
          status: action.userMessage.status,
        });
      } else if (!state.messages.some((m) => m.id === action.userMessage.id)) {
        messages = [...messages, toTranscript(action.userMessage)];
      }
      return { ...state, messages, activeRunId: action.runId };
    }
    case 'send-failed': {
      const idx = state.messages.findIndex((m) => m.clientMessageId === action.clientMessageId);
      if (idx === -1) return state;
      const cur = state.messages[idx]!;
      return {
        ...state,
        messages: replaceMessage(state.messages, idx, { ...cur, status: 'interrupted' }),
      };
    }
    case 'event':
      return applyEvent(state, action.envelope);
    case 'run-status': {
      const activeRunId = isTerminalRunState(action.state)
        ? null
        : (state.activeRunId ?? action.runId);
      return { ...state, runState: action.state, activeRunId };
    }
    case 'resync-handled':
      return { ...state, resyncRequested: false };
    default:
      return state;
  }
}
