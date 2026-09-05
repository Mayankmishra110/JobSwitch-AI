"""Embedding generation via fastembed (ONNX Runtime, no PyTorch).

Model choice and the reasoning behind it belong in specs/matching-pipeline.md
once Phase 5.3 lands there; restated briefly: BAAI/bge-small-en-v1.5,
384 dimensions, ~200MB total footprint versus ~2GB for a
torch+sentence-transformers stack - the difference between fitting
alongside eight other pods on a 24GB box and not.

The model is loaded once, lazily, and cached for the process lifetime -
see main.py's lifespan handler, which forces this to happen at startup
rather than on the first real request, so /healthz's model_loaded flag is
meaningful and the first caller doesn't pay a multi-second cold-load cost.
"""

from functools import lru_cache

from fastembed import TextEmbedding

MODEL_NAME = "BAAI/bge-small-en-v1.5"
EMBEDDING_DIM = 384


@lru_cache(maxsize=1)
def get_embedding_model() -> TextEmbedding:
    return TextEmbedding(model_name=MODEL_NAME)


def is_model_loaded() -> bool:
    return get_embedding_model.cache_info().currsize > 0


def embed_texts(texts: list[str]) -> list[list[float]]:
    model = get_embedding_model()
    # fastembed's embed() returns a generator of numpy arrays, one per
    # input text, in input order - tolist() makes each one JSON-serializable.
    return [vector.tolist() for vector in model.embed(texts)]
