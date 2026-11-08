ALTER TABLE conference_desk.workspace_state
  ADD COLUMN IF NOT EXISTS desk_lease_token uuid,
  ADD COLUMN IF NOT EXISTS desk_lease_expires_at timestamptz;

CREATE OR REPLACE FUNCTION public.desk_read_state()
RETURNS jsonb
LANGUAGE sql STABLE
SECURITY DEFINER SET search_path = ''
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'workspace', state.workspace, 'secret_box', state.secret_box, 'revision', state.revision::text
  )
  FROM conference_desk.workspace_state AS state WHERE state.id = 1;
$$;

CREATE OR REPLACE FUNCTION public.desk_claim_state(p_token uuid, p_initial_workspace jsonb, p_initial_box text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE snapshot jsonb;
BEGIN
  IF p_token IS NULL OR NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('conference_desk.workspace_state', 0)
  ) THEN
    RETURN NULL;
  END IF;

  INSERT INTO conference_desk.workspace_state (id, workspace, secret_box)
  VALUES (1, p_initial_workspace, p_initial_box)
  ON CONFLICT (id) DO NOTHING;

  UPDATE conference_desk.workspace_state AS state
  SET desk_lease_token = p_token,
      desk_lease_expires_at = pg_catalog.clock_timestamp() + interval '120 seconds'
  WHERE state.id = 1
    AND (state.desk_lease_token IS NULL OR state.desk_lease_expires_at <= pg_catalog.clock_timestamp())
  RETURNING pg_catalog.jsonb_build_object(
    'workspace', state.workspace,
    'secret_box', state.secret_box,
    'revision', state.revision::text
  ) INTO snapshot;

  RETURN snapshot;
END;
$$;

CREATE OR REPLACE FUNCTION public.desk_commit_state(p_token uuid, p_revision bigint, p_workspace jsonb, p_box text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE next_revision text;
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('conference_desk.workspace_state', 0)
  ) THEN
    RETURN NULL;
  END IF;

  UPDATE conference_desk.workspace_state AS state
  SET workspace = p_workspace, secret_box = p_box, revision = state.revision + 1
  WHERE state.id = 1 AND state.desk_lease_token = p_token
    AND state.desk_lease_expires_at > pg_catalog.clock_timestamp()
    AND state.revision = p_revision
  RETURNING state.revision::text INTO next_revision;

  RETURN next_revision;
END;
$$;

CREATE OR REPLACE FUNCTION public.desk_release_state(p_token uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER SET search_path = ''
AS $$
  UPDATE conference_desk.workspace_state
  SET desk_lease_token = NULL, desk_lease_expires_at = NULL
  WHERE id = 1 AND desk_lease_token = p_token;
$$;

REVOKE ALL ON FUNCTION public.desk_read_state() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.desk_claim_state(uuid, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.desk_commit_state(uuid, bigint, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.desk_release_state(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.desk_read_state() TO service_role;
GRANT EXECUTE ON FUNCTION public.desk_claim_state(uuid, jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.desk_commit_state(uuid, bigint, jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.desk_release_state(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
