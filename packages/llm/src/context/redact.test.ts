/**
 * Redaction pipeline unit tests (docs/11 §5): stable tokenisation, secret references
 * NEVER carry values, base64 echoes are caught, and mapping is not exposed as values.
 */
import { describe, expect, it } from 'vitest';
import { Redactor, redactText } from './redact.js';

describe('Redactor', () => {
  it('replaces a secret value with a stable [SECRET_REF_n] and never emits the value', () => {
    const r = new Redactor({ secretRefs: [{ ref: 'cred:1', value: 'sk-super-secret-123' }] });
    const out = r.redact('use key sk-super-secret-123 for the call, key sk-super-secret-123');
    expect(out).not.toContain('sk-super-secret-123');
    expect(out).toContain('[SECRET_REF_1]');
    // both occurrences replaced by the SAME stable label
    expect(out.match(/\[SECRET_REF_1\]/g)).toHaveLength(2);
    expect(r.redactionCounts.secrets).toBe(2);
  });

  it('catches a base64-echoed secret (docs/11 §5 base64-like echoes)', () => {
    const value = 'topsecretvalue';
    const b64 = Buffer.from(value, 'utf8').toString('base64');
    const r = new Redactor({ secretRefs: [{ ref: 'c', value }] });
    const out = r.redact(`raw=${value} echoed=${b64}`);
    expect(out).not.toContain(value);
    expect(out).not.toContain(b64);
    expect(out).toContain('[SECRET_REF_1]');
  });

  it('tokenises emails and hosts stably within the run scope', () => {
    const r = new Redactor();
    const out = r.redact(
      'mail a@x.com then a@x.com and host api.example.com again api.example.com',
    );
    expect(out).not.toContain('a@x.com');
    expect(out).not.toContain('api.example.com');
    expect(out.match(/\[EMAIL_1\]/g)).toHaveLength(2);
    expect(out.match(/\[HOST_1\]/g)).toHaveLength(2);
  });

  it('redacts a full URL (dropping query, which may carry secrets)', () => {
    const r = new Redactor();
    const out = r.redact('GET https://api.example.com/v1/x?token=abc123 done');
    expect(out).not.toContain('token=abc123');
    expect(out).not.toContain('api.example.com');
    expect(out).toContain('[HOST_1]');
  });

  it('prefers the secret label over host/email when a secret overlaps', () => {
    const r = new Redactor({ secretRefs: [{ ref: 'c', value: 'admin@corp.example' }] });
    const out = r.redact('login admin@corp.example');
    expect(out).toContain('[SECRET_REF_1]');
    expect(out).not.toContain('[EMAIL_1]');
    expect(out).not.toContain('admin@corp.example');
  });

  it('can be disabled per-class', () => {
    const out = redactText('a@x.com host.example.com', {
      redactEmails: false,
      redactHosts: false,
    });
    expect(out).toBe('a@x.com host.example.com');
  });

  it('exposes counts only, never the underlying values', () => {
    const r = new Redactor({ secretRefs: [{ ref: 'c', value: 'zzz-secret' }] });
    r.redact('zzz-secret a@x.com host.example.net');
    const counts = r.redactionCounts;
    expect(JSON.stringify(counts)).not.toContain('zzz-secret');
    expect(counts).toEqual({ secrets: 1, emails: 1, hosts: 1 });
  });
});
