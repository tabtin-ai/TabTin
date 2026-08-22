"""GitHub OAuth HTTP 客户端。日志禁止输出 token / secret。"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional
from urllib.parse import urlencode

import httpx

from .constants import (
    GITHUB_AUTHORIZE_URL,
    GITHUB_TOKEN_URL,
    GITHUB_USER_URL,
    OAUTH_SCOPES,
    get_github_oauth_client_id,
    get_github_oauth_client_secret,
    get_github_oauth_redirect_uri,
)

logger = logging.getLogger(__name__)


class GitHubOAuthError(Exception):
    def __init__(self, message: str, *, status_code: Optional[int] = None):
        super().__init__(message)
        self.status_code = status_code


class GitHubOAuthClient:
    def __init__(
        self,
        *,
        client_id: Optional[str] = None,
        client_secret: Optional[str] = None,
        timeout: float = 30.0,
        transport: Optional[httpx.BaseTransport] = None,
    ):
        self.client_id = get_github_oauth_client_id() if client_id is None else client_id
        self.client_secret = (
            get_github_oauth_client_secret() if client_secret is None else client_secret
        )
        self.timeout = timeout
        self._transport = transport

    def _http(self) -> httpx.Client:
        kwargs: Dict[str, Any] = {"timeout": self.timeout}
        if self._transport is not None:
            kwargs["transport"] = self._transport
        return httpx.Client(**kwargs)

    def build_authorize_url(
        self,
        *,
        state: str,
        code_challenge: str,
        code_challenge_method: str = "S256",
        redirect_uri: Optional[str] = None,
        scope: str = OAUTH_SCOPES,
    ) -> str:
        if not self.client_id:
            raise GitHubOAuthError("GitHub OAuth client_id 未配置")
        params = {
            "client_id": self.client_id,
            "redirect_uri": redirect_uri or get_github_oauth_redirect_uri(),
            "scope": scope,
            "state": state,
            "code_challenge": code_challenge,
            "code_challenge_method": code_challenge_method,
        }
        return f"{GITHUB_AUTHORIZE_URL}?{urlencode(params)}"

    def exchange_code(
        self,
        *,
        code: str,
        code_verifier: str,
        redirect_uri: Optional[str] = None,
    ) -> Dict[str, Any]:
        if not self.client_id or not self.client_secret:
            raise GitHubOAuthError("GitHub OAuth 未配置")
        data = {
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "code": code,
            "redirect_uri": redirect_uri or get_github_oauth_redirect_uri(),
            "code_verifier": code_verifier,
        }
        headers = {
            "Accept": "application/json",
            "User-Agent": "TabTin-GitHub-OAuth",
        }
        with self._http() as client:
            resp = client.post(GITHUB_TOKEN_URL, data=data, headers=headers)
        if resp.status_code >= 400:
            logger.warning("[GitHubOAuth] token exchange http=%s", resp.status_code)
            raise GitHubOAuthError("换取 GitHub 令牌失败", status_code=resp.status_code)
        body = resp.json()
        if body.get("error"):
            logger.warning("[GitHubOAuth] token exchange error=%s", body.get("error"))
            raise GitHubOAuthError(
                str(body.get("error_description") or body.get("error") or "换取令牌失败")
            )
        return body

    def get_user(self, access_token: str) -> Dict[str, Any]:
        headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {access_token}",
            "User-Agent": "TabTin-GitHub-OAuth",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        with self._http() as client:
            resp = client.get(GITHUB_USER_URL, headers=headers)
        if resp.status_code >= 400:
            logger.warning("[GitHubOAuth] get_user http=%s", resp.status_code)
            raise GitHubOAuthError("读取 GitHub 用户失败", status_code=resp.status_code)
        return resp.json()
