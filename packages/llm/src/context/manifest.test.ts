/**
 * Context-manifest unit tests (docs/11 §4): canonical ordering, token caps, summary
 * selection when history overflows, evidence truncation, mandatory band, and that the
 * assembled messages carry secret REFERENCES (never values).
 */
import { describe, expect, it } from 'vitest';
import { buildContextManifest, estimateTokens } from './manifest.js';
import type { ContextSource, TokenCaps } from './types.js';

const CAPS: TokenCaps = { total: 200, notes: 60, summary: 40, history: 60, evidence: 40 };

function source(
  partial: Partial<ContextSource> & Pick<ContextSource, 'id' | 'layer'>,
): ContextSource {
  return {
    role: partial.role ?? 'system',
    version: partial.version ?? 'v1',
    classification: partial.classification ?? 'internal',
    text: partial.text ?? '',
    ...partial,
  };
}

describe('buildContextManifest', () => {
  it('orders platform+authority first, goal last, with body between', () => {
    const sources: ContextSource[] = [
      source({ id: 'goal', layer: 'goal', role: 'user', text: 'do the thing' }),
      source({ id: 'note1', layer: 'notes', text: 'a note' }),
      source({ id: 'platform', layer: 'platform', text: 'you are redAI' }),
      source({ id: 'auth', layer: 'authority', text: 'scope snapshot' }),
    ];
    const m = buildContextManifest(sources, CAPS, { runId: 'r1' });
    expect(m.messages[0]!.content).toContain('you are redAI');
    expect(m.messages[1]!.content).toContain('scope snapshot');
    expect(m.messages[m.messages.length - 1]!.content).toContain('do the thing');
    expect(m.messages[m.messages.length - 1]!.role).toBe('user');
  });

  it('keeps secret references out — the value never reaches the messages', () => {
    const sources: ContextSource[] = [
      source({ id: 'platform', layer: 'platform', text: 'system' }),
      source({ id: 'note', layer: 'notes', text: 'the api key is sk-LEAK-999 do not share' }),
      source({ id: 'goal', layer: 'goal', role: 'user', text: 'summarise' }),
    ];
    const m = buildContextManifest(sources, CAPS, {
      runId: 'r1',
      secretRefs: [{ ref: 'k', value: 'sk-LEAK-999' }],
    });
    const blob = JSON.stringify(m.messages);
    expect(blob).not.toContain('sk-LEAK-999');
    expect(blob).toContain('[SECRET_REF_1]');
    expect(m.redactions.secrets).toBe(1);
  });

  it('uses the completed summary when recent history overflows its cap', () => {
    const bigHistory = 'x'.repeat(400); // ~100 tokens > history cap 60
    const sources: ContextSource[] = [
      source({ id: 'platform', layer: 'platform', text: 'sys' }),
      source({ id: 'sum', layer: 'summary', text: 'short summary of the chat' }),
      source({ id: 'h1', layer: 'history', role: 'user', text: bigHistory }),
      source({ id: 'goal', layer: 'goal', role: 'user', text: 'go' }),
    ];
    const m = buildContextManifest(sources, CAPS, { runId: 'r1' });
    expect(m.usedSummary).toBe(true);
    const sumEntry = m.entries.find((e) => e.id === 'sum')!;
    expect(sumEntry.included).toBe(true);
    expect(sumEntry.reason).toBe('summarized');
    // the oversized single history message does not fit and is dropped
    const hEntry = m.entries.find((e) => e.id === 'h1')!;
    expect(hEntry.included).toBe(false);
  });

  it('drops the summary when history fits (no double-spend)', () => {
    const sources: ContextSource[] = [
      source({ id: 'platform', layer: 'platform', text: 'sys' }),
      source({ id: 'sum', layer: 'summary', text: 'summary' }),
      source({ id: 'h1', layer: 'history', role: 'user', text: 'hi' }),
      source({ id: 'goal', layer: 'goal', role: 'user', text: 'go' }),
    ];
    const m = buildContextManifest(sources, CAPS, { runId: 'r1' });
    expect(m.usedSummary).toBe(false);
    expect(m.entries.find((e) => e.id === 'sum')!.included).toBe(false);
    expect(m.entries.find((e) => e.id === 'h1')!.included).toBe(true);
  });

  it('truncates an oversized evidence excerpt to a bounded window', () => {
    const huge = 'e'.repeat(1000);
    const sources: ContextSource[] = [
      source({ id: 'platform', layer: 'platform', text: 'sys' }),
      source({ id: 'ev', layer: 'evidence', role: 'tool', text: huge, untrusted: true }),
      source({ id: 'goal', layer: 'goal', role: 'user', text: 'go' }),
    ];
    const m = buildContextManifest(sources, CAPS, { runId: 'r1' });
    const ev = m.entries.find((e) => e.id === 'ev')!;
    expect(ev.included).toBe(true);
    expect(ev.reason).toBe('truncated');
    expect(ev.offset).toBeDefined();
    expect(ev.tokens).toBeLessThanOrEqual(CAPS.evidence);
    // untrusted evidence is framed, never concatenated as an instruction
    const evMsg = m.messages.find((msg) => msg.role === 'tool')!;
    expect(evMsg.content).toContain('<untrusted source="ev">');
  });

  it('always includes the mandatory band and flags overBudget when it alone exceeds total', () => {
    const tiny: TokenCaps = { total: 5, notes: 5, summary: 5, history: 5, evidence: 5 };
    const sources: ContextSource[] = [
      source({ id: 'platform', layer: 'platform', text: 'a'.repeat(40) }),
      source({ id: 'goal', layer: 'goal', role: 'user', text: 'b'.repeat(40) }),
    ];
    const m = buildContextManifest(sources, tiny, { runId: 'r1' });
    expect(m.overBudget).toBe(true);
    expect(m.entries.every((e) => e.included)).toBe(true);
    expect(m.entries.every((e) => e.reason === 'mandatory')).toBe(true);
  });

  it('records provenance (version, classification, transform id) per entry', () => {
    const sources: ContextSource[] = [
      source({
        id: 'platform',
        layer: 'platform',
        text: 'sys',
        version: 'p-7',
        classification: 'public',
      }),
      source({ id: 'goal', layer: 'goal', role: 'user', text: 'go' }),
    ];
    const m = buildContextManifest(sources, CAPS, { runId: 'r1' });
    const p = m.entries.find((e) => e.id === 'platform')!;
    expect(p.version).toBe('p-7');
    expect(p.classification).toBe('public');
    expect(p.redactionTransformId).toBe('redact-v1');
  });

  it('estimateTokens is a deterministic char/4 ceil', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});
