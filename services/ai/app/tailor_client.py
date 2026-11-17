"""HTTP client for apps/tailor - the stateless LaTeX span-surgery service.

services/ai holds no LaTeX toolchain and never will (same "stay stateless,
one job per service" boundary as its own no-Postgres rule). Graph A calls
out to apps/tailor for every operation that actually touches .tex bytes;
this module is the one place that knows apps/tailor's HTTP contract.
"""

from typing import Any

import httpx


class TailorClientError(Exception):
    """apps/tailor replied with something other than success - never
    silently treated as "no edits to make" or "no flags found."""


class TailorClient:
    def __init__(
        self, base_url: str, internal_token: str | None, http_client: httpx.AsyncClient
    ):
        self.base_url = base_url.rstrip("/")
        self._internal_token = internal_token
        self._client = http_client

    def _headers(self) -> dict[str, str]:
        if self._internal_token:
            return {"X-Internal-Token": self._internal_token}
        return {}

    async def parse(self, tex: str) -> dict[str, Any]:
        response = await self._client.post(
            f"{self.base_url}/v1/parse", json={"tex": tex}, headers=self._headers()
        )
        self._raise_for_status(response, "parse")
        return response.json()

    async def validate_nouns(
        self, tex: str, changes: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        response = await self._client.post(
            f"{self.base_url}/v1/validate-nouns",
            json={"tex": tex, "changes": changes},
            headers=self._headers(),
        )
        self._raise_for_status(response, "validate-nouns")
        return response.json()["flags"]

    async def reinject(
        self, tex: str, accepted: list[dict[str, Any]]
    ) -> dict[str, Any]:
        response = await self._client.post(
            f"{self.base_url}/v1/reinject",
            json={"tex": tex, "accepted": accepted},
            headers=self._headers(),
        )
        self._raise_for_status(response, "reinject")
        return response.json()

    def _raise_for_status(self, response: httpx.Response, op: str) -> None:
        if response.status_code != 200:
            raise TailorClientError(
                f"apps/tailor {op} returned {response.status_code}: {response.text[:500]}"
            )
