CREATE SCHEMA IF NOT EXISTS conference_desk;
REVOKE ALL ON SCHEMA conference_desk FROM PUBLIC;

CREATE TABLE IF NOT EXISTS conference_desk.workspace_state (
  id smallint PRIMARY KEY CHECK (id = 1),
  workspace jsonb NOT NULL CHECK (jsonb_typeof(workspace) = 'object'),
  secret_box text NOT NULL CHECK (secret_box LIKE 'v1:%'),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
);

REVOKE ALL ON TABLE conference_desk.workspace_state FROM PUBLIC;
ALTER TABLE conference_desk.workspace_state ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE api_role text;
BEGIN
  FOR api_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
    EXECUTE format('REVOKE ALL ON SCHEMA conference_desk FROM %I', api_role);
    EXECUTE format('REVOKE ALL ON TABLE conference_desk.workspace_state FROM %I', api_role);
  END LOOP;
END $$;
