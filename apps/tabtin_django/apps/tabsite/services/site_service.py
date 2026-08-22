"""
TabSite 核心业务服务

职责:
  - Site CRUD + 权限校验
  - 版本管理（发布 / 回滚）
  - 文件管理
  - TabData Token 自动配置
  - ResourceBridge 桥接（ContextItem 自动同步）
"""

from __future__ import annotations
from apps.tabtinspace.services.organization_control_guard import (
    assert_organization_resource_write_allowed_optional,
)

import logging
import secrets
import string
import time
import uuid as _uuid
from typing import Any, Dict, List, Optional

from django.conf import settings
from django.contrib.auth.hashers import make_password
from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import Count

from apps.i18n import _
from apps.tabtinspace.services.base import BaseService, ServiceError
from apps.tabtinspace.services.resource_bridge import ResourceBridge
from apps.tabsite.error_codes import ErrorCode
from apps.tabsite.models import Site, SiteVersion, SiteFile
from apps.services.common.db_router import postgres_app_db_alias

logger = logging.getLogger(__name__)

_dns_cache: Dict[str, tuple] = {}
_DNS_CACHE_TTL = 300


def _generate_slug(length: int = 8) -> str:
    alphabet = string.ascii_lowercase + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


def _is_valid_uuid(value: str) -> bool:
    try:
        _uuid.UUID(value)
        return True
    except (TypeError, ValueError):
        return False


def _normalize_file_path(path: str) -> str:
    """规范化文件路径，拒绝路径遍历。Service 层防御。"""
    import posixpath
    normalized = posixpath.normpath(path)
    if normalized.startswith('..') or '/../' in normalized or normalized.startswith('/'):
        raise ServiceError("INVALID_PATH", "文件路径含非法组件", status=400)
    if not normalized or normalized == '.':
        raise ServiceError("INVALID_PATH", "文件路径不能为空", status=400)
    return normalized


def _validate_code_project_path(path: str) -> None:
    """Defense-in-depth: 校验 code_project_path 不含路径遍历。允许绝对路径（Electron 场景天然需要）。"""
    import os
    normalized = os.path.normpath(path)
    if '..' in normalized.replace('\\', '/').split('/'):
        raise ServiceError("INVALID_PATH", "code_project_path 不允许包含 '..' 组件", status=400)


def _validate_oss_dist_url(dist_url: str) -> None:
    """TSITE-1 + TSITE-4: 校验 dist_url 是否指向允许的 OSS 域名，防止 SSRF。"""
    from urllib.parse import urlparse
    parsed = urlparse(dist_url)
    if parsed.scheme not in ("https", "http"):
        raise ServiceError("INVALID_DIST_URL", "dist_url 必须为 HTTP(S) 协议", status=400)

    hostname = parsed.hostname or ""

    # TSITE-4: 拒绝私有网段 / 回环地址 / 云元数据地址
    _reject_dangerous_host(hostname)

    oss_endpoint = getattr(settings, "ALIYUN_OSS_ENDPOINT", "")
    oss_bucket = getattr(settings, "ALIYUN_OSS_BUCKET_NAME", "")
    cdn_domain = getattr(settings, "ALIYUN_OSS_CDN_DOMAIN", "")

    allowed_hosts = set()
    if oss_endpoint and oss_bucket:
        allowed_hosts.add(f"{oss_bucket}.{oss_endpoint}")
    if cdn_domain:
        allowed_hosts.add(cdn_domain)

    # TSITE-4: OSS 配置为空时拒绝而非静默通过
    if not allowed_hosts:
        logger.error("TSITE-4: ALIYUN_OSS_ENDPOINT / CDN_DOMAIN 均未配置，无法校验 dist_url 域名")
        raise ServiceError("INVALID_DIST_URL", "OSS 域名配置缺失，无法验证 dist_url", status=500)

    if hostname not in allowed_hosts:
        raise ServiceError("INVALID_DIST_URL", f"dist_url 域名不在允许范围内: {hostname}", status=400)


def _reject_dangerous_host(hostname: str) -> None:
    """TSITE-4: 阻止 SSRF 敏感地址（私有 IP / 回环 / 云元数据）。"""
    import ipaddress
    import socket

    dangerous_hostnames = {"localhost", "metadata.google.internal", "169.254.169.254"}
    if hostname.lower() in dangerous_hostnames:
        raise ServiceError("INVALID_DIST_URL", f"不允许的主机名: {hostname}", status=400)

    now = time.monotonic()
    cached = _dns_cache.get(hostname)
    if cached and (now - cached[1]) < _DNS_CACHE_TTL:
        resolved = cached[0]
    else:
        try:
            resolved = socket.getaddrinfo(hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
            _dns_cache[hostname] = (resolved, now)
        except ServiceError:
            raise
        except Exception as exc:
            logger.debug("_reject_dangerous_host DNS 解析异常 (hostname=%s): %s", hostname, exc)
            return

    for _family, _type, _proto, _canonname, sockaddr in resolved:
        addr = ipaddress.ip_address(sockaddr[0])
        if addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_reserved:
            raise ServiceError(
                "INVALID_DIST_URL",
                f"dist_url 解析到内网地址 ({sockaddr[0]})，拒绝访问",
                status=400,
            )


class SiteService(BaseService):
    """TabSite 核心业务服务。"""

    # ── Site CRUD ──

    def create_site(
        self,
        organization_id: str,
        space_id: str,
        name: str = "未命名站点",
        description: str = "",
        framework: str = "react",
        template: str = "blank",
    ) -> Site:
        if not self.check_space_permission(space_id, "editor"):
            raise ServiceError(ErrorCode.PERMISSION_DENIED, _("auth.insufficient_permissions"), status=403)

        assert_organization_resource_write_allowed_optional(organization_id)

        slug = _generate_slug()
        _slug_retries = 0
        while Site.objects.filter(slug=slug).exists():
            _slug_retries += 1
            if _slug_retries >= 10:
                raise ServiceError(
                    "SLUG_GENERATION_FAILED",
                    "无法生成唯一的站点短链接，请稍后重试",
                    status=500,
                )
            slug = _generate_slug()

        site = Site.objects.create(
            organization_id=organization_id,
            space_id=space_id,
            owner_id=self.user.id,
            name=name,
            slug=slug,
            description=description,
            framework=framework,
            template=template,
            status=Site.Status.DRAFT,
            created_by=self.user,
            updated_by=self.user,
        )
        ResourceBridge.on_create(site, user=self.user)
        return site

    def list_sites(
        self,
        organization_id: str,
        space_id: str,
        status: str = "",
        page: int = 1,
        page_size: int = 20,
    ) -> Dict[str, Any]:
        if not self.check_space_permission(space_id, "viewer"):
            raise ServiceError(ErrorCode.PERMISSION_DENIED, _("auth.insufficient_permissions"), status=403)

        qs = Site.objects.filter(
            organization_id=organization_id,
            space_id=space_id,
        )
        if status:
            qs = qs.filter(status=status)
        else:
            qs = qs.exclude(status=Site.Status.ARCHIVED)

        total = qs.count()
        offset = (max(1, page) - 1) * page_size
        items = list(qs.annotate(version_count=Count("versions"))[offset:offset + page_size])
        return {"items": items, "total": total}

    def get_site_detail(self, site_id: str) -> Site:
        return self._get_site(site_id, "viewer")

    def update_site(
        self,
        site_id: str,
        name: Optional[str] = None,
        description: Optional[str] = None,
        icon: Optional[str] = None,
        is_public: Optional[bool] = None,
        password: Optional[str] = None,
        custom_domain: Optional[str] = None,
        code_project_path: Optional[str] = None,
        tabdata_table_ids: Optional[List[str]] = None,
        tabdata_token_id: Optional[str] = None,
    ) -> Site:
        site = self._get_site(site_id, "editor")
        fields_to_update = ["updated_by", "updated_at"]
        if name is not None:
            site.name = name
            fields_to_update.append("name")
        if description is not None:
            site.description = description
            fields_to_update.append("description")
        if icon is not None:
            site.icon = icon
            fields_to_update.append("icon")
        if is_public is not None:
            site.is_public = is_public
            fields_to_update.append("is_public")
        if password is not None:
            site.password = make_password(password) if password else ""
            fields_to_update.append("password")
        if custom_domain is not None:
            site.custom_domain = custom_domain
            fields_to_update.append("custom_domain")
            try:
                from django.core.cache import cache
                cache.delete('tabsite:cors_custom_domains')
            except Exception:
                pass
        if code_project_path is not None:
            _validate_code_project_path(code_project_path)
            site.code_project_path = code_project_path
            fields_to_update.append("code_project_path")
        if tabdata_table_ids is not None:
            site.tabdata_table_ids = tabdata_table_ids
            fields_to_update.append("tabdata_table_ids")
        if tabdata_token_id is not None:
            site.tabdata_token_id = tabdata_token_id
            fields_to_update.append("tabdata_token_id")
        site.updated_by = self.user
        site.save(update_fields=fields_to_update)
        ResourceBridge.on_update(site, user=self.user)
        return site

    # ── TabData Integration ──

    def provision_tabdata_token(self, site_id: str, *, force: bool = False) -> Dict[str, Any]:
        """为站点自动创建只读 TabData API Token 并返回环境变量。

        幂等：如果站点已有活跃且有效的 token，直接返回（不含 plain_token）。
        force=True 时撤销旧 Token 并重新签发，用于 .env.local 丢失后恢复。
        返回 plain_token 仅在新创建或 force 重签时可用。
        """
        from datetime import timedelta

        from django.utils import timezone as _tz

        from apps.tabdata.constants import TABDATA_DB_ALIAS
        from apps.tabdata.models_token import TableApiToken, SCOPE_PRESETS
        from apps.tabtinspace.services.host_resolver import resolve_host

        site = self._get_site(site_id, "editor")

        if site.tabdata_token_id:
            # TC-005: _check_token_valid 现在会在 DB 不可达时抛出异常
            try:
                token_valid = self._check_token_valid(site.tabdata_token_id)
            except Exception:
                raise ServiceError(
                    ErrorCode.PUBLISH_FAILED,
                    "检查 Token 有效性失败（数据库不可达），请稍后重试",
                    status=503,
                )

            if token_valid and not force:
                return self._build_tabdata_env(site, plain_token=None, is_new=False)
            if force and token_valid:
                # TC-004: _deactivate_old_token 现在会在失败时抛出异常，防止双活 Token
                try:
                    self._deactivate_old_token(site.tabdata_token_id)
                except Exception:
                    raise ServiceError(
                        ErrorCode.PUBLISH_FAILED,
                        "撤销旧 Token 失败，无法安全创建新 Token，请稍后重试",
                        status=503,
                    )
            if not token_valid:
                logger.warning(
                    "Token %s for site %s is invalid, will re-provision",
                    site.tabdata_token_id, site.slug,
                )

        if resolve_host(site.space_id) is None:
            raise ServiceError(
                ErrorCode.SITE_NOT_FOUND,
                "站点关联的 Space 不存在",
                status=404,
            )

        space_id_str = str(site.space_id)

        fields_to_update = ["tabdata_token_id", "updated_by", "updated_at"]
        if not site.tabdata_table_ids:
            discovered = self._discover_space_tables(space_id_str)
            if discovered:
                site.tabdata_table_ids = discovered
                fields_to_update.append("tabdata_table_ids")

        # TDI-006: 空列表时传 [] 而非 None，避免 Token 放行整个 Space
        effective_table_ids = site.tabdata_table_ids if site.tabdata_table_ids else []

        # TDI-004: 使用 TabSite 专属窄权限 scope
        tabsite_scopes = SCOPE_PRESETS.get("tabsite_dashboard", SCOPE_PRESETS["readonly"])

        # TDI-005: 为 TabSite Token 设置 180 天有效期
        token_expired_at = _tz.now() + timedelta(days=180)

        try:
            token_instance, plain_token = TableApiToken.create_token(
                user=self.user,
                name=f"TabSite: {site.name}",
                description=f"Auto-provisioned for site {site.slug}",
                scopes=tabsite_scopes,
                space_ids=[space_id_str],
                table_ids=effective_table_ids,
                rate_limit=60,
                expired_at=token_expired_at,
            )
        except (ValidationError, Exception) as exc:
            logger.exception("Failed to create TabData token for site %s", site_id)
            raise ServiceError(
                ErrorCode.PUBLISH_FAILED,
                f"创建 TabData Token 失败: {exc}",
                status=500,
            )

        site.tabdata_token_id = str(token_instance.id)
        site.updated_by = self.user
        site.save(update_fields=fields_to_update)

        logger.info(
            "Provisioned TabData token %s for site %s (force=%s, expires=%s)",
            token_instance.id, site.slug, force, token_expired_at.isoformat(),
        )
        return self._build_tabdata_env(site, plain_token=plain_token, is_new=True)

    @staticmethod
    def _deactivate_old_token(token_id: str) -> None:
        """撤销旧 Token（TDI-001: force 重签前清理旧 Token）。

        TC-004: 撤销失败时重新抛出异常，阻止后续创建新 Token，防止双活 Token。
        DoesNotExist 视为旧 Token 已清除，安全放行。
        """
        from apps.tabdata.models_token import TableApiToken
        from apps.tabdata.constants import TABDATA_DB_ALIAS

        try:
            token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=token_id)
            if token.is_active:
                token.cascade_deactivate()
                logger.info("Deactivated old token %s for TabSite force re-provision", token_id)
        except TableApiToken.DoesNotExist:
            logger.info("Old token %s already deleted, skipping deactivation", token_id)
        except Exception:
            logger.error(
                "Failed to deactivate old token %s, aborting to prevent dual active tokens",
                token_id, exc_info=True,
            )
            raise

    @staticmethod
    def _discover_space_tables(space_id: str, limit: int = 10) -> List[str]:
        """发现 Space 内的可见数据表，返回 table_id 列表。"""
        try:
            from apps.tabdata.models import Table
            from apps.tabdata.constants import TABDATA_DB_ALIAS
            tables = (
                Table.objects.using(TABDATA_DB_ALIAS)
                .filter(space_id=space_id, is_archived=False, visibility="normal")
                .order_by("created_at")
                .values_list("id", flat=True)[:limit]
            )
            return [str(t) for t in tables]
        except Exception:
            logger.warning("Failed to discover tables for space %s", space_id)
            return []

    @staticmethod
    def _check_token_valid(token_id: str) -> bool:
        """检查 Token 是否存在且有效（未过期、未被撤销）。

        TC-005: 区分 DoesNotExist（Token 确实无效 → False）与 DB 连接错误（→ 重新抛出），
        避免 DB 不可达时误判为「Token 无效」导致反复创建孤儿 Token。
        """
        from apps.tabdata.models_token import TableApiToken
        from apps.tabdata.constants import TABDATA_DB_ALIAS
        from django.utils import timezone

        try:
            token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=token_id)
            if not token.is_active:
                return False
            if token.expired_at and token.expired_at < timezone.now():
                return False
            return True
        except TableApiToken.DoesNotExist:
            return False
        except Exception:
            logger.warning("_check_token_valid: DB error for token %s, re-raising", token_id, exc_info=True)
            raise

    def get_tabdata_env(self, site_id: str) -> Dict[str, str]:
        """返回站点的 TabData 环境变量（不含 plain_token，仅含 token_prefix）。"""
        site = self._get_site(site_id, "viewer")
        return self._build_tabdata_env(site, plain_token=None, is_new=False)

    @staticmethod
    def _build_tabdata_env(site: Site, *, plain_token: Optional[str], is_new: bool = False) -> Dict[str, Any]:
        api_url = getattr(settings, "TABTIN_API_BASE_URL", "https://api.example.com")
        table_ids = site.tabdata_table_ids or []
        result: Dict[str, Any] = {
            "VITE_TABTIN_API_URL": api_url,
            "VITE_TABTIN_SPACE_ID": str(site.space_id),
            "tabdata_token_id": site.tabdata_token_id or "",
            "tabdata_table_ids": table_ids,
            "is_newly_created": is_new,
        }
        if plain_token:
            result["VITE_TABTIN_TOKEN"] = plain_token
        if table_ids:
            result["VITE_TABTIN_TABLE_ID"] = table_ids[0]

        return result

    def archive_site(self, site_id: str) -> None:
        site = self._get_site(site_id, "editor")
        site.status = Site.Status.ARCHIVED
        site.updated_by = self.user
        site.save(update_fields=["status", "updated_by", "updated_at"])

        # DVC-002: 归档时同时清理 upload-time 和 dist 两类 FileUsage
        self._deactivate_upload_file_usages(site)
        # TSITE-2: 归档时 deactivate dist 文件的 FileUsage，释放 OSS 引用
        self._deactivate_site_dist_file_usages(site)

        ResourceBridge.on_archive(site, user=self.user)

    def _deactivate_site_dist_file_usages(self, site: Site) -> None:
        """Deactivate 站点 dist 文件的所有 FileUsage。归档时使用，失败静默记录日志。"""
        try:
            self._do_deactivate_site_dist_file_usages(site)
        except Exception as e:
            logger.error("[TabSite] dist FileUsage deactivate 失败: site=%s, error=%s",
                         site.id, e, exc_info=True)

    def _deactivate_upload_file_usages(self, site: Site) -> None:
        """DVC-002: Deactivate confirm-upload 阶段产生的逐文件 FileUsage(context_type='site')，
        消除与 dist-level FileUsage 的双重计费。失败不阻断主流程。"""
        try:
            from apps.services.oss.services.deactivate_utils import deactivate_file_usages_and_release_storage
            user_id = str(self.user.id) if self.user else ''
            organization_id = str(getattr(site, 'organization_id', '') or '')
            count = deactivate_file_usages_and_release_storage(
                module='tabsite',
                context_filter={
                    'context_type': 'site',
                    'context_id': str(site.id),
                },
                organization_id=organization_id,
                user_id=user_id,
                biz_type='site_upload_deactivate',
                biz_id=str(site.id),
                log_prefix='[TabSite][DVC-002]',
            )
            if count:
                logger.info("[TabSite][DVC-002] deactivated %d upload FileUsage(s) for site=%s", count, site.id)
        except Exception as e:
            logger.warning(
                "[TabSite][DVC-002] upload FileUsage deactivate 失败 (非阻断): site=%s, error=%s",
                site.id, e, exc_info=True,
            )

    @staticmethod
    def _versioned_context_id(site_id: str, version_num: int) -> str:
        """DVC-008: 生成版本化 context_id，确保 FileUsage 精确到版本。"""
        return f"{site_id}:v{version_num}"

    def _do_deactivate_site_dist_file_usages(
        self, site: Site, *, version_num: Optional[int] = None,
    ) -> int:
        """Deactivate 站点 dist 文件的 FileUsage（严格模式，异常向上抛出）。

        DVC-008: version_num 指定时精确清理该版本；为 None 时清理全部（归档场景）。
        同时兼容旧格式（context_id=site.id）和新格式（context_id=site.id:vN）。
        """
        from apps.services.oss.services.deactivate_utils import deactivate_file_usages_and_release_storage
        user_id = str(self.user.id) if self.user else ''
        organization_id = str(getattr(site, 'organization_id', '') or '')

        total = 0
        site_id_str = str(site.id)

        if version_num is not None:
            # 新格式：context_id = "{site_id}:v{N}"
            count = deactivate_file_usages_and_release_storage(
                module='tabsite',
                context_filter={
                    'context_type': 'site_dist',
                    'context_id': self._versioned_context_id(site_id_str, version_num),
                },
                organization_id=organization_id,
                user_id=user_id,
                biz_type='site_dist_deactivate',
                biz_id=f"{site_id_str}:v{version_num}",
                log_prefix='[TabSite]',
            )
            total += count or 0

            # 向后兼容：旧格式 context_id = str(site.id)（无版本后缀）
            count = deactivate_file_usages_and_release_storage(
                module='tabsite',
                context_filter={
                    'context_type': 'site_dist',
                    'context_id': site_id_str,
                },
                organization_id=organization_id,
                user_id=user_id,
                biz_type='site_dist_deactivate',
                biz_id=site_id_str,
                log_prefix='[TabSite][compat]',
            )
            total += count or 0
        else:
            # 归档：清理所有版本
            # 旧格式
            count = deactivate_file_usages_and_release_storage(
                module='tabsite',
                context_filter={
                    'context_type': 'site_dist',
                    'context_id': site_id_str,
                },
                organization_id=organization_id,
                user_id=user_id,
                biz_type='site_dist_deactivate',
                biz_id=site_id_str,
                log_prefix='[TabSite]',
            )
            total += count or 0

            # 新格式：所有版本化记录
            count = deactivate_file_usages_and_release_storage(
                module='tabsite',
                context_filter={
                    'context_type': 'site_dist',
                    'context_id__startswith': f"{site_id_str}:v",
                },
                organization_id=organization_id,
                user_id=user_id,
                biz_type='site_dist_deactivate',
                biz_id=f"{site_id_str}:all",
                log_prefix='[TabSite]',
            )
            total += count or 0

        if total:
            logger.info(
                "[TabSite] deactivated %d dist FileUsage(s) for site=%s (version=%s)",
                total, site.id, version_num,
            )
        return total

    def _do_register_site_dist_file_usage(
        self, site: Site, dist_url: str, total_size: int, version_num: int,
    ) -> None:
        """为 dist 注册 FileUsage（严格模式，异常向上抛出）。

        DVC-007: 使用版本化 context_id，配合 add_usage 的 get_or_create 实现幂等。
        DVC-008: 版本化 context_id 使每个版本有独立 FileUsage，支持精确 deactivate。
        DVC-009: add_usage 自动重激活已停用的相同 context_id 记录，确保回滚目标不被 OSS 孤儿清理。
        """
        from urllib.parse import urlparse
        parsed = urlparse(dist_url)
        object_key = parsed.path.lstrip("/") if parsed.path else ""
        if not object_key:
            return

        if total_size == 0:
            logger.warning(
                "[TabSite] dist FileUsage 注册时 file_size=0，计费可能不准确: site=%s, v%d",
                site.id, version_num,
            )

        from apps.services.oss.services.file_registry import FileRegistryService
        user_id = str(self.user.id) if self.user else ''
        organization_id = str(getattr(site, 'organization_id', '') or '')
        versioned_ctx_id = self._versioned_context_id(str(site.id), version_num)

        FileRegistryService.register_uploaded_file(
            object_key=object_key,
            file_name=f"site-{site.slug}-v{version_num}-dist",
            file_size=total_size,
            content_type="application/x-site-dist",
            module='tabsite',
            user_id=user_id,
            organization_id=organization_id,
            context_type='site_dist',
            context_id=versioned_ctx_id,
            upload_source='site_publish',
            is_public=True,
        )
        logger.info(
            "[TabSite] dist FileUsage 已注册: site=%s, key=%s, v%d, ctx=%s",
            site.id, object_key, version_num, versioned_ctx_id,
        )

    def _post_commit_sync_file_usages(
        self,
        site_id: str,
        old_version_num: Optional[int],
        new_dist_url: str,
        total_size: int,
        version_num: int,
    ) -> None:
        """PostgreSQL 事务提交后同步 FileUsage（MySQL），实现最终一致。

        TS-009: 若 deactivate 失败则跳过 register，防止旧 FileUsage 泄漏。
        DVC-002: 同时清理 confirm-upload 阶段的逐文件 FileUsage。
        DVC-004: 失败时调度 Celery 补偿任务。
        DVC-008: 使用版本化 context_id 精确 deactivate 旧版本。
        """
        try:
            site = Site.objects.get(id=site_id)
        except Site.DoesNotExist:
            logger.error("[TabSite] post-commit FileUsage sync: site %s 不存在", site_id)
            return

        # DVC-002: 清理 confirm-upload 阶段产生的逐文件 FileUsage(context_type='site')
        self._deactivate_upload_file_usages(site)

        if old_version_num is not None:
            try:
                # DVC-008: 精确 deactivate 旧版本，而非全量
                self._do_deactivate_site_dist_file_usages(site, version_num=old_version_num)
            except Exception as e:
                logger.error(
                    "[TabSite] 旧版本 FileUsage 停用失败，跳过新版本注册以防双重计费。"
                    "site=%s, v%d, error=%s",
                    site.id, old_version_num, e, exc_info=True,
                )
                # DVC-004: 调度 Celery 补偿任务
                self._schedule_file_usage_compensation(
                    site_id, old_version_num, new_dist_url, total_size, version_num,
                )
                return

        try:
            self._do_register_site_dist_file_usage(site, new_dist_url, total_size, version_num)
        except Exception as e:
            logger.error(
                "[TabSite] 新版本 FileUsage 注册失败。site=%s, v%d, error=%s",
                site.id, version_num, e, exc_info=True,
            )
            # DVC-004: 调度 Celery 补偿任务（deactivation 已完成，仅需重试 register）
            self._schedule_file_usage_compensation(
                site_id, None, new_dist_url, total_size, version_num,
            )

    def _schedule_file_usage_compensation(
        self,
        site_id: str,
        old_version_num: Optional[int],
        new_dist_url: str,
        total_size: int,
        version_num: int,
    ) -> None:
        """DVC-003/DVC-004: 调度 Celery 补偿任务，处理 on_commit 内 FileUsage 同步失败。"""
        try:
            from apps.tabsite.tasks import compensate_file_usage_sync
            user_id = str(self.user.id) if self.user else ''
            compensate_file_usage_sync.apply_async(
                kwargs={
                    'site_id': site_id,
                    'old_version_num': old_version_num,
                    'new_dist_url': new_dist_url,
                    'total_size': total_size,
                    'version_num': version_num,
                    'user_id': user_id,
                },
                countdown=30,
            )
            logger.info(
                "[TabSite] FileUsage 补偿任务已调度: site=%s, v%d",
                site_id, version_num,
            )
        except Exception:
            logger.error(
                "[TabSite] FileUsage 补偿任务调度失败，需人工介入: site=%s, v%d",
                site_id, version_num, exc_info=True,
            )

    # ── Publishing ──

    @transaction.atomic(using=postgres_app_db_alias())
    def publish_site(
        self,
        site_id: str,
        message: str = "",
        dist_url: str = "",
        file_count: int = 0,
        total_size: int = 0,
    ) -> SiteVersion:
        if not dist_url:
            raise ServiceError("EMPTY_DIST_URL", _("tabsite.dist_url_required"), status=400)

        # TSITE-1: 校验 dist_url 域名，防止注入任意外部 URL
        _validate_oss_dist_url(dist_url)

        site = self._get_site(site_id, "editor", for_update=True)

        old_had_dist = bool(site.dist_oss_url)
        new_version = site.current_version + 1
        SiteVersion.objects.filter(site=site, is_current=True).update(is_current=False)

        version = SiteVersion.objects.create(
            site=site,
            version=new_version,
            message=message,
            dist_url=dist_url,
            file_count=file_count,
            total_size=total_size,
            is_current=True,
            published_by=self.user,
        )

        site.current_version = new_version
        site.dist_oss_url = dist_url
        site.status = Site.Status.PUBLISHED
        if not site.published_url:
            base_url = getattr(settings, "TABSITE_BASE_URL", "https://site.example.com")
            site.published_url = f"{base_url}/s/{site.slug}/"
        site.updated_by = self.user
        site.save(update_fields=["current_version", "dist_oss_url", "status", "published_url", "updated_by", "updated_at"])

        # TS-009/TS-011/CC-006: FileUsage（MySQL）移至 PG 事务提交后执行，
        # 避免跨库事务不一致；deactivate 失败时跳过 register 防止泄漏
        # DVC-008: 传递旧版本号以实现精确 deactivate
        _site_id = str(site.id)
        _old_version_num = (new_version - 1) if old_had_dist else None
        _dist_url = dist_url
        _total_size = total_size
        _new_version = new_version
        transaction.on_commit(
            lambda: self._post_commit_sync_file_usages(
                site_id=_site_id,
                old_version_num=_old_version_num,
                new_dist_url=_dist_url,
                total_size=_total_size,
                version_num=_new_version,
            ),
            using=postgres_app_db_alias(),
        )

        ResourceBridge.on_update(site, user=self.user)
        return version

    @transaction.atomic(using=postgres_app_db_alias())
    def rollback_to_version(
        self,
        site_id: str,
        version_num: int,
        *,
        expected_current_version: Optional[int] = None,
    ) -> Site:
        """回滚站点到指定版本。

        DVC-022: expected_current_version 提供乐观锁语义 — 若传入且与实际当前版本不一致，
        说明有并发操作，返回 409 冲突。
        """
        site = self._get_site(site_id, "editor", for_update=True)

        # DVC-022: 乐观锁版本检查，防止并发回滚激活预期外版本
        if expected_current_version is not None and site.current_version != expected_current_version:
            raise ServiceError(
                "VERSION_CONFLICT",
                f"版本冲突：当前版本 v{site.current_version}（期望 v{expected_current_version}），请刷新后重试",
                status=409,
            )

        try:
            target = SiteVersion.objects.get(site=site, version=version_num)
        except SiteVersion.DoesNotExist:
            raise ServiceError(ErrorCode.VERSION_NOT_FOUND, _("tabsite.version_not_found"), status=404)

        # CC-012: 目标版本 dist 地址为空则无法回滚（可能已被归档清理）
        if not target.dist_url:
            raise ServiceError(
                ErrorCode.VERSION_NOT_FOUND,
                "目标版本的发布文件地址为空，无法回滚",
                status=400,
            )

        old_had_dist = bool(site.dist_oss_url)
        # DVC-008: 记录旧版本号，用于精确 deactivate
        old_current_version = site.current_version

        SiteVersion.objects.filter(site=site, is_current=True).update(is_current=False)
        target.is_current = True
        target.save(update_fields=["is_current"])

        site.current_version = version_num
        site.dist_oss_url = target.dist_url
        site.status = Site.Status.PUBLISHED
        site.updated_by = self.user
        site.save(update_fields=["current_version", "dist_oss_url", "status", "updated_by", "updated_at"])

        # CC-010/CC-011: FileUsage（MySQL）移至 PG 事务提交后执行
        # DVC-008: 传递旧版本号以实现精确 deactivate
        _site_id = str(site.id)
        _target_dist_url = target.dist_url
        _target_total_size = target.total_size
        _version_num = version_num
        _old_version_num = old_current_version if old_had_dist else None
        transaction.on_commit(
            lambda: self._post_commit_sync_file_usages(
                site_id=_site_id,
                old_version_num=_old_version_num,
                new_dist_url=_target_dist_url,
                total_size=_target_total_size,
                version_num=_version_num,
            ),
            using=postgres_app_db_alias(),
        )

        ResourceBridge.on_update(site, user=self.user)
        return site

    # ── Files ──

    def list_files(self, site_id: str) -> List[SiteFile]:
        site = self._get_site(site_id, "viewer")
        return list(site.files.all())

    def read_file(self, site_id: str, path: str) -> SiteFile:
        path = _normalize_file_path(path)
        site = self._get_site(site_id, "viewer")
        try:
            return SiteFile.objects.get(site=site, path=path)
        except SiteFile.DoesNotExist:
            raise ServiceError(ErrorCode.FILE_NOT_FOUND, _("tabsite.file_not_found"), status=404)

    def write_file(
        self,
        site_id: str,
        path: str,
        content: str,
        content_type: str = "text/html",
    ) -> SiteFile:
        path = _normalize_file_path(path)
        site = self._get_site(site_id, "editor")
        f, _ = SiteFile.objects.update_or_create(
            site=site,
            path=path,
            defaults={
                "content": content,
                "content_type": content_type,
                "file_size": len(content.encode("utf-8")),
            },
        )
        return f

    def delete_file(self, site_id: str, path: str) -> None:
        path = _normalize_file_path(path)
        site = self._get_site(site_id, "editor")
        deleted, _by_label = SiteFile.objects.filter(site=site, path=path).delete()
        if not deleted:
            raise ServiceError(ErrorCode.FILE_NOT_FOUND, _("tabsite.file_not_found"), status=404)

    # ── Internal ──

    def _get_site(self, site_id: str, required_role: str = "viewer", for_update: bool = False) -> Site:
        try:
            qs = Site.objects.all()
            if for_update:
                qs = qs.select_for_update()
            site = qs.get(id=site_id)
        except Site.DoesNotExist:
            raise ServiceError(ErrorCode.SITE_NOT_FOUND, _("tabsite.site_not_found"), status=404)
        if not self.check_space_permission(str(site.space_id), required_role):
            raise ServiceError(ErrorCode.PERMISSION_DENIED, _("auth.insufficient_permissions"), status=403)
        if site.status == Site.Status.ARCHIVED and required_role != "viewer":
            raise ServiceError(ErrorCode.SITE_ARCHIVED, _("tabsite.site_archived"), status=410)
        return site
