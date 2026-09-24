'use client';

/**
 * `useChatRun` — the live chat controller (T10b).
 *
 * It loads durable history on open, streams the assistant reply for the active run
 * over SSE, and exposes a `send` that creates an Ask run with a fresh
 * Idempotency-Key. The hard invariants live in `chatState` (dedup, provisional vs
 * final, merge-not-wipe); this hook wires them to the network and to React.
 *
 * Reconnect safety: a `resync` (reconnect, stream close, or a committed message we
 * had no provisional bubble for) reloads the snapshot — history + run status — and
 * NEVER creates a run. Only an explicit `send` creates a run.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ApiError } from '../api';
import { createRun, getRun, listMessages } from '../endpoints';
import type { RunState } from '../types';
import { RealtimeConnection, type EventSourceFactory } from './connection';
import {
  chatReducer,
  initialChatState,
  isTerminalRunState,
  type ChatState,
  type TranscriptMessage,
} from './chatState';

export interface SendInput {
  text: string;
  providerConfigId: string;
  artifactIds?: string[];
  dataMode?: string;
}

export interface UseChatRun {
  messages: TranscriptMessage[];
  runState: RunState | null;
  activeRunId: string | null;
  /** True while a run is active in this chat (max_active_runs_chat = 1). */
  runActive: boolean;
  loadingHistory: boolean;
  historyError: unknown;
  sending: boolean;
  sendError: ApiError | null;
  budget: ChatState['budget'];
  plan: ChatState['plan'];
  activity: ChatState['activity'];
  send: (input: SendInput) => Promise<void>;
  reloadHistory: () => void;
}

function newUuid(): string {
  return crypto.randomUUID();
}

export function useChatRun(
  projectId: string,
  chatId: string,
  opts: { eventSourceFactory?: EventSourceFactory; enabled?: boolean } = {},
): UseChatRun {
  const enabled = opts.enabled ?? true;
  const [state, dispatch] = useReducer(chatReducer, undefined, initialChatState);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [historyError, setHistoryError] = useState<unknown>(undefined);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<ApiError | null>(null);

  const connRef = useRef<RealtimeConnection | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  activeRunIdRef.current = state.activeRunId;

  const factory = opts.eventSourceFactory;

  // --- snapshot load / resync (never creates a run) -------------------------

  const loadSnapshot = useCallback(
    async (opts2: { initial: boolean }): Promise<void> => {
      if (opts2.initial) {
        setLoadingHistory(true);
        setHistoryError(undefined);
      }
      try {
        const page = await listMessages(projectId, chatId);
        if (!mountedRef.current) return;
        dispatch({ kind: 'history', messages: page.items });

        // Reconcile run status from the latest run referenced by history, or the
        // run we already believe is active.
        const runId =
          activeRunIdRef.current ?? [...page.items].reverse().find((m) => m.run_id)?.run_id ?? null;
        if (runId) {
          try {
            const run = await getRun(projectId, runId);
            if (!mountedRef.current) return;
            dispatch({ kind: 'run-status', runId: run.id, state: run.state });
          } catch {
            // A missing/forbidden run resolves to 404; leave state as-is.
          }
        }
      } catch (err) {
        if (mountedRef.current && opts2.initial) setHistoryError(err);
      } finally {
        if (mountedRef.current && opts2.initial) setLoadingHistory(false);
      }
    },
    [projectId, chatId],
  );

  // --- SSE connection management --------------------------------------------

  const closeConn = useCallback(() => {
    connRef.current?.close();
    connRef.current = null;
  }, []);

  const connect = useCallback(
    (runId: string) => {
      if (connRef.current) return; // already streaming
      connRef.current = new RealtimeConnection(
        { projectId, runId },
        {
          onEvent: (env) => {
            if (mountedRef.current) dispatch({ kind: 'event', envelope: env });
          },
          onResync: () => {
            if (mountedRef.current) void loadSnapshot({ initial: false });
          },
        },
        factory,
      );
    },
    [projectId, loadSnapshot, factory],
  );

  // Open a connection whenever a run is active; close when it goes terminal.
  useEffect(() => {
    if (!enabled) return;
    if (state.activeRunId && !isTerminalRunState(state.runState)) {
      connect(state.activeRunId);
    } else {
      closeConn();
    }
  }, [enabled, state.activeRunId, state.runState, connect, closeConn]);

  // The reducer asks for a resync when a committed message had no provisional
  // bubble (a reconnect replayed only the commit): reload durable history.
  useEffect(() => {
    if (state.resyncRequested) {
      dispatch({ kind: 'resync-handled' });
      void loadSnapshot({ initial: false });
    }
  }, [state.resyncRequested, loadSnapshot]);

  // Initial load per chat.
  useEffect(() => {
    mountedRef.current = true;
    if (enabled) void loadSnapshot({ initial: true });
    return () => {
      mountedRef.current = false;
      closeConn();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, chatId, enabled]);

  // --- send (the ONLY path that creates a run) ------------------------------

  const runActive = state.activeRunId !== null && !isTerminalRunState(state.runState);

  const send = useCallback(
    async (input: SendInput): Promise<void> => {
      const text = input.text.trim();
      if (text.length === 0 || runActive || sending) return;
      const clientMessageId = newUuid();
      const idempotencyKey = newUuid();
      const artifactIds = input.artifactIds ?? [];
      setSendError(null);
      setSending(true);
      dispatch({ kind: 'optimistic-user', clientMessageId, text, artifactIds });
      try {
        const res = await createRun(projectId, chatId, {
          clientMessageId,
          idempotencyKey,
          providerConfigId: input.providerConfigId,
          text,
          artifactIds,
          ...(input.dataMode ? { dataMode: input.dataMode } : {}),
        });
        if (!mountedRef.current) return;
        dispatch({
          kind: 'run-created',
          runId: res.run.id,
          clientMessageId,
          userMessage: res.message,
        });
        dispatch({ kind: 'run-status', runId: res.run.id, state: res.run.state });
      } catch (err) {
        if (!mountedRef.current) return;
        dispatch({ kind: 'send-failed', clientMessageId });
        if (err instanceof ApiError) setSendError(err);
        else setSendError(new ApiError(0, 'NETWORK', 'Could not reach the server.'));
      } finally {
        if (mountedRef.current) setSending(false);
      }
    },
    [projectId, chatId, runActive, sending],
  );

  const reloadHistory = useCallback(() => {
    void loadSnapshot({ initial: true });
  }, [loadSnapshot]);

  return useMemo(
    () => ({
      messages: state.messages,
      runState: state.runState,
      activeRunId: state.activeRunId,
      runActive,
      loadingHistory,
      historyError,
      sending,
      sendError,
      budget: state.budget,
      plan: state.plan,
      activity: state.activity,
      send,
      reloadHistory,
    }),
    [
      state.messages,
      state.runState,
      state.activeRunId,
      runActive,
      loadingHistory,
      historyError,
      sending,
      sendError,
      state.budget,
      state.plan,
      state.activity,
      send,
      reloadHistory,
    ],
  );
}
