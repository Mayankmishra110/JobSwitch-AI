-- 0016 · migration 0015 granted app_matcher DELETE on resume_source and
-- resume_artifact but not SELECT, and Postgres requires SELECT on any
-- column read by a DELETE's WHERE clause (here, account_id) in addition to
-- DELETE itself - a real, previously-undiscovered gap, caught by
-- TestFindDormantActiveSessionsAndSweep actually exercising
-- SweepDormantSession's purge loop against real Postgres, not by
-- inspection. resume_upload/job_application/match_explanation didn't need
-- this fix because each already had SELECT from an earlier migration
-- (0013, 0012, 0011 respectively); resume_source and resume_artifact never
-- had any app_matcher grant before 0015.
GRANT SELECT ON resume_source TO app_matcher;
GRANT SELECT ON resume_artifact TO app_matcher;
