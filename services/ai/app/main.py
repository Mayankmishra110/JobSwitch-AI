"""services/ai - stateless FastAPI service: embeddings (fastembed) + a
plain sequential LLM chain for match explanations (Phase 5.3).

No database connection anywhere in this service, on purpose - see
specs/architecture.md's boundary note. It receives facts already tagged
with their provenance (ADR D-22) and echoes back which it used; that
boundary is enforced by the request/response schemas requiring
`provenance`, not by convention.
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI

from .embed import get_embedding_model, is_model_loaded
from .routers.embed import router as embed_router
from .routers.explain import router as explain_router


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # Load the embedding model at startup, not on first request - so a
    # cold pod's /healthz correctly reports not-ready during the load
    # window instead of the first real caller silently eating a multi-
    # second model-load cost.
    get_embedding_model()
    app.state.http_client = httpx.AsyncClient(timeout=30.0)
    try:
        yield
    finally:
        await app.state.http_client.aclose()


app = FastAPI(title="jobswitch-ai", lifespan=lifespan)

app.include_router(embed_router)
app.include_router(explain_router)


@app.get("/healthz")
async def healthz() -> dict:
    return {"ok": True, "model_loaded": is_model_loaded()}
