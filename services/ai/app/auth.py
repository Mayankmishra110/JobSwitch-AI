"""Internal-caller authentication.

This service is stateless and holds no database grant at all - it never
even opens a Postgres connection. The one thing worth gating is who can
spend LLM/embedding compute against it. When INTERNAL_TOKEN is configured
(real deployment, called only from services/matcher and apps/tailor on
the internal network), every route requires it. Left unconfigured (local
dev, no value set), the check is skipped entirely rather than locking a
developer out with a token nobody set on purpose.
"""

from typing import Annotated

from fastapi import Depends, Header, HTTPException

from .config import Settings, get_settings


async def require_internal_token(
    settings: Annotated[Settings, Depends(get_settings)],
    x_internal_token: Annotated[str | None, Header()] = None,
) -> None:
    if not settings.internal_token:
        return
    if x_internal_token != settings.internal_token:
        raise HTTPException(
            status_code=401, detail="missing or invalid X-Internal-Token"
        )
