/**
 * redAI owner password-reset CLI (host recovery path). Run at the host when the
 * password is lost.
 *
 *   printf '%s\n%s' 'RECOVERY-CODE' 'new-password' | DATABASE_URL=… \
 *     pnpm exec tsx ops/bootstrap/reset.ts
 *
 * On a piped stdin the first line is the recovery code and the second the new
 * password. On an interactive TTY the recovery code is prompted, then the new
 * password with echo disabled. Neither secret is printed or logged; the rotated
 * recovery code is written to stdout once. Exit codes: 0 reset, 1 failure, 2 config.
 */
import { createInterface } from 'node:readline';
import { createPool } from '../../packages/db/src/index.js';
import { runReset } from './runReset.js';

function readAllStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function promptVisible(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function promptHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const asMutable = rl as unknown as { _writeToOutput?: (s: string) => void };
    const original = asMutable._writeToOutput?.bind(rl);
    let muted = false;
    asMutable._writeToOutput = (s: string): void => {
      if (!muted || s.includes('\n') || s.includes('\r')) original?.(s);
    };
    process.stdout.write(prompt);
    muted = true;
    rl.question('', (answer) => {
      muted = false;
      process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    process.stderr.write('DATABASE_URL is required to reset the owner password.\n');
    process.exit(2);
    return;
  }

  let readRecoveryCode: () => Promise<string>;
  let readNewPassword: () => Promise<string>;
  if (process.stdin.isTTY) {
    readRecoveryCode = () => promptVisible('Recovery code: ');
    readNewPassword = () => promptHidden('New owner password: ');
  } else {
    const buffered = readAllStdin();
    const lines = buffered.then((raw) => raw.split(/\r?\n/));
    readRecoveryCode = async () => (await lines)[0] ?? '';
    readNewPassword = async () => (await lines)[1] ?? '';
  }

  const pool = createPool({ connectionString: databaseUrl, applicationName: 'redai-reset' });
  try {
    const outcome = await runReset({
      pool,
      readRecoveryCode,
      readNewPassword,
      output: (line) => process.stdout.write(`${line}\n`),
    });
    if (outcome.status !== 'reset') {
      const messages: Record<string, string> = {
        not_bootstrapped: 'No owner exists yet; bootstrap first.',
        invalid_recovery: 'Recovery code is invalid.',
        weak_password: 'New password does not meet the minimum length.',
      };
      process.stderr.write(`${messages[outcome.status] ?? 'Reset failed.'}\n`);
      process.exitCode = 1;
    }
  } catch (err) {
    process.stderr.write(`reset failed: ${(err as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
