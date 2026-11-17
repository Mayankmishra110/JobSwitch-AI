# Embeddings and match explanation (`services/ai`)

A stateless Python (FastAPI, managed with `uv`) service: real embeddings
via `fastembed`, resume tailoring and match explanations via LangGraph
(Phase 5.4 — `specs/resume-tailoring.md`). Phase 5.3's plain sequential
explain chain, built first as the documented working baseline, stays in
the repo unchanged but no longer sits behind a live route. Holds no
database grant of any kind — see
`specs/architecture.md`'s boundary note; it never opens a Postgres
connection, receives facts already tagged with their provenance (ADR
D-22), and echoes back which it used.

## Why Python, why `uv`, why stateless

Python was the deliberate choice for the ML/LLM half of this stack — the
`fastembed`/ONNX ecosystem and every mainstream LLM SDK live here first.
`uv` manages both the Python interpreter and the project (no separate
Python install, no `pip`/`venv` juggling) — `uv init`, `uv add`, `uv run`.
Statelessness is a boundary decision, not an accident: keeping this
service DB-free means it needs zero Postgres role, zero grant, zero RLS
story — an entire class of security question that `services/backend`
(which does hold a database role) has to reason about, this service
simply doesn't.

## `/v1/embed` — real, fully verified

```
POST /v1/embed  { texts: string[], kind: "job" | "profile" }
              -> { model, dim, vectors: number[][] }
```

`app/embed.py`: `BAAI/bge-small-en-v1.5`, 384 dimensions, via `fastembed`
(ONNX Runtime — no PyTorch). Chosen for footprint: ~200MB total versus
~2GB for a `torch`+`sentence-transformers` stack, which matters on a
shared box also running Postgres and several other services (see
`docs/ADR.md`'s cost-constraint decisions once D-24 is formally recorded
there). The model loads once, at process startup (`main.py`'s `lifespan`
handler), and is cached for the process lifetime — `/healthz`'s
`model_loaded` field is meaningful because of this, not a hardcoded `true`.

**This endpoint is genuinely, fully verified** — no API key needed, no
mock. Confirmed end to end against a real running instance: correct
384-dimension vectors, identical input text produces an identical vector,
and — the test worth trusting most — `cosine(resume, matching_jd) >
cosine(resume, unrelated_jd)` against real sentences (a Senior Frontend
Engineer resume scores closer to a matching frontend JD than to an
unrelated veterinary-surgeon posting). That last one is a genuine
model-quality regression guard: if the embedding model is ever swapped,
this is the test that would catch a swap that produces nonsense vectors,
not just a wrong dimension count.

First run downloads the model (~130MB, took ~2m49s once in this
environment); every run after that is fast (cached under
`%LOCALAPPDATA%\Temp\fastembed_cache` locally — in a real deployment, the
model should be **baked into the container image at build time**, not
downloaded on cold start, per the plan's own flagged risk. Not yet done —
no Dockerfile exists for this service.

## `/v1/match/explain` — NOW VERIFIED LIVE, real Groq key

```
POST /v1/match/explain  { job: {title, company?, description}, facts: [{ref, text, provenance}] }
                       -> { summary, evidence: [{claim, fact_ref, provenance}], model, prompt_version }
```

**As of Phase 5.4, this route runs Graph B** (`app/graphs/explain_graph.py`
— see `specs/resume-tailoring.md` for the full node-by-node writeup): a
draft pass, a genuine second-pass self-critique, a provenance gate, and a
bounded retry loop, with zero changes to this request/response contract.
`app/explain_service.py` below describes Phase 5.3's original plain
chain — one LLM call, then one deterministic filter, deliberately without
a retry loop or self-critique pass — kept in the repo unchanged as the
documented "here's the working baseline, here's what the graph adds"
comparison point the build plan asked for, not as code any route still
calls live.

### The provenance gate — D-22 enforced as code, not a prompt instruction

The system prompt tells the model to cite only real facts by `ref` — and
then `_provenance_gate()` **strips any evidence item citing a `fact_ref`
that wasn't actually in the request**, regardless of what the prompt said.
This is the same principle Graph B's own `provenance_gate` node now
applies for real (plus a second condition: `self_critique`'s verdict, not
just ref-existence); implemented as a plain function here
because Phase 5.3 has no graph to put a node in yet. Tested directly: a
`FakeLLM` configured to hallucinate a `fact_ref` that was never sent has
that evidence item silently dropped from the response, not surfaced as an
error and not trusted.

### One OpenAI-compatible client covers three providers

`app/llm.py`'s `OpenAICompatibleLLM` — Groq, Gemini, and OpenAI itself all
now expose an OpenAI-compatible chat-completions endpoint, so one client
class, parametrized by base URL/key/model, covers all three rather than
three separate SDK integrations. Provider selection
(`resolve_llm_client`) is a waterfall — first configured key wins, same
order Mayankbuilt's `nipun` pipeline uses (`src/lib/resume/llm.ts`),
matched deliberately rather than reinvented.

### Verified live, and it caught a real bug on the first try

A real Groq key was supplied and wired into `services/ai/.env` (gitignored,
never committed). The **first** live call failed: `502 {"detail":"LLM
provider returned 404"}` — the hardcoded default model,
`llama-3.3-70b-versatile`, no longer exists on Groq. Groq rotates/deprecates
model ids often enough that a hardcoded default written from training data
is not a safe assumption, confirmed exactly the way `specs/ingestion.md`'s
"never verified" adapters warned it would: the gap surfaces on the first
real run, not before. Fixed by querying `GET /openai/v1/models` with the
real key and picking a current model with `json_mode` support —
`openai/gpt-oss-20b` — rather than guessing again. `resolve_llm_client`'s
default is now that model, with a comment noting it was live-verified and
where to re-check if it 404s again in the future.

**Second call, corrected model, succeeded completely**: a real request
citing a candidate's title and two verified skills against a Senior
Frontend Engineer posting returned a well-formed, correctly-grounded
explanation — every evidence item cited a real `fact_ref` with the right
`provenance` tag, nothing hallucinated, valid JSON on the first attempt.

This also exposed a real test fragility, fixed in the same pass:
`test_explain_returns_503_when_no_provider_is_configured` had assumed "no
key is configured" by relying on the test environment having none — true
before this key was added, false after. Fixed to override `get_settings`
with an explicit empty-keys `Settings()` instance instead of depending on
what happens to be in `.env` at test time.

The request shape, JSON-mode parsing, and error mapping are additionally
tested against `FakeLLM` (`tests/fakes.py`) and, for the real HTTP client's
own JSON-parsing logic specifically, `httpx.MockTransport`
(`tests/test_llm.py`) — both still valuable for deterministic, free,
offline coverage of cases a live call wouldn't reliably exercise (malformed
provider output, HTTP error statuses). The live path is no longer the
untested one; the ATS adapters and Google OAuth (`specs/ingestion.md`,
`specs/auth-and-identity.md`) remain in that state.

### Error mapping

| Condition | Status | Why |
|---|---|---|
| No provider key configured | 503 | "Not configured to do this yet," not a bug — same distinction `apps/web`'s `Errors.oauthDisabled()` draws |
| Provider replies with non-JSON content | 502 | `LLMResponseError`, raised inside `OpenAICompatibleLLM.complete_json`, never silently passed through |
| Valid JSON, wrong shape (e.g. missing `summary`) | 502 | `pydantic.ValidationError` from `ExplanationDraft.model_validate` — malformed shape rejected, not coerced |
| Provider HTTP error (401, 500, ...) | 502 | `httpx.HTTPStatusError` |

## Internal-caller auth

`app/auth.py`'s `require_internal_token`: when `INTERNAL_TOKEN` is
configured, every route requires a matching `X-Internal-Token` header.
Left unconfigured (local dev), the check is skipped entirely rather than
locking a developer out with a token nobody set on purpose. No route in
this service is meant to be reachable from outside the internal network in
a real deployment — see `specs/architecture.md`'s deployment-target note
(`services/backend` and `apps/tailor` would be the only callers).

## Known gaps

- **No Dockerfile.** The model-bake-at-build-time step the plan flags as a
  real risk (a cold pod depending on an outbound download succeeding) is
  unaddressed — this service has only ever run via `uv run uvicorn`
  locally.
- **Closed: LangGraph is built (Phase 5.4)** — see
  `specs/resume-tailoring.md`. Graph B now runs behind this same
  `/v1/match/explain` route (`app/routers/explain.py` calls
  `run_explain_graph`, zero request/response contract changes); the plain
  chain below (`explain_service.py`) stays in the repo unchanged as the
  documented baseline it was always meant to be compared against, not as
  live code any route still calls. Graph A (resume tailoring) is a new
  route, `POST /v1/tailor/resume`.
- **Closed: `/v1/match/explain` is now wired.** `services/backend`'s
  `cmd/worker` claims `explain.match` jobs (`internal/worker/explain.go`),
  enqueued by `internal/match.RunForAccount` for the top 20 matches of
  every run, and calls this exact endpoint for real — see
  `specs/matching-pipeline.md`'s `explain.match` section for the full
  loop, verified against a real Groq call through this same route.
- **No streaming variant.** `/stream` endpoints (NDJSON per graph-node
  transition) are explicitly a phase-2 enhancement in the build plan,
  after the synchronous version works — which it now does, but streaming
  hasn't been started.
- **`GET /healthz` only reports model load state**, not LLM provider
  reachability — there is no way to distinguish "not configured" from
  "configured but the provider is down" without actually calling
  `/v1/match/explain`.

## Tests

21 tests, `uv run pytest`, all passing:

| File | Proves |
|---|---|
| `tests/test_embed.py` (5) | Real shape/determinism/health checks, plus the cosine-similarity model-quality regression test |
| `tests/test_explain.py` (7) | Route behavior against `FakeLLM`: success, provenance-gate stripping, empty-evidence-not-an-error, malformed-output→502, missing-required-field→502, prompt actually contains the facts, 503 with no provider configured |
| `tests/test_llm.py` (9) | `OpenAICompatibleLLM`'s real HTTP/JSON handling via `httpx.MockTransport`; `resolve_llm_client`'s waterfall ordering and model-override behavior |

`uv run ruff check .` and `uv run ruff format --check .` both clean.
