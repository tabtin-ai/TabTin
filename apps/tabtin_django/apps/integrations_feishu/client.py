"""飞书 OpenAPI HTTP 客户端（可 mock）。"""

from __future__ import annotations

import html
import logging
import re
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import timedelta
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import quote, urlencode, urlparse

import httpx
from django.db import transaction
from django.utils import timezone

from .constants import (
    FEISHU_RECORD_PAGE_SIZE,
    MAX_ROWS_PER_TABLE,
    OAUTH_SCOPES,
    RESOURCE_KIND_BITABLE,
    RESOURCE_KIND_DOCX,
    STATUS_REAUTHORIZATION_REQUIRED,
    STATUS_REVOKED,
    TOKEN_REFRESH_SKEW_SECONDS,
    WIKI_SPACE_MY_LIBRARY,
    get_feishu_accounts_base,
    get_feishu_api_base,
    get_feishu_oauth_app_id,
    get_feishu_oauth_app_secret,
    get_feishu_oauth_redirect_uri,
)

logger = logging.getLogger(__name__)


class FeishuAuthError(Exception):
    """需要用户重新授权。"""


class FeishuReauthorizationRequired(FeishuAuthError):
    """组织凭证已变化，当前成员必须重新授权。"""


class FeishuAPIError(Exception):
    def __init__(self, message: str, *, code: Optional[int] = None, status_code: Optional[int] = None):
        super().__init__(message)
        self.code = code
        self.status_code = status_code


@dataclass(frozen=True)
class UntitledResourceCatalog:
    resources: List[Dict[str, str]]
    complete: bool
    failed_sources: tuple[str, ...] = ()


class FeishuClient:
    """封装 OAuth 换票 / 刷新 / 多维表读写。日志禁止输出 token。"""

    _UNTITLED_NAMES = {
        "folder": "未命名文件夹",
        "wiki_space": "未命名知识空间",
        "wiki_node": "未命名文档",
        RESOURCE_KIND_BITABLE: "未命名多维表",
        RESOURCE_KIND_DOCX: "未命名文档",
        "table": "未命名数据表",
    }

    def __init__(
        self,
        *,
        api_base: Optional[str] = None,
        accounts_base: Optional[str] = None,
        timeout: float = 30.0,
        transport: Optional[httpx.BaseTransport] = None,
        app_id: Optional[str] = None,
        app_secret: Optional[str] = None,
    ):
        self.api_base = (api_base or get_feishu_api_base()).rstrip("/")
        self.accounts_base = (accounts_base or get_feishu_accounts_base()).rstrip("/")
        self.timeout = timeout
        self._transport = transport
        self.app_id = get_feishu_oauth_app_id() if app_id is None else app_id
        self.app_secret = get_feishu_oauth_app_secret() if app_secret is None else app_secret

    def _client(self) -> httpx.Client:
        kwargs: Dict[str, Any] = {"timeout": self.timeout}
        if self._transport is not None:
            kwargs["transport"] = self._transport
        return httpx.Client(**kwargs)

    @classmethod
    def _display_name(
        cls,
        raw_name: Any,
        *,
        kind: str,
        identifiers: Optional[List[str]] = None,
    ) -> str:
        name = str(raw_name or "").strip()
        hidden = {str(value or "").strip() for value in (identifiers or [])}
        if name and name not in hidden:
            return name
        return cls._UNTITLED_NAMES.get(kind, "未命名文档")

    @staticmethod
    def _filter_and_rank_by_name(
        resources: List[Dict[str, str]],
        search_key: str,
    ) -> List[Dict[str, str]]:
        query = (search_key or "").strip().casefold()
        if not query:
            return resources
        ranked = []
        for index, resource in enumerate(resources):
            name = str(resource.get("name") or "").strip().casefold()
            if query not in name:
                continue
            rank = 0 if name == query else 1 if name.startswith(query) else 2
            ranked.append((rank, index, resource))
        ranked.sort(key=lambda row: (row[0], row[1]))
        return [row[2] for row in ranked]

    @classmethod
    def _untitled_kinds_matching(
        cls,
        search_key: str,
        kinds: List[str],
    ) -> List[str]:
        query = (search_key or "").strip().casefold()
        if not query:
            return []
        return [
            kind
            for kind in kinds
            if query in cls._UNTITLED_NAMES.get(kind, "").casefold()
        ]

    @staticmethod
    def _merge_resources(
        *resource_groups: List[Dict[str, str]],
    ) -> List[Dict[str, str]]:
        merged: List[Dict[str, str]] = []
        seen = set()
        for resources in resource_groups:
            for resource in resources:
                dedupe = f'{resource.get("kind", "")}:{resource.get("token", "")}'
                if dedupe in seen:
                    continue
                seen.add(dedupe)
                merged.append(resource)
        return merged

    # ── OAuth ──────────────────────────────────────────────

    def validate_tenant_credentials(self, app_id: str, app_secret: str) -> Dict[str, Any]:
        """校验企业自建应用凭证；tenant token 仅用于本次判断，不持久化。"""
        return self._post_json(
            f"{self.api_base}/open-apis/auth/v3/tenant_access_token/internal/",
            json={"app_id": app_id, "app_secret": app_secret},
        )

    def get_tenant_domain(self, app_id: str, app_secret: str) -> Dict[str, str]:
        """Return the provider tenant's stable identity and full Feishu domain."""
        credentials = self.validate_tenant_credentials(app_id, app_secret)
        tenant_access_token = str(credentials.get("tenant_access_token") or "")
        if not tenant_access_token:
            raise FeishuAPIError("飞书未返回企业访问凭证")
        data = self._get_json(
            f"{self.api_base}/open-apis/tenant/v2/tenant/query",
            access_token=tenant_access_token,
        )
        body = data.get("data") if isinstance(data.get("data"), dict) else data
        tenant = (body or {}).get("tenant") or {}
        return {
            "tenant_key": str(tenant.get("tenant_key") or "").strip(),
            "domain": str(tenant.get("domain") or "").strip().lower(),
        }

    def build_authorize_url(self, *, state: str, redirect_uri: Optional[str] = None) -> str:
        params = {
            "client_id": self.app_id,
            "redirect_uri": redirect_uri or get_feishu_oauth_redirect_uri(),
            "response_type": "code",
            "state": state,
            "scope": OAUTH_SCOPES,
        }
        return f"{self.accounts_base}/open-apis/authen/v1/authorize?{urlencode(params)}"

    def exchange_code(self, code: str, *, redirect_uri: Optional[str] = None) -> Dict[str, Any]:
        payload = {
            "grant_type": "authorization_code",
            "client_id": self.app_id,
            "client_secret": self.app_secret,
            "code": code,
            "redirect_uri": redirect_uri or get_feishu_oauth_redirect_uri(),
        }
        return self._post_json(f"{self.api_base}/open-apis/authen/v2/oauth/token", json=payload)

    def refresh_access_token(
        self,
        refresh_token: str,
        *,
        app_id: Optional[str] = None,
        app_secret: Optional[str] = None,
    ) -> Dict[str, Any]:
        payload = {
            "grant_type": "refresh_token",
            "client_id": app_id if app_id is not None else self.app_id,
            "client_secret": app_secret if app_secret is not None else self.app_secret,
            "refresh_token": refresh_token,
        }
        return self._post_json(f"{self.api_base}/open-apis/authen/v2/oauth/token", json=payload)

    def get_user_info(self, access_token: str) -> Dict[str, Any]:
        data = self._get_json(
            f"{self.api_base}/open-apis/authen/v1/user_info",
            access_token=access_token,
        )
        # v1 返回 {code, data: {...}}；兼容扁平结构
        if isinstance(data, dict) and "data" in data and isinstance(data["data"], dict):
            return data["data"]
        return data

    def get_valid_access_token(self, connection, *, force_refresh: bool = False) -> str:
        """校验凭证版本并在过期前刷新；锁顺序固定为 Provider → Connection。"""
        from .models import FeishuOAuthConnection, FeishuOAuthProvider

        if not isinstance(connection, FeishuOAuthConnection):
            raise TypeError("connection must be FeishuOAuthConnection")

        try:
            with transaction.atomic():
                snapshot = FeishuOAuthConnection.objects.only("provider_id").get(
                    id=connection.id,
                )
                if snapshot.provider_id is None:
                    # 升级过渡：组织 Provider 尚未配置时，已发布旧客户端
                    # 创建的连接继续使用实例级凭证。Provider 一旦配置即停止 fallback。
                    if (
                        FeishuOAuthProvider.objects.filter(
                            organization_id=connection.organization_id,
                        ).exists()
                        or not self.app_id
                        or not self.app_secret
                    ):
                        raise FeishuReauthorizationRequired(
                            "飞书企业应用凭证已更新，请重新授权",
                        )
                    locked = FeishuOAuthConnection.objects.select_for_update().get(
                        id=connection.id,
                    )
                    if locked.status == STATUS_REVOKED:
                        raise FeishuAuthError("飞书连接已失效，请重新授权")
                    locked_tokens = locked.tokens or {}
                    locked_access = str(locked_tokens.get("access_token") or "")
                    if not force_refresh and not self._needs_token_refresh(
                        locked_access,
                        locked.expires_at,
                    ):
                        connection.tokens = locked.tokens
                        connection.expires_at = locked.expires_at
                        connection.status = locked.status
                        return locked_access
                    new_access = self._refresh_locked_connection(locked, None)
                    connection.tokens = locked.tokens
                    connection.expires_at = locked.expires_at
                    connection.status = locked.status
                    return new_access
                provider = FeishuOAuthProvider.objects.select_for_update().get(
                    id=snapshot.provider_id,
                )
                locked = FeishuOAuthConnection.objects.select_for_update().get(
                    id=connection.id,
                )
                self._assert_current_provider_credentials(locked, provider)
                if locked.status == STATUS_REVOKED:
                    raise FeishuAuthError("飞书连接已失效，请重新授权")

                locked_tokens = locked.tokens or {}
                locked_access = str(locked_tokens.get("access_token") or "")
                if not force_refresh and not self._needs_token_refresh(
                    locked_access,
                    locked.expires_at,
                ):
                    connection.tokens = locked.tokens
                    connection.expires_at = locked.expires_at
                    connection.status = locked.status
                    return locked_access

                new_access = self._refresh_locked_connection(locked, provider)
                connection.tokens = locked.tokens
                connection.expires_at = locked.expires_at
                connection.status = locked.status
        except (
            FeishuOAuthConnection.DoesNotExist,
            FeishuOAuthProvider.DoesNotExist,
            FeishuReauthorizationRequired,
        ) as exc:
            FeishuOAuthConnection.objects.filter(id=connection.id).update(
                status=STATUS_REAUTHORIZATION_REQUIRED,
                tokens={},
                expires_at=None,
                refresh_token_expires_at=None,
                granted_scopes=[],
                updated_at=timezone.now(),
            )
            connection.status = STATUS_REAUTHORIZATION_REQUIRED
            logger.warning(
                "[FeishuClient] connection requires reauthorization id=%s",
                connection.id,
            )
            if isinstance(exc, FeishuReauthorizationRequired):
                raise
            raise FeishuReauthorizationRequired(
                "飞书企业应用凭证已更新，请重新授权",
            ) from exc
        except FeishuAuthError:
            FeishuOAuthConnection.objects.filter(id=connection.id).update(
                status=STATUS_REVOKED,
                updated_at=timezone.now(),
            )
            connection.status = STATUS_REVOKED
            logger.warning(
                "[FeishuClient] connection revoked id=%s reason=refresh_unusable",
                connection.id,
            )
            raise

        logger.info(
            "[FeishuClient] refreshed token connection_id=%s open_id=%s",
            locked.id,
            locked.open_id,
        )
        return new_access

    @staticmethod
    def _assert_current_provider_credentials(connection, provider) -> None:
        if (
            connection.status == STATUS_REAUTHORIZATION_REQUIRED
            or provider.status != provider.Status.ACTIVE
            or provider.organization_id != connection.organization_id
            or connection.provider_id != provider.id
            or connection.credential_version is None
            or connection.credential_version != provider.credential_version
        ):
            raise FeishuReauthorizationRequired(
                "飞书企业应用凭证已更新，请重新授权",
            )

    def _refresh_locked_connection(self, connection, provider=None) -> str:
        tokens = connection.tokens or {}
        refresh_token = str(tokens.get("refresh_token") or "")
        if not refresh_token:
            raise FeishuAuthError("飞书令牌已过期，请重新授权")
        if (
            connection.refresh_token_expires_at is not None
            and connection.refresh_token_expires_at <= timezone.now()
        ):
            raise FeishuAuthError("飞书刷新令牌已过期，请重新授权")

        try:
            if provider is None:
                resp = self.refresh_access_token(refresh_token)
            else:
                resp = self.refresh_access_token(
                    refresh_token,
                    app_id=provider.app_id,
                    app_secret=provider.app_secret,
                )
        except FeishuAPIError as exc:
            raise FeishuAuthError("飞书令牌刷新失败，请重新授权") from exc

        if resp.get("code") not in (0, None) and "access_token" not in resp:
            raise FeishuAuthError("飞书令牌刷新失败，请重新授权")

        new_access = str(resp.get("access_token") or "")
        if not new_access:
            raise FeishuAuthError("飞书令牌刷新失败，请重新授权")

        connection.tokens = {
            "access_token": new_access,
            "refresh_token": str(resp.get("refresh_token") or refresh_token),
        }
        connection.expires_at = timezone.now() + timedelta(
            seconds=int(resp.get("expires_in") or 7200),
        )
        connection.status = connection.Status.CONNECTED
        update_fields = ["tokens", "expires_at", "status", "updated_at"]
        refresh_expires_in = int(
            resp.get("refresh_token_expires_in")
            or resp.get("refresh_expires_in")
            or 0
        )
        if refresh_expires_in > 0:
            connection.refresh_token_expires_at = timezone.now() + timedelta(
                seconds=refresh_expires_in,
            )
            update_fields.append("refresh_token_expires_at")
        if resp.get("scope"):
            connection.granted_scopes = sorted(set(str(resp["scope"]).split()))
            update_fields.append("granted_scopes")
        connection.save(update_fields=update_fields)
        return new_access

    @staticmethod
    def _needs_token_refresh(access_token: str, expires_at) -> bool:
        if not access_token:
            return True
        if expires_at is None:
            return False
        skew = timezone.now() + timedelta(seconds=TOKEN_REFRESH_SKEW_SECONDS)
        return expires_at <= skew

    # ── Drive / 可导入资源（bitable + docx）─────────────────

    def list_bitable_apps(self, access_token: str, *, search_key: str = "") -> List[Dict[str, str]]:
        """兼容旧调用：仅返回多维表，形状仍为 {app_token, name}。"""
        resources = self.list_importable_resources(
            access_token,
            search_key=search_key,
            kinds=(RESOURCE_KIND_BITABLE,),
        )
        return [
            {"app_token": row["token"], "name": row["name"]}
            for row in resources
            if row.get("kind") == RESOURCE_KIND_BITABLE and row.get("token")
        ]

    def list_importable_resources(
        self,
        access_token: str,
        *,
        search_key: str = "",
        kinds: Optional[List[str]] = None,
        untitled_candidates: Optional[List[Dict[str, str]]] = None,
        owner_ids: Optional[List[str]] = None,
        defer_wiki_resolution: bool = False,
        max_search_pages: Optional[int] = 1,
        tenant_host_resolver: Optional[Callable[[], Optional[str]]] = None,
    ) -> List[Dict[str, str]]:
        """列出可导入资源（多维表 / 新版云文档 Docx）。

        返回 ``[{token, name, kind}]``，kind ∈ {bitable, docx}。
        """
        wanted = self._normalize_kinds(kinds)
        key = (search_key or "").strip()
        if key:
            resources = self._search_resources_via_docs(
                access_token,
                search_key=key,
                kinds=wanted,
                owner_ids=owner_ids,
                defer_wiki_resolution=defer_wiki_resolution,
                max_pages=max_search_pages,
                tenant_host_resolver=tenant_host_resolver,
            )
            untitled_kinds = self._untitled_kinds_matching(key, wanted)
            if untitled_kinds:
                candidates = untitled_candidates
                if candidates is None:
                    candidates = self.list_untitled_resources(
                        access_token,
                        kinds=untitled_kinds,
                        owner_ids=owner_ids,
                    )
                resources = self._merge_resources(
                    resources,
                    [
                        resource
                        for resource in candidates
                        if resource.get("kind") in untitled_kinds
                    ],
                )
            return self._filter_and_rank_by_name(resources, key)

        resources = self._list_resources_in_my_space(access_token, kinds=wanted)
        if resources:
            return resources

        fallback_keys = ("*", "文档", "多维", "表", "base", "doc")
        for candidate in fallback_keys:
            try:
                found = self._search_resources_via_docs(
                    access_token, search_key=candidate, kinds=wanted,
                    owner_ids=owner_ids,
                    defer_wiki_resolution=defer_wiki_resolution,
                    max_pages=max_search_pages,
                    tenant_host_resolver=tenant_host_resolver,
                )
            except FeishuAPIError as exc:
                logger.info(
                    "[FeishuClient] docs search fallback key=%r failed: %s",
                    candidate,
                    exc,
                )
                continue
            if found:
                return found
        return []

    def list_untitled_resources(
        self,
        access_token: str,
        *,
        kinds: Optional[List[str]] = None,
        owner_ids: Optional[List[str]] = None,
    ) -> List[Dict[str, str]]:
        return self.list_untitled_resource_catalog(
            access_token,
            kinds=kinds,
            owner_ids=owner_ids,
        ).resources

    def list_untitled_resource_catalog(
        self,
        access_token: str,
        *,
        kinds: Optional[List[str]] = None,
        owner_ids: Optional[List[str]] = None,
    ) -> UntitledResourceCatalog:
        wanted = self._normalize_kinds(kinds)
        resources: List[Dict[str, str]] = []
        failed_sources: List[str] = []
        try:
            resources.extend(
                self._list_untitled_docs_search_resources(
                    access_token,
                    kinds=wanted,
                    owner_ids=owner_ids,
                )
            )
        except FeishuAPIError as exc:
            failed_sources.append("search")
            logger.warning("[FeishuClient] untitled search catalog failed: %s", exc)
        return UntitledResourceCatalog(
            resources=self._merge_resources(resources),
            complete=not failed_sources,
            failed_sources=tuple(failed_sources),
        )

    def _list_untitled_docs_search_resources(
        self,
        access_token: str,
        *,
        kinds: List[str],
        owner_ids: Optional[List[str]] = None,
    ) -> List[Dict[str, str]]:
        return self._search_resources_via_docs(
            access_token,
            search_key="",
            kinds=kinds,
            owner_ids=owner_ids,
            max_pages=None,
            untitled_only=True,
        )

    def get_docx_markdown(self, access_token: str, doc_token: str) -> str:
        """GET /open-apis/docs/v1/content — 导出新版文档 Markdown。"""
        token = (doc_token or "").strip()
        if not token:
            raise FeishuAPIError("缺少 doc_token")
        data = self._get_json(
            f"{self.api_base}/open-apis/docs/v1/content",
            access_token=access_token,
            params={
                "doc_token": token,
                "doc_type": "docx",
                "content_type": "markdown",
                "lang": "zh",
            },
        )
        body = data.get("data") if isinstance(data.get("data"), dict) else data
        content = (body or {}).get("content")
        if not isinstance(content, str):
            raise FeishuAPIError("飞书文档正文为空或非 Markdown")
        return content

    @staticmethod
    def _normalize_kinds(kinds: Optional[List[str]]) -> List[str]:
        allowed = {RESOURCE_KIND_BITABLE, RESOURCE_KIND_DOCX}
        if not kinds:
            return [RESOURCE_KIND_BITABLE, RESOURCE_KIND_DOCX]
        out: List[str] = []
        for kind in kinds:
            k = str(kind or "").strip().lower()
            if k in ("base", "8"):
                k = RESOURCE_KIND_BITABLE
            if k in ("doc",):
                # 旧版 doc 首期不做
                continue
            if k in allowed and k not in out:
                out.append(k)
        return out or [RESOURCE_KIND_BITABLE, RESOURCE_KIND_DOCX]

    @staticmethod
    def _kind_from_feishu_type(raw: str) -> Optional[str]:
        t = str(raw or "").strip().lower()
        if t in ("bitable", "base", "8"):
            return RESOURCE_KIND_BITABLE
        if t in ("docx",):
            return RESOURCE_KIND_DOCX
        if t in ("folder", "dir"):
            return "folder"
        return None

    def get_my_space_root_folder_token(self, access_token: str) -> Optional[str]:
        """GET drive/explorer/v2/root_folder/meta → 我的空间根 folder_token。

        权限不足（缺 ``drive:drive.metadata:readonly``）时抛 ``FeishuAPIError``，
        由 API 层转成「请重新授权」提示；勿静默吞掉。
        """
        meta = self._get_json(
            f"{self.api_base}/open-apis/drive/explorer/v2/root_folder/meta",
            access_token=access_token,
        )
        body = meta.get("data") if isinstance(meta.get("data"), dict) else meta
        token = (body or {}).get("token") or ""
        return str(token) if token else None

    def list_drive_folder_children(
        self,
        access_token: str,
        folder_token: str,
        *,
        page_token: Optional[str] = None,
        page_size: int = 50,
        include_folders: bool = True,
    ) -> Dict[str, Any]:
        """列云盘文件夹子项。返回 {items: BrowseNode-like dicts, has_more, next_page_token}。"""
        folder = (folder_token or "").strip()
        if not folder:
            raise FeishuAPIError("缺少 folder_token")
        params: Dict[str, Any] = {
            "folder_token": folder,
            "page_size": max(1, min(int(page_size or 50), 200)),
        }
        if page_token:
            params["page_token"] = page_token
        data = self._get_json(
            f"{self.api_base}/open-apis/drive/v1/files",
            access_token=access_token,
            params=params,
        )
        body = data.get("data") or {}
        items: List[Dict[str, Any]] = []
        for raw in body.get("files") or []:
            file_type = str(raw.get("type") or raw.get("file_type") or "").strip().lower()
            token = str(raw.get("token") or raw.get("app_token") or "").strip()
            if not token:
                continue
            if file_type in ("folder", "dir"):
                if not include_folders:
                    continue
                name = self._display_name(
                    raw.get("name") or raw.get("title"),
                    kind="folder",
                    identifiers=[token],
                )
                items.append({
                    "id": f"drive:folder:{token}",
                    "name": name,
                    "node_kind": "folder",
                    "selectable": False,
                    "expandable": True,
                    "folder_token": token,
                    "token": token,
                    "has_child": True,
                })
                continue
            kind = self._kind_from_feishu_type(file_type)
            if kind not in (RESOURCE_KIND_BITABLE, RESOURCE_KIND_DOCX):
                continue
            name = self._display_name(
                raw.get("name") or raw.get("title"),
                kind=kind,
                identifiers=[token],
            )
            items.append({
                "id": f"drive:{kind}:{token}",
                "name": name,
                "node_kind": kind,
                "selectable": True,
                "expandable": kind == RESOURCE_KIND_BITABLE,
                "token": token,
                "import_kind": kind,
                "has_child": kind == RESOURCE_KIND_BITABLE,
            })
        next_token = body.get("next_page_token") or body.get("page_token") or None
        has_more = bool(body.get("has_more")) and bool(next_token)
        return {
            "items": items,
            "has_more": has_more,
            "next_page_token": str(next_token) if has_more else None,
        }

    def list_wiki_spaces(
        self,
        access_token: str,
        *,
        page_token: Optional[str] = None,
        page_size: int = 50,
        include_my_library: bool = True,
    ) -> Dict[str, Any]:
        """列知识空间；可选在首页合成「我的文档库」(my_library)。"""
        params: Dict[str, Any] = {
            "page_size": max(1, min(int(page_size or 50), 50)),
        }
        if page_token:
            params["page_token"] = page_token
        data = self._get_json(
            f"{self.api_base}/open-apis/wiki/v2/spaces",
            access_token=access_token,
            params=params,
        )
        body = data.get("data") or {}
        items: List[Dict[str, Any]] = []
        # spaces.list 不含个人库；仅第一页前置合成入口
        if include_my_library and not page_token:
            items.append({
                "id": f"wiki:space:{WIKI_SPACE_MY_LIBRARY}",
                "name": "我的文档库",
                "node_kind": "wiki_space",
                "selectable": False,
                "expandable": True,
                "space_id": WIKI_SPACE_MY_LIBRARY,
                "has_child": True,
            })
        for raw in body.get("items") or []:
            space_id = str(raw.get("space_id") or "").strip()
            if not space_id or space_id == WIKI_SPACE_MY_LIBRARY:
                continue
            name = self._display_name(
                raw.get("name") or raw.get("space_name"),
                kind="wiki_space",
                identifiers=[space_id],
            )
            items.append({
                "id": f"wiki:space:{space_id}",
                "name": name,
                "node_kind": "wiki_space",
                "selectable": False,
                "expandable": True,
                "space_id": space_id,
                "has_child": True,
            })
        next_token = body.get("page_token") or None
        has_more = bool(body.get("has_more")) and bool(next_token)
        return {
            "items": items,
            "has_more": has_more,
            "next_page_token": str(next_token) if has_more else None,
        }

    def list_wiki_nodes(
        self,
        access_token: str,
        space_id: str,
        *,
        parent_node_token: Optional[str] = None,
        page_token: Optional[str] = None,
        page_size: int = 50,
    ) -> Dict[str, Any]:
        """列知识库节点。docx/bitable 叶子可导入；有子节点则可展开。"""
        sid = (space_id or "").strip() or WIKI_SPACE_MY_LIBRARY
        params: Dict[str, Any] = {
            "page_size": max(1, min(int(page_size or 50), 50)),
        }
        parent = (parent_node_token or "").strip()
        if parent:
            params["parent_node_token"] = parent
        if page_token:
            params["page_token"] = page_token
        data = self._get_json(
            f"{self.api_base}/open-apis/wiki/v2/spaces/{sid}/nodes",
            access_token=access_token,
            params=params,
        )
        body = data.get("data") or {}
        items: List[Dict[str, Any]] = []
        for raw in body.get("items") or []:
            if not isinstance(raw, dict):
                continue
            # 部分响应把字段包在 node 里（与 get_node 一致）
            payload = raw.get("node") if isinstance(raw.get("node"), dict) else raw
            node = self._normalize_wiki_node(payload, space_id=sid)
            if node:
                items.append(node)
        next_token = body.get("page_token") or None
        has_more = bool(body.get("has_more")) and bool(next_token)
        return {
            "items": items,
            "has_more": has_more,
            "next_page_token": str(next_token) if has_more else None,
        }

    def get_wiki_node(
        self,
        access_token: str,
        node_token: str,
        *,
        raise_on_error: bool = False,
    ) -> Optional[Dict[str, Any]]:
        """GET wiki/v2/spaces/get_node — 将 wiki token 解析为 obj_type / obj_token。"""
        token = (node_token or "").strip()
        if not token:
            return None
        try:
            data = self._get_json(
                f"{self.api_base}/open-apis/wiki/v2/spaces/get_node",
                access_token=access_token,
                params={"token": token},
            )
        except FeishuAPIError as exc:
            if raise_on_error:
                raise
            logger.info("[FeishuClient] wiki get_node failed: %s", exc)
            return None
        body = data.get("data") or {}
        node = body.get("node") if isinstance(body.get("node"), dict) else body
        if not isinstance(node, dict):
            return None
        return self._normalize_wiki_node(
            node,
            space_id=str(node.get("space_id") or "").strip() or None,
        )

    def _normalize_wiki_node(
        self,
        raw: Dict[str, Any],
        *,
        space_id: Optional[str],
    ) -> Optional[Dict[str, Any]]:
        node_token = str(raw.get("node_token") or raw.get("token") or "").strip()
        if not node_token:
            return None
        obj_type = str(raw.get("obj_type") or raw.get("objType") or "").strip().lower()
        obj_token = str(raw.get("obj_token") or raw.get("objToken") or "").strip()
        has_child = bool(raw.get("has_child") if raw.get("has_child") is not None else raw.get("hasChild"))
        sid = (space_id or str(raw.get("space_id") or "").strip() or WIKI_SPACE_MY_LIBRARY)

        import_kind = None
        if obj_type in ("bitable", "base", "8"):
            import_kind = RESOURCE_KIND_BITABLE
        elif obj_type in ("docx",):
            import_kind = RESOURCE_KIND_DOCX
        title = self._display_name(
            raw.get("title") or raw.get("name"),
            kind=import_kind or "wiki_node",
            identifiers=[node_token, obj_token],
        )
        selectable = bool(
            import_kind in (RESOURCE_KIND_BITABLE, RESOURCE_KIND_DOCX) and obj_token
        )
        # 有子节点可展开；多维表还可再展开飞书表列表
        expandable = bool(has_child) or (
            selectable and import_kind == RESOURCE_KIND_BITABLE
        )

        node: Dict[str, Any] = {
            "id": f"wiki:node:{node_token}",
            "name": title,
            "node_kind": import_kind if selectable and import_kind else "wiki_node",
            "selectable": selectable,
            "expandable": expandable,
            "space_id": sid,
            "node_token": node_token,
            "has_child": has_child,
        }
        if selectable and import_kind:
            node["token"] = obj_token
            node["import_kind"] = import_kind
        return node

    def _list_resources_in_my_space(
        self,
        access_token: str,
        *,
        kinds: List[str],
    ) -> List[Dict[str, str]]:
        """兼容旧扁平列表：仅「我的空间」根下 bitable/docx（不含文件夹）。"""
        try:
            folder_token = self.get_my_space_root_folder_token(access_token)
        except FeishuAPIError as exc:
            logger.info("[FeishuClient] root_folder/meta unavailable for flat list: %s", exc)
            return []
        if not folder_token:
            return []
        resources: List[Dict[str, str]] = []
        page_token: Optional[str] = None
        while True:
            try:
                page = self.list_drive_folder_children(
                    access_token,
                    folder_token,
                    page_token=page_token,
                    include_folders=False,
                )
            except FeishuAPIError as exc:
                logger.info("[FeishuClient] drive children list failed: %s", exc)
                break
            for item in page.get("items") or []:
                kind = item.get("import_kind") or item.get("node_kind")
                token = item.get("token") or ""
                if kind not in kinds or not token:
                    continue
                resources.append({
                    "token": str(token),
                    "name": str(item.get("name") or token),
                    "kind": str(kind),
                })
            if not page.get("has_more"):
                break
            page_token = page.get("next_page_token")
            if not page_token:
                break
        return resources

    def _search_resources_via_docs(
        self,
        access_token: str,
        *,
        search_key: str = "",
        kinds: List[str],
        owner_ids: Optional[List[str]] = None,
        max_pages: Optional[int] = 3,
        untitled_only: bool = False,
        defer_wiki_resolution: bool = False,
        tenant_host_resolver: Optional[Callable[[], Optional[str]]] = None,
    ) -> List[Dict[str, str]]:
        """使用 Search v2 搜索，并只返回授权应用所在企业的资源。"""
        key = (search_key or "").strip()
        remote_query = key[:30]
        doc_types = [str(kind).upper() for kind in kinds]
        search_filter: Dict[str, Any] = {
            "doc_types": doc_types,
            "only_title": True,
        }
        normalized_owner_ids = [
            str(owner_id) for owner_id in (owner_ids or []) if owner_id
        ]
        if normalized_owner_ids:
            search_filter["creator_ids"] = normalized_owner_ids

        result_units: List[Dict[str, Any]] = []
        page_token: Optional[str] = None
        pages_read = 0
        while max_pages is None or pages_read < max_pages:
            pages_read += 1
            payload: Dict[str, Any] = {
                "query": remote_query,
                "page_size": 20,
                "doc_filter": dict(search_filter),
                "wiki_filter": dict(search_filter),
            }
            if page_token:
                payload["page_token"] = page_token
            data = self._post_json(
                f"{self.api_base}/open-apis/search/v2/doc_wiki/search",
                json=payload,
                access_token=access_token,
            )
            body = (
                data.get("data")
                if isinstance(data.get("data"), dict)
                else data
            )
            result_units.extend((body or {}).get("res_units") or [])
            if not (body or {}).get("has_more"):
                break
            next_page_token = str((body or {}).get("page_token") or "")
            if not next_page_token or next_page_token == page_token:
                break
            page_token = next_page_token

        result_units = [
            unit
            for unit in result_units
            if str(unit.get("entity_type") or "").strip().upper() in {"DOC", "WIKI"}
        ]

        tenant_hosts = {
            urlparse(str((unit.get("result_meta") or {}).get("url") or "")).hostname
            for unit in result_units
            if (unit.get("result_meta") or {}).get("is_cross_tenant") is False
        }
        tenant_hosts.discard(None)
        has_wiki_results = any(
            str(unit.get("entity_type") or "").upper() == "WIKI"
            for unit in result_units
        )
        if not tenant_hosts and has_wiki_results and tenant_host_resolver:
            resolved_host = tenant_host_resolver()
            if resolved_host:
                tenant_hosts.add(resolved_host.strip().lower())

        same_tenant_units: List[Dict[str, Any]] = []
        for unit in result_units:
            meta = unit.get("result_meta") or {}
            cross_tenant = meta.get("is_cross_tenant")
            resource_host = urlparse(str(meta.get("url") or "")).hostname
            is_same_tenant_wiki = (
                cross_tenant is None
                and str(unit.get("entity_type") or "").upper() == "WIKI"
                and resource_host in tenant_hosts
            )
            if cross_tenant is False or is_same_tenant_wiki:
                same_tenant_units.append(unit)

        resolved_wiki_nodes: Dict[str, Optional[Dict[str, Any]]] = {}
        wiki_tokens: List[str] = []
        if not defer_wiki_resolution:
            wiki_tokens = list(dict.fromkeys(
                str((unit.get("result_meta") or {}).get("token") or "")
                for unit in same_tenant_units
                if str(unit.get("entity_type") or "").upper() == "WIKI"
                and (unit.get("result_meta") or {}).get("token")
            ))

        if not defer_wiki_resolution and wiki_tokens:
            def resolve_wiki_node(node_token: str) -> tuple[str, Optional[Dict[str, Any]]]:
                return node_token, self.get_wiki_node(access_token, node_token)

            with ThreadPoolExecutor(max_workers=min(20, len(wiki_tokens))) as executor:
                resolved_wiki_nodes.update(executor.map(resolve_wiki_node, wiki_tokens))

        resources: List[Dict[str, str]] = []
        seen: set = set()
        for unit in same_tenant_units:
            meta = unit.get("result_meta") or {}
            token = meta.get("token") or ""
            kind = self._kind_from_feishu_type(
                str(meta.get("doc_types") or unit.get("entity_type") or ""),
            )
            is_wiki = str(unit.get("entity_type") or "").upper() == "WIKI"
            wiki_node_token = str(token) if is_wiki else ""
            if is_wiki and not defer_wiki_resolution:
                wiki_node = resolved_wiki_nodes.get(str(token)) or {}
                token = wiki_node.get("token") or ""
                kind = str(wiki_node.get("import_kind") or "")
            if not token or not kind or kind not in kinds:
                continue
            highlighted_title = str(unit.get("title_highlighted") or "")
            plain_title = html.unescape(
                re.sub(r"<[^>]+>", "", highlighted_title),
            )
            if untitled_only and plain_title.strip():
                continue
            name = self._display_name(
                plain_title,
                kind=kind,
                identifiers=[str(token)],
            )
            dedupe = f"{kind}:{token}"
            if dedupe in seen:
                continue
            seen.add(dedupe)
            resource = {
                "token": str(token),
                "name": str(name),
                "kind": kind,
            }
            if is_wiki and defer_wiki_resolution:
                resource["wiki_node_token"] = wiki_node_token
            resources.append(resource)
        return resources

    def get_bitable_app_name(self, access_token: str, app_token: str) -> Optional[str]:
        """GET /bitable/v1/apps/{app_token} → name；失败返回 None（由调用方决定是否再探活）。"""
        token = (app_token or "").strip()
        if not token:
            return None
        try:
            data = self._get_json(
                f"{self.api_base}/open-apis/bitable/v1/apps/{token}",
                access_token=access_token,
            )
        except FeishuAPIError:
            return None
        body = data.get("data") or data
        app = body.get("app") if isinstance(body, dict) else None
        if isinstance(app, dict):
            name = app.get("name") or app.get("title")
            if name:
                return str(name)
        if isinstance(body, dict):
            name = body.get("name") or body.get("title")
            if name:
                return str(name)
        return None

    def get_drive_file_name(
        self,
        access_token: str,
        file_token: str,
        *,
        doc_type: str = "docx",
    ) -> Optional[str]:
        """POST /drive/v1/metas/batch_query 取文件名；失败返回 None。"""
        token = (file_token or "").strip()
        if not token:
            return None
        payload = {
            "request_docs": [
                {"doc_token": token, "doc_type": (doc_type or "docx").strip().lower()},
            ],
            "with_url": False,
        }
        try:
            data = self._post_json(
                f"{self.api_base}/open-apis/drive/v1/metas/batch_query",
                json=payload,
                access_token=access_token,
            )
        except FeishuAPIError:
            return None
        body = data.get("data") or {}
        metas = body.get("metas") or []
        if not metas:
            return None
        meta = metas[0] if isinstance(metas[0], dict) else {}
        name = meta.get("title") or meta.get("name")
        return str(name) if name else None

    def list_tables(self, access_token: str, app_token: str) -> List[Dict[str, str]]:
        items: List[Dict[str, str]] = []
        page_token: Optional[str] = None
        while True:
            params: Dict[str, Any] = {"page_size": 100}
            if page_token:
                params["page_token"] = page_token
            data = self._get_json(
                f"{self.api_base}/open-apis/bitable/v1/apps/{app_token}/tables",
                access_token=access_token,
                params=params,
            )
            body = data.get("data") or {}
            for t in body.get("items") or []:
                tid = t.get("table_id") or ""
                if tid:
                    items.append({
                        "table_id": tid,
                        "name": self._display_name(
                            t.get("name"),
                            kind="table",
                            identifiers=[str(tid)],
                        ),
                    })
            if not body.get("has_more"):
                break
            page_token = body.get("page_token")
            if not page_token:
                break
        return items

    def list_fields(self, access_token: str, app_token: str, table_id: str) -> List[Dict[str, Any]]:
        items: List[Dict[str, Any]] = []
        page_token: Optional[str] = None
        while True:
            params: Dict[str, Any] = {"page_size": 100}
            if page_token:
                params["page_token"] = page_token
            data = self._get_json(
                f"{self.api_base}/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/fields",
                access_token=access_token,
                params=params,
            )
            body = data.get("data") or {}
            items.extend(body.get("items") or [])
            if not body.get("has_more"):
                break
            page_token = body.get("page_token")
            if not page_token:
                break
        return items

    def iter_records(
        self,
        access_token: str,
        app_token: str,
        table_id: str,
        *,
        max_rows: int = MAX_ROWS_PER_TABLE,
        page_size: int = FEISHU_RECORD_PAGE_SIZE,
    ):
        """分页拉取 records（优先 search，失败回退 list）。累计不超过 max_rows。"""
        page_size = min(max(1, page_size), FEISHU_RECORD_PAGE_SIZE)
        collected = 0
        page_token: Optional[str] = None
        use_search = True

        while collected < max_rows:
            remaining = max_rows - collected
            size = min(page_size, remaining)
            try:
                if use_search:
                    body = self._search_records_page(
                        access_token, app_token, table_id,
                        page_size=size, page_token=page_token,
                    )
                else:
                    body = self._list_records_page(
                        access_token, app_token, table_id,
                        page_size=size, page_token=page_token,
                    )
            except FeishuAPIError:
                if use_search:
                    use_search = False
                    page_token = None
                    continue
                raise

            for item in body.get("items") or []:
                yield item
                collected += 1
                if collected >= max_rows:
                    return

            if not body.get("has_more"):
                return
            page_token = body.get("page_token")
            if not page_token:
                return

    def _search_records_page(
        self,
        access_token: str,
        app_token: str,
        table_id: str,
        *,
        page_size: int,
        page_token: Optional[str],
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"page_size": page_size}
        params: Dict[str, Any] = {}
        if page_token:
            params["page_token"] = page_token
        data = self._post_json(
            f"{self.api_base}/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records/search",
            json=payload,
            access_token=access_token,
            params=params or None,
        )
        return data.get("data") or {}

    def _list_records_page(
        self,
        access_token: str,
        app_token: str,
        table_id: str,
        *,
        page_size: int,
        page_token: Optional[str],
    ) -> Dict[str, Any]:
        params: Dict[str, Any] = {"page_size": page_size}
        if page_token:
            params["page_token"] = page_token
        data = self._get_json(
            f"{self.api_base}/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records",
            access_token=access_token,
            params=params,
        )
        return data.get("data") or {}

    def list_docx_blocks(
        self,
        access_token: str,
        doc_token: str,
        *,
        page_size: int = 500,
    ) -> List[Dict[str, Any]]:
        """GET /docx/v1/documents/{document_id}/blocks — 需 docx:document:readonly。"""
        document_id = (doc_token or "").strip()
        if not document_id:
            raise FeishuAPIError("缺少 doc_token")
        items: List[Dict[str, Any]] = []
        page_token: Optional[str] = None
        while True:
            params: Dict[str, Any] = {
                "page_size": max(1, min(int(page_size or 500), 500)),
            }
            if page_token:
                params["page_token"] = page_token
            data = self._get_json(
                f"{self.api_base}/open-apis/docx/v1/documents/{document_id}/blocks",
                access_token=access_token,
                params=params,
            )
            body = data.get("data") if isinstance(data.get("data"), dict) else data
            for raw in (body or {}).get("items") or []:
                if isinstance(raw, dict):
                    items.append(raw)
            if not (body or {}).get("has_more"):
                break
            page_token = (body or {}).get("page_token")
            if not page_token:
                break
        return items

    def list_whiteboard_nodes(
        self,
        access_token: str,
        whiteboard_id: str,
    ) -> List[Dict[str, Any]]:
        """GET /board/v1/whiteboards/{id}/nodes — 读取画板原始节点与连线。"""
        board_id = (whiteboard_id or "").strip()
        if not board_id:
            raise FeishuAPIError("缺少 whiteboard_id")
        data = self._get_json(
            f"{self.api_base}/open-apis/board/v1/whiteboards/{quote(board_id, safe='')}/nodes",
            access_token=access_token,
        )
        body = data.get("data") if isinstance(data.get("data"), dict) else data
        return [item for item in (body or {}).get("nodes") or [] if isinstance(item, dict)]

    def download_media(
        self,
        access_token: str,
        file_token: str,
        *,
        tmp_url: str = "",
        extra: Optional[Dict[str, Any]] = None,
    ) -> bytes:
        """下载飞书云文档 / 多维表附件字节。

        优先可信 ``file_token`` 走官方 medias API（``api_base`` 来自配置，非用户输入）。
        仅当缺少 file_token 时，才对通过 allowlist 的 ``tmp_url`` 做安全下载；
        恶意 / 非飞书 URL **不会**发请求。流式读取并强制 ``MAX_ATTACHMENT_BYTES``。
        Docx 内嵌图可传 ``extra={"drive_route_token": doc_token}``。
        """
        from .constants import MAX_ATTACHMENT_BYTES
        from .media_url_security import (
            FeishuMediaURLError,
            download_feishu_media_url,
            stream_read_response,
        )

        token = (file_token or "").strip()
        if token:
            url = f"{self.api_base}/open-apis/drive/v1/medias/{token}/download"
            headers = self._auth_headers(access_token)
            params: Optional[Dict[str, Any]] = None
            if extra:
                import json as _json

                params = {
                    "extra": _json.dumps(extra, ensure_ascii=False, separators=(",", ":")),
                }
            try:
                with self._client() as client:
                    with client.stream(
                        "GET", url, headers=headers, params=params,
                    ) as resp:
                        if resp.status_code >= 400:
                            raise FeishuAPIError(
                                f"下载飞书附件失败 HTTP {resp.status_code}",
                                status_code=resp.status_code,
                            )
                        return stream_read_response(
                            resp, max_bytes=MAX_ATTACHMENT_BYTES,
                        )
            except FeishuMediaURLError as exc:
                raise FeishuAPIError(str(exc)) from exc

        candidate = (tmp_url or "").strip()
        if not candidate:
            raise FeishuAPIError("缺少 file_token，无法下载附件")

        try:
            return download_feishu_media_url(
                candidate,
                max_bytes=MAX_ATTACHMENT_BYTES,
                timeout=self.timeout,
            )
        except FeishuMediaURLError as exc:
            logger.info(
                "[FeishuClient] reject unsafe tmp_url: %s",
                type(exc).__name__,
            )
            raise FeishuAPIError(
                "附件直链不安全或不可用，且缺少 file_token",
            ) from exc

    # ── HTTP helpers ───────────────────────────────────────

    def _get_json(
        self,
        url: str,
        *,
        access_token: Optional[str] = None,
        params: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        headers = self._auth_headers(access_token)
        with self._client() as client:
            resp = client.get(url, headers=headers, params=params)
        return self._parse_response(resp)

    def _post_json(
        self,
        url: str,
        *,
        json: Dict[str, Any],
        access_token: Optional[str] = None,
        params: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        headers = self._auth_headers(access_token)
        headers["Content-Type"] = "application/json; charset=utf-8"
        with self._client() as client:
            resp = client.post(url, headers=headers, json=json, params=params)
        return self._parse_response(resp)

    @staticmethod
    def _auth_headers(access_token: Optional[str]) -> Dict[str, str]:
        headers = {"Accept": "application/json"}
        if access_token:
            headers["Authorization"] = f"Bearer {access_token}"
        return headers

    @staticmethod
    def _parse_response(resp: httpx.Response) -> Dict[str, Any]:
        try:
            data = resp.json()
        except Exception as exc:
            raise FeishuAPIError(
                f"飞书 API 非 JSON 响应 HTTP {resp.status_code}",
                status_code=resp.status_code,
            ) from exc

        if resp.status_code >= 400:
            raise FeishuAPIError(
                f"飞书 API HTTP {resp.status_code}: {data.get('msg') or data.get('message') or 'error'}",
                code=data.get("code"),
                status_code=resp.status_code,
            )

        # OAuth token 接口成功时 code=0 且顶层含 access_token
        if isinstance(data, dict) and "access_token" in data:
            return data

        code = data.get("code") if isinstance(data, dict) else None
        if code not in (0, None):
            raise FeishuAPIError(
                f"飞书 API 错误 code={code}: {data.get('msg') or data.get('message') or ''}",
                code=code,
                status_code=resp.status_code,
            )
        return data if isinstance(data, dict) else {"data": data}
