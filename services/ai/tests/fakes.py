"""Test doubles. Deliberately only for the LLM boundary - see
conftest.py's comment on why Postgres-style "no mocks" doesn't apply to a
paid, nondeterministic third party.
"""

from app.llm import LLMResponseError


class FakeLLM:
    """Implements the same shape as llm.LLMClient (structural typing via
    Python's Protocol - no inheritance needed).

    Two response modes:
      - `response`: one fixed dict returned for every call - correct for
        the plain chain (one call) and for any graph call site that
        doesn't care about a specific sequence.
      - `responses`: a list consumed in order, one per call - needed for
        Graph B/Graph A, which make more than one LLM call per pass (draft
        then self_critique; extract_jd, plan_edits, and again on retry).
        The last entry repeats if more calls happen than entries provided,
        rather than raising - a test that only cares about the first N
        calls' shape shouldn't have to enumerate every retry attempt too.

    `raise_malformed=True` simulates what a real OpenAICompatibleLLM does
    when a provider replies with non-JSON content - raises
    LLMResponseError on every call, exactly like the real implementation's
    contract (complete_json never returns anything but a dict or raises
    this one exception; it never leaks a raw JSONDecodeError to its
    caller).
    """

    def __init__(
        self,
        response: dict | None = None,
        *,
        responses: list[dict] | None = None,
        raise_malformed: bool = False,
        model: str = "fake-model-v1",
    ):
        self.model = model
        self._responses = responses
        self._response = response
        self._raise_malformed = raise_malformed
        self._call_index = 0
        self.calls: list[dict[str, str]] = []
        self.last_system: str | None = None
        self.last_user: str | None = None

    async def complete_json(self, system: str, user: str) -> dict:
        self.last_system = system
        self.last_user = user
        self.calls.append({"system": system, "user": user})

        if self._raise_malformed:
            raise LLMResponseError(
                "provider returned non-JSON content: 'not json at all'"
            )

        if self._responses is not None:
            assert len(self._responses) > 0, (
                "FakeLLM configured with an empty responses list"
            )
            index = min(self._call_index, len(self._responses) - 1)
            self._call_index += 1
            return self._responses[index]

        assert self._response is not None, (
            "FakeLLM configured with neither response, responses, nor raise_malformed"
        )
        return self._response
