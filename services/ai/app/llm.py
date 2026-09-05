"""LLM access: one OpenAI-compatible chat-completions client, parametrized
by base URL/key/model, covering all three configured providers.

Groq, Gemini, and OpenAI itself all now expose an OpenAI-compatible chat
completions endpoint (Groq at api.groq.com/openai/v1, Gemini at
generativelanguage.googleapis.com/v1beta/openai, OpenAI natively) - so one
client class covers all three rather than three separate SDK integrations.
Provider selection is a waterfall, same order Mayankbuilt's nipun pipeline
uses (src/lib/resume/llm.ts): first configured key wins.

NEVER VERIFIED AGAINST A REAL PROVIDER. This build environment has no real
API key (Mayankbuilt's own .env.local holds only placeholder values, e.g.
GROQ_API_KEY=gsk_...). The request/response shape follows each provider's
published OpenAI-compatibility docs; tests exercise this module against a
FakeLLM implementing the same Protocol (tests/fakes.py), never against a
live provider. Treat the first real call as the actual verification - the
same honesty standard the ATS adapters and Google OAuth flow already hold
themselves to (see specs/ingestion.md, specs/auth-and-identity.md).
"""

import json
from typing import Protocol

import httpx


class LLMConfigError(Exception):
    """No provider key is configured at all."""


class LLMResponseError(Exception):
    """The provider replied, but not with valid JSON - raised, never
    silently swallowed. A caller that receives this must treat it as a
    failed call, not as an empty result (see the provenance-gate note in
    explain.py: malformed output must never pass through as if it were a
    validated, safe explanation)."""


class LLMClient(Protocol):
    model: str

    async def complete_json(self, system: str, user: str) -> dict: ...


class OpenAICompatibleLLM:
    def __init__(
        self, base_url: str, api_key: str, model: str, http_client: httpx.AsyncClient
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self._client = http_client

    async def complete_json(self, system: str, user: str) -> dict:
        response = await self._client.post(
            f"{self.base_url}/chat/completions",
            headers={"Authorization": f"Bearer {self.api_key}"},
            json={
                "model": self.model,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                "response_format": {"type": "json_object"},
                "temperature": 0.2,
            },
        )
        response.raise_for_status()
        body = response.json()
        content = body["choices"][0]["message"]["content"]

        try:
            return json.loads(content)
        except json.JSONDecodeError as error:
            raise LLMResponseError(
                f"provider returned non-JSON content: {content[:200]!r}"
            ) from error


def resolve_llm_client(
    groq_api_key: str | None,
    gemini_api_key: str | None,
    openai_api_key: str | None,
    model_override: str | None,
    http_client: httpx.AsyncClient,
) -> OpenAICompatibleLLM:
    if groq_api_key:
        return OpenAICompatibleLLM(
            "https://api.groq.com/openai/v1",
            groq_api_key,
            # Groq deprecates/rotates model ids frequently - this default
            # was live-verified against GET /openai/v1/models with a real
            # key (2026-09), not assumed from training data. If this ever
            # 404s again, check that endpoint before guessing a new name.
            model_override or "openai/gpt-oss-20b",
            http_client,
        )
    if gemini_api_key:
        return OpenAICompatibleLLM(
            "https://generativelanguage.googleapis.com/v1beta/openai",
            gemini_api_key,
            model_override or "gemini-2.0-flash-lite",
            http_client,
        )
    if openai_api_key:
        return OpenAICompatibleLLM(
            "https://api.openai.com/v1",
            openai_api_key,
            model_override or "gpt-4o-mini",
            http_client,
        )
    raise LLMConfigError(
        "No LLM API key configured. Set GROQ_API_KEY, GEMINI_API_KEY, or OPENAI_API_KEY."
    )
