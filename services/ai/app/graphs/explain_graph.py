"""Graph B - match explanation, LangGraph upgrade of explain_service.py's
plain sequential chain (Phase 5.3 baseline, kept in the repo unchanged as
the documented "here's the naive version, here's what the graph adds"
comparison point - see specs/matching-pipeline.md).

    load_match_context -> draft_explanation -> self_critique -> provenance_gate
                                ^                                     |
                                └──── (unsupported claims, retries left) ──┘
                                                    |
                                    (final) -> finalize_explanation

self_critique is a genuine second LLM pass, not restated confidence: for
each claim in the draft, it answers {claim, supported, matching_fact_id} -
real traceability checking. provenance_gate is plain code (D-22's actual
enforcement, same principle as the plain chain's own _provenance_gate, now
also checking self_critique's verdict, not just whether the fact_ref
exists at all).

Deliberate asymmetry with Graph A (tailor_graph.py): on final failure here
(retries exhausted, still some unsupported claim), this ships the shorter,
fully-supported explanation rather than blocking - a match explanation is
read-only UI copy, not a document submitted to an employer. State this
distinction if asked; it is risk-per-surface reasoning, not one rule
applied by habit.
"""

import json
from typing import TypedDict

from langgraph.graph import END, StateGraph

from ..llm import LLMClient
from ..models import (
    ClaimCritique,
    Evidence,
    ExplainResponse,
    ExplanationDraft,
    Fact,
    JobContext,
    SelfCritique,
)

PROMPT_VERSION = 2  # Graph B - bumped from the plain chain's PROMPT_VERSION = 1
MAX_RETRIES = 2

DRAFT_SYSTEM = """You explain why a job posting is a good match for a candidate, using ONLY the facts you are given.

HARD RULES:
1. Every item in "evidence" must cite exactly one fact by its "ref" value from the facts you were given. Never invent a ref.
2. Never state a claim that isn't directly supported by one of the provided facts.
3. A fact tagged "ai_inference" or "generated_text" may still be cited, but do not present it with more certainty than a "verified_fact" - use hedging language ("likely", "appears to") for inferred facts.
4. Keep "summary" to 2-3 sentences, written for the candidate, not the employer.
5. Return ONLY this JSON shape, nothing else:
   {"summary": "...", "evidence": [{"claim": "...", "fact_ref": "...", "provenance": "..."}]}
"""

CRITIQUE_SYSTEM = """You are fact-checking a draft explanation against the facts it was supposed to be grounded in.

For EACH evidence item you are given, in the SAME ORDER, decide whether the claim is genuinely, specifically supported by the fact it cites - not just plausible, but actually stated by that fact's text.

Return ONLY this JSON shape, with exactly one critique per evidence item, in order:
   {"critiques": [{"claim": "...", "supported": true|false, "matching_fact_id": "the fact ref, or null if unsupported"}]}
"""


class ExplainGraphState(TypedDict, total=False):
    job: JobContext
    facts: list[Fact]
    draft: ExplanationDraft
    critique: SelfCritique
    retry_count: int
    feedback: str | None
    final_summary: str
    final_evidence: list[Evidence]
    # Set by provenance_gate, read by should_retry/prepare_retry - a
    # human-readable description of what got cut and why, threaded into
    # the next draft attempt's prompt if one happens.
    pending_feedback: str | None


def _build_draft_prompt(
    job: JobContext, facts: list[Fact], feedback: str | None
) -> str:
    facts_json = json.dumps([f.model_dump() for f in facts], indent=2)
    description = job.description[:4000]
    company = job.company or "the company"
    feedback_block = (
        f"\n\nFeedback from a previous attempt - fix this: {feedback}"
        if feedback
        else ""
    )
    return (
        f"Job: {job.title} at {company}\n\n"
        f"Description:\n{description}\n\n"
        f"Candidate facts (cite these by ref):\n{facts_json}{feedback_block}"
    )


def _build_critique_prompt(draft: ExplanationDraft, facts: list[Fact]) -> str:
    facts_json = json.dumps([f.model_dump() for f in facts], indent=2)
    evidence_json = json.dumps([e.model_dump() for e in draft.evidence], indent=2)
    return f"Facts:\n{facts_json}\n\nEvidence to check, in order:\n{evidence_json}"


def build_explain_graph(llm: LLMClient):
    async def load_match_context(state: ExplainGraphState) -> dict:
        # Stateless normalization only - services/ai never fetches facts
        # itself (specs/architecture.md's no-DB boundary); the request
        # already carries them, same as the plain chain. Dedup by ref so a
        # caller-side duplicate never gets cited twice.
        seen: set[str] = set()
        deduped: list[Fact] = []
        for f in state["facts"]:
            if f.ref in seen:
                continue
            seen.add(f.ref)
            deduped.append(f)
        return {"facts": deduped, "retry_count": 0, "feedback": None}

    async def draft_explanation(state: ExplainGraphState) -> dict:
        raw = await llm.complete_json(
            DRAFT_SYSTEM,
            _build_draft_prompt(state["job"], state["facts"], state.get("feedback")),
        )
        draft = ExplanationDraft.model_validate(raw)
        return {"draft": draft}

    async def self_critique(state: ExplainGraphState) -> dict:
        draft = state["draft"]
        if not draft.evidence:
            return {"critique": SelfCritique(critiques=[])}
        raw = await llm.complete_json(
            CRITIQUE_SYSTEM, _build_critique_prompt(draft, state["facts"])
        )
        critique = SelfCritique.model_validate(raw)
        return {"critique": critique}

    def provenance_gate(state: ExplainGraphState) -> dict:
        draft = state["draft"]
        critique = state["critique"]
        valid_refs = {f.ref for f in state["facts"]}

        # Index-aligned with critique.critiques, per CRITIQUE_SYSTEM's own
        # instruction - a critique list shorter than the evidence list (a
        # malformed LLM response) treats the missing tail as unsupported
        # rather than crashing or assuming success.
        survivors: list[Evidence] = []
        unsupported: list[str] = []
        for i, item in enumerate(draft.evidence):
            verdict: ClaimCritique | None = (
                critique.critiques[i] if i < len(critique.critiques) else None
            )
            if item.fact_ref not in valid_refs:
                unsupported.append(f"{item.claim!r} cited an unknown fact_ref")
                continue
            if verdict is None or not verdict.supported:
                unsupported.append(f"{item.claim!r} was not verified as supported")
                continue
            survivors.append(item)

        return {
            "final_summary": draft.summary,
            "final_evidence": survivors,
            "pending_feedback": "; ".join(unsupported) if unsupported else None,
        }

    def should_retry(state: ExplainGraphState) -> str:
        if state.get("pending_feedback") and state.get("retry_count", 0) < MAX_RETRIES:
            return "retry"
        return "finalize"

    async def prepare_retry(state: ExplainGraphState) -> dict:
        return {
            "retry_count": state.get("retry_count", 0) + 1,
            "feedback": state.get("pending_feedback"),
        }

    def finalize_explanation(state: ExplainGraphState) -> dict:
        return {}

    graph = StateGraph(ExplainGraphState)
    graph.add_node("load_match_context", load_match_context)
    graph.add_node("draft_explanation", draft_explanation)
    graph.add_node("self_critique", self_critique)
    graph.add_node("provenance_gate", provenance_gate)
    graph.add_node("prepare_retry", prepare_retry)
    graph.add_node("finalize_explanation", finalize_explanation)

    graph.set_entry_point("load_match_context")
    graph.add_edge("load_match_context", "draft_explanation")
    graph.add_edge("draft_explanation", "self_critique")
    graph.add_edge("self_critique", "provenance_gate")
    graph.add_conditional_edges(
        "provenance_gate",
        should_retry,
        {"retry": "prepare_retry", "finalize": "finalize_explanation"},
    )
    graph.add_edge("prepare_retry", "draft_explanation")
    graph.add_edge("finalize_explanation", END)

    return graph.compile()


async def run_explain_graph(
    llm: LLMClient, job: JobContext, facts: list[Fact]
) -> ExplainResponse:
    graph = build_explain_graph(llm)
    result = await graph.ainvoke({"job": job, "facts": facts})
    return ExplainResponse(
        summary=result["final_summary"],
        evidence=result["final_evidence"],
        model=llm.model,
        prompt_version=PROMPT_VERSION,
    )
