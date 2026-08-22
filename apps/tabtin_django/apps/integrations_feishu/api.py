"""飞书多维表集成 API — 挂载于 /api/integrations/feishu。"""

from __future__ import annotations

import logging
import secrets
import time
from datetime import timedelta
from typing import Optional
from urllib.parse import urlencode
from uuid import UUID

from django.core.cache import cache
from django.db import transaction
from django.db.models import F
from django.http import HttpResponse, HttpResponseRedirect
from django.utils import timezone
from django.utils.html import escape
from ninja import Router
from ninja.errors import HttpError

from apps.i18n.response import error_response_with_status, success_response
from apps.services.common.runtime_build import parse_client_build
from apps.users.auth.permissions import JWTAuth

from .client import FeishuAPIError, FeishuAuthError, FeishuClient
from .constants import (
    OAUTH_STATE_CACHE_PREFIX,
    OAUTH_STATE_TTL_SECONDS,
    OAUTH_SCOPES,
    RESOURCE_KIND_BITABLE,
    RESOURCE_KIND_DOCX,
    get_feishu_oauth_app_id,
    get_feishu_oauth_app_secret,
    get_feishu_oauth_redirect_uri,
    get_feishu_oauth_success_redirect,
)
from .flow_view import FeishuFlowParseError, parse_feishu_flow
from .feature import (
    FEISHU_IMPORT_DISABLED_MESSAGE,
    feishu_import_enabled_for_organization,
)
from .models import FeishuImportJob, FeishuOAuthConnection, FeishuOAuthProvider
from .import_actions import request_cancel_table, request_skip_table
from .import_errors import (
    is_auth_api_error,
    is_expired_access_token_error,
    user_facing_import_error,
)
from .import_preview import build_import_preview
from .schemas import (
    BitableAppOut,
    BitableTableOut,
    BrowseChildrenOut,
    BrowseNodeOut,
    ConnectionOut,
    ImportableResourceOut,
    ImportPreviewIn,
    ImportPreviewOut,
    ImportRequestIn,
    ImportStartOut,
    ImportStatusOut,
    ImportTableActionIn,
    ImportTableActionOut,
    ParseFlowIn,
    ResolveUrlItemOut,
    ResolveUrlsIn,
    ResolveUrlsOut,
    OAuthProviderIn,
)
from .provider_service import (
    FeishuProviderError,
    bind_provider_tenant,
    client_for_provider,
    configure_provider,
    delete_provider,
    get_active_provider,
    get_provider,
    lock_provider_guard,
    resolve_oauth_provider,
)
from .tasks import run_feishu_import_task
from .url_resolve import resolve_feishu_urls

logger = logging.getLogger(__name__)

jwt_auth = JWTAuth()
router = Router(auth=jwt_auth)

_UNTITLED_RESOURCE_CACHE_TTL_SECONDS = 300
_EMPTY_UNTITLED_RESOURCE_CACHE_TTL_SECONDS = 60
_UNTITLED_RESOURCE_BUILD_LOCK_SECONDS = 45
_UNTITLED_RESOURCE_BUILD_WAIT_SECONDS = 35
_UNTITLED_RESOURCE_BUILD_POLL_SECONDS = 0.05
_TENANT_DOMAIN_CACHE_TTL_SECONDS = 21600


def _state_cache_key(state: str) -> str:
    return f"{OAUTH_STATE_CACHE_PREFIX}{state}"


def _require_org_member(user, organization_id: UUID) -> None:
    from apps.tabtinspace.models import OrganizationMember

    ok = OrganizationMember.objects.filter(
        organization_id=organization_id,
        user_id=user.id,
    ).exists()
    if not ok:
        raise HttpError(403, "无权访问该 Organization")


def _require_feishu_import_access(request, organization_id: UUID) -> None:
    _require_org_member(request.auth, organization_id)
    client = parse_client_build(request) if hasattr(request, "headers") else None
    if not feishu_import_enabled_for_organization(
        user_id=str(request.auth.id),
        organization_id=str(organization_id),
        client=client,
    ):
        raise HttpError(403, FEISHU_IMPORT_DISABLED_MESSAGE)


def _get_connected(user, organization_id: UUID) -> FeishuOAuthConnection:
    filters = {
        "user_id": user.id,
        "organization_id": organization_id,
        "status": FeishuOAuthConnection.Status.CONNECTED,
    }
    provider_configured = FeishuOAuthProvider.objects.filter(
        organization_id=organization_id,
    ).exists()
    try:
        if provider_configured:
            conn = FeishuOAuthConnection.objects.get(
                **filters,
                provider__status=FeishuOAuthProvider.Status.ACTIVE,
                credential_version=F("provider__credential_version"),
            )
        elif get_feishu_oauth_app_id() and get_feishu_oauth_app_secret():
            conn = FeishuOAuthConnection.objects.get(**filters, provider__isnull=True)
        else:
            raise FeishuOAuthConnection.DoesNotExist
    except FeishuOAuthConnection.DoesNotExist:
        raise HttpError(403, "未连接飞书账号，请先完成授权") from None
    return conn


def _require_import_targets(
    organization_id: UUID,
    space_id: UUID,
    collection_id: Optional[UUID],
) -> None:
    """校验导入落点：space 归属组织；collection（若有）也须同组织。"""
    from apps.tabtinspace.models import Collection, Project, Workspace
    from apps.tabtinspace.services.base import ensure_space_in_organization

    try:
        ensure_space_in_organization(organization_id, space_id)
    except ValueError as exc:
        raise HttpError(404, "目标空间不存在或不属于该组织") from exc

    if not collection_id:
        return

    col = Collection.objects.filter(id=collection_id).first()
    if col is None:
        raise HttpError(404, "目标文件夹不存在")

    if col.organization_id:
        if col.organization_id != organization_id:
            raise HttpError(404, "目标文件夹不存在")
        return

    host_org_id = None
    if col.workspace_id:
        host = Workspace.objects.filter(id=col.workspace_id).only("organization_id").first()
        host_org_id = host.organization_id if host else None
    elif col.project_id:
        host = Project.objects.filter(id=col.project_id).only("organization_id").first()
        host_org_id = host.organization_id if host else None

    if host_org_id != organization_id:
        raise HttpError(404, "目标文件夹不存在")


@router.get("/connection")
def get_connection(request, organization_id: UUID):
    """返回连接状态（不含 token）。"""
    _require_feishu_import_access(request, organization_id)
    provider_state = get_provider(request.auth, organization_id)
    try:
        conn = _get_connected(request.auth, organization_id)
    except HttpError:
        conn = None
    if not conn:
        return success_response(
            ConnectionOut(
                connected=False,
                provider_configured=provider_state["configured"],
                provider_status=provider_state["status"],
                can_manage_provider=provider_state["can_manage"],
                provider_app_id=provider_state["app_id"],
            ).model_dump()
        )
    return success_response(
        ConnectionOut(
            connected=True,
            display_name=conn.display_name or None,
            open_id=conn.open_id or None,
            updated_at=conn.updated_at.isoformat() if conn.updated_at else None,
            provider_configured=provider_state["configured"],
            provider_status=provider_state["status"],
            can_manage_provider=provider_state["can_manage"],
            provider_app_id=provider_state["app_id"],
        ).model_dump()
    )


@router.delete("/connection")
def delete_connection(request, organization_id: UUID):
    _require_org_member(request.auth, organization_id)
    deleted, _ = FeishuOAuthConnection.objects.filter(
        user_id=request.auth.id,
        organization_id=organization_id,
    ).delete()
    return success_response({"deleted": bool(deleted)})


def _provider_error_response(exc: FeishuProviderError):
    return error_response_with_status(
        exc.code,
        message=exc.message,
        status_code=exc.status_code,
    )


@router.get("/oauth/provider")
def oauth_provider_get(request, organization_id: UUID):
    _require_feishu_import_access(request, organization_id)
    try:
        return success_response(get_provider(request.auth, organization_id))
    except FeishuProviderError as exc:
        return _provider_error_response(exc)


@router.put("/oauth/provider")
def oauth_provider_put(request, payload: OAuthProviderIn):
    _require_feishu_import_access(request, payload.organization_id)
    try:
        provider = configure_provider(
            request.auth,
            organization_id=payload.organization_id,
            app_id=payload.app_id,
            app_secret=payload.app_secret,
        )
    except FeishuProviderError as exc:
        return _provider_error_response(exc)
    return success_response(provider)


@router.delete("/oauth/provider")
def oauth_provider_delete(request, organization_id: UUID):
    try:
        return success_response(delete_provider(request.auth, organization_id))
    except FeishuProviderError as exc:
        return _provider_error_response(exc)


@router.get("/oauth/start")
def oauth_start(
    request,
    organization_id: UUID,
    return_deep_link: Optional[str] = None,
    redirect: bool = False,
):
    """生成 OAuth state 并返回授权 URL（JSON）或 302。"""
    _require_feishu_import_access(request, organization_id)
    provider = None
    try:
        provider = get_active_provider(organization_id)
    except FeishuProviderError as exc:
        if (
            FeishuOAuthProvider.objects.filter(organization_id=organization_id).exists()
            or not get_feishu_oauth_app_id()
            or not get_feishu_oauth_app_secret()
        ):
            return _provider_error_response(exc)

    state = secrets.token_urlsafe(32)
    state_payload = {
        "user_id": str(request.auth.id),
        "organization_id": str(organization_id),
        "return_deep_link": return_deep_link or "",
    }
    if provider is not None:
        state_payload.update({
            "provider_id": str(provider.id),
            "provider_app_id": provider.app_id,
            "provider_credential_version": provider.credential_version,
        })
    cache.set(
        _state_cache_key(state),
        state_payload,
        timeout=OAUTH_STATE_TTL_SECONDS,
    )

    client = client_for_provider(provider) if provider is not None else FeishuClient()
    authorize_url = client.build_authorize_url(state=state)
    logger.info(
        "[FeishuOAuth] start user_id=%s org_id=%s",
        request.auth.id,
        organization_id,
    )
    if redirect:
        return HttpResponseRedirect(authorize_url)
    return success_response({"authorize_url": authorize_url})


@router.get("/oauth/callback", auth=None)
def oauth_callback(request, code: str = "", state: str = ""):
    """OAuth 回调：换 token、upsert 连接、302 到成功页。"""
    if not code or not state:
        raise HttpError(400, "缺少 code 或 state")

    payload = cache.get(_state_cache_key(state))
    cache.delete(_state_cache_key(state))
    if not payload:
        raise HttpError(400, "无效或过期的 state")

    user_id = payload.get("user_id")
    organization_id = payload.get("organization_id")
    provider_id = payload.get("provider_id")
    provider_app_id = payload.get("provider_app_id")
    provider_credential_version = payload.get("provider_credential_version")
    deep_link = payload.get("return_deep_link") or ""
    if not user_id or not organization_id:
        raise HttpError(400, "state 载荷不完整")
    provider_values = (provider_id, provider_app_id, provider_credential_version)
    has_provider_state = all(value is not None and value != "" for value in provider_values)
    if any(value is not None and value != "" for value in provider_values) and not has_provider_state:
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
        return error_response_with_status(
            "provider_invalid",
            message="飞书授权状态无效，请重新发起授权",
            status_code=400,
        )

    provider = None
    provider_uuid = None
    provider_version = None
    if has_provider_state:
        try:
            provider_uuid = UUID(str(provider_id))
            provider_version = int(provider_credential_version)
        except (TypeError, ValueError):
            return error_response_with_status(
                "provider_invalid",
                message="飞书授权状态无效，请重新发起授权",
                status_code=400,
            )

    try:
        _require_org_member(user, organization_uuid)
    except HttpError:
        return error_response_with_status(
            "user_not_authorized",
            message="用户已不属于该组织，无法完成飞书授权",
            status_code=403,
        )

    if not feishu_import_enabled_for_organization(
        user_id=str(user.id),
        organization_id=str(organization_uuid),
        client=None,
    ):
        return error_response_with_status(
            "feature_not_available",
            message=FEISHU_IMPORT_DISABLED_MESSAGE,
            status_code=403,
        )

    if has_provider_state:
        try:
            provider = resolve_oauth_provider(
                organization_id=organization_uuid,
                provider_id=provider_uuid,
                expected_app_id=str(provider_app_id),
                expected_credential_version=provider_version,
            )
        except FeishuProviderError as exc:
            return _provider_error_response(exc)
    elif not get_feishu_oauth_app_id() or not get_feishu_oauth_app_secret():
        return error_response_with_status(
            "provider_not_configured",
            message="组织尚未配置飞书企业自建应用",
            status_code=409,
        )

    client = client_for_provider(provider) if provider is not None else FeishuClient()
    try:
        token_resp = client.exchange_code(code, redirect_uri=get_feishu_oauth_redirect_uri())
    except FeishuAPIError as exc:
        logger.warning("[FeishuOAuth] exchange_code failed: %s", exc)
        raise HttpError(400, "换取飞书令牌失败") from exc

    access_token = token_resp.get("access_token") or ""
    refresh_token = token_resp.get("refresh_token") or ""
    expires_in = int(token_resp.get("expires_in") or 7200)
    refresh_expires_in = int(
        token_resp.get("refresh_token_expires_in")
        or token_resp.get("refresh_expires_in")
        or 0
    )
    if not access_token:
        raise HttpError(400, "飞书未返回 access_token")

    granted_scopes = set(str(token_resp.get("scope") or "").split())
    required_scopes = set(OAUTH_SCOPES.split())
    # 旧版飞书换票响应可能完全不返回 scope；保留这类升级中回调的兼容性。
    # 只要服务端明确返回了 scope，就必须校验完整，避免权限未发布时仍显示连接成功。
    should_validate_scopes = provider is not None or "scope" in token_resp
    if should_validate_scopes and not required_scopes.issubset(granted_scopes):
        return error_response_with_status(
            "provider_permission_incomplete",
            message="飞书应用授权范围不完整，请由管理员补齐权限后重试",
            status_code=400,
        )

    open_id = ""
    display_name = ""
    try:
        info = client.get_user_info(access_token)
        open_id = info.get("open_id") or info.get("sub") or ""
        display_name = info.get("name") or info.get("en_name") or ""
    except FeishuAPIError as exc:
        logger.warning("[FeishuOAuth] get_user_info failed: %s", exc)
        return error_response_with_status(
            "provider_invalid",
            message="无法确认飞书企业身份，请重新授权",
            status_code=400,
        )
    expires_at = timezone.now() + timedelta(seconds=expires_in)
    refresh_token_expires_at = (
        timezone.now() + timedelta(seconds=refresh_expires_in)
        if refresh_expires_in > 0
        else None
    )
    try:
        with transaction.atomic():
            # 外部换票期间管理员可能创建/轮换 Provider；落库前用组织锁统一复核。
            lock_provider_guard(organization_uuid)
            if provider is not None:
                provider = resolve_oauth_provider(
                    organization_id=organization_uuid,
                    provider_id=provider_uuid,
                    expected_app_id=str(provider_app_id),
                    expected_credential_version=provider_version,
                    for_update=True,
                )
                bind_provider_tenant(provider, str(info.get("tenant_key") or ""))
            elif FeishuOAuthProvider.objects.filter(
                organization_id=organization_uuid,
            ).exists():
                raise FeishuProviderError(
                    "provider_invalid",
                    "飞书应用配置已变更，请重新发起授权",
                    409,
                )
            FeishuOAuthConnection.objects.update_or_create(
                user=user,
                organization_id=organization_uuid,
                defaults={
                    "provider": provider,
                    "credential_version": (
                        provider.credential_version if provider is not None else None
                    ),
                    "tokens": {
                        "access_token": access_token,
                        "refresh_token": refresh_token,
                    },
                    "expires_at": expires_at,
                    "refresh_token_expires_at": refresh_token_expires_at,
                    "granted_scopes": sorted(granted_scopes),
                    "open_id": open_id,
                    "display_name": display_name,
                    "status": FeishuOAuthConnection.Status.CONNECTED,
                },
            )
    except FeishuProviderError as exc:
        return _provider_error_response(exc)
    logger.info(
        "[FeishuOAuth] connected user_id=%s org_id=%s open_id=%s",
        user_id,
        organization_id,
        open_id,
    )

    success = get_feishu_oauth_success_redirect()
    qs = {}
    if deep_link:
        qs["deep_link"] = deep_link
    else:
        qs["deep_link"] = "tabtin://integrations/feishu/connected"
    qs["connected"] = "1"
    qs["organization_id"] = str(organization_id)
    sep = "&" if "?" in success else "?"
    return HttpResponseRedirect(f"{success}{sep}{urlencode(qs)}")


def _safe_feishu_deep_link(raw: str) -> str:
    """只允许 tabtin:// 自定义协议，且限制字符集，避免反射进 HTML/JS。"""
    import re

    default = "tabtin://integrations/feishu/connected"
    link = (raw or default).strip()
    if not re.fullmatch(r"tabtin://[\w\-./?=&%:+]*", link):
        return default
    return link


@router.get("/oauth/done", auth=None)
def oauth_done(request, deep_link: str = "", connected: str = "", organization_id: str = ""):
    """授权成功落地页：唤起 Electron deep link，不依赖 tabtin-web。"""
    link = _safe_feishu_deep_link(deep_link)
    # 只写入已 escape 的属性；脚本从 DOM 读取，避免 </script> 反射型 XSS
    safe_link = escape(link)
    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>飞书授权完成</title>
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
  <div class="card">
    <h1>飞书授权已完成</h1>
    <p>正在返回 TabTin 客户端。若未自动打开，请点击下方按钮。</p>
    <a class="btn" id="open" href="{safe_link}" data-href="{safe_link}">打开 TabTin</a>
  </div>
  <script>
    (function () {{
      var el = document.getElementById('open');
      var href = el && el.getAttribute('data-href');
      if (!href) return;
      try {{ window.location.href = href; }} catch (e) {{}}
      setTimeout(function () {{
        try {{ window.location.href = href; }} catch (e) {{}}
      }}, 400);
    }})();
  </script>
</body>
</html>
"""
    return HttpResponse(html, content_type="text/html; charset=utf-8")


def _parse_resource_kinds(kinds: str) -> list[str] | None:
    raw = (kinds or "").strip()
    if not raw or raw == "all":
        return None
    parts = [p.strip().lower() for p in raw.split(",") if p.strip()]
    allowed = {RESOURCE_KIND_BITABLE, RESOURCE_KIND_DOCX}
    out = [p for p in parts if p in allowed]
    return out or None


def _get_cached_untitled_resources(
    client: FeishuClient,
    access_token: str,
    connection: FeishuOAuthConnection,
) -> list[dict]:
    cache_key = f"feishu:untitled-resources:v3:{connection.id}"
    lock_key = f"{cache_key}:building"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    lock_owner = secrets.token_urlsafe(16)
    if cache.add(lock_key, lock_owner, timeout=_UNTITLED_RESOURCE_BUILD_LOCK_SECONDS):
        try:
            catalog = client.list_untitled_resource_catalog(
                access_token,
                kinds=[RESOURCE_KIND_BITABLE, RESOURCE_KIND_DOCX],
            )
            timeout = (
                _UNTITLED_RESOURCE_CACHE_TTL_SECONDS
                if catalog.complete and catalog.resources
                else _EMPTY_UNTITLED_RESOURCE_CACHE_TTL_SECONDS
            )
            if not catalog.complete:
                logger.warning(
                    "[FeishuAPI] caching partial untitled catalog connection_id=%s sources=%s",
                    connection.id,
                    ",".join(catalog.failed_sources),
                )
            cache.set(cache_key, catalog.resources, timeout=timeout)
            return catalog.resources
        finally:
            if cache.get(lock_key) == lock_owner:
                cache.delete(lock_key)

    deadline = time.monotonic() + _UNTITLED_RESOURCE_BUILD_WAIT_SECONDS
    while time.monotonic() < deadline:
        time.sleep(_UNTITLED_RESOURCE_BUILD_POLL_SECONDS)
        cached = cache.get(cache_key)
        if cached is not None:
            return cached
    raise FeishuAPIError("飞书未命名资源目录正在构建，请稍后重试")


def _get_cached_tenant_host(
    client: FeishuClient,
    connection: FeishuOAuthConnection,
) -> str:
    provider = connection.provider
    app_id = provider.app_id if provider else get_feishu_oauth_app_id()
    app_secret = provider.app_secret if provider else get_feishu_oauth_app_secret()
    credential_version = provider.credential_version if provider else 0
    cache_key = f"feishu:tenant-domain:v1:{connection.organization_id}:{credential_version}"
    cached = cache.get(cache_key)
    if cached:
        return str(cached)

    try:
        tenant = client.get_tenant_domain(app_id, app_secret)
    except FeishuAPIError as exc:
        if exc.status_code == 403 or exc.code == 1184001:
            raise FeishuAPIError(
                "飞书应用缺少企业信息权限 tenant:tenant:readonly 或完整域名字段权限 tenant:tenant.domain:read",
                code=exc.code,
                status_code=403,
            ) from exc
        raise
    tenant_key = str(tenant.get("tenant_key") or "")
    expected_tenant_key = str(provider.tenant_key or "") if provider else ""
    if expected_tenant_key and tenant_key != expected_tenant_key:
        raise FeishuAPIError("飞书应用所属企业与当前连接不一致")
    domain = str(tenant.get("domain") or "").strip().lower()
    if not domain:
        raise FeishuAPIError(
            "飞书应用缺少完整域名字段权限 tenant:tenant.domain:read",
            code=1184001,
            status_code=403,
        )
    cache.set(cache_key, domain, timeout=_TENANT_DOMAIN_CACHE_TTL_SECONDS)
    return domain


def _raise_feishu_list_permission_error(exc: FeishuAPIError, *, context: str) -> None:
    msg = str(exc)
    if (
        "tenant:tenant:readonly" in msg
        or "tenant:tenant.domain:read" in msg
        or exc.code == 1184001
    ):
        raise HttpError(
            403,
            "飞书应用缺少企业信息权限，请在开放平台开通 tenant:tenant:readonly 和 tenant:tenant.domain:read 并发布应用后重试。",
        ) from exc
    if (
        "drive:drive" in msg
        or "drive.metadata" in msg
        or "99991679" in msg
        or "search:docs:read" in msg
        or "docs:document.content" in msg
        or "docx:document" in msg
    ):
        raise HttpError(
            403,
            "飞书应用缺少云盘/文档权限，或当前授权未包含该权限。"
            "请在飞书开放平台开通 drive:drive:readonly、"
            "drive:drive.metadata:readonly、search:docs:read、"
            "docs:document.content:read、"
            "docx:document:readonly，并在 TabTin 断开飞书后重新授权。",
        ) from exc
    if "wiki:" in msg or "wiki/" in msg or "99991672" in msg or "99991679" in msg:
        raise HttpError(
            403,
            "飞书应用缺少知识库只读权限，或当前授权未包含该权限。"
            "请在飞书开放平台开通 wiki:wiki:readonly（或 wiki:node:read）"
            "以及 wiki:space:retrieve / wiki:node:retrieve，"
            "并在 TabTin 断开后重新授权。",
        ) from exc
    raise HttpError(502, f"调用飞书{context}失败") from exc


def _browse_page_payload(page: dict) -> dict:
    items = [
        BrowseNodeOut(**row).model_dump()
        for row in (page.get("items") or [])
    ]
    return BrowseChildrenOut(
        items=items,
        next_page_token=page.get("next_page_token"),
        has_more=bool(page.get("has_more")),
    ).model_dump()


@router.get("/resources")
def list_importable_resources(
    request,
    organization_id: UUID,
    q: str = "",
    kinds: str = "all",
    defer_wiki_resolution: bool = False,
):
    """同通道可导入资源列表（bitable / docx）。搜索仍走此接口；树浏览见 /drive/* /wiki/*。"""
    _require_feishu_import_access(request, organization_id)
    conn = _get_connected(request.auth, organization_id)
    client = FeishuClient()
    try:
        token = client.get_valid_access_token(conn)
        parsed_kinds = _parse_resource_kinds(kinds)
        wanted_kinds = parsed_kinds or [RESOURCE_KIND_BITABLE, RESOURCE_KIND_DOCX]
        untitled_candidates = None
        if client._untitled_kinds_matching(q or "", wanted_kinds):
            untitled_candidates = _get_cached_untitled_resources(
                client,
                token,
                conn,
            )
        # 用户令牌已由飞书限制到“当前用户可访问”；按 owner 再过滤会误删共享资源。
        resources = client.list_importable_resources(
            token,
            search_key=q or "",
            kinds=parsed_kinds,
            untitled_candidates=untitled_candidates,
            defer_wiki_resolution=defer_wiki_resolution,
            max_search_pages=3 if defer_wiki_resolution else 1,
            tenant_host_resolver=lambda: _get_cached_tenant_host(client, conn),
        )
    except FeishuAuthError as exc:
        raise HttpError(403, str(exc)) from exc
    except FeishuAPIError as exc:
        logger.warning("[FeishuAPI] list resources failed: %s", exc)
        _raise_feishu_list_permission_error(exc, context="列出资源")
    payload = [
        ImportableResourceOut(
            token=r["token"],
            name=r["name"],
            kind=r["kind"],
            wiki_node_token=r.get("wiki_node_token"),
        ).model_dump(exclude_none=True)
        for r in resources
    ]
    return success_response(payload)


@router.get("/resources/wiki/resolve")
def resolve_wiki_resource(
    request,
    organization_id: UUID,
    node_token: str,
    expected_kind: str = "",
):
    """Resolve one selected Wiki search result to its importable resource."""
    _require_feishu_import_access(request, organization_id)
    conn = _get_connected(request.auth, organization_id)
    client = FeishuClient()
    try:
        token = client.get_valid_access_token(conn)
        try:
            node = client.get_wiki_node(token, node_token, raise_on_error=True)
        except FeishuAPIError as exc:
            if not is_expired_access_token_error(exc):
                raise
            token = client.get_valid_access_token(conn, force_refresh=True)
            node = client.get_wiki_node(token, node_token, raise_on_error=True)
    except FeishuAuthError as exc:
        raise HttpError(403, str(exc)) from exc
    except FeishuAPIError as exc:
        logger.warning("[FeishuAPI] resolve wiki resource failed: %s", exc)
        if is_auth_api_error(exc):
            status = 403
        elif exc.status_code in {403, 404} or exc.code in {403, 1002, 99991679}:
            status = 404
        else:
            status = 502
        raise HttpError(status, user_facing_import_error(exc)) from exc

    resolved_token = str((node or {}).get("token") or "").strip()
    kind = str((node or {}).get("import_kind") or "").strip()
    if not resolved_token or kind not in (RESOURCE_KIND_BITABLE, RESOURCE_KIND_DOCX):
        raise HttpError(404, "该飞书资源已删除、无权访问或暂不支持导入")
    normalized_expected_kind = (expected_kind or "").strip().lower()
    if normalized_expected_kind and normalized_expected_kind != kind:
        raise HttpError(409, "飞书资源类型已发生变化，请重新搜索后再试")
    payload = ImportableResourceOut(
        token=resolved_token,
        name=str((node or {}).get("name") or resolved_token),
        kind=kind,
    ).model_dump(exclude_none=True)
    return success_response(payload)


@router.get("/drive/root")
def get_drive_root(request, organization_id: UUID):
    """云盘「我的空间」根 folder_token，供树浏览首层展开。"""
    _require_feishu_import_access(request, organization_id)
    conn = _get_connected(request.auth, organization_id)
    client = FeishuClient()
    try:
        token = client.get_valid_access_token(conn)
        folder_token = client.get_my_space_root_folder_token(token)
    except FeishuAuthError as exc:
        raise HttpError(403, str(exc)) from exc
    except FeishuAPIError as exc:
        logger.warning("[FeishuAPI] drive root failed: %s", exc)
        _raise_feishu_list_permission_error(exc, context="获取云盘根目录")
    if not folder_token:
        raise HttpError(502, "无法获取飞书「我的空间」根目录")
    node = BrowseNodeOut(
        id=f"drive:folder:{folder_token}",
        name="我的空间",
        node_kind="folder",
        selectable=False,
        expandable=True,
        folder_token=folder_token,
        token=folder_token,
        has_child=True,
    ).model_dump()
    return success_response(node)


@router.get("/drive/children")
def list_drive_children(
    request,
    organization_id: UUID,
    folder_token: str,
    page_token: str = "",
):
    """列云盘文件夹子项（folder + bitable + docx）。"""
    _require_feishu_import_access(request, organization_id)
    conn = _get_connected(request.auth, organization_id)
    client = FeishuClient()
    try:
        token = client.get_valid_access_token(conn)
        page = client.list_drive_folder_children(
            token,
            folder_token,
            page_token=page_token or None,
            include_folders=True,
        )
    except FeishuAuthError as exc:
        raise HttpError(403, str(exc)) from exc
    except FeishuAPIError as exc:
        logger.warning("[FeishuAPI] drive children failed: %s", exc)
        _raise_feishu_list_permission_error(exc, context="列出云盘子项")
    return success_response(_browse_page_payload(page))


@router.get("/wiki/spaces")
def list_wiki_spaces(request, organization_id: UUID, page_token: str = ""):
    """知识空间列表；首页含合成入口「我的文档库」(my_library)。"""
    _require_feishu_import_access(request, organization_id)
    conn = _get_connected(request.auth, organization_id)
    client = FeishuClient()
    try:
        token = client.get_valid_access_token(conn)
        page = client.list_wiki_spaces(
            token,
            page_token=page_token or None,
            include_my_library=True,
        )
    except FeishuAuthError as exc:
        raise HttpError(403, str(exc)) from exc
    except FeishuAPIError as exc:
        logger.warning("[FeishuAPI] wiki spaces failed: %s", exc)
        _raise_feishu_list_permission_error(exc, context="列出知识空间")
    return success_response(_browse_page_payload(page))


@router.get("/wiki/nodes")
def list_wiki_nodes(
    request,
    organization_id: UUID,
    space_id: str,
    parent_node_token: str = "",
    page_token: str = "",
):
    """列知识库节点；docx/bitable 可导入，容器仅可展开。"""
    _require_feishu_import_access(request, organization_id)
    conn = _get_connected(request.auth, organization_id)
    client = FeishuClient()
    try:
        token = client.get_valid_access_token(conn)
        page = client.list_wiki_nodes(
            token,
            space_id,
            parent_node_token=parent_node_token or None,
            page_token=page_token or None,
        )
    except FeishuAuthError as exc:
        raise HttpError(403, str(exc)) from exc
    except FeishuAPIError as exc:
        logger.warning("[FeishuAPI] wiki nodes failed: %s", exc)
        _raise_feishu_list_permission_error(exc, context="列出知识库节点")
    return success_response(_browse_page_payload(page))


@router.post("/resolve")
def resolve_urls(request, body: ResolveUrlsIn):
    """解析飞书文档 / 多维表链接为 kind + token，并用当前连接探测可见性。"""
    _require_feishu_import_access(request, body.organization_id)
    urls = [u for u in (body.urls or []) if isinstance(u, str) and u.strip()]
    if not urls:
        raise HttpError(400, "urls 不能为空")
    if len(urls) > 50:
        raise HttpError(400, "单次最多解析 50 条链接")

    conn = _get_connected(request.auth, body.organization_id)
    client = FeishuClient()
    try:
        token = client.get_valid_access_token(conn)
    except FeishuAuthError as exc:
        raise HttpError(403, str(exc)) from exc

    items = resolve_feishu_urls(urls, client=client, access_token=token)
    payload = ResolveUrlsOut(
        items=[ResolveUrlItemOut(**row) for row in items],
    ).model_dump()
    return success_response(payload)


@router.post("/flow/parse")
def parse_flow(request, body: ParseFlowIn):
    """将飞书 Wiki/Docx 内嵌画板解析为聊天区 Flow View 数据。"""
    _require_feishu_import_access(request, body.organization_id)
    if not (body.url or "").strip():
        raise HttpError(400, "url 不能为空")

    conn = _get_connected(request.auth, body.organization_id)
    client = FeishuClient()
    try:
        token = client.get_valid_access_token(conn)
        payload = parse_feishu_flow(client, token, body.url.strip())
    except FeishuAuthError as exc:
        raise HttpError(403, str(exc)) from exc
    except FeishuFlowParseError as exc:
        raise HttpError(400, str(exc)) from exc
    except FeishuAPIError as exc:
        logger.warning("[FeishuAPI] parse flow failed: %s", exc)
        message = str(exc)
        if "99991679" in message or "board:whiteboard:node:read" in message:
            raise HttpError(
                403,
                "飞书应用缺少画板节点只读权限，或当前授权尚未包含该权限。"
                "请开通 board:whiteboard:node:read，并在 TabTin 断开后重新授权。",
            ) from exc
        raise HttpError(502, "调用飞书读取画板流程图失败") from exc
    return success_response(payload)


@router.get("/bitable/apps")
def list_bitable_apps(request, organization_id: UUID, q: str = ""):
    """兼容旧客户端：仅返回多维表。"""
    _require_feishu_import_access(request, organization_id)
    conn = _get_connected(request.auth, organization_id)
    client = FeishuClient()
    try:
        token = client.get_valid_access_token(conn)
        apps = client.list_bitable_apps(token, search_key=q or "")
    except FeishuAuthError as exc:
        raise HttpError(403, str(exc)) from exc
    except FeishuAPIError as exc:
        logger.warning("[FeishuAPI] list apps failed: %s", exc)
        msg = str(exc)
        if "drive:drive" in msg or "99991679" in msg or "search:docs:read" in msg:
            raise HttpError(
                403,
                "飞书应用缺少「云文档」只读权限，或当前授权未包含该权限。"
                "请在飞书开放平台开通 drive:drive:readonly，并在 TabTin 断开后重新授权。",
            ) from exc
        raise HttpError(502, "调用飞书列出多维表失败") from exc
    payload = [BitableAppOut(app_token=a["app_token"], name=a["name"]).model_dump() for a in apps]
    return success_response(payload)


@router.get("/bitable/apps/{app_token}/tables")
def list_bitable_tables(request, app_token: str, organization_id: UUID):
    _require_feishu_import_access(request, organization_id)
    conn = _get_connected(request.auth, organization_id)
    client = FeishuClient()
    try:
        token = client.get_valid_access_token(conn)
        tables = client.list_tables(token, app_token)
    except FeishuAuthError as exc:
        raise HttpError(403, str(exc)) from exc
    except FeishuAPIError as exc:
        logger.warning("[FeishuAPI] list tables failed: %s", exc)
        raise HttpError(502, "调用飞书列出数据表失败") from exc
    payload = [BitableTableOut(table_id=t["table_id"], name=t["name"]).model_dump() for t in tables]
    return success_response(payload)


@router.post("/import/preview")
def preview_import(request, body: ImportPreviewIn):
    """分析所选表的同 Base Link 闭包，供导入前审查。"""
    _require_feishu_import_access(request, body.organization_id)
    conn = _get_connected(request.auth, body.organization_id)

    selected = body.tables or []
    if not selected:
        raise HttpError(400, "tables 不能为空")

    client = FeishuClient()
    try:
        token = client.get_valid_access_token(conn)
    except FeishuAuthError as exc:
        raise HttpError(403, str(exc)) from exc

    tables_by_app: dict = {}
    fields_by_table: dict = {}
    try:
        app_tokens = {t.app_token for t in selected if t.app_token}
        for app_token in app_tokens:
            tables_by_app[app_token] = client.list_tables(token, app_token)
            # 先拉已选表字段；闭包扩展后再补
            for t in selected:
                if t.app_token != app_token:
                    continue
                fields_by_table[(app_token, t.table_id)] = client.list_fields(
                    token, app_token, t.table_id,
                )

        # 迭代扩展闭包所需字段，直到所有同 Base 关联表都已分析。
        expanded = True
        while expanded:
            expanded = False
            preview = build_import_preview(
                selected=[
                    {
                        "app_token": t.app_token,
                        "table_id": t.table_id,
                        "name": t.name or "",
                    }
                    for t in selected
                ],
                tables_by_app=tables_by_app,
                fields_by_table=fields_by_table,
            )
            for row in preview["tables"]:
                key = (row["app_token"], row["table_id"])
                if key not in fields_by_table:
                    fields_by_table[key] = client.list_fields(
                        token, row["app_token"], row["table_id"],
                    )
                    expanded = True
    except FeishuAuthError as exc:
        raise HttpError(403, str(exc)) from exc
    except FeishuAPIError as exc:
        logger.warning("[FeishuAPI] import preview failed: %s", exc)
        raise HttpError(502, f"分析飞书关联失败: {exc}") from exc

    preview = build_import_preview(
        selected=[
            {
                "app_token": t.app_token,
                "table_id": t.table_id,
                "name": t.name or "",
            }
            for t in selected
        ],
        tables_by_app=tables_by_app,
        fields_by_table=fields_by_table,
    )
    return success_response(ImportPreviewOut(**preview).model_dump())


@router.post("/import")
def start_import(request, body: ImportRequestIn):
    _require_feishu_import_access(request, body.organization_id)
    _require_import_targets(body.organization_id, body.space_id, body.collection_id)

    tables = body.tables or []
    documents = body.documents or []
    if not tables and not documents:
        raise HttpError(400, "请至少选择一张多维表或一篇云文档")

    with transaction.atomic():
        # 与 Provider 创建/轮换/删除共用组织锁：任务一旦入队，
        # 管理端在它结束前必定能观测到 PENDING/RUNNING 状态。
        lock_provider_guard(body.organization_id)
        _get_connected(request.auth, body.organization_id)
        job = FeishuImportJob.objects.create(
            user=request.auth,
            organization_id=body.organization_id,
            space_id=body.space_id,
            collection_id=body.collection_id,
            tables=[
                {
                    "app_token": t.app_token,
                    "table_id": t.table_id,
                    "name": t.name or "",
                }
                for t in tables
            ],
            documents=[
                {
                    "doc_token": d.doc_token,
                    "name": d.name or "",
                    "doc_type": (d.doc_type or "docx").strip().lower() or "docx",
                }
                for d in documents
            ],
            status=FeishuImportJob.Status.PENDING,
            result={"include_attachments": bool(body.include_attachments)},
        )
    async_result = run_feishu_import_task.delay(str(job.id))
    job.celery_task_id = async_result.id or ""
    job.save(update_fields=["celery_task_id", "updated_at"])
    return success_response(ImportStartOut(task_id=str(job.id)).model_dump())


@router.get("/import/{task_id}")
def get_import_status(request, task_id: UUID):
    try:
        job = FeishuImportJob.objects.get(id=task_id, user_id=request.auth.id)
    except FeishuImportJob.DoesNotExist:
        raise HttpError(404, "导入任务不存在") from None
    return success_response(
        ImportStatusOut(
            task_id=str(job.id),
            status=job.status,
            result=job.result or None,
            error=job.error or None,
        ).model_dump()
    )


@router.post("/import/{task_id}/cancel-table")
def cancel_import_table(request, task_id: UUID, body: ImportTableActionIn):
    """取消尚未开始的单表导入计划。"""
    try:
        job = FeishuImportJob.objects.get(id=task_id, user_id=request.auth.id)
    except FeishuImportJob.DoesNotExist:
        raise HttpError(404, "导入任务不存在") from None
    ok, message = request_cancel_table(job, body.app_token, body.table_id)
    if not ok:
        raise HttpError(400, message)
    return success_response(ImportTableActionOut().model_dump())


@router.post("/import/{task_id}/skip-table")
def skip_import_table(request, task_id: UUID, body: ImportTableActionIn):
    """跳过当前正在导入的表（停止后续行写入）。"""
    try:
        job = FeishuImportJob.objects.get(id=task_id, user_id=request.auth.id)
    except FeishuImportJob.DoesNotExist:
        raise HttpError(404, "导入任务不存在") from None
    ok, message = request_skip_table(job, body.app_token, body.table_id)
    if not ok:
        raise HttpError(400, message)
    return success_response(ImportTableActionOut().model_dump())
