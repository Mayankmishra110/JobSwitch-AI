"""Shared fixtures.

Testing philosophy note (see specs/architecture.md): the rest of this
project's "no mocks" rule is about Postgres/RLS/tenancy, where a mock
proves nothing about real database behavior. It does not extend to this
service's one external dependency, the LLM provider - a mock IS the
correct choice there, because the alternative is a nondeterministic,
paid, network-dependent test suite. fastembed, by contrast, runs locally
and is fast and deterministic, so test_embed.py uses the REAL model, no
mock - see that file's own note.
"""

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture()
def client() -> TestClient:
    # `with` triggers the lifespan context manager (model warm-load, the
    # shared httpx.AsyncClient) exactly as a real deployment would.
    with TestClient(app) as c:
        yield c
