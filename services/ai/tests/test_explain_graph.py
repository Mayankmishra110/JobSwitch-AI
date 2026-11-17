"""Graph B specifics not already covered via the HTTP route in
test_explain.py: retry-exhaustion behavior and the retry bound itself.
"""

import pytest

from app.graphs.explain_graph import MAX_RETRIES, run_explain_graph
from app.models import Fact, JobContext
from tests.fakes import FakeLLM

JOB = JobContext(
    title="Senior Frontend Engineer", company="Acme", description="Build UIs."
)
FACTS = [Fact(ref="skill:react", text="4 years of React", provenance="verified_fact")]


@pytest.mark.asyncio
async def test_ships_the_shorter_explanation_after_retries_exhausted() -> None:
    """Deliberate asymmetry with Graph A: on final failure, this ships the
    shorter, fully-supported explanation rather than blocking - never an
    error, because a match explanation is read-only UI copy."""
    always_unsupported_critique = {
        "critiques": [
            {"claim": "4 years of React", "supported": False, "matching_fact_id": None}
        ],
    }
    draft = {
        "summary": "Great fit.",
        "evidence": [
            {
                "claim": "4 years of React",
                "fact_ref": "skill:react",
                "provenance": "verified_fact",
            }
        ],
    }
    # draft, critique, retry-draft, retry-critique, retry-draft, retry-critique
    # (MAX_RETRIES=2 retries -> 3 total draft/critique rounds).
    fake = FakeLLM(responses=[draft, always_unsupported_critique] * (MAX_RETRIES + 1))

    result = await run_explain_graph(fake, JOB, FACTS)

    assert result.summary == "Great fit."
    assert result.evidence == []  # the one claim never became supported
    # 1 initial + MAX_RETRIES retries, each a (draft, critique) pair.
    assert len(fake.calls) == (MAX_RETRIES + 1) * 2


@pytest.mark.asyncio
async def test_retries_are_bounded_not_infinite() -> None:
    """A pathologically unhelpful LLM must never turn one request into an
    unbounded number of calls."""
    draft = {
        "summary": "x",
        "evidence": [
            {"claim": "c", "fact_ref": "skill:react", "provenance": "verified_fact"}
        ],
    }
    unsupported = {
        "critiques": [{"claim": "c", "supported": False, "matching_fact_id": None}]
    }
    # Provide far more rounds than could ever legitimately be consumed - if
    # the bound were broken, this test would simply hang/exhaust the list.
    fake = FakeLLM(responses=([draft, unsupported] * 10))

    await run_explain_graph(fake, JOB, FACTS)

    assert len(fake.calls) == (MAX_RETRIES + 1) * 2
