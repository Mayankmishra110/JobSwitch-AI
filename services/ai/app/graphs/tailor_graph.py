"""Graph A - resume tailoring (specs/matching-pipeline.md, docs/BUILD_PLAN.md).

    extract_jd -> load_candidate_facts -> plan_edits -> provenance_gate -> apply_splice -> fabrication_check
                                                ^                                                |
                                                └──────────── (fail, retries left, max 2) ─────────┘
                                                                        |
                                                            (fail, retries exhausted)
                                                                        v
                                                             flag_for_manual_review
                                                ( pass) -> finalize -> [resume.tailoring.proposed]

Two real deviations from the plan's literal text, both because of the
already-decided "services/ai is stateless, no DB, no fact-fetching of its
own" boundary (specs/architecture.md) - the same boundary /v1/match/explain
already lives inside:

  - "load_candidate_facts" does not call back to any API for facts - the
    request already carries them (TailorRequest.facts), same as
    ExplainRequest.facts always has. What this node actually does is call
    apps/tailor's /v1/parse (the resume's OWN structure, which nothing
    else has yet) and dedupe the given facts - the real "gather what
    plan_edits needs" step in this implementation.
  - PDF compilation is correctly NOT a node here (the plan's own call:
    "compilation is deterministic execution with no decision point") - it
    lives entirely in apps/tailor's /v1/compile, called by whoever
    invokes this graph, after a human approves specific changes. This
    graph never produces a PDF.

provenance_gate is plain code, not an LLM call - D-22's actual enforcement:
strips any edit citing a fact that isn't in the request, or one tagged
"ai_inference"/"generated_text". This is the one point of genuine asymmetry
with Graph B: a fact good enough to justify UI copy (an LLM's own inference
about the candidate) is NOT good enough to justify rewriting a document
that might be submitted to an employer verbatim.
"""

import json
from typing import Any, TypedDict

from langgraph.graph import END, StateGraph

from ..llm import LLMClient
from ..models import (
    Fact,
    JdExtraction,
    JobContext,
    PlannedEdits,
    ProperNounFlagOut,
    ProposedEdit,
    TailorResponse,
)
from ..tailor_client import TailorClient

PROMPT_VERSION = 1
MAX_RETRIES = 2

# A fact this weak must never be the sole justification for rewriting a
# document that might go to an employer verbatim - see this module's own
# doc comment on the asymmetry with Graph B.
UNTRUSTWORTHY_PROVENANCE = {"ai_inference", "generated_text"}

EXTRACT_JD_SYSTEM = """Extract structure from this job description. Return ONLY this JSON shape:
{"hard_skills": [...], "tools": [...], "soft_skills": [...], "years_experience_required": "...", "seniority_level": "...", "required_keywords": [...], "nice_to_have_keywords": [...]}
Use empty strings/arrays for anything not mentioned. Do not invent requirements not stated or clearly implied."""

PLAN_EDITS_SYSTEM = """You propose rewrites to specific fields of a candidate's resume to better match a job, using ONLY the candidate facts you are given.

HARD RULES:
1. Only propose edits for field ids that appear in the "editable fields" list you are given. Never invent a field id.
2. Every edit's "source_fact_refs" must list the fact "ref" value(s) that justify it. Never invent a ref, and never leave source_fact_refs empty for a substantive rewrite.
3. Do not introduce a company, project, technology, or number that isn't already in the original field or supported by a cited fact.
4. Propose the smallest set of edits that meaningfully improves the match - not a rewrite of every field.
5. Return ONLY this JSON shape:
   {"edits": [{"field": "...", "rewritten": "...", "source_fact_refs": ["..."]}]}
"""


class TailorGraphState(TypedDict, total=False):
    tex: str  # original source - never mutated, always the fallback
    job: JobContext
    facts: list[Fact]
    jd_extraction: JdExtraction
    editable_fields: list[dict[str, Any]]
    planned_edits: list[ProposedEdit]
    retry_count: int
    feedback: str | None
    spliced_tex: str
    applied: list[dict[str, Any]]
    flags: list[ProperNounFlagOut]
    status: str
    final_tex: str
    accepted_fields: list[str]


def _fields_summary(fields: list[dict[str, Any]]) -> str:
    return json.dumps(
        [{"id": f["id"], "kind": f["kind"], "original": f["original"]} for f in fields],
        indent=2,
    )


def build_tailor_graph(llm: LLMClient, tailor: TailorClient):
    async def extract_jd(state: TailorGraphState) -> dict:
        raw = await llm.complete_json(
            EXTRACT_JD_SYSTEM, state["job"].description[:6000]
        )
        return {
            "jd_extraction": JdExtraction.model_validate(raw),
            "retry_count": 0,
            "feedback": None,
        }

    async def load_candidate_facts(state: TailorGraphState) -> dict:
        seen: set[str] = set()
        deduped: list[Fact] = []
        for f in state["facts"]:
            if f.ref in seen:
                continue
            seen.add(f.ref)
            deduped.append(f)

        parsed = await tailor.parse(state["tex"])
        return {"facts": deduped, "editable_fields": parsed["fields"]}

    async def plan_edits(state: TailorGraphState) -> dict:
        jd = state["jd_extraction"]
        facts_json = json.dumps([f.model_dump() for f in state["facts"]], indent=2)
        feedback_block = (
            f"\n\nFeedback from a previous attempt - fix this: {state['feedback']}"
            if state.get("feedback")
            else ""
        )
        user_prompt = (
            f"Job: {state['job'].title}\n\n"
            f"Extracted requirements: {jd.model_dump_json()}\n\n"
            f"Editable fields:\n{_fields_summary(state['editable_fields'])}\n\n"
            f"Candidate facts (cite these by ref):\n{facts_json}{feedback_block}"
        )
        raw = await llm.complete_json(PLAN_EDITS_SYSTEM, user_prompt)
        planned = PlannedEdits.model_validate(raw)
        return {"planned_edits": planned.edits}

    def provenance_gate(state: TailorGraphState) -> dict:
        valid_field_ids = {f["id"] for f in state["editable_fields"]}
        facts_by_ref = {f.ref: f for f in state["facts"]}

        survivors: list[ProposedEdit] = []
        for edit in state["planned_edits"]:
            if edit.field not in valid_field_ids:
                continue
            if not edit.source_fact_refs:
                continue
            cited = [facts_by_ref.get(ref) for ref in edit.source_fact_refs]
            if any(f is None for f in cited):
                continue  # cites a fact that was never given - D-22 violation
            if any(
                f.provenance in UNTRUSTWORTHY_PROVENANCE for f in cited if f is not None
            ):
                continue  # inference/generated-text is not grounds to rewrite a real document
            survivors.append(edit)

        return {"planned_edits": survivors}

    async def apply_splice(state: TailorGraphState) -> dict:
        accepted = [
            {"field": e.field, "rewritten": e.rewritten} for e in state["planned_edits"]
        ]
        result = await tailor.reinject(state["tex"], accepted)
        if not result["integrityOk"]:
            # Should be unreachable - apps/tailor's own reinject guarantees
            # this - but a caller-side contract this important gets its
            # own explicit check rather than trusting silently.
            raise RuntimeError(
                f"apps/tailor reinject failed its own integrity check: {result}"
            )
        return {"spliced_tex": result["tex"], "applied": result["applied"]}

    async def fabrication_check(state: TailorGraphState) -> dict:
        if not state["applied"]:
            return {"flags": []}
        # The ORIGINAL tex, not spliced_tex - a genuinely load-bearing
        # distinction, found by testing against a real apps/tailor call
        # rather than by inspection. validateProperNouns builds its "known
        # vocabulary" from whatever document it's handed; handing it the
        # already-spliced text would mean checking each change's rewritten
        # content against a vocabulary that already contains that exact
        # content (the splice put it there), making every check trivially
        # pass no matter how fabricated the content actually was.
        flags = await tailor.validate_nouns(state["tex"], state["applied"])
        return {"flags": [ProperNounFlagOut.model_validate(f) for f in flags]}

    def should_retry(state: TailorGraphState) -> str:
        if not state["flags"]:
            return "finalize"
        if state.get("retry_count", 0) < MAX_RETRIES:
            return "retry"
        return "give_up"

    async def prepare_retry(state: TailorGraphState) -> dict:
        flagged = "; ".join(
            f"{f.field}: {f.token!r} ({f.reason})" for f in state["flags"]
        )
        return {
            "retry_count": state.get("retry_count", 0) + 1,
            "feedback": f"These changes introduced unverified content, avoid repeating them: {flagged}",
        }

    def finalize(state: TailorGraphState) -> dict:
        return {
            "status": "proposed",
            "final_tex": state["spliced_tex"],
            "accepted_fields": [a["field"] for a in state["applied"]],
        }

    def flag_for_manual_review(state: TailorGraphState) -> dict:
        # Never ships a partially-fabricated edit, even under retry
        # pressure - the plan's own rule. Reverts to the byte-identical
        # original; the flags survive so the caller can show the candidate
        # what could not be safely tailored, and why.
        return {"status": "unchanged", "final_tex": state["tex"], "accepted_fields": []}

    graph = StateGraph(TailorGraphState)
    graph.add_node("extract_jd", extract_jd)
    graph.add_node("load_candidate_facts", load_candidate_facts)
    graph.add_node("plan_edits", plan_edits)
    graph.add_node("provenance_gate", provenance_gate)
    graph.add_node("apply_splice", apply_splice)
    graph.add_node("fabrication_check", fabrication_check)
    graph.add_node("prepare_retry", prepare_retry)
    graph.add_node("finalize", finalize)
    graph.add_node("flag_for_manual_review", flag_for_manual_review)

    graph.set_entry_point("extract_jd")
    graph.add_edge("extract_jd", "load_candidate_facts")
    graph.add_edge("load_candidate_facts", "plan_edits")
    graph.add_edge("plan_edits", "provenance_gate")
    graph.add_edge("provenance_gate", "apply_splice")
    graph.add_edge("apply_splice", "fabrication_check")
    graph.add_conditional_edges(
        "fabrication_check",
        should_retry,
        {
            "retry": "prepare_retry",
            "finalize": "finalize",
            "give_up": "flag_for_manual_review",
        },
    )
    graph.add_edge("prepare_retry", "plan_edits")
    graph.add_edge("finalize", END)
    graph.add_edge("flag_for_manual_review", END)

    return graph.compile()


async def run_tailor_graph(
    llm: LLMClient, tailor: TailorClient, tex: str, job: JobContext, facts: list[Fact]
) -> TailorResponse:
    graph = build_tailor_graph(llm, tailor)
    result = await graph.ainvoke({"tex": tex, "job": job, "facts": facts})
    return TailorResponse(
        status=result["status"],
        tex=result["final_tex"],
        proposed_changes=result["planned_edits"]
        if result["status"] == "proposed"
        else [],
        accepted_fields=result["accepted_fields"],
        flags=result["flags"],
        retries_used=result.get("retry_count", 0),
        model=llm.model,
        prompt_version=PROMPT_VERSION,
    )
