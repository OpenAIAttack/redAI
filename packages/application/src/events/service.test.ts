/**
 * EventStream unit tests (no DB): the pure read-model behaviour — commit-ordered
 * contiguity stop, project/run filtering with cursor advancement, envelope
 * validation, and cursor classification (ok / future / expired).
 */
import { describe, expect, it } from 'vitest';
import { EventStream } from './service.js';
import type { EventJournalReader, EventRow } from './ports.js';

const WS = '00000000-0000-4000-8000-000000000001';
const PROJ_A = '00000000-0000-4000-8000-0000000000a1';
const PROJ_B = '00000000-0000-4000-8000-0000000000b2';
const RUN = '00000000-0000-4000-8000-0000000000c3';
const CHAT = '00000000-0000-4000-8000-0000000000d4';

function row(eventId: bigint, projectId: string | null, runId: string | null): EventRow {
  return {
    workspaceId: WS,
    eventId,
    projectId,
    runId,
    eventType: 'run.created',
    payload: { run_id: RUN, chat_id: CHAT },
    createdAt: new Date('2026-09-24T03:00:00.000Z'),
  };
}

/** In-memory reader over a fixed, ascending row list. */
function fakeReader(rows: EventRow[], counterNext?: bigint): EventJournalReader {
  const sorted = [...rows].sort((a, b) => (a.eventId < b.eventId ? -1 : 1));
  return {
    async readAfter(_ws, afterCursor, limit) {
      return sorted.filter((r) => r.eventId > afterCursor).slice(0, limit);
    },
    async earliestEventId() {
      return sorted.length ? sorted[0]!.eventId : null;
    },
    async latestAllocatedEventId() {
      if (counterNext !== undefined) return counterNext - 1n;
      return sorted.length ? sorted[sorted.length - 1]!.eventId : 0n;
    },
  };
}

describe('EventStream.readAfter', () => {
  it('delivers a contiguous run and advances the cursor to its last id', async () => {
    const s = new EventStream(
      fakeReader([row(1n, null, RUN), row(2n, null, RUN), row(3n, null, RUN)]),
    );
    const r = await s.readAfter(WS, 0n);
    expect(r.events.map((e) => e.event_id)).toEqual(['1', '2', '3']);
    expect(r.cursor).toBe(3n);
    expect(r.advancedPastFiltered).toBe(false);
  });

  it('stops at a gap and does not advance past an id a lower in-flight txn will fill', async () => {
    // id 2 is missing (its transaction has not committed yet); 3 is visible.
    const s = new EventStream(fakeReader([row(1n, null, RUN), row(3n, null, RUN)], 4n));
    const r = await s.readAfter(WS, 0n);
    expect(r.events.map((e) => e.event_id)).toEqual(['1']);
    expect(r.cursor).toBe(1n); // never jumps to 3
  });

  it('picks up the filler once the lower id appears, then continues past it', async () => {
    const s = new EventStream(
      fakeReader([row(1n, null, RUN), row(2n, null, RUN), row(3n, null, RUN)]),
    );
    const r = await s.readAfter(WS, 1n);
    expect(r.events.map((e) => e.event_id)).toEqual(['2', '3']);
    expect(r.cursor).toBe(3n);
  });

  it('advances the cursor past filtered-out events and flags it', async () => {
    const rows = [row(1n, PROJ_B, RUN), row(2n, PROJ_A, RUN), row(3n, PROJ_B, RUN)];
    const s = new EventStream(fakeReader(rows));
    const r = await s.readAfter(WS, 0n, { projectId: PROJ_A });
    expect(r.events.map((e) => e.event_id)).toEqual(['2']); // only project A leaks
    expect(r.cursor).toBe(3n); // but the cursor still moves to 3
    expect(r.advancedPastFiltered).toBe(true);
  });

  it('validates every emitted row against the contract envelope', async () => {
    const bad = row(1n, null, RUN);
    bad.payload = { run_id: 'not-a-uuid', chat_id: CHAT };
    const s = new EventStream(fakeReader([bad]));
    await expect(s.readAfter(WS, 0n)).rejects.toThrow(/contract event/i);
  });
});

describe('EventStream.classifyCursor', () => {
  it('ok when the cursor is within the surviving range', async () => {
    const s = new EventStream(fakeReader([row(1n, null, RUN), row(2n, null, RUN)], 3n));
    expect(await s.classifyCursor(WS, 1n)).toBe('ok');
  });

  it('future when the cursor is ahead of anything committed', async () => {
    const s = new EventStream(fakeReader([row(1n, null, RUN)], 2n));
    expect(await s.classifyCursor(WS, 2n)).toBe('future');
  });

  it('expired when an event after the cursor was purged by retention', async () => {
    // earliest surviving id is 101 → events 1..100 (and cursor 0..99) are gone.
    const s = new EventStream(fakeReader([row(101n, null, RUN)], 102n));
    expect(await s.classifyCursor(WS, 0n)).toBe('expired');
    expect(await s.classifyCursor(WS, 50n)).toBe('expired');
    expect(await s.classifyCursor(WS, 100n)).toBe('ok'); // caught up to the floor
  });

  it('ok for cursor 0 against an empty journal', async () => {
    const s = new EventStream(fakeReader([], 1n));
    expect(await s.classifyCursor(WS, 0n)).toBe('ok');
  });
});
