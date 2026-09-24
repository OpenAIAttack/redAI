import { describe, it, expect } from 'vitest';
import { vi } from './vi';
import { en } from './en';

/**
 * Every language must define exactly the same keys so a missing translation is a
 * build/test failure, not a runtime blank. (The `en: Messages` annotation already
 * enforces this at type level; this guards the runtime shape too.)
 */
function keyPaths(obj: Record<string, unknown>, prefix = ''): string[] {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') {
      paths.push(...keyPaths(value as Record<string, unknown>, path));
    } else {
      paths.push(path);
    }
  }
  return paths.sort();
}

describe('i18n catalogs', () => {
  it('vi and en have identical key sets', () => {
    expect(keyPaths(en)).toEqual(keyPaths(vi));
  });

  it('every leaf is a non-empty string', () => {
    for (const catalog of [vi, en]) {
      for (const path of keyPaths(catalog as Record<string, unknown>)) {
        const value = path
          .split('.')
          .reduce<unknown>((acc, k) => (acc as Record<string, unknown>)[k], catalog);
        expect(typeof value).toBe('string');
        expect((value as string).length).toBeGreaterThan(0);
      }
    }
  });
});
