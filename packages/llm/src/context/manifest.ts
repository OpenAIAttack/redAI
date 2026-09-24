/**
 * Context manifest assembly (docs/11 §4). Deterministic, pure and unit-testable:
 * given owner-approved {@link ContextSource}s, {@link TokenCaps} and
 * {@link RedactionOptions}, it produces the redacted {@link Message}[] for the gateway
 * plus a {@link ContextManifest} that records every inclusion/drop/summary/truncation.
 *
 * Message order (docs/11 §4): platform + authority (mandatory head) → approved notes →
 * completed summary / recent history → evidence excerpts → the owner Run goal
 * (mandatory tail, the final user turn).
 *
 * Budget policy:
 *   - The mandatory band (platform / authority / goal) is always included. If it alone
 *     exceeds `total`, `overBudget` is set — the runtime then stops (docs/11 §7); we
 *     never silently drop the platform instruction or the owner goal.
 *   - The remainder is filled greedily by priority: notes → summary/history → evidence.
 *   - When the recent history does not fit its cap, the completed summary is used in
 *     its place ("summary selection") and as much recent history as still fits is kept.
 *   - Oversized evidence excerpts are truncated to a bounded window (offset recorded),
 *     never dumped whole (docs/11 §4 "Large logs đưa artifact ref + bounded excerpt").
 *
 * Token counting uses a deterministic char/4 heuristic (no external tokenizer). It is
 * used ONLY for cap selection here; the budget reservation upper bound is computed by
 * @redai/application/budget from the configured context cap (docs/11 §7).
 */
import type { Message } from '../types.js';
import { Redactor, REDACTION_TRANSFORM_ID } from './redact.js';
import type {
  ContextLayer,
  ContextManifest,
  ContextSource,
  ManifestEntry,
  RedactionOptions,
  TokenCaps,
} from './types.js';

/** Deterministic token estimate: ~4 chars/token, rounded up. */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

const MESSAGE_FRAME_TOKENS = 2;

/** Priority order the greedy filler walks (mandatory band handled separately). */
const FILL_ORDER: ContextLayer[] = ['notes', 'summary', 'history', 'evidence'];
const MANDATORY_HEAD: ReadonlySet<ContextLayer> = new Set(['platform', 'authority']);

interface Prepared {
  source: ContextSource;
  redacted: string;
  tokens: number;
}

function capFor(layer: ContextLayer, caps: TokenCaps): number {
  switch (layer) {
    case 'notes':
      return caps.notes;
    case 'summary':
      return caps.summary;
    case 'history':
      return caps.history;
    case 'evidence':
      return caps.evidence;
    default:
      return caps.total;
  }
}

/** Truncate `text` to at most `maxTokens`, returning the kept window + its tokens. */
function truncateToTokens(text: string, maxTokens: number): { kept: string; tokens: number } {
  if (maxTokens <= 0) return { kept: '', tokens: 0 };
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return { kept: text, tokens: estimateTokens(text) };
  const kept = text.slice(0, maxChars);
  return { kept, tokens: estimateTokens(kept) };
}

function frame(source: ContextSource, text: string): string {
  if (source.untrusted) {
    // Bounded, tagged, never concatenated as an instruction (docs/11 §6).
    return `<untrusted source="${source.id}">\n${text}\n</untrusted>`;
  }
  return text;
}

function headRank(layer: ContextLayer): number {
  return layer === 'platform' ? 0 : 1; // platform before authority
}

/**
 * Build the redacted context manifest. `sources` may arrive in any order; the builder
 * sorts them into the canonical layer order for both the messages and the manifest.
 */
export function buildContextManifest(
  sources: ContextSource[],
  caps: TokenCaps,
  redaction: RedactionOptions,
): ContextManifest {
  const redactor = new Redactor({
    ...(redaction.secretRefs !== undefined ? { secretRefs: redaction.secretRefs } : {}),
    ...(redaction.canaries !== undefined ? { canaries: redaction.canaries } : {}),
    ...(redaction.redactEmails !== undefined ? { redactEmails: redaction.redactEmails } : {}),
    ...(redaction.redactHosts !== undefined ? { redactHosts: redaction.redactHosts } : {}),
  });

  // Redact once up front; token counts are over the REDACTED text (what egresses).
  const prepared: Prepared[] = sources.map((source) => {
    const redacted = redactor.redact(source.text);
    return { source, redacted, tokens: estimateTokens(redacted) + MESSAGE_FRAME_TOKENS };
  });

  const entries: ManifestEntry[] = [];
  const headMessages: Message[] = [];
  const bodyMessages: Message[] = [];
  const tailMessages: Message[] = [];
  let totalTokens = 0;
  let usedSummary = false;

  const emit = (
    p: Prepared,
    included: boolean,
    reason: ManifestEntry['reason'],
    text: string,
    tokens: number,
    bucket: Message[],
    offset?: { start: number; end: number },
  ): void => {
    entries.push({
      id: p.source.id,
      layer: p.source.layer,
      role: p.source.role,
      version: p.source.version,
      classification: p.source.classification,
      untrusted: p.source.untrusted ?? false,
      redactionTransformId: REDACTION_TRANSFORM_ID,
      tokens: included ? tokens : 0,
      included,
      reason,
      ...(offset !== undefined ? { offset } : {}),
    });
    if (included) {
      bucket.push({ role: p.source.role, content: frame(p.source, text) });
      totalTokens += tokens;
    }
  };

  // 1) Mandatory head (platform, authority) — always included, in canonical order.
  const head = prepared
    .filter((p) => MANDATORY_HEAD.has(p.source.layer))
    .sort((a, b) => headRank(a.source.layer) - headRank(b.source.layer));
  for (const p of head) emit(p, true, 'mandatory', p.redacted, p.tokens, headMessages);

  // 2) Mandatory tail (goal) — always included, emitted last.
  const tail = prepared.filter((p) => p.source.layer === 'goal');
  for (const p of tail) emit(p, true, 'mandatory', p.redacted, p.tokens, tailMessages);

  const overBudget = totalTokens > caps.total;
  let remaining = Math.max(0, caps.total - totalTokens);
  const bandUsed: Record<string, number> = { notes: 0, summary: 0, history: 0, evidence: 0 };

  const historySources = prepared.filter((p) => p.source.layer === 'history');
  const summarySources = prepared.filter((p) => p.source.layer === 'summary');
  const historyTokens = historySources.reduce((n, p) => n + p.tokens, 0);
  const historyOverflows = historyTokens > caps.history;

  // 3) Greedy fill by priority.
  for (const layer of FILL_ORDER) {
    if (layer === 'summary' && !historyOverflows) {
      for (const p of summarySources) {
        emit(p, false, 'dropped_over_budget', p.redacted, p.tokens, bodyMessages);
      }
      continue;
    }
    if (layer === 'summary' && historyOverflows) {
      usedSummary = true; // summary stands in for the full history
    }

    const layerSources = prepared.filter((p) => p.source.layer === layer);
    for (const p of layerSources) {
      const layerRemaining = capFor(layer, caps) - bandUsed[layer]!;
      const room = Math.min(remaining, layerRemaining);
      if (room <= 0) {
        emit(p, false, 'dropped_over_budget', p.redacted, p.tokens, bodyMessages);
        continue;
      }
      if (p.tokens <= room) {
        const reason = layer === 'summary' ? 'summarized' : 'included';
        emit(p, true, reason, p.redacted, p.tokens, bodyMessages);
        remaining -= p.tokens;
        bandUsed[layer]! += p.tokens;
      } else if (layer === 'evidence') {
        const budget = room - MESSAGE_FRAME_TOKENS;
        const { kept, tokens } = truncateToTokens(p.redacted, budget);
        if (kept.length === 0) {
          emit(p, false, 'dropped_over_budget', p.redacted, p.tokens, bodyMessages);
          continue;
        }
        const withFrame = tokens + MESSAGE_FRAME_TOKENS;
        emit(p, true, 'truncated', kept, withFrame, bodyMessages, { start: 0, end: kept.length });
        remaining -= withFrame;
        bandUsed[layer]! += withFrame;
      } else {
        emit(p, false, 'dropped_over_budget', p.redacted, p.tokens, bodyMessages);
      }
    }
  }

  const messages = [...headMessages, ...bodyMessages, ...tailMessages];

  return {
    runId: redaction.runId,
    transformId: REDACTION_TRANSFORM_ID,
    caps,
    messages,
    entries,
    totalTokens,
    overBudget,
    usedSummary,
    redactions: redactor.redactionCounts,
  };
}
