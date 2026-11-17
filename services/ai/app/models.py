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


# ---------------------------------------------------------------------------
# Graph B (match explanation) internal shapes - not part of the public
# request/response contract above, which stays byte-compatible with the
# plain-chain baseline it replaces.
# ---------------------------------------------------------------------------


class ClaimCritique(BaseModel):
    """One self_critique verdict on one evidence item - genuine second-pass
    traceability checking (specs/matching-pipeline.md's Graph B), not
    restated confidence. Index-aligned with the draft's own evidence list."""

    claim: str
    supported: bool
    matching_fact_id: str | None = None


class SelfCritique(BaseModel):
    critiques: list[ClaimCritique] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# /v1/tailor/resume (Graph A)
# ---------------------------------------------------------------------------


class JdExtraction(BaseModel):
    """extract_jd's own output shape - mirrors Mayankbuilt's nipun pipeline
    types.ts JdExtraction verbatim (the same structure that pipeline's
    first LLM call already produced), not reinvented for this port."""

    hard_skills: list[str] = Field(default_factory=list)
    tools: list[str] = Field(default_factory=list)
    soft_skills: list[str] = Field(default_factory=list)
    years_experience_required: str = ""
    seniority_level: str = ""
    required_keywords: list[str] = Field(default_factory=list)
    nice_to_have_keywords: list[str] = Field(default_factory=list)


class TailorRequest(BaseModel):
    tex: str
    job: JobContext
    facts: list[Fact] = Field(default_factory=list)


class ProposedEdit(BaseModel):
    """Must cite the fact(s) behind it - plan_edits' own output contract,
    enforced structurally: a plan_edits response with no source_fact_refs
    at all still parses, but provenance_gate then has nothing to check it
    against and drops it (see tailor_graph.py)."""

    field: str
    rewritten: str
    source_fact_refs: list[str] = Field(default_factory=list)


class PlannedEdits(BaseModel):
    """What plan_edits asks the LLM to return."""

    edits: list[ProposedEdit] = Field(default_factory=list)


class ProperNounFlagOut(BaseModel):
    field: str
    token: str
    reason: Literal["new-entity", "new-metric"]
    rewritten: str


TailorStatus = Literal["proposed", "unchanged"]


class TailorResponse(BaseModel):
    status: TailorStatus
    tex: str
    proposed_changes: list[ProposedEdit] = Field(default_factory=list)
    accepted_fields: list[str] = Field(default_factory=list)
    flags: list[ProperNounFlagOut] = Field(default_factory=list)
    retries_used: int = 0
    model: str
    prompt_version: int
