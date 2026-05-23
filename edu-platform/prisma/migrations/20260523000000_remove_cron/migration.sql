-- Drop cron feature tables (safe: no other tables reference these)
DROP TABLE IF EXISTS "cron_job_runs";
DROP TABLE IF EXISTS "cron_jobs";
