-- 0012 · app_matcher needs to read job_application (Phase 5.2).
--
-- Found by testing, not by review: the Stage 1 hard-constraint prefilter
-- (services/matcher/internal/repo's PrefilterCandidates) excludes any
-- posting the candidate already tracks as an application - the same
-- "never re-surface what's already handled" rule job_match's own dismissed
-- exclusion follows. That query's NOT EXISTS against job_application
-- requires SELECT for whichever role runs it, and 0008 only granted
-- job_application to app_web, since app_matcher did not exist as a table
-- consumer yet at that point in the migration sequence.
--
-- SELECT only, deliberately: the matcher reads applications to avoid
-- duplicating a candidate's own tracked pipeline, and has no legitimate
-- reason to create, edit, or delete one - that stays app_web's job,
-- driven by the candidate's own action, not a batch process.

GRANT SELECT ON job_application TO app_matcher;
