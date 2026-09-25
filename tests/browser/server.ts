/** Isolated browser fixture: real API, migrations, auth, vault and PostgreSQL. */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase } from '../integration/db/support.js';
import { AuthService, createDbAuthRepository } from '../../packages/application/src/index.js';
import { buildServer } from '../../apps/api/src/server.js';
import { modelFixture } from './modelFixture.js';
import { loadApiEnv } from '../../apps/api/src/env.js';
const db = await createTestDatabase();
const root = await mkdtemp(join(tmpdir(), 'redai-browser-'));
const store = join(root, 'objects');
await mkdir(store);
const keyPath = join(root, 'master.key');
await writeFile(keyPath, randomBytes(32), { mode: 0o600 });
process.env.REDAI_MASTER_KEY_FILE = keyPath;
const auth = new AuthService({ repo: createDbAuthRepository(db.pool) });
await auth.bootstrapOwner({ username: 'browser-owner', password: 'synthetic-browser-password' });
const model = modelFixture();
await new Promise<void>((resolve, reject) => {
  model.once('error', reject);
  model.listen(8790, '127.0.0.1', resolve);
});
process.env.REDAI_LOCAL_MODEL_BASE_URLS = 'http://127.0.0.1:8790/v1';
const app = buildServer({
  env: loadApiEnv({
    NODE_ENV: 'test',
    DATABASE_URL: db.url,
    OBJECT_STORE_ROOT: store,
    API_ALLOWED_ORIGINS: 'http://127.0.0.1:3008',
    API_PORT: '8789',
  }),
});
let closing = false;
async function cleanup() {
  if (closing) return;
  closing = true;
  await app.close();
  model.closeAllConnections();
  await new Promise<void>((resolve) => model.close(() => resolve()));
  await db.drop();
  await rm(root, { recursive: true, force: true });
}
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    void cleanup().then(() => process.exit(0));
  });
try {
  await app.listen({ host: '127.0.0.1', port: 8789 });
} catch (error) {
  await cleanup();
  throw error;
}
