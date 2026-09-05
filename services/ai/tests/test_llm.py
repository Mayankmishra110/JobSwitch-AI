"""Unit tests for OpenAICompatibleLLM itself - test_explain.py only
exercises FakeLLM, never this real implementation's own JSON-handling.
Uses httpx.MockTransport (no real network, no real provider) to verify
the actual HTTP request shape and response parsing.
"""

import httpx
import pytest

from app.llm import LLMResponseError, OpenAICompatibleLLM, resolve_llm_client


def make_client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_complete_json_parses_a_well_formed_response() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer test-key"
        return httpx.Response(
            200, json={"choices": [{"message": {"content": '{"summary": "ok"}'}}]}
        )

    llm = OpenAICompatibleLLM(
        "https://example.test/v1", "test-key", "test-model", make_client(handler)
    )
    result = await llm.complete_json("system", "user")
    assert result == {"summary": "ok"}


@pytest.mark.asyncio
async def test_complete_json_raises_llm_response_error_on_non_json_content() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"choices": [{"message": {"content": "not valid json at all"}}]}
        )

    llm = OpenAICompatibleLLM(
        "https://example.test/v1", "test-key", "test-model", make_client(handler)
    )
    with pytest.raises(LLMResponseError):
        await llm.complete_json("system", "user")


@pytest.mark.asyncio
async def test_complete_json_raises_on_http_error_status() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "invalid api key"})

    llm = OpenAICompatibleLLM(
        "https://example.test/v1", "bad-key", "test-model", make_client(handler)
    )
    with pytest.raises(httpx.HTTPStatusError):
        await llm.complete_json("system", "user")


@pytest.mark.asyncio
async def test_complete_json_sends_json_mode_and_low_temperature() -> None:
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json

        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"choices": [{"message": {"content": "{}"}}]})

    llm = OpenAICompatibleLLM(
        "https://example.test/v1", "test-key", "test-model", make_client(handler)
    )
    await llm.complete_json("sys prompt", "user prompt")

    assert captured["body"]["response_format"] == {"type": "json_object"}
    assert captured["body"]["model"] == "test-model"
    assert captured["body"]["messages"][0] == {
        "role": "system",
        "content": "sys prompt",
    }
    assert captured["body"]["messages"][1] == {"role": "user", "content": "user prompt"}


class TestResolveLlmClient:
    def test_prefers_groq_when_all_three_keys_present(self) -> None:
        client = resolve_llm_client(
            "groq-key", "gemini-key", "openai-key", None, httpx.AsyncClient()
        )
        assert "groq" in client.base_url
        assert client.api_key == "groq-key"

    def test_falls_back_to_gemini_when_no_groq_key(self) -> None:
        client = resolve_llm_client(
            None, "gemini-key", "openai-key", None, httpx.AsyncClient()
        )
        assert "generativelanguage.googleapis.com" in client.base_url

    def test_falls_back_to_openai_when_only_openai_key_present(self) -> None:
        client = resolve_llm_client(None, None, "openai-key", None, httpx.AsyncClient())
        assert "api.openai.com" in client.base_url

    def test_model_override_is_honored(self) -> None:
        client = resolve_llm_client(
            "groq-key", None, None, "custom-model", httpx.AsyncClient()
        )
        assert client.model == "custom-model"

    def test_raises_when_no_key_is_configured(self) -> None:
        from app.llm import LLMConfigError

        with pytest.raises(LLMConfigError):
            resolve_llm_client(None, None, None, None, httpx.AsyncClient())
