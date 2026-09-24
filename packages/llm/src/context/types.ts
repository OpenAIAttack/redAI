/**
 * Context-manifest + redaction types (docs/11 §4–§5).
 *
 * The runtime hands the gateway a set of owner-approved {@link ContextSource}s — the
 * fixed platform instruction, the Run goal, an authority snapshot, approved project
 * notes/files, recent conversation and bounded tool/evidence excerpts. This module
 * turns them into the redacted {@link Message}[] the provider receives, under
 * per-layer token caps, and produces a {@link ContextManifest} that records exactly
 * what was included, dropped, summarised or truncated — with each source's
 * id/version/classification and the redaction transform id, for reproducibility.
 *
 * SECRET DISCIPLINE: a secret enters this module only as a {@link SecretRefInput}
 * whose `value` is used SOLELY to detect and replace occurrences with a stable
 * `[SECRET_REF_n]` reference. The value never appears in the produced messages, the
 * manifest, or anything this module returns or logs — the model works from the
 * reference, and the trusted executor injects the real credential later (docs/11 §5).
 */
import type { Message, MessageRole } from '../types.js';

/** Owner classification of a source (mirrors the artifacts `classification` domain). */
export type SourceClassification = 'public' | 'internal' | 'sensitive' | 'restricted';

/**
 * The context layers of docs/11 §4. Ordering + framing is deterministic:
 *   platform → authority → notes → summary → history → evidence → goal.
 * `platform`/`goal`/`authority` are the reserved band (always included).
 */
export type ContextLayer =
  'platform' | 'goal' | 'authority' | 'notes' | 'summary' | 'history' | 'evidence';

/** A single owner-approved context input, before redaction and cap selection. */
export interface ContextSource {
  /** Stable id (note id, artifact id, message id, "platform", …). */
  id: string;
  layer: ContextLayer;
  /** The gateway role this source maps to. */
  role: MessageRole;
  /** Version / revision / hash tag the runtime provides for provenance. */
  version: string;
  classification: SourceClassification;
  /** Raw text (untrusted for notes/history/evidence). Redacted before egress. */
  text: string;
  /**
   * Marks tool/evidence output as untrusted so the manifest labels it and the
   * assembled message is framed as data, never an instruction (docs/11 §6).
   */
  untrusted?: boolean;
}

/**
 * Per-band token caps (docs/11 §4 "Context budget phân chia"). `total` is the hard
 * ceiling; the reserved band (platform/goal/authority) is always included even if it
 * alone exceeds the remainder (then {@link ContextManifest.overBudget} is set). The
 * remaining bands are filled greedily up to their own caps: notes, then summary,
 * then the most-recent history, then evidence excerpts.
 */
export interface TokenCaps {
  total: number;
  notes: number;
  summary: number;
  history: number;
  evidence: number;
}

/**
 * A secret reference. `value` is consumed ONLY to redact matching text to `ref`'s
 * stable `[SECRET_REF_n]` placeholder; it is never emitted, stored or logged.
 */
export interface SecretRefInput {
  /** Stable reference id (e.g. a secret id / credential_ref). */
  ref: string;
  /** The literal secret value to detect and redact. Never surfaced anywhere. */
  value: string;
}

/** Options controlling the redaction pipeline for one Run. */
export interface RedactionOptions {
  /** Run scope for stable token numbering (mapping stays local, never logged). */
  runId: string;
  /** Secret references whose values must be redacted to `[SECRET_REF_n]`. */
  secretRefs?: SecretRefInput[];
  /**
   * Canary sentinels (a known secret value a test plants to prove no leak). They are
   * redacted exactly like secret values; a leak means the canary survived to egress.
   */
  canaries?: string[];
  /** Redact email addresses to `[EMAIL_n]` (default true). */
  redactEmails?: boolean;
  /** Redact hosts / URLs to `[HOST_n]` (default true). */
  redactHosts?: boolean;
}

/** Why a source was (not) included in the assembled context. */
export type InclusionReason =
  'mandatory' | 'included' | 'summarized' | 'truncated' | 'dropped_over_budget';

/** One row of the manifest: what happened to a source. */
export interface ManifestEntry {
  id: string;
  layer: ContextLayer;
  role: MessageRole;
  version: string;
  classification: SourceClassification;
  untrusted: boolean;
  /** Id of the redaction transform applied (for reproducibility). */
  redactionTransformId: string;
  /** Estimated tokens of the redacted text actually placed into context. */
  tokens: number;
  included: boolean;
  reason: InclusionReason;
  /** For a truncated excerpt: the character window of the original kept. */
  offset?: { start: number; end: number };
}

/** Number of times each redaction class fired (counts only — never the values). */
export interface RedactionCounts {
  secrets: number;
  emails: number;
  hosts: number;
}

/** The assembled, redacted context plus its provenance manifest. */
export interface ContextManifest {
  runId: string;
  transformId: string;
  caps: TokenCaps;
  /** Redacted messages ready for the gateway (contain references, never secrets). */
  messages: Message[];
  entries: ManifestEntry[];
  totalTokens: number;
  /** True when the mandatory reserved band alone exceeded the total cap. */
  overBudget: boolean;
  /** True when history was dropped in favour of a completed summary. */
  usedSummary: boolean;
  redactions: RedactionCounts;
}
