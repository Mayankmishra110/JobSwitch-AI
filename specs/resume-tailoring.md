# Resume tailoring (Phase 5.4)

Three pieces, in dependency order: `packages/resume-core` (pure LaTeX span
surgery, extracted), `apps/tailor` (the stateless HTTP service that uses
it, plus real PDF compilation), and `services/ai`'s Graph A (the LangGraph
orchestration that calls both, plus an LLM). Graph B (match explanation)
is documented alongside Graph A here since they share this phase and one
module (`app/graphs/`), even though Graph B lives behind the pre-existing
`/v1/match/explain` route from Phase 5.3, not a new one.

## `packages/resume-core` — extracted, not rewritten

Extracted from `Mayankbuilt`'s private `nipun` pipeline
(`src/lib/resume/{types,parser,reinject,latexSafety,properNouns}.ts`) —
the byte-exact LaTeX span-splicing path, verified against Mayank's own
real resumes. Per the build plan's own decision (`docs/BUILD_PLAN.md`'s
"nipun extraction" section): **ported, not rewritten in Python, and not
called via the deployed Mayankbuilt service** — the offset arithmetic
(brace-matching, right-to-left splicing, `verifyKeepIntegrity`'s
delta-tracking re-walk) is not translatable prose, and the deployed
service's `/api/*` routes have no auth and persist nothing.

**One deliberate omission from the plan's file list**: `registry.ts`
(nipun's bundled, hardcoded two-variant lookup) was **not** ported.
JobSwitch AI stores a candidate's LaTeX template per-account in
`resume_source` (migration 0008) — a real, multi-tenant database table,
not a compile-time bundle of one person's own resumes. Porting the
registry concept would mean either bundling Mayank's personal resumes
into a shared package (wrong for a multi-tenant product) or building a
placeholder nobody would call. `parseResumeSource` already took `raw`
text as a parameter in the original module; dropping the registry wrapper
and its `variantId` field from `ParsedResume` was the only change needed.

### What's byte-exact vs. what's genuinely new

`types.ts`, `latexSafety.ts`, `parser.ts`, `reinject.ts`, `properNouns.ts`
are the ported logic, unchanged in behavior (see the two callouts below
for what this means in practice). `test/` is entirely new — the build
plan's own gap analysis names `scripts/test-resume-pipeline.ts` (nipun's
own) as manual-only, so there was no automated parity suite to port.

**Golden tests run against a real resume**, not a synthetic fixture:
`test/fixtures/fullstack.tex` is a direct copy of Mayank's own real
`fullstack.tex` from `Mayankbuilt` (already used exactly this way inside
that project — the same person's resume, reused as a private test fixture
in another one of his own local repos). 32 tests, `pnpm --filter
@jobswitch/resume-core test`:

| File | Proves |
|---|---|
| `parser.test.ts` | **The core round-trip invariant**: for every extracted field, `raw.slice(start, end) === original`, on the real fixture. Also: unique field ids, correct summary/skills/experience/education extraction, empty structure for a source with none of the expected sections. |
| `reinject.test.ts` | Changing one field leaves every other byte identical (`before + rewritten + after`, checked directly); a no-op rewrite (`rewritten === original`) produces byte-identical output; an unknown field id is skipped, not erroring; an unbalanced-brace rewrite is skipped rather than risking a broken compile; a bare special character is escaped rather than the whole rewrite rejected; multiple non-overlapping changes apply correctly right-to-left; overlapping spans throw rather than silently corrupting output; `verifyKeepIntegrity` actually detects a kept field mutated by something outside this module. |
| `latexSafety.test.ts` | Escaping is idempotent; structural characters (`$ { } \`) are never touched; brace/math balance detection, including that an escaped brace doesn't count toward depth. |
| `properNouns.test.ts` | Already-known words/numbers aren't flagged even reordered and recased; a genuinely new entity/metric is flagged; common words are protected even sentence-initial and capitalized; flags dedupe per field/token; the conservative-by-design false-positive tradeoff (`Turborepo`, unmentioned but plausible, is still flagged); **and one test that documents a real, inherited quirk** (see below) rather than hiding it. |

### A real, inherited quirk, documented rather than hidden

`looksLikeEntity`'s tech-token heuristic (`/[.#+/]/.test(token) &&
/[A-Za-z]/.test(token)`) exists to catch things like `Node.js`/`C++`/
`CI/CD`. Because `TOKEN_RE` absorbs a trailing sentence-ending period into
the token it's attached to (by design, for the same reason — `Node.js.`
at the end of a sentence needs the internal dot to survive), an ordinary
word immediately followed by a period with no space (`patterns.`) also
matches that heuristic and gets flagged, whether or not it's a real
tech-ish token. `properNouns.test.ts` names this explicitly with its own
test rather than working around it silently — byte-exact means the quirk
came along with the logic, and it is real, existing behavior, not
something this extraction introduced.

**A second, separate quirk to know about when writing new fixtures**
(this one is about `texToPlain`, and bit `apps/tailor`'s own tests before
being caught — see below): `texToPlain` strips LaTeX commands and braces
but never inserts a separator where one was. `\section{Foo}\normalsize{Bar
baz.}` with **no whitespace between them** plain-texts to `"FooBar baz."` —
the last word of one region and the first word of the next fuse into one
token. Every real resume has whitespace/newlines there (see
`fullstack.tex`); a hand-written test fixture that crams sections
together on one line does not, and the fusion silently breaks vocabulary
matching in exactly the way a real bug would. Not a defect in the ported
code — a broken fixture that looks exactly like one if you don't check.

## `apps/tailor` — the stateless service that uses it

New Fastify app, `PORT=8200` by default. No database connection anywhere
— same boundary `services/ai` already holds (`specs/architecture.md`).
Internal-token auth mirrors `services/ai`'s `require_internal_token`
exactly: `INTERNAL_TOKEN` unset skips the check (local dev); configured,
every `/v1/*` route requires an exact `X-Internal-Token` match; `/healthz`
is always open, the same reasoning both services share (a liveness probe
should never need a secret).

| Route | Does |
|---|---|
| `POST /v1/parse` | `{tex} -> {fields, structured}` — thin wrapper over `parseResumeSource` |
| `POST /v1/validate-nouns` | `{tex, changes[]} -> {flags[]}` — parses `tex` fresh, then `validateProperNouns` |
| `POST /v1/reinject` | `{tex, accepted[]} -> {tex, applied[], skipped[], integrityOk, integrityViolations?}` — `applyAcceptedChanges` + `verifyKeepIntegrity` in one call, since a caller (Graph A) always wants both |
| `POST /v1/compile` | `{tex} -> application/pdf` bytes, `X-Pdf-Sha256` header; `422 {error, message, log}` on a real compile failure |

### PDF compilation — real, local, verified; one honest gap

`src/services/compile.ts` shells out to a real LaTeX engine
(`LATEX_ENGINE=pdflatex` by default) in a scratch temp directory, deleted
after every call regardless of outcome. **Judged by whether a `.pdf` file
actually appeared**, not by the engine's exit code — `pdflatex` has a long
history of exiting 0 on a document with warnings that still produced
something wrong; a caller needs a decisive answer, not a warning to
interpret itself.

**Verified against MiKTeX's real `pdflatex` locally** — no fake, no
stub: `test/compile.test.ts` compiles the real `fullstack.tex` fixture end
to end and asserts a genuine `%PDF-` byte signature, a 2-page-resume-sized
document (not a stub), and that the returned `X-Pdf-Sha256` header matches
a fresh hash of the actual bytes. A second test feeds a deliberately
broken document and asserts a `422` with a real, non-empty compiler log.

**The one named, un-closed gap**: D-30 picks `tectonic` for the
production image (smaller, self-contained, arm64-friendly). `tectonic`'s
CLI is genuinely different from `pdflatex`/`xelatex` — no
`-interaction`/`-output-directory` flags the way both of those share —
so `LATEX_ENGINE=tectonic` would **not** work today without also changing
how the process is invoked. Stated in `.env.example` rather than implied
to just work by swapping a value.

12 tests total, `pnpm --filter @jobswitch/tailor test`
(`test/routes.test.ts` + `test/compile.test.ts`): the four routes above,
the internal-token gate (rejects with none configured-and-missing,
accepts with the right one, `/healthz` exempt either way), and the two
real-compile tests.

## `services/ai/app/graphs/` — LangGraph

`langgraph>=1.2.11` (pulls in `langchain-core` for its type system only —
not the broader LangChain integrations ecosystem, consistent with this
service's existing "minimal dependency" pattern: `fastembed` over
`torch`+`sentence-transformers`, one HTTP client class over three
provider SDKs).

### Two real, documented deviations from the plan's literal diagrams

Both come from the same already-decided boundary: **`services/ai` is
stateless and never touches Postgres** (`specs/architecture.md`), the
exact boundary `/v1/match/explain`'s facts-in-the-request-body design
already lived inside since Phase 5.3.

1. **"`load_candidate_facts`/`load_match_context`" do not call back to any
   API for facts.** The request already carries them
   (`TailorRequest.facts`, same as `ExplainRequest.facts` always has).
   What `load_candidate_facts` actually does: call `apps/tailor`'s
   `/v1/parse` (the one thing nothing else has yet — the resume's own
   field structure) and dedupe the given facts by `ref`.
2. **PDF compilation is correctly not a graph node.** The plan's own
   words apply exactly: "compilation is deterministic execution with no
   decision point." It lives entirely in `apps/tailor`'s `/v1/compile`,
   called by whoever invokes Graph A after a human approves specific
   changes. Neither graph ever produces a PDF.

### Graph B — `/v1/match/explain`, upgraded in place

```
load_match_context -> draft_explanation -> self_critique -> provenance_gate
                            ^                                     |
                            └──── (unsupported claims, retries left) ──┘
                                                |
                                (final) -> finalize_explanation
```

Replaces Phase 5.3's plain sequential chain (`app/explain_service.py`,
**kept in the repo unchanged** as the documented "here's the naive
version, here's what the graph adds" comparison point — the build plan's
own framing for why the baseline ships first). `routers/explain.py` now
calls `run_explain_graph` instead of `draft_explanation` — **zero changes
to the request/response contract**, so `services/backend`'s Go client
(`internal/clients/ai.go`'s `Explain`, `internal/worker/explain.go`)
needed no changes either. `PROMPT_VERSION` bumped `1 -> 2` since the
underlying generation process materially changed.

`self_critique` is a genuine second LLM pass — for each evidence item, in
order, it answers `{claim, supported, matching_fact_id}`: real
traceability checking, not restated confidence. `provenance_gate` (plain
code) keeps an item only if **both** its `fact_ref` exists in the given
facts **and** `self_critique` marked it supported — the ref-existence
check runs first and unconditionally, so a hallucinated ref is stripped
regardless of what the critique pass claims about it.

**Deliberate asymmetry with Graph A**: on retry exhaustion (`MAX_RETRIES =
2`), this ships the shorter, fully-supported explanation rather than
blocking. A match explanation is read-only UI copy; a resume is a
document that might be submitted to an employer verbatim. Same risk
surface, different failure mode on purpose.

### Graph A — `POST /v1/tailor/resume`, new

```
extract_jd -> load_candidate_facts -> plan_edits -> provenance_gate -> apply_splice -> fabrication_check
                                            ^                                                |
                                            └──────────── (fail, retries left, max 2) ─────────┘
                                                                    |
                                                        (fail, retries exhausted)
                                                                    v
                                                         flag_for_manual_review
                                            (pass) -> finalize -> [status: "proposed"]
```

`provenance_gate` here is plain code with the sharper of the two rules in
this codebase: strips any edit whose `source_fact_refs` cites a fact that
either (a) wasn't in the request, or (b) carries provenance `ai_inference`
or `generated_text`. **This is the actual point of the asymmetry with
Graph B** — a fact good enough to justify read-only UI copy (the model's
own inference about the candidate) is not good enough to justify rewriting
a document that might be submitted to an employer. `apply_splice` calls
`apps/tailor`'s `/v1/reinject`; a `false` `integrityOk` in the response is
treated as an unreachable-but-checked invariant violation (raises, rather
than silently trusting a contract this important). `fabrication_check`
calls `/v1/validate-nouns`.

On retry exhaustion: **reverts to the byte-identical original tex**,
`status: "unchanged"`, with the last round's flags preserved so a caller
can show what couldn't be safely tailored and why. Never ships a
partially-fabricated edit under retry pressure, per the plan's own rule.

**A real bug, found by testing against the real `apps/tailor` service, not
by inspection**: `fabrication_check`'s first draft called
`/v1/validate-nouns` with the **already-spliced** tex. Since
`validateProperNouns` builds its "known vocabulary" from whatever document
it's handed, and the spliced document already contains the exact rewrite
being checked, every check trivially passed — a fabricated technology name
sailed through undetected in the first end-to-end test run. Fixed to pass
the **original** tex instead (`apply_splice`'s own `state["tex"]`, never
`state["spliced_tex"]`) — the same "compare against the true baseline, not
a moving target" property `verifyKeepIntegrity` already depends on one
layer down.

### Tests

`extract_jd`/`plan_edits`/`draft_explanation`/`self_critique` are the
paid, nondeterministic boundary — `FakeLLM` always, per this service's
standing rule (`tests/conftest.py`). `FakeLLM` gained a `responses: list`
mode (consumed in order, last entry repeats) specifically because a graph
makes more than one LLM call per pass, unlike Phase 5.3's plain chain.
`apps/tailor`, by contrast, is local, fast, deterministic, and owned by
this same repo — Graph A's tests call the **real running instance**,
skipping (not failing) if it isn't up, the same pattern
`services/backend`'s own cross-service tests already use for calling the
real `services/ai`.

| File | Proves |
|---|---|
| `tests/test_explain.py` | Existing Phase 5.3 route tests, updated for two calls per pass; the hallucinated-ref test now genuinely exercises one retry round, not just the gate in isolation |
| `tests/test_explain_graph.py` | Retry-exhaustion ships the shorter explanation, never an error; retries are bounded (`MAX_RETRIES`), not infinite, even against a pathologically unhelpful fake |
| `tests/test_tailor_graph.py` | Full happy path produces a real spliced document via the real `apps/tailor`; `provenance_gate` strips an `ai_inference`-grounded edit and a hallucinated-ref edit, in each case leaving the tex genuinely untouched; gives up and reverts to the byte-identical original after `MAX_RETRIES`, with real flags from the real fabrication check |

27 tests total, `uv run pytest`. `uv run ruff check .` / `uv run ruff
format --check .` both clean.

## Known gaps

- **Single-response only.** `graph.ainvoke()`, not `graph.astream()` — the
  build plan's own sequencing calls for the synchronous version to work
  end to end first. Streaming (`/stream`, NDJSON per node transition) is
  still unstarted for both graphs.
- ~~No caller wired up yet~~ **Wired, Phase 7**: `apps/web`'s `POST
  /api/v1/applications/:id/tailor` calls this directly (not through
  `services/backend`, which has no route to the tenant tables Graph A's
  human-approval step needs — see `specs/application-workspace.md`'s own
  "assembling facts, calling services/ai directly" section for why). The
  human-approval step between `finalize` and an actual `/v1/compile` call
  is `apps/web`'s `POST /api/v1/artifacts/:id/compile`, which reinjects
  the human-accepted subset into the **original** `resume_source` tex —
  not this graph's own already-spliced draft — for exactly the reason
  this file's own `fabrication_check` bug (above) already explains.
- **`jd_extraction`'s own cache table is unused by this graph.** Migration
  0008's `jd_extraction` (Layer-1-shared, keyed by
  `job_posting_version_id`) exists for exactly this purpose, but
  `services/ai` has no DB access to read or write it — a future caller
  (Phase 7, which does have DB access) would check that cache before
  calling `/v1/tailor/resume` and pass the cached extraction in, or accept
  paying for `extract_jd` again. Not wired either way yet.
- **No Dockerfile for `apps/tailor`.** Same gap `services/ai` already has,
  plus this service also needs its LaTeX engine baked into the image
  (D-30's tectonic decision, not yet implemented in code - see above).
