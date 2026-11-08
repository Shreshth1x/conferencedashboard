CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS supabase_vault;

-- Configure the desk_project_url and desk_cron_secret names in Vault after deploying the function.
CREATE OR REPLACE FUNCTION conference_desk.dispatch_due_work()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  due_at timestamptz := pg_catalog.clock_timestamp();
  due_iso text := pg_catalog.to_char(due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  recent_iso text := pg_catalog.to_char((due_at - interval '14 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  project_url text;
  cron_secret text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM conference_desk.workspace_state AS state
    WHERE state.id = 1
      AND (state.desk_lease_token IS NULL OR state.desk_lease_expires_at <= due_at)
      AND (
        EXISTS (
          SELECT 1 FROM pg_catalog.jsonb_array_elements(state.workspace->'queue') AS item
          WHERE item->>'status' IN ('scheduled', 'sending') AND item->>'scheduledAt' <= due_iso
        ) OR EXISTS (
          SELECT 1 FROM pg_catalog.jsonb_array_elements(state.workspace->'jobs') AS job
          WHERE job->>'status' = 'running'
        ) OR EXISTS (
          SELECT 1 FROM pg_catalog.jsonb_array_elements(state.workspace->'apolloRuns') AS run
          CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(run->'recipients') AS recipient
          WHERE recipient->>'status' IN ('queued', 'submitting')
             OR (recipient->>'status' = 'pending' AND CASE pg_catalog.jsonb_typeof(recipient->'nextCheckAt')
               WHEN 'number' THEN (recipient->>'nextCheckAt')::numeric <= EXTRACT(epoch FROM due_at) * 1000
               ELSE true END)
        ) OR (
          EXTRACT(minute FROM due_at)::integer % 5 = 0 AND (
            EXISTS (
              SELECT 1 FROM pg_catalog.jsonb_array_elements(state.workspace->'queue') AS item
              WHERE (item->>'status' = 'sent' AND item->>'sentAt' >= recent_iso)
                 OR (item->>'status' = 'failed' AND item ? 'sendingAt')
            ) OR EXISTS (
              SELECT 1 FROM pg_catalog.jsonb_array_elements(state.workspace->'conferences') AS event
              CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(event->'contacts') AS person
              WHERE person->'sentAt' IS NULL AND (person->'draft' ? 'gmailId')
            )
          )
        )
      )
  ) THEN
    RETURN;
  END IF;

  SELECT decrypted_secret INTO project_url FROM vault.decrypted_secrets WHERE name = 'desk_project_url';
  SELECT decrypted_secret INTO cron_secret FROM vault.decrypted_secrets WHERE name = 'desk_cron_secret';
  IF project_url IS NULL OR project_url !~ '^https://[a-z0-9]+\.supabase\.co$'
    OR cron_secret IS NULL OR pg_catalog.length(cron_secret) < 32 THEN
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := project_url || '/functions/v1/desk/cron',
    headers := pg_catalog.jsonb_build_object('Content-Type', 'application/json', 'x-desk-cron', cron_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 90000
  );
END;
$$;

REVOKE ALL ON FUNCTION conference_desk.dispatch_due_work() FROM PUBLIC, anon, authenticated, service_role;

SELECT cron.schedule('conference-desk-worker', '* * * * *', 'SELECT conference_desk.dispatch_due_work()');
