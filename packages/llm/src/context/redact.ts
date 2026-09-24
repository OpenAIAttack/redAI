/**
 * Stable, run-scoped redaction (docs/11 §5).
 *
 * A {@link Redactor} tokenises sensitive spans into stable placeholders within one
 * Run: `[SECRET_REF_n]`, `[EMAIL_n]`, `[HOST_n]`. The mapping lives only inside the
 * instance and is NEVER logged or returned as values — callers get counts and the
 * redacted text. Secret values are matched first (raw and base64-echoed) so a secret
 * that also looks like a URL or email is caught as a secret, not merely a host.
 *
 * This is defence in depth, not a guarantee that regex catches every sensitive byte
 * (docs/11 §5 is explicit). The primary protection is not handing secrets or egress
 * to the model at all; this pipeline keeps known secret refs and obvious PII out of
 * the prompt, previews and logs, and lets a canary test prove a planted secret never
 * reaches an egress surface.
 */
import type { SecretRefInput } from './types.js';

/** The redaction transform id stamped into every manifest entry. */
export const REDACTION_TRANSFORM_ID = 'redact-v1';

/** Email addresses. Intentionally broad; false positives only over-redact. */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** http(s) URLs — replaced whole (path/query dropped) so query secrets never leak. */
const URL_RE = /\bhttps?:\/\/[^\s"'<>)\]]+/gi;

/**
 * Bare hostnames (a.b.c). Matched after URLs. Kept conservative (must contain a dot
 * and a 2+ char TLD) to avoid eating ordinary prose.
 */
const HOST_RE = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}\b/gi;

function base64Of(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface RedactorOptions {
  secretRefs?: SecretRefInput[];
  canaries?: string[];
  redactEmails?: boolean;
  redactHosts?: boolean;
}

export class Redactor {
  private readonly secretLabels = new Map<string, string>();
  private readonly emailLabels = new Map<string, string>();
  private readonly hostLabels = new Map<string, string>();
  /** Ordered [needle, label] for secret values; longest first so overlaps resolve. */
  private readonly secretNeedles: Array<{ needle: string; label: string }> = [];
  private readonly redactEmails: boolean;
  private readonly redactHosts: boolean;
  private counts = { secrets: 0, emails: 0, hosts: 0 };

  public constructor(options: RedactorOptions = {}) {
    this.redactEmails = options.redactEmails ?? true;
    this.redactHosts = options.redactHosts ?? true;

    // Assign a stable [SECRET_REF_n] per distinct ref, in declaration order. Both the
    // raw value and its base64 echo map to the SAME label (a reflected/encoded secret
    // is still that secret — docs/11 §5 base64-like echoes).
    const refs = options.secretRefs ?? [];
    refs.forEach((ref, i) => {
      if (ref.value.length === 0) return;
      const label = `[SECRET_REF_${i + 1}]`;
      this.registerSecret(ref.value, label);
      this.registerSecret(base64Of(ref.value), label);
    });

    // Canaries share the secret namespace; a distinct label makes a leak unmistakable.
    (options.canaries ?? []).forEach((value, i) => {
      if (value.length === 0) return;
      const label = `[CANARY_${i + 1}]`;
      this.registerSecret(value, label);
      this.registerSecret(base64Of(value), label);
    });

    // Longest needle first: prevents a short secret masking a longer overlapping one.
    this.secretNeedles.sort((a, b) => b.needle.length - a.needle.length);
  }

  private registerSecret(needle: string, label: string): void {
    if (needle.length === 0 || this.secretLabels.has(needle)) return;
    this.secretLabels.set(needle, label);
    this.secretNeedles.push({ needle, label });
  }

  /** Redact one string. Secrets → emails → hosts, each stable within the Run. */
  public redact(input: string): string {
    let text = input;

    // 1) Secret values (raw + base64), literal replacement.
    for (const { needle, label } of this.secretNeedles) {
      if (text.includes(needle)) {
        const before = text;
        text = text.split(needle).join(label);
        if (text !== before) {
          // Count each occurrence removed.
          const removed = before.split(needle).length - 1;
          this.counts.secrets += removed;
        }
      }
    }

    // 2) Emails.
    if (this.redactEmails) {
      text = text.replace(EMAIL_RE, (m) => this.labelFor(m, this.emailLabels, 'EMAIL', 'emails'));
    }

    // 3) URLs then bare hosts.
    if (this.redactHosts) {
      text = text.replace(URL_RE, (m) => this.labelFor(m, this.hostLabels, 'HOST', 'hosts'));
      text = text.replace(HOST_RE, (m) => this.labelFor(m, this.hostLabels, 'HOST', 'hosts'));
    }

    return text;
  }

  private labelFor(
    match: string,
    table: Map<string, string>,
    prefix: string,
    counter: 'emails' | 'hosts',
  ): string {
    let label = table.get(match);
    if (label === undefined) {
      label = `[${prefix}_${table.size + 1}]`;
      table.set(match, label);
    }
    this.counts[counter] += 1;
    return label;
  }

  /** Redaction counts (never the values). Safe to log. */
  public get redactionCounts(): { secrets: number; emails: number; hosts: number } {
    return { ...this.counts };
  }
}

/** Convenience: build a {@link Redactor} and redact a single string. */
export function redactText(input: string, options?: RedactorOptions): string {
  return new Redactor(options).redact(input);
}

export { escapeRegExp };
