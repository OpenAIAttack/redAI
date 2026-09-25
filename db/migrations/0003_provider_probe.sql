-- Derived evidence is separate from owner-editable config capability declarations.
ALTER TABLE provider_configs ADD COLUMN probe_result jsonb;
ALTER TABLE provider_configs ADD COLUMN probe_attempt_id uuid;
