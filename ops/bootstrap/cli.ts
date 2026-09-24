/**
 * redAI owner bootstrap CLI — run at the host, once, to create the singleton owner.
 *
 *   DATABASE_URL=postgres://… pnpm exec tsx ops/bootstrap/cli.ts [--username NAME] [--workspace NAME]
 *   printf '%s' 'the-password' | DATABASE_URL=… pnpm exec tsx ops/bootstrap/cli.ts
 *
 * The password is read ONLY from stdin (never argv or env): piped input is read as
 * the first line; on an interactive TTY it is prompted with echo disabled. The
 * password is never printed or logged. On success the one-time recovery code is
 * written to stdout. Refuses (exit 1) if an owner already exists.
 */
import { createInterface } from 'node:readline';
import { createPool } from '../../packages/db/src/index.js';
import { runBootstrap } from './runBootstrap.js';

interface CliArgs {
  username?: string;
  workspace?: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--username' && value !== undefined) {
      args.username = value;
      i += 1;
    } else if (flag === '--workspace' && value !== undefined) {
      args.workspace = value;
      i += 1;
    }
  }
  return args;
}

function readPipedStdin(): Promise<string> {
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

async function readPassword(): Promise<string> {
  const raw = process.stdin.isTTY
    ? await promptHidden('Initial owner password: ')
    : await readPipedStdin();
  // Take the first line only, and strip a trailing CR/LF from a piped echo.
  const firstLine = raw.split(/\r?\n/, 1)[0] ?? '';
  return firstLine;
}

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    process.stderr.write('DATABASE_URL is required to bootstrap the owner.\n');
    process.exit(2);
    return;
  }

  const args = parseArgs(process.argv.slice(2));
  const pool = createPool({ connectionString: databaseUrl, applicationName: 'redai-bootstrap' });
  try {
    const outcome = await runBootstrap({
      pool,
      readPassword,
      output: (line) => process.stdout.write(`${line}\n`),
      ...(args.username !== undefined ? { username: args.username } : {}),
      ...(args.workspace !== undefined ? { workspaceName: args.workspace } : {}),
    });
    if (outcome.status === 'already_exists') {
      process.stderr.write('An owner already exists; refusing to create a second owner.\n');
      process.exitCode = 1;
    }
  } catch (err) {
    // Message only — never the password/recovery code.
    process.stderr.write(`bootstrap failed: ${(err as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
