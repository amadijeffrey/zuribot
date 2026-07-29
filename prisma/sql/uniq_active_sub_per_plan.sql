-- Defense-in-depth backstop for the duplicate-subscription race.
--
-- The app-level fix (atomic claim in handleInitialPayment) prevents the known
-- concurrent webhook + verify-on-demand race. This partial unique index makes it
-- physically impossible for a user to hold two live (ACTIVE/GRACE) subscriptions
-- for the same plan, regardless of any future code path or race.
--
-- Prisma's @@unique can't express a partial (WHERE-filtered) index, and this repo
-- uses `prisma db push`, so apply this manually once, e.g.:
--   psql "$DATABASE_URL" -f prisma/sql/uniq_active_sub_per_plan.sql
--
-- NOTE: run AFTER de-duplicating any existing rows, or the CREATE will fail.
--   Find dupes:
--     SELECT user_id, plan_id, count(*) FROM subscriptions
--     WHERE status IN ('ACTIVE','GRACE') GROUP BY 1,2 HAVING count(*) > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_sub_per_plan
ON subscriptions (user_id, plan_id)
WHERE status IN ('ACTIVE', 'GRACE');
