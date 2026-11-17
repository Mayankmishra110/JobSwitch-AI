-- 0015 · app_matcher needs to run the D-31 dormancy sweep for real.
--
-- Found by testing against real Postgres, the same way the BYPASSRLS gap
-- in specs/matching-pipeline.md was: internal/repo.ActiveJobSearchAccountIDs
-- and the new FindDormantActiveSessions/SweepDormantSession (Phase 5.3's
-- cmd/worker scheduled-tasks loop) had never actually been exercised
-- against a real app_matcher role before, because nothing called them
-- outside a test until now. The first real run failed immediately with
-- "permission denied for table job_search_session" - app_matcher had
-- never been granted anything on it (only app_web was, migration 0009).
--
-- job_search_session: SELECT to find active/dormant accounts, UPDATE to
-- mark a dormant one 'stopped' - never INSERT (the matcher never starts a
-- search) or DELETE (a session row is retained, per D-31, not removed).
GRANT SELECT, UPDATE ON job_search_session TO app_matcher;

-- The sweep hard-deletes the same purge targets
-- packages/db/src/repositories/jobSearch.ts's stopJobSearch does, but the
-- matcher-worker performs the scheduled half of that purge itself
-- (internal/repo.SweepDormantSession) rather than calling back into
-- apps/web - so it needs its own DELETE grants, DELETE only, on whichever
-- of these it didn't already hold:
--   - resume_upload:    had SELECT only (0013, for embed.profile) - not enough to purge.
--   - resume_source:    had no grant at all.
--   - resume_artifact:  had no grant at all.
--   - job_application:  had SELECT only (0012, to avoid duplicating a tracked posting) - not enough to purge.
--   - match_explanation: had SELECT/INSERT/UPDATE (0011) - not enough to purge.
-- job_match already has DELETE from migration 0011 - not repeated here.
GRANT DELETE ON resume_upload TO app_matcher;
GRANT DELETE ON resume_source TO app_matcher;
GRANT DELETE ON resume_artifact TO app_matcher;
GRANT DELETE ON job_application TO app_matcher;
GRANT DELETE ON match_explanation TO app_matcher;
