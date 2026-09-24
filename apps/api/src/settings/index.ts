/**
 * apps/api settings barrel. `registerSettings` wires the Fastify routes; the
 * coordinator composes the concrete `SettingsService` and adapts the auth plugin's
 * session validation into the injected {@link SettingsAuth} guard when registering.
 */
export { registerSettings } from './plugin.js';
export type {
  SettingsPluginDeps,
  SettingsServicePort,
  SettingsAuth,
  OwnerAuthContext,
} from './plugin.js';
export {
  parseCreateProviderConfig,
  parseUpdateProviderConfig,
  parseUpdateSettings,
  BodyValidationError,
  CREATE_PROVIDER_CONFIG_SCHEMA,
  UPDATE_PROVIDER_CONFIG_SCHEMA,
  UPDATE_SETTINGS_SCHEMA,
} from './bodySchemas.js';
export type {
  CreateProviderConfigBody,
  UpdateProviderConfigBody,
  UpdateSettingsBody,
} from './bodySchemas.js';
