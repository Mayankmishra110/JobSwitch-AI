from typing import Annotated

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import ValidationError

from ..auth import require_internal_token
from ..config import Settings, get_settings
from ..graphs.tailor_graph import run_tailor_graph
from ..llm import LLMClient, LLMConfigError, LLMResponseError, resolve_llm_client
from ..models import TailorRequest, TailorResponse
from ..tailor_client import TailorClient, TailorClientError

router = APIRouter(dependencies=[Depends(require_internal_token)])


def get_http_client(request: Request) -> httpx.AsyncClient:
    return request.app.state.http_client


def get_llm_client(
    settings: Annotated[Settings, Depends(get_settings)],
    http_client: Annotated[httpx.AsyncClient, Depends(get_http_client)],
) -> LLMClient:
    try:
        return resolve_llm_client(
            settings.groq_api_key,
            settings.gemini_api_key,
            settings.openai_api_key,
            settings.llm_model,
            http_client,
        )
    except LLMConfigError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


def get_tailor_client(
    settings: Annotated[Settings, Depends(get_settings)],
    http_client: Annotated[httpx.AsyncClient, Depends(get_http_client)],
) -> TailorClient:
    # A real dependency, not a bare constructor call - same reasoning as
    # get_llm_client: tests override this with a client pointed at a test
    # double or a real local apps/tailor instance, whichever the test needs.
    return TailorClient(
        settings.tailor_service_url, settings.internal_token, http_client
    )


@router.post("/v1/tailor/resume", response_model=TailorResponse)
async def tailor_resume(
    req: TailorRequest,
    llm: Annotated[LLMClient, Depends(get_llm_client)],
    tailor: Annotated[TailorClient, Depends(get_tailor_client)],
) -> TailorResponse:
    try:
        # Graph A (LangGraph) - see app/graphs/tailor_graph.py. Single-
        # response only for now (graph.invoke, not graph.astream) - the
        # build plan's own sequencing calls for the synchronous version to
        # work end to end before a streaming variant is worth building.
        return await run_tailor_graph(llm, tailor, req.tex, req.job, req.facts)
    except (LLMResponseError, ValidationError) as error:
        raise HTTPException(
            status_code=502, detail=f"LLM returned an unusable response: {error}"
        ) from error
    except httpx.HTTPStatusError as error:
        raise HTTPException(
            status_code=502,
            detail=f"LLM provider returned {error.response.status_code}",
        ) from error
    except TailorClientError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
