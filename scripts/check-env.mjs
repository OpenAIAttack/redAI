#!/usr/bin/env node
// Environment validation for redAI dev/CI.
// Verifies pinned toolchain majors from docs/dependency-baseline.md.
// Exit non-zero if a REQUIRED tool is missing or the major is incompatible.
// gVisor (runsc) is only WARNED about: it blocks the execution lab, not scaffold/DB/mocks.

import { execFileSync } from 'node:child_process';

let failed = false;

function tryVersion(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function requireMajor(label, actual, extract, min, max) {
  if (actual === null) {
    console.error(`✗ ${label}: not found (required)`);
    failed = true;
    return;
  }
  const m = extract.exec(actual);
  const major = m ? Number(m[1]) : NaN;
  if (Number.isNaN(major) || major < min || (max !== undefined && major > max)) {
    console.error(
      `✗ ${label}: ${actual} (need major ${min}${max !== undefined ? `–${max}` : '+'})`,
    );
    failed = true;
    return;
  }
  console.log(`✓ ${label}: ${actual}`);
}

requireMajor('Node.js', process.version, /v(\d+)\./, 22, 22);
requireMajor('pnpm', tryVersion('pnpm', ['-v']), /(\d+)\./, 10, 10);
requireMajor('Go', tryVersion('go', ['version']), /go(\d+)\.(\d+)/, 1, 1);
requireMajor('PostgreSQL client', tryVersion('psql', ['--version']), /(\d+)\./, 16);

const runsc = tryVersion('runsc', ['--version']);
if (runsc === null) {
  console.warn(
    '⚠ gVisor (runsc): not found — execution/sandbox lab (T18/T19/T29) blocked; scaffold/DB/mocks unaffected.',
  );
} else {
  console.log(`✓ gVisor: ${runsc.split('\n')[0]}`);
}

if (failed) {
  console.error('\nEnvironment check FAILED. See docs/dependency-baseline.md for pinned versions.');
  process.exit(1);
}
console.log('\nEnvironment check passed.');
