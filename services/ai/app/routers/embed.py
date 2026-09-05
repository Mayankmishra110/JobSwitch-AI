from fastapi import APIRouter, Depends

from ..auth import require_internal_token
from ..embed import EMBEDDING_DIM, MODEL_NAME, embed_texts
from ..models import EmbedRequest, EmbedResponse

router = APIRouter(dependencies=[Depends(require_internal_token)])


@router.post("/v1/embed", response_model=EmbedResponse)
async def embed(req: EmbedRequest) -> EmbedResponse:
    vectors = embed_texts(req.texts)
    return EmbedResponse(model=MODEL_NAME, dim=EMBEDDING_DIM, vectors=vectors)
