/**
 * Typed wrappers over the real API routes (see apps/api/src/<area>/plugin.ts). Each
 * function maps 1:1 to an endpoint so screens stay declarative and no route
 * string is duplicated across the app.
 */
import { apiRequest, setCsrfToken } from './api';
import type {
  Artifact,
  Chat,
  CreateRunResponse,
  ListResponse,
  Message,
  Note,
  Project,
  ProviderConfig,
  RunStatus,
  SecretMetadata,
  SessionProfile,
  WorkerBinding,
  WorkspaceSettings,
} from './types';

// --- auth -------------------------------------------------------------------

export async function getSession(): Promise<SessionProfile> {
  const profile = await apiRequest<SessionProfile>('/api/v1/auth/session');
  setCsrfToken(profile.csrf_token);
  return profile;
}

export async function login(username: string, password: string): Promise<SessionProfile> {
  const profile = await apiRequest<SessionProfile>('/api/v1/auth/login', {
    method: 'POST',
    body: { username, password },
  });
  setCsrfToken(profile.csrf_token);
  return profile;
}

export async function logout(): Promise<void> {
  await apiRequest<void>('/api/v1/auth/logout', { method: 'POST' });
  setCsrfToken(null);
}

// --- projects ---------------------------------------------------------------

export function listProjects(cursor?: string): Promise<ListResponse<Project>> {
  const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return apiRequest<ListResponse<Project>>(`/api/v1/projects${q}`);
}

export function getInbox(): Promise<Project> {
  return apiRequest<Project>('/api/v1/projects/inbox');
}

export function getProject(id: string): Promise<Project> {
  return apiRequest<Project>(`/api/v1/projects/${id}`);
}

export function createProject(input: {
  name: string;
  description?: string;
  approval_mode?: string;
  data_mode?: string;
}): Promise<Project> {
  return apiRequest<Project>('/api/v1/projects', { method: 'POST', body: input });
}

export function updateProject(
  id: string,
  expectedRevision: number,
  patch: {
    name?: string;
    description?: string | null;
    approval_mode?: string;
    data_mode?: string;
  },
): Promise<Project> {
  return apiRequest<Project>(`/api/v1/projects/${id}`, {
    method: 'PATCH',
    body: { expected_revision: expectedRevision, ...patch },
  });
}

export function archiveProject(id: string): Promise<Project> {
  return apiRequest<Project>(`/api/v1/projects/${id}/archive`, { method: 'POST' });
}

export function unarchiveProject(id: string): Promise<Project> {
  return apiRequest<Project>(`/api/v1/projects/${id}/unarchive`, { method: 'POST' });
}

// --- chats ------------------------------------------------------------------

export function listChats(projectId: string, cursor?: string): Promise<ListResponse<Chat>> {
  const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return apiRequest<ListResponse<Chat>>(`/api/v1/projects/${projectId}/chats${q}`);
}

export function createChat(
  projectId: string,
  input: { title?: string; pinned?: boolean },
): Promise<Chat> {
  return apiRequest<Chat>(`/api/v1/projects/${projectId}/chats`, {
    method: 'POST',
    body: input,
  });
}

export function getChat(projectId: string, chatId: string): Promise<Chat> {
  return apiRequest<Chat>(`/api/v1/projects/${projectId}/chats/${chatId}`);
}

// --- runs & messages --------------------------------------------------------

export interface CreateRunInput {
  clientMessageId: string;
  idempotencyKey: string;
  providerConfigId: string;
  text: string;
  artifactIds?: string[];
  dataMode?: string;
}

/**
 * Create an Ask run for a chat. The `Idempotency-Key` header is REQUIRED (a fresh
 * UUID per user send) so a double-submit dedupes to a single run (docs/06 §4). The
 * body's `mode` is fixed to `ask`; Agent runs return 501 in this milestone.
 */
export function createRun(
  projectId: string,
  chatId: string,
  input: CreateRunInput,
): Promise<CreateRunResponse> {
  return apiRequest<CreateRunResponse>(`/api/v1/projects/${projectId}/chats/${chatId}/runs`, {
    method: 'POST',
    headers: { 'idempotency-key': input.idempotencyKey },
    body: {
      chat_id: chatId,
      client_message_id: input.clientMessageId,
      text: input.text,
      mode: 'ask',
      provider_config_id: input.providerConfigId,
      ...(input.artifactIds && input.artifactIds.length > 0
        ? { artifact_ids: input.artifactIds }
        : {}),
      ...(input.dataMode ? { data_mode: input.dataMode } : {}),
    },
  });
}

export function getRun(projectId: string, runId: string): Promise<RunStatus> {
  return apiRequest<RunStatus>(`/api/v1/projects/${projectId}/runs/${runId}`);
}

export function listMessages(
  projectId: string,
  chatId: string,
  cursor?: string,
): Promise<ListResponse<Message>> {
  const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return apiRequest<ListResponse<Message>>(
    `/api/v1/projects/${projectId}/chats/${chatId}/messages${q}`,
  );
}

// --- notes ------------------------------------------------------------------

export function listNotes(projectId: string): Promise<ListResponse<Note>> {
  return apiRequest<ListResponse<Note>>(`/api/v1/projects/${projectId}/notes`);
}

export function createNote(
  projectId: string,
  input: { title: string; content: string; selected_for_context?: boolean },
): Promise<Note> {
  return apiRequest<Note>(`/api/v1/projects/${projectId}/notes`, {
    method: 'POST',
    body: input,
  });
}

// --- artifacts --------------------------------------------------------------

export function listArtifacts(projectId: string): Promise<ListResponse<Artifact>> {
  return apiRequest<ListResponse<Artifact>>(`/api/v1/projects/${projectId}/artifacts`);
}

// --- worker bindings --------------------------------------------------------

export function listBindings(projectId: string): Promise<ListResponse<WorkerBinding>> {
  return apiRequest<ListResponse<WorkerBinding>>(`/api/v1/projects/${projectId}/workers`);
}

// --- settings ---------------------------------------------------------------

export function getSettings(): Promise<WorkspaceSettings> {
  return apiRequest<WorkspaceSettings>('/api/v1/settings');
}

export function updateSettings(
  expectedRevision: number,
  settings: Record<string, unknown>,
): Promise<WorkspaceSettings> {
  return apiRequest<WorkspaceSettings>('/api/v1/settings', {
    method: 'PUT',
    body: { expected_revision: expectedRevision, settings },
  });
}

export function listProviders(): Promise<ListResponse<ProviderConfig>> {
  return apiRequest<ListResponse<ProviderConfig>>('/api/v1/settings/providers');
}

export function createProvider(input: {
  display_name: string;
  config: Record<string, unknown>;
  enabled?: boolean;
  api_key?: string;
  credential_ref?: string | null;
}): Promise<ProviderConfig> {
  return apiRequest<ProviderConfig>('/api/v1/settings/providers', {
    method: 'POST',
    body: input,
  });
}

export function updateProvider(
  id: string,
  expectedRevision: number,
  patch: { display_name?: string; config?: Record<string, unknown>; enabled?: boolean },
): Promise<ProviderConfig> {
  return apiRequest<ProviderConfig>(`/api/v1/settings/providers/${id}`, {
    method: 'PATCH',
    body: { expected_revision: expectedRevision, ...patch },
  });
}

export function listSecrets(): Promise<ListResponse<SecretMetadata>> {
  return apiRequest<ListResponse<SecretMetadata>>('/api/v1/settings/secrets');
}

export function revokeSecret(id: string): Promise<void> {
  return apiRequest<void>(`/api/v1/settings/secrets/${id}`, { method: 'DELETE' });
}
