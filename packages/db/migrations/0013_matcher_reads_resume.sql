-- 0013 · app_matcher needs SELECT on resume_upload to embed it
-- (embed.profile handler, Phase 5.3's second embedding worker).
--
-- Same shape as 0012_matcher_reads_applications.sql's grant on
-- job_application: SELECT only, deliberately. The matcher reads resume
-- text to compute profile_embedding's 'resume' kind; it must never write,
-- update, or delete resume_upload itself - that table's own D-31 purge
-- (DELETE) stays exclusively app_web's job, exercised only through
-- packages/db/src/repositories/jobSearch.ts's stopJobSearch.
GRANT SELECT ON resume_upload TO app_matcher;
