"""Match explanation tests - against FakeLLM, never a real provider (see
conftest.py's note). What matters here is the code around the LLM call:
the provenance gate, and that malformed output is rejected rather than
silently trusted.
"""

from fastapi.testclient import TestClient

from app.main import app
from app.routers.explain import get_llm_client
from tests.fakes import FakeLLM

REQUEST_BODY = {
    "job": {
        "title": "Senior Frontend Engineer",
        "company": "Acme Corp",
        "description": "Build product surfaces in React and TypeScript.",
    },
    "facts": [
        {
            "ref": "profile:current_title",
            "text": "Senior Software Engineer",
            "provenance": "self_asserted",
        },
        {
            "ref": "resume:skill:react",
            "text": "4 years of React",
            "provenance": "verified_fact",
        },
    ],
}


def override_llm(fake: FakeLLM):
    app.dependency_overrides[get_llm_client] = lambda: fake


def test_explain_returns_the_llms_explanation(client: TestClient) -> None:
    fake = FakeLLM(
        {
            "summary": "Strong match on React experience and seniority.",
            "evidence": [
                {
                    "claim": "4 years of React",
                    "fact_ref": "resume:skill:react",
                    "provenance": "verified_fact",
                },
            ],
        }
    )
    override_llm(fake)
    try:
        res = client.post("/v1/match/explain", json=REQUEST_BODY)
        assert res.status_code == 200
        body = res.json()
        assert body["summary"] == "Strong match on React experience and seniority."
        assert len(body["evidence"]) == 1
        assert body["evidence"][0]["fact_ref"] == "resume:skill:react"
        assert body["model"] == "fake-model-v1"
        assert body["prompt_version"] == 1
    finally:
        app.dependency_overrides.clear()


def test_explain_provenance_gate_strips_evidence_citing_an_unknown_fact(
    client: TestClient,
) -> None:
    """The actual D-22 enforcement test: the model hallucinates a fact_ref
    that was never in the request. This must be stripped, not passed
    through to the candidate as if it were a grounded claim."""
    fake = FakeLLM(
        {
            "summary": "Great fit.",
            "evidence": [
                {
                    "claim": "4 years of React",
                    "fact_ref": "resume:skill:react",
                    "provenance": "verified_fact",
                },
                # Hallucinated - not in REQUEST_BODY's facts at all.
                {
                    "claim": "Fluent in Rust",
                    "fact_ref": "resume:skill:rust",
                    "provenance": "verified_fact",
                },
            ],
        }
    )
    override_llm(fake)
    try:
        res = client.post("/v1/match/explain", json=REQUEST_BODY)
        assert res.status_code == 200
        evidence = res.json()["evidence"]
        assert len(evidence) == 1
        assert evidence[0]["fact_ref"] == "resume:skill:react"
        assert all(e["fact_ref"] != "resume:skill:rust" for e in evidence)
    finally:
        app.dependency_overrides.clear()


def test_explain_with_no_valid_evidence_returns_empty_evidence_not_an_error(
    client: TestClient,
) -> None:
    fake = FakeLLM(
        {
            "summary": "Some fit, but nothing specific to point to.",
            "evidence": [
                {
                    "claim": "made up",
                    "fact_ref": "nonexistent",
                    "provenance": "verified_fact",
                }
            ],
        }
    )
    override_llm(fake)
    try:
        res = client.post("/v1/match/explain", json=REQUEST_BODY)
        assert res.status_code == 200
        assert res.json()["evidence"] == []
    finally:
        app.dependency_overrides.clear()


def test_explain_maps_malformed_llm_output_to_502_not_500_or_200(
    client: TestClient,
) -> None:
    fake = FakeLLM(raise_malformed=True)
    override_llm(fake)
    try:
        res = client.post("/v1/match/explain", json=REQUEST_BODY)
        assert res.status_code == 502
    finally:
        app.dependency_overrides.clear()


def test_explain_rejects_a_response_missing_the_required_summary_field(
    client: TestClient,
) -> None:
    """Not just 'non-JSON' - valid JSON that doesn't match the expected
    shape must also be rejected, not silently coerced."""
    fake = FakeLLM({"evidence": []})  # no "summary" key at all
    override_llm(fake)
    try:
        res = client.post("/v1/match/explain", json=REQUEST_BODY)
        assert res.status_code == 502
    finally:
        app.dependency_overrides.clear()


def test_explain_passes_the_facts_to_the_prompt(client: TestClient) -> None:
    fake = FakeLLM({"summary": "ok", "evidence": []})
    override_llm(fake)
    try:
        client.post("/v1/match/explain", json=REQUEST_BODY)
        assert "resume:skill:react" in fake.last_user
        assert "Senior Frontend Engineer" in fake.last_user
    finally:
        app.dependency_overrides.clear()


def test_explain_returns_503_when_no_provider_is_configured(client: TestClient) -> None:
    # No override - the real get_llm_client dependency runs, which raises
    # LLMConfigError because this test environment has no real API keys
    # (see app/llm.py's own doc comment on why that's true and expected).
    res = client.post("/v1/match/explain", json=REQUEST_BODY)
    assert res.status_code == 503
