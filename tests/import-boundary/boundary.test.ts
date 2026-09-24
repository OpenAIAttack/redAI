import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'dist' || entry === 'node_modules') continue;
      out.push(...tsFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Modules a pure package must never depend on. */
const FORBIDDEN = [
  /\bfrom\s+['"]fastify['"]/,
  /\bfrom\s+['"]next(\/|['"])/,
  /\bfrom\s+['"]react(\/|['"])/,
  /\bfrom\s+['"]pg['"]/,
  /\bfrom\s+['"]dockerode['"]/,
  /\bfrom\s+['"]openai['"]/,
  /\bfrom\s+['"]@redai\/(db|llm|storage)['"]/,
  /\bfrom\s+['"][^'"]*apps\//,
];

const PURE_PACKAGES = ['packages/domain', 'packages/policy'];

describe('architecture import boundaries', () => {
  for (const pkg of PURE_PACKAGES) {
    it(`${pkg} imports no HTTP/UI/DB/provider modules`, () => {
      const files = tsFiles(join(repoRoot, pkg, 'src')).filter((f) => !f.endsWith('.test.ts'));
      expect(files.length).toBeGreaterThan(0);
      const violations: string[] = [];
      for (const file of files) {
        const text = readFileSync(file, 'utf8');
        for (const rx of FORBIDDEN) {
          if (rx.test(text)) violations.push(`${file} matches ${rx}`);
        }
      }
      expect(violations, violations.join('\n')).toEqual([]);
    });
  }
});
