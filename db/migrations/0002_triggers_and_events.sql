-- redAI migration 0002_triggers_and_events
-- Derived from db/001_reference_schema.sql lines 715-754 (immutable-row triggers + redai_append_event helper).
-- No BEGIN/COMMIT here: the migration runner wraps each file in a single transaction.

-- Immutable versions can be deleted only through controlled purge; updates are prohibited.
CREATE FUNCTION redai_reject_version_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable version: %', TG_TABLE_NAME USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER scope_version_immutable BEFORE UPDATE ON scope_versions
  FOR EACH ROW EXECUTE FUNCTION redai_reject_version_update();
CREATE TRIGGER finding_version_immutable BEFORE UPDATE ON finding_versions
  FOR EACH ROW EXECUTE FUNCTION redai_reject_version_update();

CREATE FUNCTION redai_protect_artifact_payload() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('ready', 'deleting', 'deleted') AND
     (NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.byte_size IS DISTINCT FROM OLD.byte_size
      OR NEW.storage_key IS DISTINCT FROM OLD.storage_key OR NEW.project_id IS DISTINCT FROM OLD.project_id
      OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id) THEN
    RAISE EXCEPTION 'immutable finalized artifact payload' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER artifact_payload_immutable BEFORE UPDATE ON artifacts
  FOR EACH ROW EXECUTE FUNCTION redai_protect_artifact_payload();

-- This allocates an event cursor under a row lock retained until COMMIT.
-- The caller MUST invoke it within the same transaction as the business mutation.
CREATE FUNCTION redai_append_event(p_workspace uuid, p_project uuid, p_run uuid,
  p_type text, p_payload jsonb) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE result_id bigint;
BEGIN
  INSERT INTO event_counters(workspace_id) VALUES (p_workspace) ON CONFLICT DO NOTHING;
  UPDATE event_counters SET next_event_id = next_event_id + 1
    WHERE workspace_id = p_workspace RETURNING next_event_id - 1 INTO result_id;
  INSERT INTO events(workspace_id, event_id, project_id, run_id, event_type, payload)
    VALUES (p_workspace, result_id, p_project, p_run, p_type, p_payload);
  PERFORM pg_notify('redai_events', p_workspace::text);
  RETURN result_id;
END;
$$;
