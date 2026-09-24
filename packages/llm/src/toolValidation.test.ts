import { describe, expect, it } from 'vitest';

import type { ToolCall } from './types.js';
import { isToolArgsValid, validateToolCall } from './toolValidation.js';

function call(args: unknown): ToolCall {
  return {
    id: 'c1',
    index: 0,
    name: 'file_read',
    argumentsRaw: JSON.stringify(args),
    arguments: args,
  };
}

describe('tool-call validation against @redai/contracts', () => {
  it('accepts arguments that satisfy the contract schema', () => {
    const result = validateToolCall('tool-input.FileRead', call({ path: '/x', max_bytes: 10 }));
    expect(result.ok).toBe(true);
    expect(isToolArgsValid('tool-input.FileRead', { path: '/x', max_bytes: 10 })).toBe(true);
  });

  it('rejects arguments missing a required field (do-not-dispatch)', () => {
    const result = validateToolCall('tool-input.FileRead', call({ path: '/x' }));
    expect(result.ok).toBe(false);
    expect(isToolArgsValid('tool-input.FileRead', { path: '/x' })).toBe(false);
  });

  it('rejects unknown/extra fields (additionalProperties:false)', () => {
    const result = validateToolCall(
      'tool-input.FileRead',
      call({ path: '/x', max_bytes: 10, evil: true }),
    );
    expect(result.ok).toBe(false);
  });
});
