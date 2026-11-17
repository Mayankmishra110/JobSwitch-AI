"""Settings, loaded once per process but injected via FastAPI Depends rather
than read as a bare module-level global.

The reason this matters: the TS side's nipun pipeline (packages/db's
sibling project, see specs/matching-pipeline.md) reads provider keys from
process.env at module import time, which the build plan flagged as a real
leak - it means the module can't be configured programmatically in a test.
get_settings() being an explicit, overridable dependency is the fix for
that same class of problem here.
"""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Bound to the internal compose/k8s network only in real deployment -
    # apps/tailor and services/backend would send this header. Optional so
    # local dev without it configured still works; production sets it.
    internal_token: str | None = None

    embedding_model: str = "BAAI/bge-small-en-v1.5"

    # apps/tailor's own base URL - this service is stateless and holds no
    # LaTeX toolchain itself, so Graph A (resume tailoring) calls out to it
    # for parse/reinject/validate-nouns. Internal network only in real
    # deployment; localhost default matches services/ai's own AI_SERVICE_URL
    # convention for local dev.
    tailor_service_url: str = "http://127.0.0.1:8200"

    # Provider waterfall, same order and same "first key wins" behavior as
    # Mayankbuilt's nipun pipeline (src/lib/resume/llm.ts) - kept
    # consistent deliberately, not reinvented.
    groq_api_key: str | None = None
    gemini_api_key: str | None = None
    openai_api_key: str | None = None
    llm_model: str | None = None


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
