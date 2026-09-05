from typing import Annotated

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import ValidationError

from ..auth import require_internal_token
from ..config import Settings, get_settings
from ..explain_service import draft_explanation
from ..llm import LLMClient, LLMConfigError, LLMResponseError, resolve_llm_client
from ..models import ExplainRequest, ExplainResponse

router = APIRouter(dependencies=[Depends(require_internal_token)])


def get_http_client(request: Request) -> httpx.AsyncClient:
    # Set once at app startup (main.py's lifespan) and reused across
    # requests - a fresh client per call would leak connections under load.
    return request.app.state.http_client


def get_llm_client(
    settings: Annotated[Settings, Depends(get_settings)],
    http_client: Annotated[httpx.AsyncClient, Depends(get_http_client)],
) -> LLMClient:
    """A real dependency, not a bare function call inside the route -
    specifically so tests can override it with a FakeLLM via
    app.dependency_overrides, the same pattern the DB layer's tests use
    real Postgres instead of a mock for everything EXCEPT this: this is
    the one deliberate exception, because a mocked LLM is the only way to
    have a deterministic suite for a paid, nondeterministic call.
    """
    try:
        return resolve_llm_client(
            settings.groq_api_key,
            settings.gemini_api_key,
            settings.openai_api_key,
            settings.llm_model,
            http_client,
        )
    except LLMConfigError as error:
        # 503, not 500: "not configured to do this yet," not a bug - the
        # same distinction apps/web's Errors.oauthDisabled() draws.
        raise HTTPException(status_code=503, detail=str(error)) from error


@router.post("/v1/match/explain", response_model=ExplainResponse)
async def explain(
    req: ExplainRequest,
    llm: Annotated[LLMClient, Depends(get_llm_client)],
) -> ExplainResponse:
    try:
        return await draft_explanation(llm, req.job, req.facts)
    except (LLMResponseError, ValidationError) as error:
        # Both mean the same thing from a caller's perspective: the
        # provider replied, but not with something we can trust - never
        # passed through as if it were a validated explanation.
        raise HTTPException(
            status_code=502, detail=f"LLM returned an unusable response: {error}"
        ) from error
    except httpx.HTTPStatusError as error:
        raise HTTPException(
            status_code=502,
            detail=f"LLM provider returned {error.response.status_code}",
        ) from error
