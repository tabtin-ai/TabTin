"""
TabSite FC 工具

提供 Agent 操作站点的能力：创建、查询、更新、发布、版本回滚。
"""

from __future__ import annotations

import logging
import re
import uuid as _uuid
from typing import Annotated, Final, Literal, Optional

from pydantic import BaseModel, Field, validator

from apps.services.common.state.injected_state import InjectedState
from apps.services.tools import BaseTool
from apps.services.tools.domains._shared import load_user as _load_user
from apps.services.tools.error_envelope import build_tool_error
from apps.tabsite.error_codes import ErrorCode
from apps.tabtinspace.services.base import ServiceError

logger = logging.getLogger(__name__)

_SITE_RESOURCE_NOT_FOUND_CODES: Final[frozenset[str]] = frozenset(
    {
        ErrorCode.FILE_NOT_FOUND,
        ErrorCode.SITE_ARCHIVED,
        ErrorCode.SITE_NOT_FOUND,
        ErrorCode.VERSION_NOT_FOUND,
    }
)
_SITE_INVALID_PARAM_CODES: Final[frozenset[str]] = frozenset(
    {
        "EMPTY_DIST_URL",
        "INVALID_DIST_URL",
        "INVALID_PATH",
        ErrorCode.SLUG_CONFLICT,
    }
)
_SITE_UPSTREAM_CODES: Final[frozenset[str]] = frozenset(
    {
        "SLUG_GENERATION_FAILED",
        ErrorCode.BUILD_FAILED,
        ErrorCode.PUBLISH_FAILED,
    }
)


def _err_user_not_found() -> dict:
    return build_tool_error(
        "用户未找到",
        error_kind="runtime_misconfig",
        hint="Ensure the Agent session injects user_id before calling tabsite tools.",
        retryable=False,
    )


def _err_internal(operation: str) -> dict:
    return build_tool_error(
        f"TabSite {operation} failed.",
        error_kind="internal_error",
        hint="Retry once. If it fails again, ask the user to retry from the TabSite UI.",
        retryable=True,
    )


def _err_service(exc: ServiceError, operation: str) -> dict:
    """Map known TabSite service codes without exposing infrastructure details."""
    code = str(exc.code or "")
    message = exc.message or code or "TabSite operation failed."

    if code in _SITE_RESOURCE_NOT_FOUND_CODES:
        return build_tool_error(
            message,
            error_kind="resource_not_found",
            hint="Confirm the site_id/version/file still exists and is accessible, then retry.",
            retryable=False,
            upstream_code=code,
        )
    if code == ErrorCode.PERMISSION_DENIED:
        return build_tool_error(
            message,
            error_kind="permission_denied",
            hint="Ask the user to grant the required TabSite access, then retry.",
            retryable=False,
            upstream_code=code,
        )
    if code == "INVALID_DIST_URL" and exc.status >= 500:
        return build_tool_error(
            "TabSite OSS validation is not configured.",
            error_kind="runtime_misconfig",
            hint="Ask an administrator to configure the TabSite OSS endpoint or CDN domain before retrying.",
            retryable=False,
            upstream_code=code,
        )
    if code in _SITE_INVALID_PARAM_CODES:
        return build_tool_error(
            message,
            error_kind="invalid_param_format",
            hint="Correct the invalid TabSite input and retry.",
            retryable=False,
            upstream_code=code,
        )
    if code == "VERSION_CONFLICT":
        return build_tool_error(
            message,
            error_kind="version_conflict",
            hint="Re-read the current site version, then retry the update.",
            retryable=True,
            upstream_code=code,
        )
    if code == ErrorCode.RATE_LIMIT_EXCEEDED:
        return build_tool_error(
            message,
            error_kind="rate_limited",
            hint="Wait before retrying the TabSite operation.",
            retryable=True,
            upstream_code=code,
        )

    # Known infrastructure failures and unknown typed service errors may wrap
    # lower-level exceptions, so never expose their message.
    if code in _SITE_UPSTREAM_CODES:
        return build_tool_error(
            f"TabSite {operation} could not be completed.",
            error_kind="upstream_error",
            hint="Retry once. If it fails again, ask the user to retry from the TabSite UI.",
            retryable=True,
            upstream_code=code or None,
        )
    return build_tool_error(
        f"TabSite {operation} returned an unrecognized service error.",
        error_kind="upstream_error",
        hint="Retry once. If it fails again, ask the user to retry from the TabSite UI.",
        retryable=True,
        upstream_code=code or None,
    )


# ── Validators ──


def _fc_validate_uuid(value: str) -> str:
    """校验 UUID 格式，与 API schemas._validate_uuid 对齐。"""
    try:
        _uuid.UUID(value)
    except (TypeError, ValueError):
        raise ValueError(f"无效的 UUID 格式: {value}")
    return value


def _fc_validate_domain(value: str) -> str:
    """校验域名格式，与 API schemas._validate_domain 对齐。"""
    if '://' in value:
        raise ValueError("域名不应包含协议前缀")
    if '/' in value:
        raise ValueError("域名不应包含路径")
    domain_re = re.compile(
        r'^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$'
    )
    if not domain_re.match(value):
        raise ValueError("域名格式不合法")
    return value.lower()


# ── Serialization ──


def _serialize_site_detail(site, *, include_versions: bool = False) -> dict:
    """将 Site 对象序列化为 FC 工具返回的标准字典，与 API SiteDetail 字段对齐。"""
    vc = getattr(site, "version_count", None)
    data = {
        "id": str(site.id),
        "name": site.name,
        "slug": site.slug,
        "description": site.description,
        "icon": site.icon or "",
        "status": site.status,
        "framework": site.framework,
        "template": site.template or "",
        "published_url": site.published_url or "",
        "dist_oss_url": site.dist_oss_url or "",
        "current_version": site.current_version,
        "total_views": site.total_views,
        "is_public": site.is_public,
        "password_protected": bool(site.password),
        "custom_domain": site.custom_domain or "",
        "code_project_path": site.code_project_path or "",
        "tabdata_table_ids": site.tabdata_table_ids or [],
        "tabdata_token_id": site.tabdata_token_id or "",
        "version_count": vc if vc is not None else site.versions.count(),
        "created_at": site.created_at.isoformat() if site.created_at else "",
        "updated_at": site.updated_at.isoformat() if site.updated_at else "",
    }
    if include_versions:
        data["versions"] = [
            _serialize_version(v)
            for v in site.versions.all()[:20]
        ]
    return data


def _serialize_version(version) -> dict:
    """将 SiteVersion 对象序列化，与 API SiteVersionOut 字段对齐。"""
    return {
        "id": str(version.id),
        "version": version.version,
        "message": version.message,
        "dist_url": version.dist_url,
        "file_count": version.file_count,
        "total_size": version.total_size,
        "is_current": version.is_current,
        "created_at": version.created_at.isoformat(),
    }


# ── Input Schemas ──


class CreateSiteInput(BaseModel):
    user_id: Annotated[Optional[str], InjectedState("user_id")] = Field(
        default=None, description="用户 ID（自动注入）",
    )
    organization_id: Annotated[Optional[str], InjectedState("organization_id")] = Field(
        default=None, description="工作区 ID（自动注入）",
    )
    space_id: Annotated[Optional[str], InjectedState("current_space_id")] = Field(
        default=None, description="Space ID（自动注入）",
    )
    name: str = Field(description="站点名称")
    description: str = Field(default="", description="站点描述")
    framework: Literal["react", "vanilla"] = Field(
        default="react", description="技术栈：react 或 vanilla",
    )
    template: Literal["blank", "dashboard"] = Field(
        default="blank", description="模板：blank 或 dashboard",
    )


class ListSitesInput(BaseModel):
    user_id: Annotated[Optional[str], InjectedState("user_id")] = Field(
        default=None, description="用户 ID（自动注入）",
    )
    organization_id: Annotated[Optional[str], InjectedState("organization_id")] = Field(
        default=None, description="工作区 ID（自动注入）",
    )
    space_id: Annotated[Optional[str], InjectedState("current_space_id")] = Field(
        default=None, description="Space ID（自动注入）",
    )
    status: str = Field(default="", description="过滤状态：draft/published/archived，留空返回全部非归档")


class GetSiteInput(BaseModel):
    user_id: Annotated[Optional[str], InjectedState("user_id")] = Field(
        default=None, description="用户 ID（自动注入）",
    )
    organization_id: Annotated[Optional[str], InjectedState("organization_id")] = Field(
        default=None, description="工作区 ID（自动注入）",
    )
    space_id: Annotated[Optional[str], InjectedState("current_space_id")] = Field(
        default=None, description="Space ID（自动注入）",
    )
    site_id: str = Field(description="站点 ID")


class UpdateSiteInput(BaseModel):
    user_id: Annotated[Optional[str], InjectedState("user_id")] = Field(
        default=None, description="用户 ID（自动注入）",
    )
    site_id: str = Field(description="站点 ID")
    name: Optional[str] = Field(default=None, description="新名称")
    description: Optional[str] = Field(default=None, description="新描述")
    icon: Optional[str] = Field(default=None, max_length=50, description="站点图标")
    is_public: Optional[bool] = Field(default=None, description="是否公开")
    password: Optional[str] = Field(default=None, description="访问密码（空字符串清除密码）")
    custom_domain: Optional[str] = Field(
        default=None, max_length=255, description="自定义域名（空字符串清除）",
    )
    code_project_path: Optional[str] = Field(default=None, description="关联的 TabCode 项目路径")
    tabdata_table_ids: Optional[list[str]] = Field(default=None, description="绑定的 TabData 表 ID 列表")
    tabdata_token_id: Optional[str] = Field(default=None, description="关联的 TabData API Token ID")

    @validator("custom_domain", pre=True)
    def validate_custom_domain(cls, v):
        if v is None or v == "":
            return v
        return _fc_validate_domain(v)

    @validator("tabdata_table_ids", pre=True)
    def validate_table_ids(cls, v):
        if v is None:
            return v
        for item in v:
            _fc_validate_uuid(item)
        return v


class PublishSiteInput(BaseModel):
    user_id: Annotated[Optional[str], InjectedState("user_id")] = Field(
        default=None, description="用户 ID（自动注入）",
    )
    site_id: str = Field(description="站点 ID")
    message: str = Field(default="", description="版本说明")
    dist_url: str = Field(
        description="构建产物 OSS 地址（必填，需先通过 CLI `tabtin site build <id>` 或手动上传 dist 到 OSS 获取）",
        min_length=1,
    )
    file_count: int = Field(default=0, ge=0, description="dist 产物文件数量（可选，用于版本记录统计）")
    total_size: int = Field(default=0, ge=0, description="dist 产物总大小（字节，可选，用于存储配额统计）")


class RollbackSiteInput(BaseModel):
    user_id: Annotated[Optional[str], InjectedState("user_id")] = Field(
        default=None, description="用户 ID（自动注入）",
    )
    organization_id: Annotated[Optional[str], InjectedState("organization_id")] = Field(
        default=None, description="工作区 ID（自动注入）",
    )
    space_id: Annotated[Optional[str], InjectedState("current_space_id")] = Field(
        default=None, description="Space ID（自动注入）",
    )
    site_id: str = Field(description="站点 ID")
    version: int = Field(description="目标版本号")


# ── Tool Classes ──


def _ensure_context(user_id, organization_id=None, space_id=None):
    user = _load_user(user_id)
    if not user:
        return None, _err_user_not_found()

    missing = []
    empty = []
    for name, val in [("organization_id", organization_id), ("space_id", space_id)]:
        if val is None:
            missing.append(name)
        elif isinstance(val, str) and not val.strip():
            empty.append(name)

    if missing:
        return None, build_tool_error(
            f"上下文注入失败，缺少 {', '.join(missing)}。请确保在 Space 内启动 Agent 会话",
            error_kind="runtime_misconfig",
            hint=(
                "Start the Agent inside a Space so "
                f"{', '.join(missing)} are injected before calling tabsite tools."
            ),
            retryable=False,
        )
    if empty:
        return None, build_tool_error(
            f"上下文值为空：{', '.join(empty)}。当前会话的 Space 可能未正确激活",
            error_kind="runtime_misconfig",
            hint=(
                "Re-activate the current Space session so "
                f"{', '.join(empty)} are non-empty, then retry."
            ),
            retryable=False,
        )
    return user, None


class TabsiteCreateSiteTool(BaseTool):
    name: str = "tabsite_create_site"
    description: str = (
        "在数据库中创建站点记录。注意：此工具仅创建 DB 记录，"
        "不会初始化项目目录、不会生成 Token、不会写入 .env.local。"
        "如需完整的创建流程（含项目初始化和 Token 配置），请使用 CLI 命令 "
        "`tabtin site create --name <名称> --template <模板> --space-id <id>`。"
    )
    args_schema: type = CreateSiteInput
    app_id: str = "tabsite"
    risk_level: str = "review"
    required_permissions: list[str] = ["tabsite"]
    available_modes: tuple = ("agent",)

    def run(
        self,
        name: str,
        user_id: str | None = None,
        organization_id: str | None = None,
        space_id: str | None = None,
        description: str = "",
        framework: str = "react",
        template: str = "blank",
    ) -> dict:
        user, err = _ensure_context(user_id, organization_id, space_id)
        if err:
            return err
        try:
            from apps.tabsite.services.site_service import SiteService
            svc = SiteService(user=user)
            site = svc.create_site(
                organization_id=organization_id,
                space_id=space_id,
                name=name,
                description=description,
                framework=framework,
                template=template,
            )
            return {"success": True, "site": _serialize_site_detail(site)}
        except ServiceError as exc:
            logger.info("tabsite.create_site service error: %s", exc.code)
            return _err_service(exc, "create_site")
        except Exception:
            logger.exception("tabsite.create_site failed")
            return _err_internal("create_site")


class TabsiteListSitesTool(BaseTool):
    name: str = "tabsite_list_sites"
    description: str = (
        "列出当前 Space 中的所有站点。"
        "可按状态过滤（draft/published/archived）。"
    )
    args_schema: type = ListSitesInput
    app_id: str = "tabsite"
    risk_level: str = "safe"
    required_permissions: list[str] = ["tabsite"]
    available_modes: tuple = ("agent",)

    def run(
        self,
        user_id: str | None = None,
        organization_id: str | None = None,
        space_id: str | None = None,
        status: str = "",
    ) -> dict:
        user, err = _ensure_context(user_id, organization_id, space_id)
        if err:
            return err
        try:
            from apps.tabsite.services.site_service import SiteService
            svc = SiteService(user=user)
            result = svc.list_sites(
                organization_id=organization_id,
                space_id=space_id,
                status=status,
            )
            sites = [
                {
                    "id": str(s.id),
                    "name": s.name,
                    "slug": s.slug,
                    "status": s.status,
                    "framework": s.framework,
                    "template": s.template or "",
                    "published_url": s.published_url or "",
                    "dist_oss_url": s.dist_oss_url or "",
                    "current_version": s.current_version,
                    "total_views": s.total_views,
                    "is_public": s.is_public,
                    "version_count": getattr(s, "version_count", 0),
                }
                for s in result["items"]
            ]
            return {"success": True, "sites": sites, "total": result["total"]}
        except ServiceError as exc:
            logger.info("tabsite.list_sites service error: %s", exc.code)
            return _err_service(exc, "list_sites")
        except Exception:
            logger.exception("tabsite.list_sites failed")
            return _err_internal("list_sites")


class TabsiteGetSiteTool(BaseTool):
    name: str = "tabsite_get_site"
    description: str = (
        "获取站点详情，包括版本历史、关联的 TabData 表、代码项目路径等。"
    )
    args_schema: type = GetSiteInput
    app_id: str = "tabsite"
    risk_level: str = "safe"
    required_permissions: list[str] = ["tabsite"]
    available_modes: tuple = ("agent",)

    def run(
        self,
        site_id: str,
        user_id: str | None = None,
        organization_id: str | None = None,
        space_id: str | None = None,
    ) -> dict:
        user, err = _ensure_context(user_id, organization_id, space_id)
        if err:
            return err
        try:
            from apps.tabsite.services.site_service import SiteService
            svc = SiteService(user=user)
            site = svc.get_site_detail(site_id)
            return {
                "success": True,
                "site": _serialize_site_detail(site, include_versions=True),
            }
        except ServiceError as exc:
            logger.info("tabsite.get_site service error: %s", exc.code)
            return _err_service(exc, "get_site")
        except Exception:
            logger.exception("tabsite.get_site failed")
            return _err_internal("get_site")


class TabsiteUpdateSiteTool(BaseTool):
    name: str = "tabsite_update_site"
    description: str = (
        "更新站点属性（名称、描述、图标、公开状态、密码、自定义域名等）。"
    )
    args_schema: type = UpdateSiteInput
    app_id: str = "tabsite"
    risk_level: str = "review"
    required_permissions: list[str] = ["tabsite"]
    available_modes: tuple = ("agent",)

    def run(
        self,
        site_id: str,
        user_id: str | None = None,
        name: str | None = None,
        description: str | None = None,
        icon: str | None = None,
        is_public: bool | None = None,
        password: str | None = None,
        custom_domain: str | None = None,
        code_project_path: str | None = None,
        tabdata_table_ids: list[str] | None = None,
        tabdata_token_id: str | None = None,
    ) -> dict:
        user = _load_user(user_id)
        if not user:
            return _err_user_not_found()
        try:
            from apps.tabsite.services.site_service import SiteService
            svc = SiteService(user=user)
            site = svc.update_site(
                site_id=site_id,
                name=name,
                description=description,
                icon=icon,
                is_public=is_public,
                password=password,
                custom_domain=custom_domain,
                code_project_path=code_project_path,
                tabdata_table_ids=tabdata_table_ids,
                tabdata_token_id=tabdata_token_id,
            )
            return {"success": True, "site": _serialize_site_detail(site)}
        except ServiceError as exc:
            logger.info("tabsite.update_site service error: %s", exc.code)
            return _err_service(exc, "update_site")
        except Exception:
            logger.exception("tabsite.update_site failed")
            return _err_internal("update_site")


class TabsitePublishSiteTool(BaseTool):
    name: str = "tabsite_publish_site"
    description: str = (
        "发布站点的新版本。dist_url 为必填参数，必须提供构建产物的 OSS 地址。"
        "推荐使用 CLI `tabtin site build <site-id>` 一键完成构建+上传+发布，"
        "无需手动调用此工具。仅在已有 dist_url 的情况下（如重新发布已有产物）才直接调用此工具。"
    )
    args_schema: type = PublishSiteInput
    app_id: str = "tabsite"
    risk_level: str = "review"
    required_permissions: list[str] = ["tabsite"]
    available_modes: tuple = ("agent",)

    def run(
        self,
        site_id: str,
        dist_url: str,
        user_id: str | None = None,
        message: str = "",
        file_count: int = 0,
        total_size: int = 0,
    ) -> dict:
        user = _load_user(user_id)
        if not user:
            return _err_user_not_found()
        if not dist_url or not dist_url.strip():
            return build_tool_error(
                (
                    "dist_url 不能为空，需要提供构建产物的 OSS 地址。"
                    "推荐使用 CLI 命令 `tabtin site build <site_id>` 一键完成构建+上传+发布，"
                    "该命令会自动执行 npm run build、上传 dist 到 OSS、调用发布接口。"
                ),
                error_kind="missing_required_param",
                hint="Provide dist_url from `tabtin site build <site_id>` (or an uploaded OSS URL), then retry publish.",
                retryable=False,
            )
        try:
            from apps.tabsite.services.site_service import SiteService
            svc = SiteService(user=user)
            version = svc.publish_site(
                site_id=site_id,
                message=message,
                dist_url=dist_url,
                file_count=file_count,
                total_size=total_size,
            )
            return {
                "success": True,
                "site": {
                    "id": str(version.site.id),
                    "status": version.site.status,
                    "published_url": version.site.published_url or "",
                },
                "version": _serialize_version(version),
            }
        except ServiceError as exc:
            logger.info("tabsite.publish_site service error: %s", exc.code)
            return _err_service(exc, "publish_site")
        except Exception:
            logger.exception("tabsite.publish_site failed")
            return _err_internal("publish_site")


class TabsiteRollbackSiteTool(BaseTool):
    name: str = "tabsite_rollback_site"
    description: str = (
        "将站点回滚到指定版本号。回滚后站点的发布内容会切换到目标版本的快照。"
    )
    args_schema: type = RollbackSiteInput
    app_id: str = "tabsite"
    risk_level: str = "review"
    required_permissions: list[str] = ["tabsite"]
    available_modes: tuple = ("agent",)

    def run(
        self,
        site_id: str,
        version: int,
        user_id: str | None = None,
        organization_id: str | None = None,
        space_id: str | None = None,
    ) -> dict:
        user, err = _ensure_context(user_id, organization_id, space_id)
        if err:
            return err
        try:
            from apps.tabsite.services.site_service import SiteService
            svc = SiteService(user=user)
            site = svc.rollback_to_version(site_id, version)
            return {"success": True, "site": _serialize_site_detail(site)}
        except ServiceError as exc:
            logger.info("tabsite.rollback_site service error: %s", exc.code)
            return _err_service(exc, "rollback_site")
        except Exception:
            logger.exception("tabsite.rollback_site failed")
            return _err_internal("rollback_site")


class ArchiveSiteInput(BaseModel):
    user_id: Annotated[Optional[str], InjectedState("user_id")] = Field(
        default=None, description="用户 ID（自动注入）",
    )
    organization_id: Annotated[Optional[str], InjectedState("organization_id")] = Field(
        default=None, description="工作区 ID（自动注入）",
    )
    space_id: Annotated[Optional[str], InjectedState("current_space_id")] = Field(
        default=None, description="Space ID（自动注入）",
    )
    site_id: str = Field(description="站点 ID")


class ProvisionTokenInput(BaseModel):
    user_id: Annotated[Optional[str], InjectedState("user_id")] = Field(
        default=None, description="用户 ID（自动注入）",
    )
    site_id: str = Field(description="站点 ID")


class TabsiteProvisionTokenTool(BaseTool):
    name: str = "tabsite_provision_token"
    description: str = (
        "为站点自动创建只读 TabData API Token。"
        "首次创建时返回 VITE_TABTIN_TOKEN（明文），该值仅在首次创建时可获取。"
        "如果站点通过 init-template 初始化，.env.local 已自动写入，无需手动操作。"
        "幂等操作：如果站点已有有效 Token，不会重复创建，且不返回 VITE_TABTIN_TOKEN（明文不可恢复）。"
        "请勿在幂等返回时尝试将空值写入 .env.local，这会破坏已有配置。"
    )
    args_schema: type = ProvisionTokenInput
    app_id: str = "tabsite"
    risk_level: str = "review"
    required_permissions: list[str] = ["tabsite"]
    available_modes: tuple = ("agent",)

    def run(self, site_id: str, user_id: str | None = None) -> dict:
        user = _load_user(user_id)
        if not user:
            return _err_user_not_found()
        try:
            from apps.tabsite.services.site_service import SiteService
            svc = SiteService(user=user)
            env_data = svc.provision_tabdata_token(site_id)
            newly_created = "VITE_TABTIN_TOKEN" in env_data
            result = {"success": True, "newly_created": newly_created, **env_data}
            if not newly_created:
                result["hint"] = (
                    "Token 已存在，未重复创建。明文 Token 仅在首次创建时返回。"
                    "如果 .env.local 已由 init-template 写入，无需额外操作。"
                )
            return result
        except ServiceError as exc:
            logger.info("tabsite.provision_token service error: %s", exc.code)
            return _err_service(exc, "provision_token")
        except Exception:
            logger.exception("tabsite.provision_token failed")
            return _err_internal("provision_token")


class TabsiteArchiveSiteTool(BaseTool):
    name: str = "tabsite_archive_site"
    description: str = (
        "归档站点。归档后站点不再公开可访问，但数据保留可恢复。"
        "同时会释放 OSS dist 文件的存储引用。"
        "归档操作不可通过此工具撤销，如需恢复请联系管理员。"
    )
    args_schema: type = ArchiveSiteInput
    app_id: str = "tabsite"
    risk_level: str = "review"
    required_permissions: list[str] = ["tabsite"]
    available_modes: tuple = ("agent",)

    def run(
        self,
        site_id: str,
        user_id: str | None = None,
        organization_id: str | None = None,
        space_id: str | None = None,
    ) -> dict:
        user, err = _ensure_context(user_id, organization_id, space_id)
        if err:
            return err
        try:
            from apps.tabsite.services.site_service import SiteService
            svc = SiteService(user=user)
            svc.archive_site(site_id)
            return {"success": True, "site_id": site_id, "status": "archived"}
        except ServiceError as exc:
            logger.info("tabsite.archive_site service error: %s", exc.code)
            return _err_service(exc, "archive_site")
        except Exception:
            logger.exception("tabsite.archive_site failed")
            return _err_internal("archive_site")


def get_tabsite_tools() -> list[BaseTool]:
    return [
        TabsiteCreateSiteTool(),
        TabsiteListSitesTool(),
        TabsiteGetSiteTool(),
        TabsiteUpdateSiteTool(),
        TabsitePublishSiteTool(),
        TabsiteRollbackSiteTool(),
        TabsiteProvisionTokenTool(),
        TabsiteArchiveSiteTool(),
    ]
