import { InvalidSettingsError } from './errors.js';

/** Reject known secret fields and immutable security switches before JSON persistence.
 * This validates settings metadata; it does not claim to detect arbitrary secrets in prose.
 */
export function validatePublicSettings(value: unknown, depth = 0): void {
  if (depth > 16) throw new InvalidSettingsError('Settings nesting is too deep.');
  if (Array.isArray(value)) {
    for (const v of value) validatePublicSettings(v, depth + 1);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replace(/[_-]/g, '').toLowerCase();
    if (
      [
        'apikey',
        'password',
        'secret',
        'secretvalue',
        'token',
        'authorization',
        'cookie',
        'privatekey',
        'masterkey',
        'workertoken',
        'securityinvariants',
        'disablecsrf',
        'disableauth',
        'allowunrestrictednetwork',
        'sandboxruntime',
      ].includes(normalized)
    ) {
      throw new InvalidSettingsError(
        'Secret fields and immutable security settings are not accepted here.',
      );
    }
    validatePublicSettings(child, depth + 1);
  }
}
export function validateApiKey(value: string): void {
  if (
    !value.trim() ||
    /^(\*+|•+|<[^>]+>|\$\{[^}]+\}|your[-_ ].*|replace[-_ ].*|changeme)$/i.test(value.trim())
  ) {
    throw new InvalidSettingsError('Provide a real key value, not a masked placeholder.');
  }
}
