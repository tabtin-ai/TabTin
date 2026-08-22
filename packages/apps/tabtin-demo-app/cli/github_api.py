"""GitHub Issue API 客户端——真实 REST API 调用（PRD §14.2 N15）。

所有方法接收 ``token`` 参数以便测试时注入 mock。
生产路径从 ``config.get_access_token()`` 取 token。
"""

from __future__ import annotations

import json
import sys
from typing import Any, Dict, List, Optional
from urllib.error import HTTPError
from urllib.request import Request, urlopen

API_BASE = "https://api.github.com"
USER_AGENT = "tabtin-demo-app/0.1.0"


class GitHubAPIError(Exception):
    def __init__(self, status: int, message: str, url: str) -> None:
        self.status = status
        self.url = url
        super().__init__(f"GitHub API {status}: {message} ({url})")


def _request(
    method: str,
    path: str,
    token: str,
    *,
    body: Optional[Dict[str, Any]] = None,
    params: Optional[Dict[str, str]] = None,
    base_url: str = API_BASE,
) -> Any:
    url = f"{base_url}{path}"
    if params:
        qs = "&".join(f"{k}={v}" for k, v in params.items() if v is not None)
        if qs:
            url = f"{url}?{qs}"

    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": "2022-11-28",
    }
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = Request(url, data=data, headers=headers, method=method)
    try:
        with urlopen(req, timeout=30) as resp:
            resp_data = resp.read().decode("utf-8")
            return json.loads(resp_data) if resp_data.strip() else {}
    except HTTPError as exc:
        err_body = ""
        if exc.fp:
            try:
                err_body = exc.fp.read().decode("utf-8", errors="replace")
            except Exception:
                pass
        try:
            err_json = json.loads(err_body)
            message = err_json.get("message", err_body[:200])
        except (json.JSONDecodeError, ValueError):
            message = err_body[:200] if err_body else str(exc)
        raise GitHubAPIError(exc.code, message, url) from exc


def create_issue(
    token: str,
    repo: str,
    title: str,
    *,
    body: Optional[str] = None,
    labels: Optional[List[str]] = None,
    base_url: str = API_BASE,
) -> Dict[str, Any]:
    payload: Dict[str, Any] = {"title": title}
    if body:
        payload["body"] = body
    if labels:
        payload["labels"] = labels
    return _request("POST", f"/repos/{repo}/issues", token, body=payload, base_url=base_url)


def list_issues(
    token: str,
    repo: str,
    *,
    state: str = "open",
    per_page: int = 30,
    base_url: str = API_BASE,
) -> List[Dict[str, Any]]:
    params = {"state": state, "per_page": str(per_page)}
    result = _request("GET", f"/repos/{repo}/issues", token, params=params, base_url=base_url)
    return result if isinstance(result, list) else []


def get_issue(
    token: str,
    repo: str,
    number: int,
    *,
    base_url: str = API_BASE,
) -> Dict[str, Any]:
    return _request("GET", f"/repos/{repo}/issues/{number}", token, base_url=base_url)


def close_issue(
    token: str,
    repo: str,
    number: int,
    *,
    base_url: str = API_BASE,
) -> Dict[str, Any]:
    return _request(
        "PATCH",
        f"/repos/{repo}/issues/{number}",
        token,
        body={"state": "closed"},
        base_url=base_url,
    )
