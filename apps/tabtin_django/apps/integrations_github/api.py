"""GitHub OAuth API — 挂载于 /api/integrations/github。

方案 A：Electron 生成 PKCE；Django 保管 client_secret 并换票；
令牌经一次性 ticket 交回客户端本机保管，不长期落库。
"""

from __future__ import annotations

import logging
import re
import secrets
from typing import Optional
from urllib.parse import urlencode
from uuid import UUID

from django.core.cache import cache
from django.http import HttpResponse, HttpResponseRedirect
from django.utils.html import escape
from ninja import Router, Schema
from ninja.errors import HttpError

from apps.i18n.response import error_response_with_status, success_response
from apps.users.auth.permissions import JWTAuth

from .client import GitHubOAuthClient, GitHubOAuthError
from .constants import (
    DEEP_LINK_DEFAULT,
    OAUTH_CLAIM_CACHE_PREFIX,
    OAUTH_CLAIM_TTL_SECONDS,
    OAUTH_STATE_CACHE_PREFIX,
    OAUTH_STATE_TTL_SECONDS,
    get_github_oauth_redirect_uri,
    get_github_oauth_success_redirect,
    github_oauth_configured,
)

logger = logging.getLogger(__name__)

jwt_auth = JWTAuth()
router = Router(auth=jwt_auth)

_STATE_RE = re.compile(r"^[A-Za-z0-9_\-]{16,128}$")
_CHALLENGE_RE = re.compile(r"^[A-Za-z0-9_\-]{43,128}$")
_VERIFIER_RE = re.compile(r"^[A-Za-z0-9_\-\.~]{43,128}$")


class OAuthStartIn(Schema):
    organization_id: UUID
    state: str
    code_challenge: str
    code_verifier: str
    code_challenge_method: str = "S256"
    return_deep_link: Optional[str] = None


class OAuthClaimIn(Schema):
    ticket: str


def _state_cache_key(state: str) -> str:
    return f"{OAUTH_STATE_CACHE_PREFIX}{state}"


def _claim_cache_key(ticket: str) -> str:
    return f"{OAUTH_CLAIM_CACHE_PREFIX}{ticket}"


def _require_org_member(user, organization_id: UUID) -> None:
    from apps.tabtinspace.models import OrganizationMember

    ok = OrganizationMember.objects.filter(
        organization_id=organization_id,
        user_id=user.id,
    ).exists()
    if not ok:
        raise HttpError(403, "无权访问该 Organization")


def _safe_github_deep_link(raw: str, ticket: str) -> str:
    """只允许 tabtin://integrations/github/…，并把 ticket 写入 query。"""
    default = DEEP_LINK_DEFAULT
    link = (raw or default).strip() or default
    if not re.fullmatch(r"tabtin://[\w\-./?=&%:+]*", link):
        link = default
    if not link.startswith("tabtin://integrations/github/"):
        link = default
    sep = "&" if "?" in link else "?"
    return f"{link}{sep}{urlencode({'ticket': ticket})}"


@router.get("/oauth/status")
def oauth_status(request):
    """客户端探测平台是否已配置 GitHub OAuth App。"""
    return success_response({"configured": github_oauth_configured()})


@router.post("/oauth/start")
def oauth_start(request, body: OAuthStartIn):
    """登记 Electron PKCE 会话，返回 GitHub 授权 URL。"""
    if not github_oauth_configured():
        return error_response_with_status(
            "github_oauth_not_configured",
            message="服务端尚未配置 GitHub OAuth App，请联系管理员",
            status_code=503,
        )

    _require_org_member(request.auth, body.organization_id)

    state = (body.state or "").strip()
    challenge = (body.code_challenge or "").strip()
    verifier = (body.code_verifier or "").strip()
    method = (body.code_challenge_method or "S256").strip() or "S256"

    if method != "S256":
        raise HttpError(400, "仅支持 code_challenge_method=S256")
    if not _STATE_RE.fullmatch(state):
        raise HttpError(400, "无效的 state")
    if not _CHALLENGE_RE.fullmatch(challenge):
        raise HttpError(400, "无效的 code_challenge")
    if not _VERIFIER_RE.fullmatch(verifier):
        raise HttpError(400, "无效的 code_verifier")

    if cache.get(_state_cache_key(state)) is not None:
        raise HttpError(409, "state 已使用，请重新发起授权")

    cache.set(
        _state_cache_key(state),
        {
            "user_id": str(request.auth.id),
            "organization_id": str(body.organization_id),
            "code_verifier": verifier,
            "code_challenge": challenge,
            "return_deep_link": body.return_deep_link or "",
        },
        timeout=OAUTH_STATE_TTL_SECONDS,
    )

    client = GitHubOAuthClient()
    try:
        authorize_url = client.build_authorize_url(
            state=state,
            code_challenge=challenge,
            code_challenge_method=method,
        )
    except GitHubOAuthError as exc:
        cache.delete(_state_cache_key(state))
        return error_response_with_status(
            "github_oauth_misconfigured",
            message=str(exc),
            status_code=503,
        )

    logger.info(
        "[GitHubOAuth] start user_id=%s org_id=%s",
        request.auth.id,
        body.organization_id,
    )
    return success_response({"authorize_url": authorize_url})


@router.get("/oauth/callback", auth=None)
def oauth_callback(request, code: str = "", state: str = ""):
    """GitHub 回调：用 client_secret + PKCE verifier 换票，签发一次性领取 ticket。"""
    if not code or not state:
        raise HttpError(400, "缺少 code 或 state")
    if not _STATE_RE.fullmatch(state):
        raise HttpError(400, "无效的 state")

    payload = cache.get(_state_cache_key(state))
    cache.delete(_state_cache_key(state))
    if not payload:
        raise HttpError(400, "无效或过期的 state")

    user_id = payload.get("user_id")
    organization_id = payload.get("organization_id")
    code_verifier = payload.get("code_verifier")
    deep_link = payload.get("return_deep_link") or ""
    if not user_id or not organization_id or not code_verifier:
        raise HttpError(400, "state 载荷不完整")

    from django.contrib.auth import get_user_model

    User = get_user_model()
    try:
        user = User.objects.get(id=user_id)
    except User.DoesNotExist:
        raise HttpError(400, "用户不存在") from None

    try:
        organization_uuid = UUID(str(organization_id))
    except ValueError:
        raise HttpError(400, "organization_id 无效") from None

    try:
        _require_org_member(user, organization_uuid)
    except HttpError:
        return error_response_with_status(
            "user_not_authorized",
            message="用户已不属于该组织，无法完成 GitHub 授权",
            status_code=403,
        )

    client = GitHubOAuthClient()
    try:
        token_resp = client.exchange_code(code=code, code_verifier=code_verifier)
    except GitHubOAuthError as exc:
        logger.warning("[GitHubOAuth] exchange_code failed: %s", exc)
        raise HttpError(400, "换取 GitHub 令牌失败") from exc

    access_token = token_resp.get("access_token") or ""
    token_type = (token_resp.get("token_type") or "bearer").lower()
    scope = token_resp.get("scope") or ""
    if not access_token:
        raise HttpError(400, "GitHub 未返回 access_token")

    login = ""
    try:
        info = client.get_user(access_token)
        login = str(info.get("login") or "")
    except GitHubOAuthError as exc:
        logger.warning("[GitHubOAuth] get_user failed: %s", exc)
        # 换票已成功；用户信息失败不阻断领取

    ticket = secrets.token_urlsafe(32)
    cache.set(
        _claim_cache_key(ticket),
        {
            "user_id": str(user_id),
            "organization_id": str(organization_id),
            "access_token": access_token,
            "token_type": token_type,
            "scope": scope,
            "login": login,
        },
        timeout=OAUTH_CLAIM_TTL_SECONDS,
    )
    logger.info(
        "[GitHubOAuth] ticket issued user_id=%s org_id=%s login=%s",
        user_id,
        organization_id,
        login or "-",
    )

    success = get_github_oauth_success_redirect()
    safe_link = _safe_github_deep_link(deep_link, ticket)
    qs = {
        "deep_link": safe_link,
        "ticket": ticket,
        "connected": "1",
        "organization_id": str(organization_id),
    }
    if login:
        qs["login"] = login
    sep = "&" if "?" in success else "?"
    return HttpResponseRedirect(f"{success}{sep}{urlencode(qs)}")


@router.get("/oauth/done", auth=None)
def oauth_done(
    request,
    deep_link: str = "",
    ticket: str = "",
    connected: str = "",
    organization_id: str = "",
    login: str = "",
):
    """授权成功落地页：唤起 Electron deep link；应用内窗可直接读 ticket。"""
    link = _safe_github_deep_link(deep_link, ticket) if ticket else DEEP_LINK_DEFAULT
    safe_link = escape(link)
    safe_ticket = escape(ticket or "")
    safe_login = escape(login or "")
    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="tabtin-github-oauth-ticket" content="{safe_ticket}" />
  <title>GitHub 授权完成</title>
  <style>
    body {{ font-family: system-ui, sans-serif; margin: 0; min-height: 100vh;
      display: flex; align-items: center; justify-content: center; background: #f6f7f9; color: ; }}
    .card {{ max-width: 420px; padding: 28px 24px; border-radius: 16px; background: #fff;
      border: 1px solid #e5e7eb; box-shadow: 0 8px 24px rgba(0,0,0,.04); }}
    h1 {{ font-size: 20px; margin: 0 0 8px; }}
    p {{ margin: 0 0 16px; color: #6b7280; line-height: 1.5; font-size: 14px; }}
    a.btn {{ display: inline-flex; padding: 10px 14px; border-radius: 10px; background: ;
      color: #fff; text-decoration: none; font-size: 14px; }}
  </style>
</head>
<body>
  <div class="card" data-oauth-done="github" data-ticket="{safe_ticket}">
    <h1>GitHub 授权已完成</h1>
    <p>正在返回 TabTin。若未自动打开，请点击下方按钮。{"（@" + safe_login + "）" if safe_login else ""}</p>
    <a class="btn" id="open-app" href="{safe_link}">打开 TabTin</a>
  </div>
  <script>
    (function () {{
      var link = document.getElementById('open-app');
      if (link && link.href) {{
        window.location.href = link.href;
      }}
    }})();
  </script>
</body>
</html>"""
    return HttpResponse(html, content_type="text/html; charset=utf-8")


@router.post("/oauth/claim")
def oauth_claim(request, body: OAuthClaimIn):
    """JWT 用户一次性领取 access_token（领取后 ticket 作废）。"""
    ticket = (body.ticket or "").strip()
    if not ticket or len(ticket) < 16 or len(ticket) > 128:
        raise HttpError(400, "无效的 ticket")

    key = _claim_cache_key(ticket)
    payload = cache.get(key)
    cache.delete(key)
    if not payload:
        return error_response_with_status(
            "github_oauth_ticket_invalid",
            message="授权凭证已失效，请重新授权",
            status_code=410,
        )

    if str(payload.get("user_id")) != str(request.auth.id):
        return error_response_with_status(
            "github_oauth_ticket_forbidden",
            message="无权领取该授权凭证",
            status_code=403,
        )

    access_token = payload.get("access_token") or ""
    if not access_token:
        return error_response_with_status(
            "github_oauth_ticket_empty",
            message="授权凭证为空，请重新授权",
            status_code=410,
        )

    logger.info(
        "[GitHubOAuth] claim user_id=%s org_id=%s login=%s",
        request.auth.id,
        payload.get("organization_id"),
        payload.get("login") or "-",
    )
    return success_response(
        {
            "access_token": access_token,
            "token_type": payload.get("token_type") or "bearer",
            "scope": payload.get("scope") or "",
            "login": payload.get("login") or "",
            "organization_id": payload.get("organization_id") or "",
        }
    )
