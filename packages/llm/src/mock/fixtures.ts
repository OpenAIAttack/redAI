/**
 * Scripted fixture format for the deterministic mock provider. Fixtures live under
 * `tests/fixtures/models/**` as JSON so CI needs no API key or payment (docs/11 §1
 * "deterministic mock adapter cho test"; AGENTS "mock provider … hiển thị nhãn rõ").
 *
 * A fixture is an ordered list of events replayed either as a stream or aggregated.
 * The format intentionally supports MALFORMED scripts (bad tool JSON, conflicting
 * indices, a mid-stream interrupt) so the failure paths are testable offline.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { FinishReason, StreamEvent, Usage } from '../types.js';

/** One scripted step. Exactly one of the below keys is present. */
export type MockEvent =
  | { text: string }
  | { tool_call: { index: number; id?: string; name?: string; arguments?: string } }
  | { usage: { input_tokens: number; output_tokens: number; total_tokens?: number } | 'unknown' }
  | { finish: string }
  /** Simulate a stream that dies mid-frame: yielding throws {@link LlmProtocolError}. */
  | { interrupt: string };

export interface MockFixture {
  id: string;
  description?: string;
  /** Optional selection predicate against the request. */
  match?: { lastUserIncludes?: string; hasTools?: boolean };
  /** Ordered scripted events. */
  events: MockEvent[];
  /** Per-event delay when streaming (lets a test abort mid-stream). */
  chunkDelayMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse (with runtime checks, not casts) an unknown JSON value into a fixture. */
export function parseFixture(value: unknown): MockFixture {
  if (!isRecord(value)) throw new Error('fixture must be an object');
  const id = value['id'];
  if (typeof id !== 'string' || id === '') throw new Error('fixture.id must be a non-empty string');
  const rawEvents = value['events'];
  if (!Array.isArray(rawEvents)) throw new Error(`fixture ${id}: events must be an array`);

  const events: MockEvent[] = rawEvents.map((raw, i) => {
    if (!isRecord(raw)) throw new Error(`fixture ${id}: event ${i} must be an object`);
    if ('text' in raw) {
      if (typeof raw['text'] !== 'string') throw new Error(`fixture ${id}: event ${i} text`);
      return { text: raw['text'] };
    }
    if ('tool_call' in raw) {
      const tc = raw['tool_call'];
      if (!isRecord(tc) || typeof tc['index'] !== 'number') {
        throw new Error(`fixture ${id}: event ${i} tool_call.index`);
      }
      const call: { index: number; id?: string; name?: string; arguments?: string } = {
        index: tc['index'],
      };
      if (typeof tc['id'] === 'string') call.id = tc['id'];
      if (typeof tc['name'] === 'string') call.name = tc['name'];
      if (typeof tc['arguments'] === 'string') call.arguments = tc['arguments'];
      return { tool_call: call };
    }
    if ('usage' in raw) {
      const u = raw['usage'];
      if (u === 'unknown') return { usage: 'unknown' };
      if (
        !isRecord(u) ||
        typeof u['input_tokens'] !== 'number' ||
        typeof u['output_tokens'] !== 'number'
      ) {
        throw new Error(`fixture ${id}: event ${i} usage`);
      }
      const usage: { input_tokens: number; output_tokens: number; total_tokens?: number } = {
        input_tokens: u['input_tokens'],
        output_tokens: u['output_tokens'],
      };
      if (typeof u['total_tokens'] === 'number') usage.total_tokens = u['total_tokens'];
      return { usage };
    }
    if ('finish' in raw) {
      if (typeof raw['finish'] !== 'string') throw new Error(`fixture ${id}: event ${i} finish`);
      return { finish: raw['finish'] };
    }
    if ('interrupt' in raw) {
      if (typeof raw['interrupt'] !== 'string')
        throw new Error(`fixture ${id}: event ${i} interrupt`);
      return { interrupt: raw['interrupt'] };
    }
    throw new Error(`fixture ${id}: event ${i} has no known key`);
  });

  const fixture: MockFixture = { id, events };
  if (typeof value['description'] === 'string') fixture.description = value['description'];
  if (typeof value['chunkDelayMs'] === 'number') fixture.chunkDelayMs = value['chunkDelayMs'];
  if (isRecord(value['match'])) {
    const m = value['match'];
    const match: { lastUserIncludes?: string; hasTools?: boolean } = {};
    if (typeof m['lastUserIncludes'] === 'string') match.lastUserIncludes = m['lastUserIncludes'];
    if (typeof m['hasTools'] === 'boolean') match.hasTools = m['hasTools'];
    fixture.match = match;
  }
  return fixture;
}

/** Load and parse every `*.json` fixture in a directory (used by tests). */
export function loadFixtureDir(dir: string): MockFixture[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => parseFixture(JSON.parse(readFileSync(join(dir, name), 'utf8'))));
}

/** Map one scripted usage step to a gateway {@link Usage}. */
export function fixtureUsage(
  u: { input_tokens: number; output_tokens: number; total_tokens?: number } | 'unknown',
): Usage {
  if (u === 'unknown') return { kind: 'unknown' };
  return {
    kind: 'known',
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    totalTokens: u.total_tokens ?? u.input_tokens + u.output_tokens,
  };
}

/**
 * Translate a fixture event to a gateway {@link StreamEvent}, or `null` for control
 * events (interrupt) the caller handles specially. Finish reasons are passed through
 * and normalized to the {@link StreamEvent} union.
 */
export function fixtureEventToStreamEvent(event: MockEvent): StreamEvent | 'interrupt' {
  if ('text' in event) return { type: 'text', text: event.text };
  if ('tool_call' in event) {
    const out: Extract<StreamEvent, { type: 'tool_call' }> = {
      type: 'tool_call',
      index: event.tool_call.index,
    };
    if (event.tool_call.id !== undefined) out.id = event.tool_call.id;
    if (event.tool_call.name !== undefined) out.name = event.tool_call.name;
    if (event.tool_call.arguments !== undefined) out.argumentsDelta = event.tool_call.arguments;
    return out;
  }
  if ('usage' in event) return { type: 'usage', usage: fixtureUsage(event.usage) };
  if ('finish' in event) {
    return { type: 'finish', finishReason: normalizeFinish(event.finish) };
  }
  return 'interrupt';
}

const FINISH_REASONS: readonly FinishReason[] = [
  'stop',
  'length',
  'tool_calls',
  'content_filter',
  'canceled',
  'error',
  'unknown',
];

function normalizeFinish(raw: string): FinishReason {
  return FINISH_REASONS.find((r) => r === raw) ?? 'unknown';
}
