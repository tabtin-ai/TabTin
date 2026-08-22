"""
TabMemo Agent 工具集

提供 17 个工具，覆盖碎片笔记（Memo）、集合（Collection）、授权（Grant）的完整 CRUD：

Memo 操作:
  - tabmemo_create_memo: 创建碎片笔记
  - tabmemo_search_memos: 搜索当前 Space 可见的碎片笔记（含 Grant 授权）
  - tabmemo_get_memo: 获取单条碎片详情
  - tabmemo_update_memo: 修改碎片内容、标签、颜色等
  - tabmemo_archive_memo: 归档碎片
  - tabmemo_restore_memo: 恢复已归档的碎片
  - tabmemo_restore_from_trash: 从回收站恢复碎片
  - tabmemo_batch_operate: 批量归档/回收/恢复/置顶/打标/移入集合
  - tabmemo_list_attachments: 列出碎片附件

Collection 操作:
  - tabmemo_list_collections: 列出 Space 可见集合
  - tabmemo_create_collection: 创建集合（支持智能集合）
  - tabmemo_update_collection: 修改集合属性
  - tabmemo_delete_collection: 删除集合
  - tabmemo_add_to_collection: 将碎片添加到集合（skip-invalid 模式）
  - tabmemo_remove_from_collection: 将碎片从集合移除

Grant 操作:
  - tabmemo_list_grants: 列出当前 Space 被授权访问的 Grant 列表
  - tabmemo_manage_grant: 创建或撤销碎片/集合的 Agent 访问授权
"""

from __future__ import annotations

import logging
from typing import Any, List, Literal, Optional

from pydantic import BaseModel, Field
from typing_extensions import Annotated

from apps.i18n import get_text as _
from apps.services.common.state.injected_state import InjectedState
from apps.services.tools import BaseTool
from apps.services.tools.domains._shared import load_user as _load_user
from apps.services.tools.error_envelope import build_tool_error


logger = logging.getLogger(__name__)


def _get_service_error_class():
    """延迟导入 ServiceError，避免在模块级触发 Django get_user_model()。"""
    from apps.tabtinspace.services.base import ServiceError
    return ServiceError


def _is_service_error(exc: Exception) -> bool:
    return isinstance(exc, _get_service_error_class())


def _map_service_error_kind(code: str) -> str:
    normalized = (code or "").upper()
    if "NOT_FOUND" in normalized or normalized.endswith("_MISSING"):
        return "resource_not_found"
    if "PERMISSION" in normalized or "FORBIDDEN" in normalized or "DENIED" in normalized:
        return "permission_denied"
    if "INVALID" in normalized or "VALIDATION" in normalized or "MISMATCH" in normalized:
        return "invalid_param_format"
    return "upstream_error"


def _service_err_response(exc: Exception) -> dict:
    """将 ServiceError 或通用异常转为标准失败 envelope。"""
    if _is_service_error(exc):
        code = str(getattr(exc, "code", "") or "")
        kind = _map_service_error_kind(code)
        hint_by_kind = {
            "resource_not_found": "Confirm the memo/collection ID still exists, then retry.",
            "permission_denied": "Ask the user to grant TabMemo access for this Space, then retry.",
            "invalid_param_format": "Fix the invalid input fields and retry the TabMemo tool.",
        }
        return build_tool_error(
            getattr(exc, "message", None) or code or "TabMemo operation failed.",
            error_kind=kind,
            hint=hint_by_kind.get(
                kind,
                "Retry once. If it fails again, tell the user TabMemo is temporarily unavailable.",
            ),
            retryable=kind == "upstream_error",
            upstream_code=code or None,
        )
    return build_tool_error(
        "TabMemo operation failed.",
        error_kind="internal_error",
        hint="Retry once. If it fails again, ask the user to retry from the TabMemo UI.",
        retryable=True,
    )


def _err_user_not_found() -> dict:
    return build_tool_error(
        _("memo_tools.user_not_found"),
        error_kind="runtime_misconfig",
        hint="Ensure the Agent session injects user_id before calling tabmemo tools.",
        retryable=False,
    )


def _err_organization_space_required() -> dict:
    return build_tool_error(
        _("memo_tools.organization_space_required"),
        error_kind="runtime_misconfig",
        hint="Start the Agent inside a Space so organization_id and space_id are injected.",
        retryable=False,
    )


def _err_memo_ids_required() -> dict:
    return build_tool_error(
        _("memo_tools.memo_ids_required"),
        error_kind="missing_required_param",
        hint="Provide at least one memo_id in memo_ids before calling this tool.",
        retryable=False,
    )


def _err_missing_param(error: str, *, param: str) -> dict:
    return build_tool_error(
        error,
        error_kind="missing_required_param",
        hint=f"Provide {param} before calling this tabmemo tool.",
        retryable=False,
    )


def _err_invalid_param(error: str, *, param: str) -> dict:
    return build_tool_error(
        error,
        error_kind="invalid_param_format",
        hint=f"Check {param} and retry with a valid value.",
        retryable=False,
    )


def _is_valid_uuid(value: str) -> bool:
    import uuid
    try:
        uuid.UUID(value)
        return True
    except (TypeError, ValueError):
        return False


def _check_uuids(**fields: str) -> dict | None:
    """校验多个 UUID 字段，返回第一个非法字段的错误 dict，全部合法返回 None。"""
    for name, value in fields.items():
        if value and not _is_valid_uuid(value):
            return build_tool_error(
                _("memo_tools.invalid_uuid", name=name),
                error_kind="invalid_param_format",
                hint=f"Provide a valid UUID for {name}.",
                retryable=False,
            )
    return None


def _make_svc(user, space_id: str | None = None):
    """统一创建 MemoService，确保 Agent 上下文的 space_id 传入 requesting_space_id。"""
    from apps.tabmemo.services.memo_service import MemoService
    return MemoService(user=user, requesting_space_id=space_id)


# ─── Input Schemas ────────────────────────────────────────


class CreateMemoInput(BaseModel):
    user_id: Annotated[Optional[str], InjectedState("user_id")] = Field(
        default=None, description="用户 ID（自动注入）",
    )
    organization_id: Annotated[Optional[str], InjectedState("organization_id")] = Field(
        default=None, description="工作区 ID（自动注入）",
    )
    space_id: Annotated[Optional[str], InjectedState("current_space_id")] = Field(
        default=None, description="Space ID（自动注入）",
    )
    content: str = Field(
        description="碎片笔记内容（纯文本或 Markdown）",
    )
    tags: List[str] = Field(
        default_factory=list,
        description="标签列表，如 ['灵感', '待办']",
    )
    color: str = Field(
        default="",
        description="颜色标记。可选：yellow / blue / green / pink / purple / orange / gray",
    )
    bookmark_url: str = Field(
        default="",
        description="关联的书签 URL。传入后会自动抓取标题和封面。",
    )
    collection_id: str = Field(
        default="",
        description="创建后自动加入的集合 ID（可选）",
    )
    memo_type: str = Field(
        default="note",
        description="碎片类型，可选值: note / bookmark / about_you / insight / task_summary / skill",
    )
    importance: Optional[int] = Field(
        default=None,
        description="重要性（1-5），null 表示不设置",
        ge=1,
        le=5,
    )


class SearchMemosInput(BaseModel):
    user_id: Annotated[Optional[str], InjectedState("user_id")] = Field(
        default=None, description="用户 ID（自动注入）",
    )
    organization_id: Annotated[Optional[str], InjectedState("organization_id")] = Field(
        default=None, description="工作区 ID（自动注入）",
    )
    space_id: Annotated[Optional[str], InjectedState("current_space_id")] = Field(
        default=None, description="Space ID（自动注入）",
    )
    query: str = Field(
        default="",
        description="搜索关键词（全文搜索）",
    )
    tags: List[str] = Field(
        default_factory=list,
        description="按标签筛选（AND 语义）",
    )
    color: str = Field(
        default="",
        description="按颜色过滤，可选值: yellow/blue/green/pink/purple/orange/gray",
    )
    collection_id: str = Field(
        default="",
        description="按集合 ID 过滤",
    )
    memo_type: str = Field(
        default="",
        description="按碎片类型过滤，可选值: note / bookmark / about_you / insight / task_summary / skill，空字符串表示不过滤",
    )
    status: Literal["active", "archived", "trashed"] = Field(
        default="active",
        description="按状态过滤，可选值: active（活跃）/ archived（已归档）/ trashed（回收站）",
    )
    source: Literal["", "user", "agent", "manual", "browser", "share", "api", "voice"] = Field(
        default="",
        description=(
            "按来源过滤。'user'=排除 Agent 写入的 memo（用户视角）；"
            "'agent'=只看 Agent 写入；'manual'/'browser' 等=精确匹配单一来源；"
            "空字符串=不过滤（混排）。"
        ),
    )
    created_after: str = Field(
        default="",
        description=(
            "创建时间下界（ISO 8601 字符串），仅返回 created_at >= 此时间的 memo。"
            "用于「今日 / 本周 / 上月」等基于时间窗口的检索。空字符串=不过滤。"
        ),
    )
    limit: int = Field(
        default=10,
        description="返回数量上限（1-50）",
        ge=1,
        le=50,
    )
    cursor: Optional[str] = Field(
        default=None,
        description="分页游标，从上一次搜索结果的 next_cursor 获取",
    )
    sort: str = Field(
        default="-created_at",
        description="排序字段，可选值: created_at / -created_at / updated_at / -updated_at（- 前缀表示降序）",
    )


class GetMemoInput(BaseModel):
    user_id: Annotated[Optional[str], InjectedState("user_id")] = Field(
        default=None, description="用户 ID（自动注入）",
    )
    space_id: Annotated[Optional[str], InjectedState("current_space_id")] = Field(
        default=None, description="Space ID（自动注入，用于 Grant 权限校验）",
    )
    memo_id: str = Field(
        description="碎片笔记 ID",
    )


class UpdateMemoInput(BaseModel):
    user_id: Annotated[Optional[str], InjectedState("user_id")] = Field(
        default=None, description="用户 ID（自动注入）",
    )
    space_id: Annotated[Optional[str], InjectedState("current_space_id")] = Field(
        default=None, description="Space ID（自动注入，用于 Grant 权限校验）",
    )
    memo_id: str = Field(description="要修改的碎片 ID")
    content: Optional[str] = Field(default=None, description="新内容（Markdown），null 表示不修改，空字符串可用于清空内容")
    tags: Optional[List[str]] = Field(default=None, description="新标签列表，null 表示不修改，空列表表示清空")
    color: Optional[str] = Field(default=None, description="新颜色标记，null 表示不修改，空字符串表示清除颜色")
    is_pinned: Optional[bool] = Field(default=None, description="置顶状态，null 表示不修改")
    bookmark_url: Optional[str] = Field(default=None, description="书签 URL，null 表示不修改，空字符串表示清除")
    bookmark_title: Optional[str] = Field(default=None, description="书签标题，null 表示不修改，空字符串表示清除")
    bookmark_description: Optional[str] = Field(default=None, description="书签描述，null 表示不修改，空字符串表示清除")
    bookmark_image: Optional[str] = Field(default=None, description="书签缩略图 URL，null 表示不修改，空字符串表示清除")
    memo_type: Optional[str] = Field(
        default=None,
        description="碎片类型，可选值: note / bookmark / about_you / insight / task_summary / skill，null 表示不修改",
    )
    importance: Optional[int] = Field(
        default=None,
        description="重要性（1-5），null 表示不修改，传 0 表示清除",
    )


class ArchiveMemoInput(BaseModel):
    user_id: Annotated[Optional[str], InjectedState("user_id")] = Field(
        default=None, description="用户 ID（自动注入）",
    )
    space_id: Annotated[Optional[str], InjectedState("current_space_id")] = Field(
        default=None, description="Space ID（自动注入，用于 Grant 权限校验）",
    )
    memo_id: str = Field(description="要归档的碎片 ID")


class RestoreMemoInput(BaseModel):
    user_id: Annotated[Optional[str], InjectedState("user_id")] = Field(
        default=None, description="用户 ID（自动注入）",
    )
    space_id: Annotated[Optional[str], InjectedState("current_space_id")] = Field(
        default=None, description="Space ID（自动注入，用于 Grant 权限校验）",
    )
    memo_id: str = Field(description="要恢复的碎片 ID")


class RestoreFromTrashInput(BaseModel):
    user_id: Annotated[Optional[str], InjectedState("user_id")] = Field(
        default=None, description="用户 ID（自动注入）",
    )
    space_id: Annotated[Optional[str], InjectedState("current_space_id")] = Field(
        default=None, description="Space ID（自动注入，用于 Grant 权限校验）",
    )
    memo_id: str = Field(description="要从回收站恢复的碎片 ID")


class ListCollectionsInput(BaseModel):
    user_id: Annotated[Optional[str], InjectedState("user_id")] = Field(
        default=None, description="用户 ID（自动注入）",
    )
    organization_id: Annotated[Optional[str], InjectedState("organization_id")] = Field(
        default=None, description="工作区 ID（自动注入）",
    )
    space_id: Annotated[Optional[str], InjectedState("current_space_id")] = Field(
        default=None, description="Space ID（自动注入）",
    )


class AddToCollectionInput(BaseModel):
    user_id: Annotated[Optional[str], InjectedState("user_id")] = Field(
        default=None, description="用户 ID（自动注入）",
    )
    space_id: Annotated[Optional[str], InjectedState("current_space_id")] = Field(
        default=None, description="Space ID（自动注入，用于 Grant 权限校验）",
    )
    collection_id: str = Field(description="目标集合 ID")
    memo_ids: List[str] = Field(description="要添加到集合的碎片 ID 列表")


class RemoveFromCollectionInput(BaseModel):
    user_id: Annotated[Optional[str], InjectedState("user_id")] = Field(
        default=None, description="用户 ID（自动注入）",
    )
    space_id: Annotated[Optional[str], InjectedState("current_space_id")] = Field(
        default=None, description="Space ID（自动注入，用于 Grant 权限校验）",
    )
    collection_id: str = Field(description="集合 ID")
    memo_ids: List[str] = Field(description="要从集合中移除的碎片 ID 列表")


class CreateCollectionInput(BaseModel):
    user_id: Annotated[Optional[str], InjectedState("user_id")] = Field(
        default=None, description="用户 ID（自动注入）",
    )
    organization_id: Annotated[Optional[str], InjectedState("organization_id")] = Field(
        default=None, description="工作区 ID（自动注入）",
    )
    space_id: Annotated[Optional[str], InjectedState("current_space_id")] = Field(
        default=None, description="Space ID（自动注入）",
    )
    title: str = Field(description="集合名称")
    description: str = Field(default="", description="集合描述")
    icon: str = Field(default="", description="集合图标")
    color: str = Field(default="", description="集合颜色")
    is_smart: bool = Field(default=False, description="是否为智能集合")
    smart_filter: dict = Field(
        default_factory=dict,
        description=(
            '智能过滤条件 JSON，如 {"match_mode":"all","tags":["设计"],"keywords":["架构"],'
            '"color":"blue","source":["manual","agent"]}'
        ),
    )


class UpdateCollectionInput(BaseModel):
    user_id: Annotated[Optional[str], InjectedState("user_id")] = Field(
        default=None, description="用户 ID（自动注入）",
    )
    space_id: Annotated[Optional[str], InjectedState("current_space_id")] = Field(
        default=None, description="Space ID（自动注入，用于 Grant 权限校验）",
    )
    collection_id: str = Field(description="要修改的集合 ID")
    title: Optional[str] = Field(default=None, description="新名称，null 表示不修改，空字符串可用于清空")
    description: Optional[str] = Field(default=None, description="新描述，null 表示不修改，空字符串可用于清空")
    icon: Optional[str] = Field(default=None, description="新图标，null 表示不修改，空字符串可用于清空")
    color: Optional[str] = Field(default=None, description="新颜色，null 表示不修改，空字符串可用于清空")
    is_smart: Optional[bool] = Field(default=None, description="是否为智能集合，null 表示不修改")
    smart_filter: Optional[dict] = Field(default=None, description="智能过滤条件，null 表示不修改")


class DeleteCollectionInput(BaseModel):
    user_id: Annotated[Optional[str], InjectedState("user_id")] = Field(
        default=None, description="用户 ID（自动注入）",
    )
    space_id: Annotated[Optional[str], InjectedState("current_space_id")] = Field(
        default=None, description="Space ID（自动注入，用于 Grant 权限校验）",
    )
    collection_id: str = Field(description="要删除的集合 ID")


class BatchOperateInput(BaseModel):
    user_id: Annotated[Optional[str], InjectedState("user_id")] = Field(
        default=None, description="用户 ID（自动注入）",
    )
    organization_id: Annotated[Optional[str], InjectedState("organization_id")] = Field(
        default=None, description="工作区 ID（自动注入）",
    )
    space_id: Annotated[Optional[str], InjectedState("current_space_id")] = Field(
        default=None, description="Space ID（自动注入）",
    )
    memo_ids: List[str] = Field(description="要操作的碎片 ID 列表")
    action: Literal["archive", "trash", "restore", "pin", "unpin", "tag", "move_to_collection"] = Field(
        description=(
            "操作类型: archive（批量归档）/ trash（批量移入回收站）/ restore（批量恢复归档）"
            "/ pin（批量置顶）/ unpin（批量取消置顶）/ tag（批量打标）/ move_to_collection（批量移入集合）"
        ),
    )
    tags: List[str] = Field(default_factory=list, description="action=tag 时需要追加的标签列表")
    collection_id: str = Field(default="", description="action=move_to_collection 时的目标集合 ID")


class ListAttachmentsInput(BaseModel):
    user_id: Annotated[Optional[str], InjectedState("user_id")] = Field(
        default=None, description="用户 ID（自动注入）",
    )
    space_id: Annotated[Optional[str], InjectedState("current_space_id")] = Field(
        default=None, description="Space ID（自动注入，用于 Grant 权限校验）",
    )
    memo_id: str = Field(description="碎片 ID")


class ListGrantsInput(BaseModel):
    """列出当前 Space 被授权访问的碎片 Grant"""
    user_id: Annotated[Optional[str], InjectedState("user_id")] = Field(
        default=None, description="用户 ID（自动注入）",
    )
    organization_id: Annotated[Optional[str], InjectedState("organization_id")] = Field(
        default=None, description="工作区 ID（自动注入）",
    )
    space_id: Annotated[Optional[str], InjectedState("current_space_id")] = Field(
        default=None, description="Space ID（自动注入）",
    )
    limit: int = Field(
        default=20,
        description="返回数量上限（1-100）",
        ge=1,
        le=100,
    )
    offset: int = Field(
        default=0,
        description="偏移量，用于分页",
        ge=0,
    )


class ManageGrantInput(BaseModel):
    """创建或撤销碎片/集合的 Agent 访问授权"""
    user_id: Annotated[Optional[str], InjectedState("user_id")] = Field(
        default=None, description="用户 ID（自动注入）",
    )
    organization_id: Annotated[Optional[str], InjectedState("organization_id")] = Field(
        default=None, description="工作区 ID（自动注入）",
    )
    space_id: Annotated[Optional[str], InjectedState("current_space_id")] = Field(
        default=None, description="Space ID（自动注入）",
    )
    action: Literal["create", "delete"] = Field(
        description="操作类型: create（创建授权）/ delete（撤销授权）",
    )
    target_space_id: str = Field(
        default="",
        description="授权目标 Space ID（action=create 时必填，即授权哪个 Space 的 Agent 可访问）",
    )
    memo_ids: List[str] = Field(
        default_factory=list,
        description="action=create 时，要授权的碎片 ID 列表",
    )
    collection_ids: List[str] = Field(
        default_factory=list,
        description="action=create 时，要授权的集合 ID 列表",
    )
    permission: Literal["read", "write"] = Field(
        default="read",
        description="权限级别: read（只读）/ write（读写），仅 action=create 时有效",
    )
    grant_id: str = Field(
        default="",
        description="action=delete 时，要撤销的 Grant ID",
    )


# ─── Tools ────────────────────────────────────────────────


class TabmemoCreateMemoTool(BaseTool):
    category: str = "write_file"
    name: str = "tabmemo_create_memo"
    description: str = (
        "创建一条碎片笔记（TabMemo）。"
        "适合随手记录灵感、链接、待办、摘录等碎片化内容。"
        "支持 Markdown 格式、标签和颜色标记。"
        "如果传入 bookmark_url，将保存该链接供后续查看。"
    )
    args_schema: type = CreateMemoInput
    app_id: str = "tabmemo"
    risk_level: str = "review"
    required_permissions: list[str] = ["tabmemo"]
    available_modes: tuple = ("agent",)

    def run(
        self,
        content: str,
        user_id: str | None = None,
        organization_id: str | None = None,
        space_id: str | None = None,
        tags: list[str] | None = None,
        color: str = "",
        bookmark_url: str = "",
        collection_id: str = "",
        memo_type: str = "note",
        importance: int | None = None,
    ) -> dict:
        user = _load_user(user_id)
        if not user:
            return _err_user_not_found()
        if not organization_id or not space_id:
            return _err_organization_space_required()
        if err := _check_uuids(collection_id=collection_id):
            return err

        try:
            svc = _make_svc(user, space_id)
            memo = svc.create_memo(
                organization_id=organization_id,
                space_id=space_id,
                content_markdown=content,
                tags=tags or [],
                color=color,
                memo_type=memo_type,
                importance=importance,
                source="agent",
                bookmark_url=bookmark_url,
                collection_id=collection_id or None,
            )

            result = {
                "success": True,
                "memo_id": str(memo.id),
                "content_plaintext": (memo.content_plaintext or "")[:200],
                "tags": memo.tags,
                "color": memo.color,
                "is_pinned": memo.is_pinned,
                "memo_type": memo.memo_type,
                "importance": memo.importance,
                "source": memo.source,
                "status": memo.status,
                "bookmark_url": memo.bookmark_url or "",
                "bookmark_title": memo.bookmark_title or "",
                "created_at": memo.created_at.isoformat(),
                "updated_at": memo.updated_at.isoformat(),
            }
            warnings = getattr(memo, "_warnings", None)
            if warnings:
                result["warnings"] = warnings
            return result

        except Exception as e:
            if _is_service_error(e):
                logger.warning("tabmemo.create_memo business error: %s", e)
            else:
                logger.exception("tabmemo.create_memo failed")
            return _service_err_response(e)


class TabmemoSearchMemosTool(BaseTool):
    name: str = "tabmemo_search_memos"
    description: str = (
        "搜索当前 Space 可见的碎片笔记（包括 Space 自有碎片和通过 Grant 授权的碎片）。"
        "支持全文搜索、标签筛选、颜色过滤、集合过滤、来源过滤、时间窗口过滤。"
        "返回匹配的碎片列表（摘要信息），可用于查找用户之前记录的内容。"
        "注意：搜索结果缓存 10 秒，短时间内重复查询会返回缓存结果。"
    )
    args_schema: type = SearchMemosInput
    app_id: str = "tabmemo"
    risk_level: str = "safe"
    required_permissions: list[str] = ["tabmemo"]
    cacheable: bool = True
    cache_ttl: int = 10

    def run(
        self,
        user_id: str | None = None,
        organization_id: str | None = None,
        space_id: str | None = None,
        query: str = "",
        tags: list[str] | None = None,
        color: str = "",
        collection_id: str = "",
        memo_type: str = "",
        status: str = "active",
        source: str = "",
        created_after: str = "",
        limit: int = 10,
        cursor: str | None = None,
        sort: str = "-created_at",
    ) -> dict:
        user = _load_user(user_id)
        if not user:
            return _err_user_not_found()
        if not organization_id or not space_id:
            return _err_organization_space_required()
        if err := _check_uuids(collection_id=collection_id):
            return err

        #  / ：source=agent 分流到独立 AgentMemory 表
        _requested_types = {t.strip() for t in memo_type.split(",") if t.strip()} if memo_type else set()
        AGENT_MEMORY_MEMO_TYPES = {"about_you", "insight", "task_summary", "diary"}
        if source == "agent":
            from apps.agent_memory.recall import AgentMemoryRecall
            agent_ids = AgentMemoryRecall.resolve_recall_agent_ids(space_id)
            if not agent_ids:
                return {"success": True, "items": [], "count": 0, "has_more": False, "next_cursor": ""}
            result = AgentMemoryRecall.list_memories(
                agent_ids=agent_ids,
                organization_id=organization_id,
                owner_id=str(user.id),
                memo_type=",".join(_requested_types & AGENT_MEMORY_MEMO_TYPES),
                status=status if status in ("active", "archived") else "active",
                search=query,
                created_after=created_after or None,
                sort=sort,
                cursor=cursor or "",
                limit=min(limit, 50),
                for_recall=True,
            )
            items = [
                {
                    "memo_id": entry["id"],
                    "content_plaintext": (entry["content_plaintext"] or "")[:200],
                    "tags": entry["tags"],
                    "memo_type": entry["memo_type"],
                    "importance": entry["importance"],
                    "source": "agent",
                    "created_at": entry["created_at"],
                    "updated_at": entry["updated_at"],
                }
                for entry in result["items"]
            ]
            return {
                "success": True,
                "items": items,
                "count": len(items),
                "has_more": result.get("has_more", False),
                "next_cursor": result.get("next_cursor", ""),
            }


        try:
            svc = _make_svc(user, space_id)
            result = svc.list_memos(
                organization_id=organization_id,
                space_id=space_id,
                search=query,
                tags=tags if tags else None,
                color=color,
                memo_type=memo_type,
                collection_id=collection_id,
                status=status,
                sort=sort,
                limit=min(limit, 50),
                cursor=cursor,
                source=source or None,
                created_after=created_after or None,
            )

            items = []
            for memo in result["items"]:
                items.append({
                    "memo_id": str(memo.id),
                    "content_plaintext": (memo.content_plaintext or "")[:200],
                    "tags": memo.tags,
                    "color": memo.color,
                    "is_pinned": memo.is_pinned,
                    "memo_type": memo.memo_type,
                    "importance": memo.importance,
                    "source": memo.source,
                    "bookmark_url": memo.bookmark_url or "",
                    "bookmark_title": memo.bookmark_title or "",
                    "created_at": memo.created_at.isoformat(),
                    "updated_at": memo.updated_at.isoformat(),
                })

            return {
                "success": True,
                "items": items,
                "count": len(items),
                "has_more": result.get("has_more", False),
                "next_cursor": result.get("next_cursor", ""),
            }

        except Exception as e:
            if _is_service_error(e):
                logger.warning("tabmemo.search_memos business error: %s", e)
            else:
                logger.exception("tabmemo.search_memos failed")
            return _service_err_response(e)


class TabmemoGetMemoTool(BaseTool):
    name: str = "tabmemo_get_memo"
    description: str = (
        "获取单条碎片笔记的完整详情，包括全部内容、标签、书签信息、附件列表。"
        "用于在对话中引用或展示碎片内容。"
        "注意：详情结果缓存 30 秒，短时间内重复获取会返回缓存结果。"
    )
    args_schema: type = GetMemoInput
    app_id: str = "tabmemo"
    risk_level: str = "safe"
    required_permissions: list[str] = ["tabmemo"]
    cacheable: bool = True
    cache_ttl: int = 30

    def run(
        self,
        memo_id: str,
        user_id: str | None = None,
        space_id: str | None = None,
    ) -> dict:
        user = _load_user(user_id)
        if not user:
            return _err_user_not_found()
        if err := _check_uuids(memo_id=memo_id):
            return err

        try:
            svc = _make_svc(user, space_id)
            memo = svc.get_memo_detail(memo_id)

            attachments = []
            for att in memo.attachments.all():
                attachments.append({
                    "id": str(att.id),
                    "file_name": att.file_name,
                    "file_type": att.file_type,
                    "file_url": att.file_url,
                    "mime_type": att.mime_type,
                })

            return {
                "success": True,
                "memo_id": str(memo.id),
                "content_markdown": memo.content_markdown or "",
                "content_plaintext": memo.content_plaintext or "",
                "tags": memo.tags,
                "ai_tags": memo.ai_tags,
                "color": memo.color,
                "source": memo.source,
                "is_pinned": memo.is_pinned,
                "bookmark_url": memo.bookmark_url or "",
                "bookmark_title": memo.bookmark_title or "",
                "bookmark_description": memo.bookmark_description or "",
                "bookmark_image": memo.bookmark_image or "",
                "memo_type": memo.memo_type,
                "importance": memo.importance,
                "status": memo.status,
                "attachments": attachments,
                "created_at": memo.created_at.isoformat(),
                "updated_at": memo.updated_at.isoformat(),
            }

        except Exception as e:
            if _is_service_error(e):
                logger.warning("tabmemo.get_memo business error: %s", e)
            else:
                logger.exception("tabmemo.get_memo failed")
            return _service_err_response(e)


class TabmemoUpdateMemoTool(BaseTool):
    category: str = "write_file"
    name: str = "tabmemo_update_memo"
    description: str = (
        "修改一条碎片笔记的内容、标签、颜色或置顶状态。"
        "只需传入要修改的字段，未传的字段保持不变。"
    )
    args_schema: type = UpdateMemoInput
    app_id: str = "tabmemo"
    risk_level: str = "review"
    required_permissions: list[str] = ["tabmemo"]
    available_modes: tuple = ("agent",)

    def run(
        self,
        memo_id: str,
        user_id: str | None = None,
        space_id: str | None = None,
        content: str | None = None,
        tags: list[str] | None = None,
        color: str | None = None,
        is_pinned: bool | None = None,
        bookmark_url: str | None = None,
        bookmark_title: str | None = None,
        bookmark_description: str | None = None,
        bookmark_image: str | None = None,
        memo_type: str | None = None,
        importance: int | None = None,
    ) -> dict:
        user = _load_user(user_id)
        if not user:
            return _err_user_not_found()
        if err := _check_uuids(memo_id=memo_id):
            return err

        try:
            svc = _make_svc(user, space_id)
            kwargs: dict[str, Any] = {"memo_id": memo_id}
            if content is not None:
                kwargs["content_markdown"] = content
            if tags is not None:
                kwargs["tags"] = tags
            if color is not None:
                kwargs["color"] = color
            if is_pinned is not None:
                kwargs["is_pinned"] = is_pinned
            if bookmark_url is not None:
                kwargs["bookmark_url"] = bookmark_url
            if bookmark_title is not None:
                kwargs["bookmark_title"] = bookmark_title
            if bookmark_description is not None:
                kwargs["bookmark_description"] = bookmark_description
            if bookmark_image is not None:
                kwargs["bookmark_image"] = bookmark_image
            if memo_type is not None:
                kwargs["memo_type"] = memo_type
            if importance is not None:
                kwargs["importance"] = importance

            memo = svc.update_memo(**kwargs)
            return {
                "success": True,
                "memo_id": str(memo.id),
                "content_plaintext": (memo.content_plaintext or "")[:200],
                "tags": memo.tags,
                "color": memo.color,
                "is_pinned": memo.is_pinned,
                "memo_type": memo.memo_type,
                "importance": memo.importance,
                "updated_at": memo.updated_at.isoformat(),
            }
        except Exception as e:
            if _is_service_error(e):
                logger.warning("tabmemo.update_memo business error: %s", e)
            else:
                logger.exception("tabmemo.update_memo failed")
            return _service_err_response(e)


class TabmemoArchiveMemoTool(BaseTool):
    name: str = "tabmemo_archive_memo"
    description: str = (
        "归档一条碎片笔记。归档后碎片不再出现在默认列表中，但可通过归档视图查看。"
    )
    args_schema: type = ArchiveMemoInput
    app_id: str = "tabmemo"
    risk_level: str = "review"
    required_permissions: list[str] = ["tabmemo"]
    available_modes: tuple = ("agent",)

    def run(
        self,
        memo_id: str,
        user_id: str | None = None,
        space_id: str | None = None,
    ) -> dict:
        user = _load_user(user_id)
        if not user:
            return _err_user_not_found()
        if err := _check_uuids(memo_id=memo_id):
            return err

        try:
            svc = _make_svc(user, space_id)
            svc.archive_memo(memo_id)
            return {"success": True, "memo_id": memo_id, "status": "archived"}
        except Exception as e:
            if _is_service_error(e):
                logger.warning("tabmemo.archive_memo business error: %s", e)
            else:
                logger.exception("tabmemo.archive_memo failed")
            return _service_err_response(e)


class TabmemoRestoreMemoTool(BaseTool):
    name: str = "tabmemo_restore_memo"
    description: str = (
        "恢复一条已归档的碎片笔记。恢复后碎片重新出现在默认列表中。"
        "仅对已归档的碎片有效。"
    )
    args_schema: type = RestoreMemoInput
    app_id: str = "tabmemo"
    risk_level: str = "review"
    required_permissions: list[str] = ["tabmemo"]
    available_modes: tuple = ("agent",)

    def run(
        self,
        memo_id: str,
        user_id: str | None = None,
        space_id: str | None = None,
    ) -> dict:
        user = _load_user(user_id)
        if not user:
            return _err_user_not_found()
        if err := _check_uuids(memo_id=memo_id):
            return err

        try:
            svc = _make_svc(user, space_id)
            memo = svc.restore_memo(memo_id)
            return {"success": True, "memo_id": str(memo.id), "status": "active"}
        except Exception as e:
            if _is_service_error(e):
                logger.warning("tabmemo.restore_memo business error: %s", e)
            else:
                logger.exception("tabmemo.restore_memo failed")
            return _service_err_response(e)


class TabmemoRestoreFromTrashTool(BaseTool):
    name: str = "tabmemo_restore_from_trash"
    description: str = (
        "从回收站恢复一条碎片笔记。仅对已移入回收站的碎片有效。"
        "恢复后碎片会回到之前的状态（活跃或归档）。"
    )
    args_schema: type = RestoreFromTrashInput
    app_id: str = "tabmemo"
    risk_level: str = "review"
    required_permissions: list[str] = ["tabmemo"]
    available_modes: tuple = ("agent",)

    def run(
        self,
        memo_id: str,
        user_id: str | None = None,
        space_id: str | None = None,
    ) -> dict:
        user = _load_user(user_id)
        if not user:
            return _err_user_not_found()
        if err := _check_uuids(memo_id=memo_id):
            return err

        try:
            svc = _make_svc(user, space_id)
            memo = svc.restore_memo_from_trash(memo_id)
            return {"success": True, "memo_id": str(memo.id), "status": memo.status}
        except Exception as e:
            if _is_service_error(e):
                logger.warning("tabmemo.restore_from_trash business error: %s", e)
            else:
                logger.exception("tabmemo.restore_from_trash failed")
            return _service_err_response(e)


class TabmemoListCollectionsTool(BaseTool):
    name: str = "tabmemo_list_collections"
    description: str = (
        "列出当前 Space 可见的碎片集合（包括 Space 自有集合和通过 Grant 授权的集合），"
        "包括集合名称、描述、碎片数量等信息。"
    )
    args_schema: type = ListCollectionsInput
    app_id: str = "tabmemo"
    risk_level: str = "safe"
    required_permissions: list[str] = ["tabmemo"]
    cacheable: bool = True
    cache_ttl: int = 10

    def run(
        self,
        user_id: str | None = None,
        organization_id: str | None = None,
        space_id: str | None = None,
    ) -> dict:
        user = _load_user(user_id)
        if not user:
            return _err_user_not_found()
        if not organization_id or not space_id:
            return _err_organization_space_required()

        try:
            svc = _make_svc(user, space_id)
            collections = svc.list_collections(organization_id, space_id)
            items = []
            for c in collections:
                items.append({
                    "collection_id": str(c.id),
                    "title": c.title,
                    "description": c.description or "",
                    "icon": c.icon or "",
                    "color": c.color or "",
                    "is_smart": c.is_smart,
                    "smart_filter": c.smart_filter if c.is_smart else {},
                    "memo_count": getattr(c, "memo_count", 0),
                })
            return {"success": True, "collections": items, "count": len(items)}
        except Exception as e:
            if _is_service_error(e):
                logger.warning("tabmemo.list_collections business error: %s", e)
            else:
                logger.exception("tabmemo.list_collections failed")
            return _service_err_response(e)


class TabmemoAddToCollectionTool(BaseTool):
    name: str = "tabmemo_add_to_collection"
    description: str = (
        "将一条或多条碎片笔记添加到指定集合中。"
        "已在集合中的碎片会被自动跳过，不会重复添加。"
    )
    args_schema: type = AddToCollectionInput
    app_id: str = "tabmemo"
    risk_level: str = "review"
    required_permissions: list[str] = ["tabmemo"]
    available_modes: tuple = ("agent",)

    def run(
        self,
        collection_id: str,
        memo_ids: list[str] | None = None,
        user_id: str | None = None,
        space_id: str | None = None,
    ) -> dict:
        user = _load_user(user_id)
        if not user:
            return _err_user_not_found()
        if not memo_ids:
            return _err_memo_ids_required()
        if err := _check_uuids(collection_id=collection_id):
            return err

        # skip-invalid: 过滤掉非法 UUID，而非 fail-fast
        valid_ids = [mid for mid in memo_ids if _is_valid_uuid(mid)]
        skipped = len(memo_ids) - len(valid_ids)
        if not valid_ids:
            return {"success": True, "collection_id": collection_id, "added": 0, "skipped": skipped}

        try:
            svc = _make_svc(user, space_id)
            added = svc.add_memos_to_collection(collection_id, valid_ids)
            return {"success": True, "collection_id": collection_id, "added": added, "skipped": skipped}
        except Exception as e:
            if _is_service_error(e):
                logger.warning("tabmemo.add_to_collection business error: %s", e)
            else:
                logger.exception("tabmemo.add_to_collection failed")
            return _service_err_response(e)


class TabmemoRemoveFromCollectionTool(BaseTool):
    name: str = "tabmemo_remove_from_collection"
    description: str = (
        "将一条或多条碎片笔记从指定集合中移除。碎片本身不会被删除，仅解除与集合的关联。"
    )
    args_schema: type = RemoveFromCollectionInput
    app_id: str = "tabmemo"
    risk_level: str = "review"
    required_permissions: list[str] = ["tabmemo"]
    available_modes: tuple = ("agent",)

    def run(
        self,
        collection_id: str,
        memo_ids: list[str] | None = None,
        user_id: str | None = None,
        space_id: str | None = None,
    ) -> dict:
        user = _load_user(user_id)
        if not user:
            return _err_user_not_found()
        if not memo_ids:
            return _err_memo_ids_required()
        if err := _check_uuids(collection_id=collection_id):
            return err
        for mid in memo_ids:
            if err := _check_uuids(memo_id=mid):
                return err

        try:
            svc = _make_svc(user, space_id)
            removed = 0
            for mid in memo_ids:
                try:
                    svc.remove_memo_from_collection(collection_id, mid)
                    removed += 1
                except Exception:
                    logger.warning("tabmemo.remove_from_collection failed for memo %s", mid)
            return {
                "success": True,
                "collection_id": collection_id,
                "removed": removed,
            }
        except Exception as e:
            if _is_service_error(e):
                logger.warning("tabmemo.remove_from_collection business error: %s", e)
            else:
                logger.exception("tabmemo.remove_from_collection failed")
            return _service_err_response(e)


class TabmemoCreateCollectionTool(BaseTool):
    name: str = "tabmemo_create_collection"
    description: str = (
        "创建一个碎片集合。支持创建普通集合和智能集合。"
        "智能集合通过 smart_filter 自动匹配符合条件的碎片。"
    )
    args_schema: type = CreateCollectionInput
    app_id: str = "tabmemo"
    risk_level: str = "review"
    required_permissions: list[str] = ["tabmemo"]
    available_modes: tuple = ("agent",)

    def run(
        self,
        title: str,
        user_id: str | None = None,
        organization_id: str | None = None,
        space_id: str | None = None,
        description: str = "",
        icon: str = "",
        color: str = "",
        is_smart: bool = False,
        smart_filter: dict | None = None,
    ) -> dict:
        user = _load_user(user_id)
        if not user:
            return _err_user_not_found()
        if not organization_id or not space_id:
            return _err_organization_space_required()

        try:
            svc = _make_svc(user, space_id)
            coll = svc.create_collection(
                organization_id=organization_id,
                space_id=space_id,
                title=title,
                description=description,
                icon=icon,
                color=color,
                is_smart=is_smart,
                smart_filter=smart_filter,
            )
            return {
                "success": True,
                "collection_id": str(coll.id),
                "title": coll.title,
                "description": coll.description or "",
                "icon": coll.icon or "",
                "color": coll.color or "",
                "is_smart": coll.is_smart,
                "smart_filter": coll.smart_filter if coll.is_smart else {},
            }
        except Exception as e:
            if _is_service_error(e):
                logger.warning("tabmemo.create_collection business error: %s", e)
            else:
                logger.exception("tabmemo.create_collection failed")
            return _service_err_response(e)


class TabmemoUpdateCollectionTool(BaseTool):
    name: str = "tabmemo_update_collection"
    description: str = (
        "修改碎片集合的名称、描述、图标、颜色等属性。"
        "也可将普通集合转为智能集合或反之。"
    )
    args_schema: type = UpdateCollectionInput
    app_id: str = "tabmemo"
    risk_level: str = "review"
    required_permissions: list[str] = ["tabmemo"]
    available_modes: tuple = ("agent",)

    def run(
        self,
        collection_id: str,
        user_id: str | None = None,
        space_id: str | None = None,
        title: str | None = None,
        description: str | None = None,
        icon: str | None = None,
        color: str | None = None,
        is_smart: bool | None = None,
        smart_filter: dict | None = None,
    ) -> dict:
        user = _load_user(user_id)
        if not user:
            return _err_user_not_found()
        if err := _check_uuids(collection_id=collection_id):
            return err

        try:
            svc = _make_svc(user, space_id)
            kwargs: dict[str, Any] = {"collection_id": collection_id}
            if title is not None:
                kwargs["title"] = title
            if description is not None:
                kwargs["description"] = description
            if icon is not None:
                kwargs["icon"] = icon
            if color is not None:
                kwargs["color"] = color
            if is_smart is not None:
                kwargs["is_smart"] = is_smart
            if smart_filter is not None:
                kwargs["smart_filter"] = smart_filter

            coll = svc.update_collection(**kwargs)
            return {
                "success": True,
                "collection_id": str(coll.id),
                "title": coll.title,
                "description": coll.description or "",
                "icon": coll.icon or "",
                "color": coll.color or "",
                "is_smart": coll.is_smart,
                "smart_filter": coll.smart_filter if coll.is_smart else {},
            }
        except Exception as e:
            if _is_service_error(e):
                logger.warning("tabmemo.update_collection business error: %s", e)
            else:
                logger.exception("tabmemo.update_collection failed")
            return _service_err_response(e)


class TabmemoDeleteCollectionTool(BaseTool):
    name: str = "tabmemo_delete_collection"
    description: str = (
        "删除一个碎片集合。集合内的碎片不会被删除，仅解除与集合的关联。"
    )
    args_schema: type = DeleteCollectionInput
    app_id: str = "tabmemo"
    risk_level: str = "review"
    required_permissions: list[str] = ["tabmemo"]
    available_modes: tuple = ("agent",)

    def run(
        self,
        collection_id: str,
        user_id: str | None = None,
        space_id: str | None = None,
    ) -> dict:
        user = _load_user(user_id)
        if not user:
            return _err_user_not_found()
        if err := _check_uuids(collection_id=collection_id):
            return err

        try:
            svc = _make_svc(user, space_id)
            svc.delete_collection(collection_id)
            return {"success": True, "collection_id": collection_id}
        except Exception as e:
            if _is_service_error(e):
                logger.warning("tabmemo.delete_collection business error: %s", e)
            else:
                logger.exception("tabmemo.delete_collection failed")
            return _service_err_response(e)


class TabmemoBatchOperateTool(BaseTool):
    category: str = "data_mutation"
    name: str = "tabmemo_batch_operate"
    description: str = (
        "批量操作碎片笔记。支持批量归档、移入回收站、恢复归档、置顶、取消置顶、打标签、移入集合。"
    )
    args_schema: type = BatchOperateInput
    app_id: str = "tabmemo"
    risk_level: str = "review"
    required_permissions: list[str] = ["tabmemo"]
    available_modes: tuple = ("agent",)

    def run(
        self,
        memo_ids: list[str],
        action: str,
        user_id: str | None = None,
        organization_id: str | None = None,
        space_id: str | None = None,
        tags: list[str] | None = None,
        collection_id: str = "",
    ) -> dict:
        user = _load_user(user_id)
        if not user:
            return _err_user_not_found()
        if not organization_id or not space_id:
            return _err_organization_space_required()
        if not memo_ids:
            return _err_memo_ids_required()
        for mid in memo_ids:
            if err := _check_uuids(memo_id=mid):
                return err
        if collection_id:
            if err := _check_uuids(collection_id=collection_id):
                return err

        try:
            svc = _make_svc(user, space_id)

            # trash/restore/pin/unpin 由工具层逐条调用 Service 方法
            if action in ("trash", "restore", "pin", "unpin"):
                affected = 0
                for mid in memo_ids:
                    try:
                        if action == "trash":
                            svc.trash_memo(mid)
                        elif action == "restore":
                            svc.restore_memo(mid)
                        elif action == "pin":
                            svc.pin_memo(mid, pinned=True)
                        elif action == "unpin":
                            svc.pin_memo(mid, pinned=False)
                        affected += 1
                    except Exception:
                        logger.warning("tabmemo.batch_operate %s failed for %s", action, mid)
                return {"success": True, "action": action, "affected": affected}

            result = svc.batch_operate_memos(
                organization_id=organization_id,
                space_id=space_id,
                memo_ids=memo_ids,
                action=action,
                tags=tags,
                collection_id=collection_id or None,
            )
            return {"success": True, **result}
        except Exception as e:
            if _is_service_error(e):
                logger.warning("tabmemo.batch_operate business error: %s", e)
            else:
                logger.exception("tabmemo.batch_operate failed")
            return _service_err_response(e)


class TabmemoListAttachmentsTool(BaseTool):
    name: str = "tabmemo_list_attachments"
    description: str = (
        "列出指定碎片笔记的所有附件信息（文件名、类型、大小等）。"
    )
    args_schema: type = ListAttachmentsInput
    app_id: str = "tabmemo"
    risk_level: str = "safe"
    required_permissions: list[str] = ["tabmemo"]
    cacheable: bool = True
    cache_ttl: int = 30

    def run(
        self,
        memo_id: str,
        user_id: str | None = None,
        space_id: str | None = None,
    ) -> dict:
        user = _load_user(user_id)
        if not user:
            return _err_user_not_found()
        if err := _check_uuids(memo_id=memo_id):
            return err

        try:
            svc = _make_svc(user, space_id)
            memo = svc.get_memo_detail(memo_id)
            attachments = []
            for att in memo.attachments.all():
                attachments.append({
                    "id": str(att.id),
                    "file_name": att.file_name,
                    "file_type": att.file_type,
                    "file_size": att.file_size,
                    "mime_type": att.mime_type or "",
                    "file_url": att.file_url,
                    "thumbnail_url": att.thumbnail_url or "",
                    "created_at": att.created_at.isoformat(),
                })
            return {"success": True, "attachments": attachments, "count": len(attachments)}
        except Exception as e:
            if _is_service_error(e):
                logger.warning("tabmemo.list_attachments business error: %s", e)
            else:
                logger.exception("tabmemo.list_attachments failed")
            return _service_err_response(e)


class TabmemoListGrantsTool(BaseTool):
    name: str = "tabmemo_list_grants"
    description: str = (
        "列出当前 Space 被授权访问的碎片笔记 Grant 列表。"
        "每条 Grant 描述了一个 Memo 或 Collection 对当前 Space 的访问授权。"
    )
    args_schema: type = ListGrantsInput
    app_id: str = "tabmemo"
    risk_level: str = "safe"
    required_permissions: list[str] = ["tabmemo"]
    cacheable: bool = True
    cache_ttl: int = 10

    def run(
        self,
        user_id: str | None = None,
        organization_id: str | None = None,
        space_id: str | None = None,
        limit: int = 20,
        offset: int = 0,
    ) -> dict:
        user = _load_user(user_id)
        if not user:
            return _err_user_not_found()
        if not organization_id or not space_id:
            return _err_organization_space_required()

        try:
            svc = _make_svc(user, space_id)
            result = svc.list_received_grants(
                organization_id=organization_id,
                target_space_id=space_id,
                limit=limit,
                offset=offset,
            )
            page = result["items"]
            total = result["total"]
            items = []
            for g in page:
                items.append({
                    "id": str(g.id),
                    "type": "memo" if g.memo_id else "collection",
                    "target_id": str(g.memo_id or g.collection_id),
                    "target_title": (
                        g.memo.get_context_title() if g.memo_id and g.memo else
                        (g.collection.title if g.collection_id and g.collection else "")
                    ),
                    "permission": g.permission,
                    "granted_by": str(g.granted_by),
                    "created_at": g.created_at.isoformat(),
                })
            return {
                "success": True,
                "grants": items,
                "count": len(items),
                "total": total,
                "has_more": offset + len(items) < total,
            }
        except Exception as e:
            if _is_service_error(e):
                logger.warning("tabmemo.list_grants business error: %s", e)
            else:
                logger.exception("tabmemo.list_grants failed")
            return _service_err_response(e)


class TabmemoManageGrantTool(BaseTool):
    name: str = "tabmemo_manage_grant"
    description: str = (
        "管理碎片笔记的 Agent 访问授权。"
        "支持两种操作：create（为指定 Space 创建 Memo/Collection 的访问授权）"
        "和 delete（撤销一条已有的授权）。"
    )
    args_schema: type = ManageGrantInput
    app_id: str = "tabmemo"
    risk_level: str = "review"
    required_permissions: list[str] = ["tabmemo"]
    available_modes: tuple = ("agent",)

    def run(
        self,
        action: str,
        user_id: str | None = None,
        organization_id: str | None = None,
        space_id: str | None = None,
        target_space_id: str = "",
        memo_ids: list[str] | None = None,
        collection_ids: list[str] | None = None,
        permission: str = "read",
        grant_id: str = "",
    ) -> dict:
        user = _load_user(user_id)
        if not user:
            return _err_user_not_found()
        if not organization_id or not space_id:
            return _err_organization_space_required()

        try:
            svc = _make_svc(user, space_id)

            if action == "create":
                if not target_space_id:
                    return _err_missing_param(
                        _("memo_tools.target_space_required"),
                        param="target_space_id",
                    )
                if err := _check_uuids(target_space_id=target_space_id):
                    return err
                for mid in (memo_ids or []):
                    if err := _check_uuids(memo_id=mid):
                        return err
                for cid in (collection_ids or []):
                    if err := _check_uuids(collection_id=cid):
                        return err
                if not memo_ids and not collection_ids:
                    return _err_missing_param(
                        _("memo_tools.grant_target_required"),
                        param="memo_id or collection_id",
                    )

                grants = svc.create_grants(
                    organization_id=organization_id,
                    target_space_id=target_space_id,
                    memo_ids=memo_ids or None,
                    collection_ids=collection_ids or None,
                    permission=permission,
                )
                return {
                    "success": True,
                    "action": "create",
                    "created_count": len(grants),
                    "grants": [
                        {
                            "id": str(g.id),
                            "type": "memo" if g.memo_id else "collection",
                            "target_id": str(g.memo_id or g.collection_id),
                            "permission": g.permission,
                        }
                        for g in grants
                    ],
                }

            elif action == "delete":
                if not grant_id:
                    return _err_missing_param(
                        _("memo_tools.grant_id_required"),
                        param="grant_id",
                    )
                if err := _check_uuids(grant_id=grant_id):
                    return err
                svc.delete_grant(grant_id)
                return {"success": True, "action": "delete", "grant_id": grant_id}

            else:
                return _err_invalid_param(
                    _("memo_tools.invalid_grant_action"),
                    param="action",
                )

        except Exception as e:
            if _is_service_error(e):
                logger.warning("tabmemo.manage_grant business error: %s", e)
            else:
                logger.exception("tabmemo.manage_grant failed")
            return _service_err_response(e)


# ─── Provider Function ─────────────────────────────────────


def get_tabmemo_tools() -> list[BaseTool]:
    return [
        TabmemoCreateMemoTool(),
        TabmemoSearchMemosTool(),
        TabmemoGetMemoTool(),
        TabmemoUpdateMemoTool(),
        TabmemoArchiveMemoTool(),
        TabmemoRestoreMemoTool(),
        TabmemoRestoreFromTrashTool(),
        TabmemoListCollectionsTool(),
        TabmemoCreateCollectionTool(),
        TabmemoUpdateCollectionTool(),
        TabmemoDeleteCollectionTool(),
        TabmemoAddToCollectionTool(),
        TabmemoRemoveFromCollectionTool(),
        TabmemoBatchOperateTool(),
        TabmemoListAttachmentsTool(),
        TabmemoListGrantsTool(),
        TabmemoManageGrantTool(),
    ]
