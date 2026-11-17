"""Graph A tests. Two boundaries, two different testing strategies (same
split as everywhere else in this codebase): the LLM is a paid,
nondeterministic third party (FakeLLM, always); apps/tailor is a local,
fast, deterministic HTTP service this repo also owns, so these tests call
the REAL running instance - skipping (not failing) if it isn't up, the
same pattern services/backend's own tests use for calling the real
services/ai.
"""

import httpx
import pytest
import pytest_asyncio

from app.graphs.tailor_graph import MAX_RETRIES, run_tailor_graph
from app.models import Fact, JobContext
from app.tailor_client import TailorClient
from tests.fakes import FakeLLM

TAILOR_URL = "http://127.0.0.1:8200"

SAMPLE_TEX = (
    "\\documentclass{article}\\begin{document}\n"
    # A real resume always has whitespace between a \section header and the
    # \normalsize block that follows (see resume-core's own fixture,
    # fullstack.tex) - texToPlain strips braces/commands but never inserts
    # a separator, so cramming them together with no whitespace at all
    # (as an earlier version of this fixture did) fuses the last word of
    # one with the first word of the next into one token ("SummaryGo") and
    # silently breaks proper-noun vocabulary matching. Not a bug in the
    # ported code - a broken test fixture looks exactly like one if you
    # don't check for it, which is exactly what happened while writing
    # this test the first time.
    "\\section{Professional Summary}\n"
    "\\normalsize{Backend engineer with 5 years of Go and API experience.}\n"
    "\\end{document}"
)

JOB = JobContext(
    title="Senior Backend Engineer",
    company="Acme",
    description="Build scalable APIs in Go.",
)


def require_real_tailor_service() -> None:
    try:
        resp = httpx.get(f"{TAILOR_URL}/healthz", timeout=2.0)
        if resp.status_code != 200:
            pytest.skip(f"apps/tailor is not healthy at {TAILOR_URL}")
    except httpx.HTTPError:
        pytest.skip(
            f"apps/tailor is not reachable at {TAILOR_URL} "
            "(run `pnpm --filter @jobswitch/tailor dev` in apps/tailor)"
        )


@pytest_asyncio.fixture()
async def tailor_client() -> TailorClient:
    require_real_tailor_service()
    async with httpx.AsyncClient(timeout=10.0) as http_client:
        yield TailorClient(TAILOR_URL, None, http_client)


@pytest.mark.asyncio
async def test_full_happy_path_produces_a_spliced_document(
    tailor_client: TailorClient,
) -> None:
    facts = [Fact(ref="skill:go", text="5 years of Go", provenance="verified_fact")]
    fake = FakeLLM(
        responses=[
            # extract_jd
            {
                "hard_skills": ["Go"],
                "tools": [],
                "soft_skills": [],
                "years_experience_required": "5+",
                "seniority_level": "senior",
                "required_keywords": ["Go"],
                "nice_to_have_keywords": [],
            },
            # plan_edits - reorders words already present in SAMPLE_TEX's own
            # summary. Deliberately introduces nothing new: apps/tailor's
            # real /v1/validate-nouns call would (correctly) flag a genuinely
            # new number or entity even when a cited fact backs it, since
            # that service is fact-agnostic by design (specs/architecture.md
            # - it never sees "facts," only resume text) - see the
            # "gives up" test below for that path exercised on purpose.
            {
                "edits": [
                    {
                        "field": "summary",
                        "rewritten": "Go and API backend engineer with 5 years of experience.",
                        "source_fact_refs": ["skill:go"],
                    }
                ]
            },
        ]
    )

    result = await run_tailor_graph(fake, tailor_client, SAMPLE_TEX, JOB, facts)

    assert result.status == "proposed"
    assert "Go and API backend engineer" in result.tex
    assert result.accepted_fields == ["summary"]
    assert result.flags == []
    assert result.retries_used == 0


@pytest.mark.asyncio
async def test_provenance_gate_strips_an_edit_grounded_only_in_an_inference(
    tailor_client: TailorClient,
) -> None:
    """The actual asymmetry with Graph B: a fact tagged ai_inference is not
    good enough to justify rewriting a document that might be submitted to
    an employer verbatim - stripped before apply_splice ever sees it."""
    facts = [
        Fact(
            ref="inferred:leadership",
            text="Likely has leadership experience",
            provenance="ai_inference",
        )
    ]
    fake = FakeLLM(
        responses=[
            {
                "hard_skills": [],
                "tools": [],
                "soft_skills": [],
                "years_experience_required": "",
                "seniority_level": "",
                "required_keywords": [],
                "nice_to_have_keywords": [],
            },
            {
                "edits": [
                    {
                        "field": "summary",
                        "rewritten": "Proven engineering leader.",
                        "source_fact_refs": ["inferred:leadership"],
                    }
                ]
            },
        ]
    )

    result = await run_tailor_graph(fake, tailor_client, SAMPLE_TEX, JOB, facts)

    # The edit was stripped by provenance_gate, so apply_splice had nothing
    # to apply - the document comes back unchanged, not with the
    # inference-grounded rewrite.
    assert result.status == "proposed"
    assert result.tex == SAMPLE_TEX
    assert result.accepted_fields == []


@pytest.mark.asyncio
async def test_provenance_gate_strips_an_edit_citing_an_unknown_fact(
    tailor_client: TailorClient,
) -> None:
    facts = [Fact(ref="skill:go", text="5 years of Go", provenance="verified_fact")]
    fake = FakeLLM(
        responses=[
            {
                "hard_skills": [],
                "tools": [],
                "soft_skills": [],
                "years_experience_required": "",
                "seniority_level": "",
                "required_keywords": [],
                "nice_to_have_keywords": [],
            },
            # Hallucinated ref - "skill:kubernetes" was never sent.
            {
                "edits": [
                    {
                        "field": "summary",
                        "rewritten": "Kubernetes expert.",
                        "source_fact_refs": ["skill:kubernetes"],
                    }
                ]
            },
        ]
    )

    result = await run_tailor_graph(fake, tailor_client, SAMPLE_TEX, JOB, facts)

    assert result.tex == SAMPLE_TEX
    assert result.accepted_fields == []


@pytest.mark.asyncio
async def test_gives_up_and_reverts_to_the_original_after_retries_exhausted(
    tailor_client: TailorClient,
) -> None:
    """Never ships a partially-fabricated edit, even under retry pressure -
    the plan's own rule. A rewrite that introduces a brand-new, unverified
    proper noun trips apps/tailor's real fabrication check every round."""
    facts = [Fact(ref="skill:go", text="Go experience", provenance="verified_fact")]
    extract_jd_response = {
        "hard_skills": [],
        "tools": [],
        "soft_skills": [],
        "years_experience_required": "",
        "seniority_level": "",
        "required_keywords": [],
        "nice_to_have_keywords": [],
    }
    # Every plan_edits call proposes the same fabricated technology
    # ("Kubernetes" is never mentioned in SAMPLE_TEX or the facts) - the
    # real apps/tailor /v1/validate-nouns call will flag it every time.
    plan_edits_response = {
        "edits": [
            {
                "field": "summary",
                "rewritten": "Backend engineer skilled in Kubernetes.",
                "source_fact_refs": ["skill:go"],
            }
        ]
    }
    fake = FakeLLM(
        responses=[extract_jd_response] + [plan_edits_response] * (MAX_RETRIES + 1)
    )

    result = await run_tailor_graph(fake, tailor_client, SAMPLE_TEX, JOB, facts)

    assert result.status == "unchanged"
    assert (
        result.tex == SAMPLE_TEX
    )  # byte-identical original, not a corrupted partial edit
    assert result.accepted_fields == []
    assert len(result.flags) > 0
    assert result.retries_used == MAX_RETRIES
