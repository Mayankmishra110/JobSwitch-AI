"""Match explanation - Phase 5.3's plain sequential chain.

One LLM call, then one deterministic filter. This is deliberately NOT
LangGraph's Graph B yet (specs/matching-pipeline.md once that phase
lands): no retry loop, no self-critique pass, no bounded-retry state
machine. The point of shipping this first is exactly what the build plan
says - guarantee a working, cheaper baseline exists before the graph
version becomes a deliberate, separately-explainable upgrade on top of it.
"""

import json

from .llm import LLMClient
from .models import ExplainResponse, ExplanationDraft, Fact, JobContext

PROMPT_VERSION = 1

EXPLAIN_SYSTEM = """You explain why a job posting is a good match for a candidate, using ONLY the facts you are given.

HARD RULES:
1. Every item in "evidence" must cite exactly one fact by its "ref" value from the facts you were given. Never invent a ref.
2. Never state a claim that isn't directly supported by one of the provided facts.
3. A fact tagged "ai_inference" or "generated_text" may still be cited, but do not present it with more certainty than a "verified_fact" - use hedging language ("likely", "appears to") for inferred facts.
4. Keep "summary" to 2-3 sentences, written for the candidate, not the employer.
5. Return ONLY this JSON shape, nothing else:
   {"summary": "...", "evidence": [{"claim": "...", "fact_ref": "...", "provenance": "..."}]}
"""


def _build_user_prompt(job: JobContext, facts: list[Fact]) -> str:
    facts_json = json.dumps([f.model_dump() for f in facts], indent=2)
    description = job.description[
        :4000
    ]  # bound prompt size, same spirit as nipun's own truncation limits
    company = job.company or "the company"
    return (
        f"Job: {job.title} at {company}\n\n"
        f"Description:\n{description}\n\n"
        f"Candidate facts (cite these by ref):\n{facts_json}"
    )


def _provenance_gate(draft: ExplanationDraft, facts: list[Fact]) -> list:
    """The actual D-22 enforcement for this endpoint: strip any evidence
    item citing a fact_ref that doesn't correspond to a fact we actually
    sent. This is plain code, not a prompt instruction the model could
    ignore - the same principle the eventual LangGraph version's own
    provenance_gate node applies, done here as a function because Phase
    5.3 has no graph to put a node in yet.
    """
    valid_refs = {f.ref for f in facts}
    return [e for e in draft.evidence if e.fact_ref in valid_refs]


async def draft_explanation(
    llm: LLMClient, job: JobContext, facts: list[Fact]
) -> ExplainResponse:
    raw = await llm.complete_json(EXPLAIN_SYSTEM, _build_user_prompt(job, facts))

    # Malformed shape raises here (pydantic ValidationError) - never passes
    # through as a partial or best-effort explanation.
    draft = ExplanationDraft.model_validate(raw)

    evidence = _provenance_gate(draft, facts)

    return ExplainResponse(
        summary=draft.summary,
        evidence=evidence,
        model=llm.model,
        prompt_version=PROMPT_VERSION,
    )
