"""Test doubles. Deliberately only for the LLM boundary - see
conftest.py's comment on why Postgres-style "no mocks" doesn't apply to a
paid, nondeterministic third party.
"""

from app.llm import LLMResponseError


class FakeLLM:
    """Implements the same shape as llm.LLMClient (structural typing via
    Python's Protocol - no inheritance needed).

    Two modes: pass a dict to simulate a well-formed response, or
    raise_malformed=True to simulate what a real OpenAICompatibleLLM does
    when a provider replies with non-JSON content - raises
    LLMResponseError, exactly like the real implementation's contract
    (complete_json never returns anything but a dict or raises this one
    exception; it never leaks a raw JSONDecodeError to its caller).
    """

    def __init__(
        self,
        response: dict | None = None,
        *,
        raise_malformed: bool = False,
        model: str = "fake-model-v1",
    ):
        self.model = model
        self._response = response
        self._raise_malformed = raise_malformed
        self.last_system: str | None = None
        self.last_user: str | None = None

    async def complete_json(self, system: str, user: str) -> dict:
        self.last_system = system
        self.last_user = user
        if self._raise_malformed:
            raise LLMResponseError(
                "provider returned non-JSON content: 'not json at all'"
            )
        assert self._response is not None, (
            "FakeLLM configured with neither response nor raise_malformed"
        )
        return self._response
