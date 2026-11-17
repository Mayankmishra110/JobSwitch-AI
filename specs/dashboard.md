# Dashboard (Phase 6)

`apps/dashboard` - Next.js 15 (App Router, React 19), the 5 screens
`docs/BUILD_PLAN.md` names, PWA-first. The one architectural decision that
shapes everything else in this file: **zero auth code, taken literally**.

## "Zero auth code" - what it actually means here

The build plan's own words: Traefik path-routing gives one origin, so the
dashboard just reads the same `js_session` cookie apps/web already issues.
Phase 5.0 (the Traefik deployment) is deliberately skipped for now, so this
phase had to decide what "zero auth code" means **without** a shared
origin to lean on - and the answer is: every single call to apps/web is
server-to-server, never browser-to-apps/web, in dev or in the eventual
Traefik-routed shape alike:

- **Reads** are Server Components (`src/lib/apiServer.ts`'s `apiGetOrRedirect`)
  - the incoming request's cookie is read via `next/headers` and forwarded
  verbatim in the outbound `fetch` to apps/web.
- **Writes** are Server Actions (`'use server'` files under each route) -
  same cookie-forwarding helper, called from a form or a button's
  `onClick` via `useTransition`.
- **The two genuinely long-lived/binary exceptions** - the SSE stream and
  a PDF download - are Route Handlers
  (`app/api/events/stream/route.ts`, `app/api/artifacts/[id]/pdf/route.ts`)
  that pipe apps/web's response straight through (`new Response(upstream.body, ...)`).
- **`middleware.ts`** checks only whether a `js_session` cookie is
  *present*, redirecting to `/login` if not - it is a UX fast path, not a
  security boundary. An expired or revoked cookie still reaches a page's
  real data fetch and gets a genuine `401` from apps/web, which
  `apiGetOrRedirect` turns into the identical `/login` redirect. This app
  never parses the cookie, never hashes anything, never re-implements a
  single bit of what `apps/web/src/services/auth.ts` already does - the
  literal meaning of "zero auth code."

**One real, disclosed dev-only constraint** this design creates:
`API_BASE_URL` defaults to `http://localhost:3000`, not `127.0.0.1` -
`app/api/gmail/authorize/route.ts` (below) depends on both apps being
reached via the exact same hostname string, because cookie matching
ignores port but not hostname. This constraint disappears entirely once
Traefik gives both apps one real origin (D-29); it exists only because
this phase was built ahead of Phase 5.0 on purpose (see the phase
ordering note in `specs/README.md`).

## The five screens

| Route | What it does |
|---|---|
| `/login` | A form (email/password, sign-in or sign-up toggle) whose Server Action relays straight to apps/web's real `/auth/login`/`/auth/signup` and copies the `Set-Cookie` header through - see "Zero auth code" above. Not literally "a redirect" (the build plan's own words) because a redirect-based flow would land the browser on apps/web's own placeholder HTML pages, not this dashboard; a same-origin-feeling form that relays server-side is the more literal reading of "zero auth code" once Traefik isn't there to make a redirect free. |
| `/pipeline` | The board: every tracked application, inline status `<select>` (Server Action, `revalidatePath`), a manual "track a new application" form. |
| `/matches` | Ranked feed: per-signal score bars, the explanation summary with provenance badges (`badge-<provenance>` classes matching D-22's five kinds), Dismiss/Track buttons. |
| `/applications/[id]` | JD text, the tailor panel (variant picker → propose → per-field accept/reject checkboxes → compile → download), the outreach panel (draft → edit → approve → send), a live-progress banner (SSE), and status history. |
| `/profile` | The job-search active/stop toggle front and center (per the plan's own emphasis), profile fields, skills, resume templates, and Gmail connection status. |

Two more routes exist outside the "5 screens" count, both reachable only
from `/login`: `/forgot-password` and `/reset-password` (see their own
section below) - the plan's 5 screens are the product surface; a password
reset is auth plumbing, the same category `/login` itself is in.

## Password reset closes the loop `APP_ORIGIN` started

Phase 1 already emails a password-reset link
(`apps/web/src/services/auth.ts`, built from config's `APP_ORIGIN`); this
phase's Gmail-link callback (`specs/application-workspace.md`) added a
second, similar redirect. Both need to land on a **dashboard** page, but
neither did originally - `APP_ORIGIN` defaulted to apps/web's own origin,
and apps/web has no `/reset-password` page a candidate could actually use
(only a server-rendered placeholder from Phase 1, before this dashboard
existed).

Fixed on both ends:

- **`apps/web`'s `APP_ORIGIN` default** changed from its own origin
  (`:3000`) to this dashboard's (`:3001`) - it was always meant to be "the
  user-facing origin," and now there's a real one to point it at. Every
  existing apps/web test already set `APP_ORIGIN` explicitly in its own
  config, so this default change couldn't and didn't break any of them
  (verified - the full apps/web suite stayed green).
- **`/forgot-password` and `/reset-password`** are new dashboard pages,
  built the same way `/login` was: a thin relay
  (`lib/authRelay.ts`'s `requestPasswordReset`/`confirmPasswordReset`) to
  apps/web's real `/auth/forgot-password`/`/auth/reset-password`, zero
  password logic of its own. `middleware.ts` treats both as public like
  `/login` - but, unlike `/login`, does **not** bounce an already-
  authenticated visitor away from them, since resetting your password
  without signing out first is a normal thing to want to do.
- `/login` gained a "Forgot your password?" link and a `?reset=1`
  success notice (`useSearchParams` inside `LoginForm`, which is why
  `login/page.tsx` now wraps it in a `<Suspense>` boundary - Next.js
  requires one around any component that opts into client-side rendering
  this way, or an otherwise-static page fails to prerender at build time;
  caught by `next build`, not `tsc`, the same class of gap the `.js`-
  extension bug above was).

**Verified with a real, live, full round trip** (same "curl against real
HTTP responses, not a browser" disclosure as this file's other manual
tests): signed up a real account, requested a reset, extracted the real
emailed link from apps/web's log output and confirmed it now points at
`http://localhost:3001/reset-password?token=...` (the dashboard, not
apps/web); the dashboard's `/reset-password` page rendered with that real
token pre-filled in its hidden field; completing the reset with a new
password succeeded for real, and - proving the whole thing, not just the
HTTP 200 - the **old password stopped working** (`401
invalid_credentials`) while the **new one succeeded**, confirming apps/web's
"every session revoked" behavior extends to the credential itself, not
just active sessions.

## The tailor panel: proper-noun flags actually block compile

The build plan's own words for screen 2: "proper-noun flags block
compile." Implemented as a real gate, not a warning label:
`TailorPanel.tsx` computes `canCompile = status === 'proposed' &&
!hasUnreviewedFlags`, and `hasUnreviewedFlags` is true whenever
`artifact.flags.length > 0` and the candidate hasn't checked "I've
reviewed these and confirm they're accurate." The Compile button is
`disabled` under that condition - a flagged fabrication risk cannot be
compiled past without an explicit acknowledgment, the same spirit
`fabrication_check`'s own retry/exhaustion logic already holds one layer
down in `services/ai`.

Compiling with **zero** proposed changes is also a real, supported path
(not a dead end): an artifact with `proposedChanges.length === 0` still
shows a "compile as-is" button, since "the resume already matches well" is
a legitimate outcome of Graph A, not an error state.

## Live progress: honestly scoped

`LiveProgress.tsx` opens one `EventSource` to `/api/events/stream`
(proxied) and listens for `resume.tailoring.proposed`,
`resume.tailoring.compiled`, `outreach.draft.created`, and
`application.status_changed`, filtered to this page's own
`applicationId`. On a match, it shows a banner and calls
`router.refresh()` to re-run the page's Server Component fetch. This is
**not** the granular per-node progress the build plan's diagrams show for
Graph A/B - that would require `graph.astream()`, which
`specs/resume-tailoring.md` already names as a real, unstarted gap. What
this delivers honestly: the dashboard updates itself the moment something
finishes, without the candidate refreshing the page - a real improvement
over polling, not a simulation of streaming that isn't there.

## PWA: an honest app shell, not a fake offline promise

`public/manifest.webmanifest` (SVG icon, `display: standalone`) and
`public/sw.js`. The service worker deliberately does **not** cache
navigation requests (`event.request.mode === 'navigate'` is left alone) -
every page here is server-rendered per request against live data (a job
board, a live SSE stream); caching an HTML response would mean serving a
candidate stale or wrong pipeline data while offline, which is worse than
an honest "you're offline" browser error. What it does cache: the static
shell assets (`manifest.webmanifest`, the icon) an offline launch attempt
needs to show anything at all. No `next-pwa` or similar dependency - a
hand-written ~30-line service worker, consistent with this project's
existing minimalism (one HTTP client class over a vendor SDK,
`fastembed` over `torch`+`sentence-transformers`, etc.).

## Capacitor: real native projects scaffolded, unbuilt and unverified

The build plan's own sequencing: "PWA built first - Capacitor
Android/iOS shells wrap the working PWA as the final packaging step."

**What's real**: `capacitor.config.ts`, `@capacitor/core`/`android`/`ios`/`cli`
as real dependencies, and `npx cap add android` / `npx cap add ios` both
ran for real - `android/` and `ios/` are genuine, complete native project
trees (a real Gradle project with `gradlew`, a real Xcode project with a
`Package.swift`), not placeholder directories. `cap:sync`/`cap:open:android`/
`cap:open:ios` scripts are wired in `package.json`.

**One real architectural decision, not a default**: `capacitor.config.ts`
uses `server.url` (pointed at this app's own dev server via
`10.0.2.2`, the Android emulator's alias for the host's `localhost`)
rather than a bundled static `webDir`. Capacitor's more common quickstart
pattern - export the web app to static files and bundle them into the
native app - does not fit this dashboard at all: every page here is
server-rendered per request against live apps/web data, mutations are
Server Actions, and live updates ride a real SSE connection. None of that
survives a static export. `server.url` mode (a WebView pointing at a
real, running server, exactly like a hybrid banking or dashboard app)
is the architecturally correct choice for this shape of app, not a
workaround.

**What's still not done, and genuinely can't be from here**: this
environment has no Java (`gradlew tasks` fails immediately on a missing
`JAVA_HOME`, confirmed by actually running it) and, being Windows, no
Xcode at all. Building an APK/IPA, launching an emulator/simulator, or
verifying the app actually installs and loads the dashboard needs a
machine with the real Android Studio/Xcode toolchains - this session's
own standing rule against claiming untested UI work as done applies
exactly as much to "does the native shell actually launch" as it does to
a web page, so this is disclosed as unverified rather than assumed to
work. Revisit `server.url`'s placeholder address for whatever host a real
device/emulator needs once there's a machine that can actually build and
run these projects.

## Tests and verification

**A real vitest suite exists** (`apps/dashboard/test/`, 34 tests), added
in a follow-up pass once the shape of the app settled - see "How this app
became testable" below for why that had to come first. What was actually
verified, and how:

- `pnpm run typecheck` (all 10 workspace projects, including this one) and
  `npx next build` (a real production build - catches the class of error
  `tsc --noEmit` alone doesn't, which is exactly how a real bug was found:
  see below) both clean.
- **A real, live smoke test**, both dev servers running together
  (`apps/web` on `:3000` against the real `jobswitch_test` Postgres and
  the real NATS container, `apps/dashboard` on `:3001`), driven with
  `curl` against real HTTP responses - not a browser, disclosed
  explicitly per this project's own "if you can't test the UI in a
  browser, say so" rule:
  - Unauthenticated `/pipeline` → `307` to `/login`; an authenticated
    session hitting `/login` → `307` to `/pipeline` (`middleware.ts`).
  - A real session cookie (issued by a real `/auth/signup` call to
    apps/web) forwarded to the dashboard's `/pipeline`, `/matches`, and
    `/profile` renders real, correct data end to end - including a
    non-trivial case: a real `job_match` + `match_explanation` row
    (seeded directly in Postgres) rendered with the right title, company,
    87% overall score, the explanation summary, and a
    `badge-verified_fact` provenance class.
  - A real application (created via a direct `POST` to apps/web) appears
    correctly on `/pipeline` and its own `/applications/[id]` page,
    including the JD text and the tailor panel's two states (no resume
    template yet → the empty-state message; a template added → the real
    variant picker and "Tailor for this role" button).
  - The SSE proxy (`/api/events/stream`) connects and passes through
    apps/web's real `: connected` keepalive with the correct
    `content-type: text/event-stream`.
  - `/api/gmail/authorize` correctly returns `404` when Gmail isn't
    configured (this build's real state, per specs/application-workspace.md).
  - The PWA manifest, service worker, and icon all serve with `200`.
- **What curl cannot exercise, and therefore wasn't verified this way**:
  every Server Action triggered by a button click or form submit (login,
  create-application, dismiss/track, tailor/compile, outreach create/
  approve/send, profile updates) - these ride Next.js's client-runtime RPC
  protocol (a `Next-Action` header plus serialized arguments), which has
  no practical curl equivalent. The code itself calls the exact same
  `apiMutate`/`apiFetchRaw` helpers already exercised live by the read-
  path tests above, and follows the standard, widely-used
  `useActionState`/`useTransition` pattern - but the click-through
  experience is unverified in an actual browser, because none is
  available in this environment. Disclosed here rather than claimed.
- **A real bug this process caught**: the first cut of `next.config.ts`'s
  imports used NodeNext-style explicit `.js` extensions
  (`from '@/lib/apiServer.js'`), matching every other TS package in this
  monorepo (`apps/web`, `packages/db`, etc., all plain `tsc`+Node, which
  require it). `tsc --noEmit` alone did not catch this - it passed clean.
  `npx next build`'s webpack bundler failed with `Module not found` for
  every such import, because Next's bundler resolves extensionless
  specifiers, not NodeNext's explicit-`.js`-for-a-`.ts`-file convention.
  Fixed by stripping every `.js` suffix from this app's own imports
  (`sed` across `src/`) - a real, disclosed difference in import
  convention between this bundled app and the rest of the monorepo's
  plain-Node packages, not a mistake left in place.

## How this app became testable

Next's App Router APIs - `next/headers`'s `cookies()`, `next/navigation`'s
`redirect()` - only work inside a real Next-managed request (a Server
Component render, a Server Action invocation, a Route Handler call). They
throw outside one, which means a plain vitest file (no Next.js runtime at
all) cannot call `apiGet`/`apiMutate`/`loginAction` directly - exactly the
gap this file used to name.

The fix was a split, not a workaround: pull every branch worth testing
out into a plain function that takes what it needs as an explicit
argument, and leave only the unavoidable one- or two-line
`cookies()`/`redirect()` glue in the Next-specific file that imports it.

- **`lib/apiServer.ts`**: `apiRequest`/`apiGetWith`/`apiMutateWith` take
  the cookie header as a parameter instead of reading `next/headers`
  themselves. `apiFetchRaw`/`apiGet`/`apiMutate` (what pages/actions
  actually import) are now three-line wrappers that read the cookie and
  delegate.
- **`lib/authRelay.ts`** (new): `parseSessionCookie` (already pure) and a
  new `performAuthRequest` - the actual `fetch` + Set-Cookie extraction,
  returning the parsed cookie instead of calling `cookies().set()`
  itself. `login/actions.ts` is now just that call plus the
  `cookies().set()`/`redirect()` it can't avoid holding.
- **The three Route Handlers** (SSE stream, PDF download, Gmail
  authorize) switched from `next/headers` to reading
  `request.headers.get('cookie')` directly - a Route Handler already
  receives the raw platform `Request`, so this needs no Next-specific API
  at all, and it's what makes each one callable directly in a test with a
  hand-built `Request`.
- **`middleware.ts`** needed no change - it already took a `NextRequest`
  and returned a `NextResponse`, both plain constructible classes.

Every test runs against a REAL, separately-running apps/web
(`test/helpers.ts`'s `isApiReachable`/`signupAndGetCookie`) - this
project's standing "no mocks for infra this repo owns and runs for real"
rule, extended to apps/web itself the same way apps/tailor's own tests
already extend it to a real local LaTeX engine. Each suite checks
reachability at module-load time (a top-level `await`, since
`describe.runIf` needs its condition already resolved when the `describe`
blocks are collected - a `beforeAll` runs too late for that) and skips
cleanly with a warning if apps/web isn't up, rather than failing opaquely.
Running them for real needs apps/web started with `RATE_LIMIT_ENABLED=false`
(this suite signs up a fresh account per test - enough in one run to trip
the real `/auth/signup` rate limit otherwise), the same flag apps/web's
own test suite always sets for the same reason.

| File | Proves |
|---|---|
| `test/middleware.test.ts` (9 tests) | The cookie-presence redirect logic in both directions, that an obviously-invalid-looking token is still let through, and that `/forgot-password`/`/reset-password` are public but - unlike `/login` - never bounce an authenticated visitor away |
| `test/apiServer.test.ts` (8 tests) | `apiRequest`/`apiGetWith`/`apiMutateWith` against real apps/web: cookie forwarding reaches a real authenticated route; a missing cookie reaches it as genuinely unauthenticated; real 400/401/404/204 responses are all handled correctly |
| `test/authRelay.test.ts` (11 tests) | `parseSessionCookie`'s parsing (including apps/web's real `Expires`-style cookie, not a fabricated `Max-Age` one); `performAuthRequest` against real signup/login - a real validation failure, real wrong-password rejection, and a real successful cookie issuance; `requestPasswordReset`'s real anti-enumeration parity; `confirmPasswordReset` rejecting a real invalid token |
| `test/routes.test.ts` (6 tests) | Each of the three Route Handlers, called directly with a hand-built `Request`, against real apps/web: correct proxying and correct `401`s with no cookie |

**Two real bugs this suite caught, not fabricated for this section**:

1. The webpack/`.js`-extension issue above (caught by `next build`, not
   this suite - listed again here only for completeness of "what testing
   found").
2. **apps/web sets `Expires`, not `Max-Age`, on the session cookie**
   (`routes/auth.ts`'s `setSessionCookie` passes `expires: session.expiresAt`,
   a `Date`) - `parseSessionCookie`'s first version only ever checked for
   `Max-Age`, so it silently returned a null expiration for every real
   signup/login response. Manually written Set-Cookie strings in a
   hand-rolled test would have used whichever attribute the test author
   happened to type - only a real response from real apps/web exposed
   that the two disagreed. Left unfixed, this dashboard's own cookie
   would have silently become a session-only cookie (gone the moment the
   browser closes) instead of matching apps/web's real 14-day lifetime -
   a genuine, user-visible bug that a "does this string parse" unit test
   without real infra would not have caught. Fixed by parsing `Expires`
   first (falling back to `Max-Age`) and changing `ParsedSessionCookie`
   to carry an absolute `expiresAt: Date | null` instead of a relative
   `maxAgeSeconds`, so `login/actions.ts` now passes `expires` to
   `cookies().set()` - the same attribute apps/web itself uses, not a
   converted approximation of it.

**What this suite still cannot exercise**: every Server Action triggered
by a button click or form submit from an actual browser (create-
application, dismiss/track, tailor/compile, outreach create/approve/send,
profile updates) rides Next.js's client-runtime RPC protocol (a
`Next-Action` header plus a serialized-arguments payload), which has no
practical test-harness equivalent without a real browser - none is
available in this environment. Every one of those actions is a thin
wrapper calling the exact `apiMutate`/`apiGetOrRedirect` functions
`apiServer.test.ts` already exercises live against real apps/web, so the
HTTP contract each depends on is verified even though the click-through
path itself is not. Disclosed here rather than claimed as covered.

## The resume-template editor (`/profile`)

Closed a gap this file used to name: `profile/ResumeSourceEditor.tsx`, one
form per existing `resume_source` variant plus an "add a resume template"
form for a new one. `variantId` is editable only on creation (it's the
primary key, `readOnly` on an existing variant's form) and validated
client-side against the same pattern (`upsertResumeSourceInput`'s regex)
the backend itself enforces.

**The full LaTeX content is fetched server-side, not lazily on click**:
`profile/page.tsx` calls the list endpoint (`GET
/api/v1/profile/resume-source`, which omits `tex` - each entry can be
tens of KB) and then fetches every variant's full detail in parallel
(`Promise.all`) before rendering. Fine at the scale one candidate's own
templates ever reach (a handful, not hundreds) - a real, disclosed
tradeoff that would need revisiting only if that assumption stops
holding, not a bug.

Verified with a real, live smoke test (same "no browser here, curl
against real HTTP responses" disclosure as this file's other manual
tests): a fresh account's `/profile` shows "No resume templates yet"; a
resume added via a direct API call is then correctly pre-filled - label,
PDF filename, the exact LaTeX text, and a truncated sha256 - in the
editor's form; the tailor panel's empty-state message on a resume-less
account now links to `/profile` instead of naming a direct API call.

## Known gaps

- **Capacitor's native builds are unverified**, per the section above - the
  projects are genuinely scaffolded; building, launching, and confirming
  they actually load the dashboard needs a machine with a real Android/
  Xcode toolchain, which this one isn't.
