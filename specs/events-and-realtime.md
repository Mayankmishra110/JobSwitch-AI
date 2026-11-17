# Events and realtime (Phase 5.5)

D-26: NATS **core** pub/sub (not JetStream persistence) feeding a
per-account SSE stream in `apps/web`. Two independent publishers today —
TS (`apps/web`) and Go (`services/backend`) — one consumer (the SSE
bridge), one subject convention shared by both languages.

## Why core NATS, not JetStream, not Kafka, not WebSocket

The only consumer this phase has is a currently-connected browser tab.
There is nothing to replay to a subscriber who connects later — if no tab
is open when `match.computed` fires, the right behavior is exactly
nothing, not a durable backlog delivered on next connect. JetStream stays
running on the same server (`docker-compose.yml`'s `nats` service already
passes `-js`) for whatever future event genuinely needs durability; this
phase doesn't add one. Kafka was never in consideration at this scale
(D-26). SSE over WebSocket: a plain `GET` carries the session cookie
automatically, and this phase's traffic is entirely server-to-browser —
nothing here needs a client-to-server message channel.

`job_queue` (Postgres, `FOR UPDATE SKIP LOCKED`) and NATS are
complementary, not redundant, and this phase doesn't blur that line:
`job_queue` remains the only way work gets claimed exactly once by a
single-language worker; NATS is used exclusively for fan-out to a
consumer that was never going to claim anything — a browser tab.

## Subject convention

`packages/core/src/events.ts` (TS) and
`services/backend/internal/events/events.go` (Go) each define the same
two functions, independently, to the same output — no shared package
crosses the TS/Go boundary anywhere else in this repo either (`internal/db`
vs. `packages/db` are the same pattern):

```
accountSubject(accountId, event)   -> "account.<accountId>.<event>"
accountWildcardSubject(accountId)  -> "account.<accountId>.>"
```

Every event this phase wires is tenant-scoped by construction — the
subject itself carries the account id, so a subscriber's wildcard
subscription to its own account can never receive another account's
message. This isn't an application-level filter that could be
forgotten; it's the address the message was published to.

## The event catalog — wired vs. reserved

`Events` (TS, `packages/core/src/events.ts`) is the full catalog named in
`docs/BUILD_PLAN.md`. As of Phase 7, every entry except the Layer-1 pair
below is wired to a real publisher and the same real consumer (the SSE
bridge):

| Event | Status | Why |
|---|---|---|
| `match.computed` | **Wired** (Go), Phase 5.5 | Real, new consumer (SSE) once `internal/match.RunForAccount` finishes a run |
| `job_search.stopped` | **Wired** (TS), Phase 5.5 | Real, new consumer once `stopJobSearch` commits |
| `application.status_changed` | **Wired** (TS), Phase 7 | `routes/applications.ts`'s `PATCH .../:id` and `routes/matches.ts`'s `.../track`, after the status-changing transaction commits (see specs/application-workspace.md) |
| `resume.tailoring.proposed` | **Wired** (TS), Phase 7 | `routes/applications.ts`'s `.../tailor`, after the `resume_artifact` row commits |
| `resume.tailoring.compiled` | **Wired** (TS), Phase 7 | `routes/artifacts.ts`'s `.../compile`, after the `resume_artifact` row commits |
| `outreach.draft.created` | **Wired** (TS), Phase 7 | `routes/outreach.ts`'s `POST .../outreach`, after the `outreach_draft` row commits |
| `job.posting.created` | Reserved | Layer 1, shared across all accounts, not tenant-scoped — doesn't fit `account.<id>.*` at all. Already has a working consumer via `job_queue`'s `embed.job_version`; a NATS publisher here would be a second, redundant path to the same effect for no new consumer. |
| `job_version.embedded` | Reserved | Same reasoning as above |

Building a publisher for a reserved event with no real consumer would be
untested code exercising a codepath nothing depends on — deferred
indefinitely for the Layer-1 pair above, for exactly that reason.

## `match.computed` — Go publisher

`services/backend/internal/events/events.go`: a `Publisher` wrapping one
`*nats.Conn`. **Nil-safe by design** — `Publish`/`Close` on a nil
`*Publisher` are no-ops, not panics. This is what let every pre-existing
`match.RunForAccount` test (all of `match_integration_test.go`, written
before this phase) keep passing unchanged by simply passing `nil` as the
publisher, and it's what lets `cmd/worker/main.go` treat a NATS outage at
startup as a warning rather than refusing to start the whole worker over
a bus that only affects live UI push, never the actual matching pipeline:

```go
publisher, err := events.Connect(cfg.NatsURL)
if err != nil {
    logger.Warn("connecting to NATS failed; match.computed will not be published", "err", err)
    publisher = nil
}
```

`RunForAccount`'s signature gained a fourth parameter,
`publisher *events.Publisher`, threaded through
`cmd/worker/main.go` → `worker.RunScheduledTasks` → `runMatchingTick` →
`match.RunForAccount`. The publish call sits after `UpsertMatches` and
`enqueueTopExplanations` both commit, right before the function returns —
publishing before the writes are durable would let a subscriber's live
refresh race ahead of data that isn't actually queryable yet. A publish
failure is logged (`slog.Default()`, since `cmd/worker`'s `main.go`
already installs the process-wide JSON handler) and never turned into an
error returned to the caller — the `job_match` rows are already correct;
a bus hiccup should cost a live UI refresh, not retry an entire matching
run.

## `job_search.stopped` — TS publisher

`apps/web/src/routes/jobSearch.ts`'s `POST /api/v1/job-search/stop`
publishes after `stopJobSearch`'s purge transaction commits, matching the
Go side's same "after the durable write, never before" rule and D-31's
own "boom, gone" claim — the event existing at all is a signal the purge
already happened, not a promise that it's about to. `void
events.publish(...).catch(...)`: best-effort, logged, never turns an
already-successful purge into a 500 for the caller.

## The SSE bridge — `apps/web`

`apps/web/src/services/events.ts`'s `EventBus`:

```typescript
interface EventBus {
  publish(accountId, event, payload): Promise<void>;
  subscribeAccount(accountId, signal): AsyncIterable<{ event, payload }>;
  close(): Promise<void>;
}
```

Backed by `@nats-io/transport-node` (the current, maintained client — not
the deprecated `nats` package). One lazily-created connection, reused for
every publish and every subscription; `close()` drains it. `createPool`
mirrors `packages/db`'s own lazy-connect pattern for exactly the same
reason: importing the module must never itself require a live NATS
server, only actually using it does.

`apps/web/src/routes/events.ts`: `GET /api/v1/events/stream`, behind
`app.requireAuth`. Uses Fastify's `reply.hijack()` — the one route in
this codebase that needs to hold the underlying socket open indefinitely
and write to it directly, rather than returning a value Fastify
serializes once. Subscribes to `accountWildcardSubject(principal.accountId)`;
the subject itself is the tenancy boundary (see above), so this route has
no additional filtering to get right or get wrong. On the request's
`AbortSignal` firing (client disconnect), `subscribeAccount`'s `finally`
unsubscribes — no leaked NATS subscriptions accumulating across
reconnects.

## Tests

**No mock NATS anywhere** — same rule this project applies to Postgres:
`apps/web/test/events.test.ts` runs against the real
`docker-compose.yml` `nats` service, a real listening HTTP server
(`app.listen({port: 0})`, not `app.inject()` — SSE's response only
resolves on disconnect, which `inject()` can't exercise meaningfully),
and a real `fetch()` reading the response body as it streams.
`services/backend/internal/match/match_integration_test.go`'s
`TestRunForAccountPublishesMatchComputed` does the Go-side equivalent: a
raw `nats.Conn` subscriber plays the SSE bridge's role, subscribing to
the same `account.<id>.>` wildcard, and asserts a real `RunForAccount`
call with a real `*events.Publisher` produces a real message on the wire
— skips (doesn't fail) if NATS isn't reachable, the same pattern this
project already uses for calling real cross-service dependencies.

| File | Proves |
|---|---|
| `apps/web/test/events.test.ts` | `/api/v1/events/stream` requires auth; a published event on this account's subject is received, with the right `event`/`data` shape; an event published to a different account is never received even when both streams are open concurrently; a real `POST /job-search/stop` call publishes `job_search.stopped` with `purgedTables`, received live over the same connection |
| `services/backend/internal/match/match_integration_test.go`'s `TestRunForAccountPublishesMatchComputed` | A real `RunForAccount` run publishes `match.computed` to the real bus, on the right subject, with `accountId`/`matchesWritten` matching the run's own result |

4 TS tests, 1 new Go test (plus every pre-existing `match` test still
passing with a `nil` publisher). `go build ./...`, `go vet ./...`,
`gofmt -l .` all clean.

## Known gaps

- **No reconnect/backoff tuning.** `@nats-io/transport-node` and
  `nats.go` both have their own default reconnect behavior; this phase
  didn't configure either beyond the default. A prolonged NATS outage's
  exact reconnect timing is whatever the client library ships with.
- **No heartbeat/keepalive on the SSE stream itself.** Long-lived HTTP
  connections through some proxies get closed on inactivity; this phase
  has no periodic `: comment` line to keep the connection alive through
  such a proxy. Fine for local dev and direct connections; a real gap for
  a production deployment behind certain load balancers.
- **`job.posting.created` / `job_version.embedded` have no NATS
  publisher**, by deliberate choice (see catalog table above) — revisit
  only if a genuinely new, tenant-scoped consumer needs them.
