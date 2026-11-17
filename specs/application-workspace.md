# Application workspace (Phase 7) and notification email (Phase 8)

The tracker, resume tailoring's human-facing half, outreach, and (Phase 8)
event-triggered notification email - all in `apps/web`. Schema for
`job_application`/`application_event`/`resume_source`/`resume_artifact`
already existed from Phase 5
(`packages/db/migrations/0008_tailoring_and_pipeline.sql`); Phase 7 is the
first application-layer code to read or write any of it, plus
`outreach_draft`/`email_credential` (new, migration `0017`). Phase 8 is
covered in its own section near the end of this file, since it's a small,
direct extension of Phase 7's own Gmail integration rather than a
separately-scoped feature.

## Two deliberate deviations from the build plan's literal contract

`docs/BUILD_PLAN.md`'s own endpoint table writes `POST
/applications/:id/tailor -> 202 {queueJobId}` and `POST
/artifacts/:id/compile {accepted[]} -> 202`. Both run **synchronously**
here instead - a real, considered choice, not a shortcut:

1. **Graph A and Graph B are single-response only** (`graph.ainvoke()`, not
   `graph.astream()`) - already a named, open gap in
   `specs/resume-tailoring.md`. A queued job + SSE progress bar promises
   granular "extracting JD... planning edits... checking provenance..."
   updates that don't exist yet; the honest version of that promise today
   is "started" and "done," which a synchronous POST already delivers with
   less machinery.
2. **Reinject + compile is "deterministic execution with no decision
   point"** - the build plan's own words for why PDF compilation isn't a
   LangGraph node. The same reasoning applies one layer up: there's nothing
   for a background worker to retry or coordinate that a direct call
   doesn't already handle.

Both routes still publish their D-26 event (`resume.tailoring.proposed`,
`resume.tailoring.compiled`) after the write commits, so the SSE bridge and
a future streaming upgrade have a real, already-correct integration point -
revisiting this later means swapping what runs *inside* the route for a
queue enqueue, not inventing new plumbing.

One consequence worth naming: **the tailor route holds no transaction open
across the AI call**. Everything the LLM needs (job context, the resume
template, candidate facts) is read and validated inside one `withAccount`
transaction; `application.status` flips to `'tailoring'` there; the actual
`aiClient.tailorResume()` call happens **outside** any transaction, and the
result (or failure) is persisted in a second, separate `withAccount` call.
A multi-second LLM call holding a pooled connection the whole time would
starve the pool under any real concurrent load - the same reasoning
`withAccount`'s own doc comment gives for why each request gets its own
short-lived transaction, applied to a slower operation.

## Endpoints

```
GET/POST   /api/v1/matches, /matches/:id/{dismiss,track}
GET/POST   /api/v1/applications, /applications/:id, PATCH .../:id
POST       /api/v1/applications/:id/tailor              (synchronous - see above)
GET        /api/v1/artifacts/:id
POST       /api/v1/artifacts/:id/compile  {accepted[]}   (synchronous - see above)
GET        /api/v1/artifacts/:id/pdf
POST       /api/v1/applications/:id/outreach
GET        /api/v1/outreach, /outreach/:id, PATCH /outreach/:id
POST       /api/v1/outreach/:id/{approve,send}            (send: compare-and-set, 409 if not approved)
GET/PUT    /api/v1/profile/resume-source, /resume-source/:variantId
GET/DELETE /api/v1/outreach/gmail/status  ...  /gmail  (Gmail link - see below)
```

`resume-source` routes are new this phase, under `/profile` rather than
`/applications` - a candidate's LaTeX template is personal data reused
across every application, the same reasoning `candidate_profile` itself
already follows, not something scoped to one tracked job.

## Matches: dismiss and track

`repositories/matches.ts` is read-only over `job_match` (written only by
`services/backend`) plus the two actions `app_web`'s own grant allows
(migration `0011`): `UPDATE (dismissed_at)` and reading enough to create a
`job_application`. "Track" is `createApplicationFromMatch` -
`ON CONFLICT (account_id, job_posting_id) ... DO NOTHING`, so tracking the
same match twice is a safe, idempotent no-op that returns the existing
application rather than a constraint-violation 500.

## The tailor route: assembling facts, calling services/ai directly

`apps/web` calls `services/ai`'s `POST /v1/tailor/resume` directly over
HTTP (`services/aiClient.ts`) - there is no queue hop through `apps/worker`
for this call, and there couldn't be: `apps/worker` connects as
`app_ingest`, which per ADR D-14 has **zero grant on any tenant table**.
Tailoring needs `resume_source`/`resume_artifact`/`job_application`
(tenant tables, `app_web`-only), so the caller has to be a process already
holding that grant - `apps/web` itself, which is also where the human
request (and its session/account context) already lives.

`repositories/profile.ts`'s new `buildCandidateFacts` mirrors
`services/backend/internal/worker/explain.go`'s `explanationFacts`
field-for-field: same refs (`current_title`, `years_experience`,
`desired_titles`, `skill:<name>`), same provenance rule
(`desired_titles` is always `'preference'` by the schema's own documented
invariant, never a guess). Two independent callers, one in Go and one in
TS, describing the same candidate to an LLM boundary the same way - not
shared code, since there's no cross-language module to share it through,
but shared shape, verified by both existing.

`jobContextFor` picks the JD depending on source: a manual application's
own `manual_title`/`manual_jd_text`, or - for a match-sourced one - the
joined posting's **current** version (`job_posting_version` via
`job_posting.current_version_id`), the same "always the current version"
rule `GetJobExplanationContext` already enforces on the Go side (D-09).

## The compile route: reinject against the ORIGINAL tex, never the draft

This is the one place this phase repeats, deliberately, a bug class
`specs/resume-tailoring.md` already documents and fixed once at the graph
level: **`tailorClient.reinject()` is called with `resumeSource.tex` (the
untouched original), never `resume_artifact.tex`** (Graph A's own already-
spliced draft, kept only so the diff-review UI has something to show).
Splicing the human-accepted subset into the graph's own draft would let
`verifyKeepIntegrity`-style corruption (or worse, a fabricated claim the
human never actually accepted) survive silently, for the same reason
`fabrication_check`'s real bug was reachable in the first place: validating
a document against its own already-modified copy makes every check
trivially pass.

**Staleness is checked explicitly, not assumed**: if
`resume_source.sha256` has changed since the artifact's `source_sha256`
was recorded (the candidate edited their template after the proposal was
made), compile refuses with `409` rather than splicing field offsets that
no longer describe the current document - the same "hard stop, never
partially trusted" rule `verifyKeepIntegrity` itself applies one layer
down, held here at the layer above it.

An unknown `accepted` field id (not present in the artifact's own
`proposed_changes`) is rejected with `400` before any HTTP call to
`apps/tailor` - the candidate can only accept what was actually proposed,
never inject an arbitrary field/rewrite pair through this endpoint.

## Outreach: drafted from a template, not an LLM

`services/outreachTemplate.ts`'s `draftOutreachContent` is a plain,
editable template - not a call to `services/ai`. A deliberate, named scope
decision: `services/ai` has no outreach-drafting graph, and building one is
real new scope beyond what this phase's own line in the build plan asks
for ("sits on the retention-aware `job_application` table from 5.1"). A
templated draft gets a candidate to something sendable in one click today;
an LLM-drafted version is a tracked gap (see below), not a placeholder
pretending to be the finished thing.

Status only ever advances `draft -> approved -> sent`, each transition
gated on the row already being in the expected prior state
(`outreachRepo`'s own compare-and-set queries, not just app-level
`if` checks) - editing an approved draft, approving twice, or sending
twice all fail cleanly rather than silently succeeding or double-sending.

## Gmail: linking (Phase 7) and sending (Phase 7 outreach, Phase 8 email)

Two capabilities, one stored credential:

- **`services/gmail.ts`** - a SEPARATE OAuth flow from `google-oauth.ts`'s
  sign-in, sharing the same Google Cloud client id/secret (one client
  authorizes more than one redirect URI) and the same PKCE mechanics,
  factored out into `services/pkce.ts` so both flows use one
  implementation. Scope is `gmail.send openid email`, with
  `access_type=offline` + `prompt=consent` - both required to guarantee a
  `refresh_token` actually comes back (Google only issues one on a truly
  first consent otherwise).
- **`repositories/emailCredential.ts`** - the refresh token is encrypted at
  rest with pgcrypto's `pgp_sym_encrypt`/`pgp_sym_decrypt` (`0017`'s own
  comment explains why: it is the one credential in this schema that
  grants a real external capability - sending mail as the candidate - if
  it ever leaked from a backup or a stray `SELECT *`). The symmetric key
  (`EMAIL_CREDENTIAL_ENCRYPTION_KEY`) lives in config, never in this
  database. **Not** a D-31 purge target - linking an inbox is a standing,
  account-level connection like Google sign-in, not something one job
  search did (the same reasoning that already keeps `candidate_profile`
  out of `jobSearchRepo`'s `PURGE_TABLES`).
- **`services/gmailSend.ts`** - refresh-token exchange, RFC 2822/MIME
  construction (multipart/mixed with one optional attachment, RFC 2047 for
  a non-ASCII display name), and the actual `POST
  gmail.googleapis.com/.../messages/send`. No `googleapis` SDK - one HTTP
  client, the same one-class minimalism `services/ai`'s own LLM clients
  already hold. This is the one function Phase 8's own event-triggered
  notification mailer will also call.

**Per the user's explicit instruction for this phase: the integration code
is written; real Google credentials are deliberately not configured.**
Every route that needs them checks `config.gmail.enabled` first and
returns `oauth_disabled` (404) when absent - the same "half-configured is
worse than visibly off" rule `google-oauth.ts` already established for
sign-in. **NOTE ON VERIFICATION** (same disclosure both `gmail.ts` and
`gmailSend.ts` carry in their own doc comments): the live round trip
against real Google is unverified. What's actually tested: PKCE/state
handling and the token-response shape (`test/gmail.test.ts`, a fake token
endpoint), MIME construction and the send request shape
(`test/gmailSend.test.ts`, a fake token+send endpoint), and every route-
level guard that fires before a real Gmail call would ever happen -
disabled config, an unapproved draft, no credential connected
(`test/outreach.test.ts`). The first run against real credentials is the
actual verification, exactly as `google-oauth.ts`'s own note already says
for sign-in.

## Events wired this phase

`APPLICATION_STATUS_CHANGED`, `RESUME_TAILORING_PROPOSED`,
`RESUME_TAILORING_COMPILED`, and `OUTREACH_DRAFT_CREATED` move from
"reserved, no publisher" to wired, real publishers, in this phase -
`specs/events-and-realtime.md`'s own catalog table is updated alongside.
Same rule as Phase 5.5's `match.computed`/`job_search.stopped`: publish
strictly after the write transaction commits, best-effort
(`.catch(() => request.log.error(...))`), never turned into a 500 for the
caller over a bus hiccup.

## Tests

No mocks for Postgres/RLS, mocks only for the two boundaries that are
either paid+nondeterministic (the LLM, behind `services/ai`) or require
real external credentials this build doesn't have (Gmail):

| File | Proves |
|---|---|
| `packages/db/test/applicationWorkspace.test.ts` (16 tests) | RLS isolation on every new table; `patchApplication` writes an event only when status actually changes; `createApplicationFromMatch` is idempotent; artifact create -> compile -> PDF round-trips `proposed_changes`/`flags`/`accepted` correctly; outreach's draft/approve/send compare-and-set chain; `job_match` dismiss is idempotent and tenant-scoped; **`email_credential`'s pgcrypto round-trip against the real column** - the raw ciphertext never contains the plaintext token, decrypting with the wrong key genuinely fails |
| `apps/web/test/matches.test.ts` (6 tests) | Auth required; tenant-scoped listing; dismiss and track wiring, including idempotent re-tracking |
| `apps/web/test/applications.test.ts` (8 tests) | CRUD + patch/event-logging wiring; **the tailor route's fact/job-context assembly**, asserted against a fake `AIClient` capturing its actual call args; 404 on an unknown resume variant before any AI call is made |
| `apps/web/test/artifacts.test.ts` (7 tests) | **Reinject is called with the ORIGINAL resume_source tex, never the artifact's own draft** - asserted directly against a fake `TailorHttpClient`'s captured call; stale-`sha256` conflict; unknown-field rejection; already-compiled conflict; a `reinject` integrity failure or a `compile` error both mark the artifact `'failed'` rather than compiling anyway |
| `apps/web/test/outreach.test.ts` (7 tests) | Gmail-disabled 404 gating; template draft content references the real title/company; draft -> approve -> send transitions and their failure modes; cross-tenant 404s; the account-wide outreach list |
| `apps/web/test/gmail.test.ts` (7 tests) | Config gating; PKCE/state shape; correct extraction of email+refresh_token from a well-formed token response; the missing-refresh_token edge case fails clearly instead of silently storing nothing |
| `apps/web/test/gmailSend.test.ts` (7 tests) | MIME construction (plain and multipart-with-attachment), RFC 2047 encoding, the refresh-then-send call sequence, and both failure paths |

A real bug was caught by this test suite, not by inspection: the first
draft of `artifacts.test.ts`'s fake `TailorHttpClient` used `{...state}` to
spread mutable fields onto the returned object at construction time,
which silently froze `nextCompileError`/`nextReinject` at their initial
`null` values - a test mutating them afterward had no effect, and the two
tests exercising failure paths passed for the wrong reason (200, not the
expected 409, until the assertion caught it). Fixed by having the fake's
own methods close over the same object the test mutates, rather than a
value snapshotted at construction.

58 new tests across Phase 7's own new files (16 + 6 + 8 + 7 + 7 + 7 + 7),
plus updated purge coverage in the two pre-existing suites that already
covered `job_application`/`resume_artifact` (`packages/db/test/
jobSearch.test.ts` and `apps/web/test/jobSearch.test.ts`, both now also
seeding and asserting `outreach_draft`), plus Phase 8's own 4 (below).
Full workspace: `pnpm run typecheck` and `pnpm run test` both clean across
all 9 TS packages/apps; `go build ./...` for `services/backend` unaffected
(neither phase touched Go code).

## Phase 8: event-triggered notification email

`docs/BUILD_PLAN.md`'s own words for this phase: "wire
`job_search.stopped`/`match.computed` to email now that both the event bus
and Gmail integration exist." With Phase 5.5 (event bus) and this phase's
own Gmail integration (above) both real, what Phase 8 actually needed was
small: a cross-account subscriber and two messages.

**Sends through the same per-account Gmail credential outreach already
uses** (`repositories/emailCredential.ts`) - "notify yourself, via your
own connected inbox" - rather than a separate system service-account
mailer, because no such account exists anywhere in this build; the only
real "send an email" capability that exists at all is the Gmail
integration Phase 7 just built. An account with no linked Gmail falls back
to the general-purpose `Mailer` (`services/mailer.ts`, `log`/`noop`
today) rather than silently dropping the notification.

**`services/events.ts`'s `EventBus` gained one new method**,
`subscribeEvent(event, signal)`: cross-account, `account.*.<event>` (NATS
`*` matches exactly one token, so this never also matches a different
event name for some account) - a genuinely different shape from
`subscribeAccount`'s existing per-connection, single-account subscription,
which the SSE bridge already owns and which is the wrong shape for a
process that has to react to whichever account an event happens to
concern, not one chosen ahead of time.

**`services/notifications.ts`'s `runNotificationSubscriber`** runs two
independent `for await` loops (one per event, not one multiplexed loop
branching on event name) for the life of the server:

- `job_search.stopped` -> always emails, listing exactly the tables the
  event's own `purgedTables` payload named - "boom, gone, here's the
  receipt," reusing the payload D-26 already guarantees carries no PII,
  just table names.
- `match.computed` -> emails only when `matchesWritten > 0`. Reachable at
  zero (an account with active search but nothing new since the last run)
  and deliberately silent - "3 new matches" is useful, "0 new matches"
  every few minutes is spam a candidate would disable the whole feature to
  stop.

**Off by default** (`NOTIFICATIONS_ENABLED`, `config.ts`): this is new
standing background behavior - a process-wide, cross-account NATS
subscription running for the life of the server, not a per-request code
path - so it needs its own explicit opt-in rather than silently starting
whenever a NATS server happens to be reachable, the same "explicit config
over a silent default" rule `MAIL_TRANSPORT`/`GOOGLE_*` already follow.
`server.ts` starts it conditionally and tears it down on `onClose` via an
`AbortController` - the same shutdown shape `subscribeAccount`'s own doc
comment already establishes for why a signal (not just letting the
process exit) is what actually unblocks a `for await` loop parked waiting
for the next message.

**`repositories/identity.ts` gained `findAccountOwnerEmail`** - the
reverse of the existing `findPrimaryMembership` (user -> account), using
the same "earliest membership" tie-break so the two functions can never
disagree about who "the" account owner is for an account with more than
one member.

### Tests

`apps/web/test/notifications.test.ts` (4 tests) - against the **real**
NATS server and real Postgres, no mocks: publishes a real event, asserts a
recording `Mailer` actually received the right message; `matchesWritten:
0` genuinely sends nothing (proven by racing a second, later, real event
for the same account and confirming only that second message arrived -
not a bare timeout-and-hope); and cross-account isolation - an event for
account B never reaches account A's mailbox.

## Known gaps

- **No streaming tailor/compile progress.** Both routes are synchronous
  (see above) - a real UX simplification versus the plan's literal 202 +
  SSE progress contract, revisited once Graph A/B's own streaming gap
  (`specs/resume-tailoring.md`) closes.
- **Outreach drafting is templated, not LLM-generated.** Named above, not
  hidden - a `draftOutreachContent` upgrade to call a real (yet-to-exist)
  outreach graph in `services/ai` is future work, not a broken feature
  today.
- **Gmail has no real credentials configured**, by explicit instruction for
  this phase. The code path is real and unit-tested; the live round trip
  is not, per this file's own "NOTE ON VERIFICATION" above. This also
  means Phase 8's notification email currently always falls through to the
  `log`/`noop` `Mailer` in practice (no account has a linked Gmail yet) -
  correct, tested behavior, just not the Gmail-send path until real
  credentials exist.
- **No `MCP server`/dashboard caller yet.** Nothing in a UI calls any of
  these routes yet - that's Phase 6 (dashboard), which is expected to be
  this phase's first real caller.
- **`NOTIFICATIONS_ENABLED` defaults off everywhere**, including
  local/dev - it has to be explicitly turned on (with a running NATS
  server) to see Phase 8's subscriber do anything at all.
