"""Shared request/response schemas.

This service is stateless and holds no DB grant of any kind (see
specs/architecture.md's boundary note) - every fact it reasons about
arrives already tagged with its provenance (ADR D-22) and is echoed back
tagged the same way. That boundary is enforced by these schemas requiring
`provenance` on every Fact, not by convention.
"""

from typing import Literal

from pydantic import BaseModel, Field

FactProvenance = Literal[
    "verified_fact",
    "self_asserted",
    "preference",
    "ai_inference",
    "generated_text",
]

# ---------------------------------------------------------------------------
# /v1/embed
# ---------------------------------------------------------------------------


class EmbedRequest(BaseModel):
    texts: list[str] = Field(..., min_length=1, max_length=64)
    kind: Literal["job", "profile"]


class EmbedResponse(BaseModel):
    model: str
    dim: int
    vectors: list[list[float]]


# ---------------------------------------------------------------------------
# /v1/match/explain
# ---------------------------------------------------------------------------


class Fact(BaseModel):
    ref: str
    text: str
    provenance: FactProvenance


class JobContext(BaseModel):
    title: str
    company: str | None = None
    description: str


class ExplainRequest(BaseModel):
    job: JobContext
    facts: list[Fact] = Field(default_factory=list)


class Evidence(BaseModel):
    claim: str
    fact_ref: str
    provenance: FactProvenance


class ExplanationDraft(BaseModel):
    """What the LLM is asked to return - validated before anything else
    touches it. A malformed shape here raises at the pydantic boundary,
    never passes through as partial data."""

    summary: str
    evidence: list[Evidence] = Field(default_factory=list)


class ExplainResponse(BaseModel):
    summary: str
    evidence: list[Evidence]
    model: str
    prompt_version: int
