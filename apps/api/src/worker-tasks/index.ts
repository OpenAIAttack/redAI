/**
 * Barrel for the worker TASK plane plugin (T17). The coordinator imports
 * `registerWorkerTasks` in `server.ts` and injects the concrete `ExecutionService`
 * (built from the installation Ed25519 signer) plus the storage input-artifact reader.
 */
export { registerWorkerTasks } from './plugin.js';
export type {
  WorkerTasksPluginDeps,
  ExecutionApi,
  WorkerScope,
  WorkerTaskContext,
  TaskEnvelope,
  RenewResult,
  ResultAck,
  SubmitResultInput,
  InputArtifactReader,
} from './plugin.js';
