"""HTTP client for the TabTin API."""

from __future__ import annotations

from typing import Any, Optional

import httpx

from tabtin_sdk.types import TabTinError


class HttpClient:
    """Low-level HTTP client with auth and response unwrapping."""

    def __init__(self, base_url: str, token: str, timeout: float = 30.0):
        self._base_url = base_url.rstrip("/")
        self._client = httpx.Client(
            base_url=self._base_url,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            timeout=timeout,
        )

    def get(self, path: str, params: Optional[dict[str, Any]] = None) -> Any:
        resp = self._client.get(path, params=params)
        return self._handle(resp)

    def post(self, path: str, json: Optional[Any] = None) -> Any:
        resp = self._client.post(path, json=json)
        return self._handle(resp)

    def patch(self, path: str, json: Optional[Any] = None) -> Any:
        resp = self._client.patch(path, json=json)
        return self._handle(resp)

    def post_form(
        self,
        path: str,
        data: dict[str, str],
        files: dict[str, tuple[str, bytes]],
    ) -> Any:
        """POST multipart form data (used for file uploads).

        httpx sets the correct ``Content-Type: multipart/form-data`` boundary
        automatically, so we must drop the default JSON content-type header.
        """
        headers = {"Content-Type": None}  # type: ignore[dict-item]
        resp = self._client.post(path, data=data, files=files, headers=headers)
        return self._handle(resp)

    def delete(self, path: str) -> Any:
        resp = self._client.delete(path)
        return self._handle(resp)

    def close(self) -> None:
        self._client.close()

    # ── Internal ────────────────────────────────────────

    def _handle(self, resp: httpx.Response) -> Any:
        if resp.status_code >= 400:
            try:
                body = resp.json()
            except Exception:
                body = {}
            raise TabTinError(
                message=body.get("message") or body.get("detail") or f"HTTP {resp.status_code}",
                status=resp.status_code,
                code=body.get("error_code", "UNKNOWN"),
                detail=body.get("detail"),
            )
        return self._unwrap(resp.json())

    @staticmethod
    def _unwrap(json: Any) -> Any:
        """Unwrap TabTin {success, data, ...} envelope."""
        if isinstance(json, dict) and "success" in json:
            if not json["success"]:
                raise TabTinError(
                    message=str(json.get("message") or json.get("code") or "Request failed"),
                    code=str(json.get("error_code", "UNKNOWN")),
                )
            if "data" in json:
                return json["data"]
        return json
