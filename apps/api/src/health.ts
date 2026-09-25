import { randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { computeReadiness, type ComponentCheck, type ReadinessResult } from '@redai/domain';
import { assertNoSymlink } from '@redai/storage';
import type { ApiEnv } from './env.js';

export interface ReadinessProbes {
  database: () => Promise<boolean>;
  objectStore: () => Promise<boolean>;
}

/** Verify write/fsync/atomic rename/read/delete on the configured, existing root.
 * Never create a missing root silently or publish artifact bytes from this probe.
 */
export async function probeObjectStore(root: string): Promise<boolean> {
  const file = join(resolve(root), `.health-${randomUUID()}`);
  const finalized = `${file}.ready`;
  const bytes = randomUUID();
  try {
    await assertNoSymlink(root, file);
    const handle = await open(file, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(file, finalized);
    return (await readFile(finalized, 'utf8')) === bytes;
  } catch {
    return false;
  } finally {
    await Promise.all([unlink(file).catch(() => {}), unlink(finalized).catch(() => {})]);
  }
}

async function bounded(probe: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(probe)
        .catch(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function checkReadiness(
  env: ApiEnv,
  probes: ReadinessProbes,
  timeoutMs = 1500,
): Promise<ReadinessResult> {
  const [database, objectStore] = await Promise.all([
    env.databaseUrl ? bounded(probes.database, timeoutMs) : false,
    env.objectStoreRoot ? bounded(probes.objectStore, timeoutMs) : false,
  ]);
  const components: ComponentCheck[] = [
    { name: 'database', required: true, configured: !!env.databaseUrl, healthy: database },
    {
      name: 'object_store',
      required: true,
      configured: !!env.objectStoreRoot,
      healthy: objectStore,
    },
    // Configured is not probed. No paid model calls are triggered by a health GET.
    {
      name: 'model_provider',
      required: false,
      configured: env.modelProviderConfigured,
      healthy: false,
    },
  ];
  return computeReadiness(components);
}
