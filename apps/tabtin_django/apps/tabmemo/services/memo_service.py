"""
TabMemo 碎片笔记核心业务服务

职责:
  - Memo CRUD + 权限校验
  - MemoCollection 管理
  - 全文搜索向量维护
  - ResourceBridge 桥接（ContextItem 自动同步）
"""

from __future__ import annotations
from apps.tabtinspace.services.organization_control_guard import (
    assert_organization_resource_write_allowed_optional,
)

import logging
import re
import uuid as _uuid
from functools import reduce
from operator import and_ as op_and, or_ as op_or
from typing import Any, Dict, List, Optional

# Sentinel 值：区分「调用方未传参」和「调用方显式传 None」
_UNSET = object()

from django.db import DatabaseError, connections, transaction
from django.db.models import Count, Q

from apps.i18n import _
from apps.tabtinspace.services.base import BaseService, ServiceError, ensure_space_in_organization
from apps.tabtinspace.services.resource_bridge import ResourceBridge
from apps.tabmemo.constants import (
    ALLOWED_SORT_FIELDS,
    DEFAULT_PAGE_SIZE,
    DEFAULT_SORT,
    MAX_ATTACHMENT_COUNT,
    MAX_PAGE_SIZE,
    SEARCH_VECTOR_MAX_LEN,
    TABMEMO_DB,
)
from apps.tabmemo.error_codes import ErrorCode
from apps.tabmemo.models import (
    Memo,
    MemoAttachment,
    MemoCollection,
    MemoCollectionMembership,
)

logger = logging.getLogger(__name__)

from apps.services.common.unicode_security import sanitize_text_for_storage as _sanitize_text

POSTGRES_LOCK_NOT_AVAILABLE = "55P03"


def _is_nowait_lock_error(exc: DatabaseError) -> bool:
    """Return True when PostgreSQL reports a nowait row-lock miss."""
    cause = exc.__cause__
    pgcode = getattr(cause, "pgcode", None) or getattr(cause, "sqlstate", None)
    if pgcode == POSTGRES_LOCK_NOT_AVAILABLE:
        return True
    message = str(exc).lower()
    return "could not obtain lock" in message or "lock not available" in message


def _apply_update_memo_db_timeouts() -> None:
    """Tighten statement/lock timeouts for the current update_memo transaction only."""
    conn = connections[TABMEMO_DB]
    if conn.vendor != "postgresql":
        return
    with conn.cursor() as cursor:
        # 持锁保存不应无限挂起；超时后释放事务，避免拖死 ASGI worker 线程。
        cursor.execute("SET LOCAL statement_timeout = %s", ["15s"])
        cursor.execute("SET LOCAL lock_timeout = %s", ["3s"])


def _is_valid_uuid(value: str) -> bool:
    try:
        _uuid.UUID(value)
        return True
    except (TypeError, ValueError):
        return False


class MemoService(BaseService):
    """
    TabMemo 核心业务服务。
    继承 BaseService 获得 organization / space 级权限检查能力。
    """

    def __init__(self, user=None, requesting_space_id: Optional[str] = None):
        super().__init__(user=user)
        # Agent 场景下传入当前 Space ID，用于 Grant 权限路径
        self.requesting_space_id = requesting_space_id

    # ── 内部工具 ──

    def _check_memo_access(self, memo: Memo, required_role: str = "viewer") -> None:
        """Memo 访问权限检查：owner → organization admin → space member → Grant。

        设计意图：owner（created_by / owner_id）拥有完整权限，无论 required_role 值如何
        均直接放行。required_role 仅在 space 级权限回退路径中生效（非 owner 用户
        通过 space 权限体系获得受限访问时，才区分 viewer/editor 等角色）。
        Grant 路径：当 requesting_space_id 已设置时，检查 MemoAgentGrant 是否对该
        Space 授权了对应权限（read/write）。
        """
        user_id = str(self.user.id) if self.user else None
        # BI-7: 统一使用 created_by_id 进行所有权检查，owner_id 作为兼容回退
        if user_id and memo.created_by_id and str(memo.created_by_id) == user_id:
            return
        if user_id and memo.owner_id and str(memo.owner_id) == user_id:
            return
        # organization admin 通过
        if self.check_organization_permission(str(memo.organization_id), "admin"):
            return
        # 如果 memo 绑定了 space，检查 space 权限（向下兼容）
        if memo.space_id and self.check_space_permission(str(memo.space_id), required_role):
            return
        # Grant 路径：检查 MemoAgentGrant 是否授权了当前 requesting_space_id
        if self.requesting_space_id and self._check_memo_grant(
            memo, self.requesting_space_id, required_role
        ):
            return
        raise ServiceError(ErrorCode.PERMISSION_DENIED, _("auth.insufficient_permissions"), status=403)

    def _check_memo_grant(
        self, memo: Memo, space_id: str, required_role: str
    ) -> bool:
        """检查 memo 是否通过 MemoAgentGrant 授权给指定 space。

        read 操作（required_role=viewer）：permission in [read, write] 均可；
        write 操作（required_role=editor 等）：仅 permission=write 可通过。
        同时检查直接授权和通过 collection 的间接授权。
        """
        from apps.tabmemo.models import MemoAgentGrant

        perm_values = (
            ["write"] if required_role != "viewer" else ["read", "write"]
        )

        # 直接授权
        if MemoAgentGrant.objects.using(TABMEMO_DB).filter(
            memo_id=memo.id,
            target_space_id=space_id,
            permission__in=perm_values,
        ).exists():
            return True

        # 间接授权：memo 所属 collection 被授权
        coll_ids = list(
            MemoCollectionMembership.objects.using(TABMEMO_DB).filter(memo=memo).values_list(
                "collection_id", flat=True
            )
        )
        if coll_ids and MemoAgentGrant.objects.using(TABMEMO_DB).filter(
            collection_id__in=coll_ids,
            target_space_id=space_id,
            permission__in=perm_values,
        ).exists():
            return True

        return False

    def _check_collection_access(self, coll: MemoCollection, required_role: str = "viewer") -> None:
        """Collection 访问权限检查：owner → organization admin → space member → Grant"""
        user_id = str(self.user.id) if self.user else None
        # owner 直接通过（created_by）
        if user_id and coll.created_by_id and str(coll.created_by_id) == user_id:
            return
        # organization admin 通过
        if self.check_organization_permission(str(coll.organization_id), "admin"):
            return
        # 如果 collection 绑定了 space，检查 space 权限（向下兼容）
        if coll.space_id and self.check_space_permission(str(coll.space_id), required_role):
            return
        # Grant 路径：检查 MemoAgentGrant 是否授权了当前 requesting_space_id
        if self.requesting_space_id and self._check_collection_grant(
            coll, self.requesting_space_id, required_role
        ):
            return
        raise ServiceError(ErrorCode.PERMISSION_DENIED, _("auth.insufficient_permissions"), status=403)

    def _check_collection_grant(
        self, coll: MemoCollection, space_id: str, required_role: str
    ) -> bool:
        """检查 collection 是否通过 MemoAgentGrant 授权给指定 space。"""
        from apps.tabmemo.models import MemoAgentGrant

        perm_values = (
            ["write"] if required_role != "viewer" else ["read", "write"]
        )
        return MemoAgentGrant.objects.using(TABMEMO_DB).filter(
            collection_id=coll.id,
            target_space_id=space_id,
            permission__in=perm_values,
        ).exists()

    def _get_memo(
        self,
        memo_id: str,
        required_role: str = "viewer",
        *,
        for_update: bool = False,
        for_update_nowait: bool = False,
    ) -> Memo:
        try:
            qs = Memo.objects.using(TABMEMO_DB)
            if for_update:
                qs = qs.select_for_update(nowait=for_update_nowait)
            memo = qs.get(id=memo_id, status=Memo.Status.ACTIVE)
        except Memo.DoesNotExist:
            raise ServiceError(ErrorCode.MEMO_NOT_FOUND, _("tabmemo.memo_not_found"), status=404)
        self._check_memo_access(memo, required_role)
        return memo

    def _get_memo_any_status(self, memo_id: str, required_role: str = "viewer") -> Memo:
        """获取任意状态的碎片（包括 trashed/archived），用于回收站操作"""
        try:
            memo = Memo.objects.using(TABMEMO_DB).get(id=memo_id)
        except Memo.DoesNotExist:
            raise ServiceError(ErrorCode.MEMO_NOT_FOUND, _("tabmemo.memo_not_found"), status=404)
        self._check_memo_access(memo, required_role)
        return memo

    def _get_collection(
        self, collection_id: str, required_role: str = "viewer"
    ) -> MemoCollection:
        try:
            coll = (
                MemoCollection.objects.using(TABMEMO_DB)
                .exclude(status=MemoCollection.Status.TRASHED)
                .get(id=collection_id)
            )
        except MemoCollection.DoesNotExist:
            raise ServiceError(
                ErrorCode.COLLECTION_NOT_FOUND, _("tabmemo.collection_not_found"), status=404
            )
        self._check_collection_access(coll, required_role)
        return coll

    def _extract_plaintext(self, content_json: dict) -> str:
        """从 ProseMirror JSON 中提取纯文本。

        段落/块级节点之间用换行分隔，行内节点（text/hardBreak/mention）
        用空格拼接，避免 bold/italic 等 marks 文本被错误换行。
        """
        if not content_json:
            return ""
        block_parts: list[str] = []
        self._walk_pm_blocks(content_json, block_parts)
        return "\n".join(p for p in block_parts if p)

    # ── 块级节点类型（ProseMirror） ──
    _BLOCK_TYPES = frozenset({
        "paragraph", "heading", "blockquote", "codeBlock",
        "bulletList", "orderedList", "listItem", "taskList", "taskItem",
        "table", "tableRow", "tableCell", "tableHeader",
        "horizontalRule", "doc",
    })

    @staticmethod
    def _walk_pm_blocks(node: dict, block_parts: list[str], max_depth: int = 50) -> None:
        """递归遍历 ProseMirror JSON，按块级节点分段提取文本。"""
        if not isinstance(node, dict) or max_depth <= 0:
            return
        node_type = node.get("type", "")
        # 块级节点：收集其内部的行内文本作为一个段落
        if node_type in MemoService._BLOCK_TYPES or node_type == "doc":
            inline_parts: list[str] = []
            for child in node.get("content", []):
                MemoService._collect_inline(child, inline_parts, max_depth - 1)
            text = " ".join(inline_parts)
            if text.strip():
                block_parts.append(text.strip())
            # 继续递归子块（如 listItem 内嵌 paragraph）
            for child in node.get("content", []):
                if child.get("type", "") in MemoService._BLOCK_TYPES:
                    MemoService._walk_pm_blocks(child, block_parts, max_depth - 1)
            return
        # image 节点：提取 alt 文本
        if node_type == "image":
            alt = (node.get("attrs") or {}).get("alt", "")
            if alt:
                block_parts.append(alt)
            return
        # 其他未知节点：递归其 content
        for child in node.get("content", []):
            MemoService._walk_pm_blocks(child, block_parts, max_depth - 1)

    @staticmethod
    def _collect_inline(node: dict, parts: list[str], max_depth: int = 50) -> None:
        """收集块级节点内部的行内文本片段。"""
        if not isinstance(node, dict) or max_depth <= 0:
            return
        node_type = node.get("type", "")
        if node_type == "text":
            text = node.get("text", "")
            if text:
                parts.append(text)
            return
        if node_type == "hardBreak":
            parts.append("\n")
            return
        if node_type == "mention":
            label = (node.get("attrs") or {}).get("label", "")
            if label:
                parts.append(label)
            return
        if node_type == "image":
            alt = (node.get("attrs") or {}).get("alt", "")
            if alt:
                parts.append(alt)
            return
        # 跳过嵌套块级节点（由 _walk_pm_blocks 处理）
        if node_type in MemoService._BLOCK_TYPES:
            return
        for child in node.get("content", []):
            MemoService._collect_inline(child, parts, max_depth - 1)

    def _update_search_vector(self, memo: Memo) -> None:
        """更新 Memo 的全文搜索向量（同步，仍持有行锁时慎用）。"""
        from apps.tabmemo.search import refresh_search_vector
        refresh_search_vector(memo)

    def _schedule_search_vector_refresh(self, memo_id) -> None:
        """提交后再刷 search_vector，缩短 update_memo 行锁持有时间。"""

        def _refresh() -> None:
            try:
                memo = Memo.objects.using(TABMEMO_DB).get(pk=memo_id)
                self._update_search_vector(memo)
            except Memo.DoesNotExist:
                return
            except Exception:
                logger.error(
                    "TabMemo deferred search_vector refresh failed: memo=%s",
                    memo_id,
                    exc_info=True,
                )

        transaction.on_commit(_refresh, using=TABMEMO_DB)

    def _notify_bridge(self, action: str, memo: Memo) -> None:
        """在 on_commit 中安全调用 ResourceBridge"""
        bridge_fn = {
            "created": ResourceBridge.on_create,
            "updated": ResourceBridge.on_update,
            "archived": ResourceBridge.on_archive,
            "trashed": ResourceBridge.on_trash,
            "restored": ResourceBridge.on_restore,
        }.get(action)
        if bridge_fn:
            user = self.user
            memo_id = getattr(memo, "id", None)

            def _safe_notify_bridge() -> None:
                try:
                    bridge_fn(memo, user=user)
                except Exception:
                    logger.error(
                        "TabMemo ResourceBridge %s failed after commit: memo=%s",
                        action,
                        memo_id,
                        exc_info=True,
                    )

            transaction.on_commit(
                _safe_notify_bridge, using=TABMEMO_DB
            )

    # ── Smart Filter ──

    @staticmethod
    def _build_smart_filter_q(smart_filter: Dict[str, Any]) -> Q:
        """将智能集合的 smart_filter JSON 编译为 Django Q 对象。"""
        match_mode = smart_filter.get("match_mode", "all")
        conditions: list[Q] = []

        if tags := smart_filter.get("tags"):
            if isinstance(tags, list) and tags:
                conditions.append(Q(tags__overlap=tags))

        if keywords := smart_filter.get("keywords"):
            if isinstance(keywords, list) and keywords:
                # BC-49: 优先使用 search_vector 全文检索，中文降级到 icontains
                _is_pg = connections[TABMEMO_DB].vendor == "postgresql"
                if _is_pg:
                    from django.contrib.postgres.search import SearchQuery
                    kw_q = reduce(
                        op_or,
                        (
                            Q(search_vector=SearchQuery(kw, config="simple"))
                            | Q(content_plaintext__icontains=kw)
                            for kw in keywords
                        ),
                    )
                else:
                    kw_q = reduce(
                        op_or, (Q(content_plaintext__icontains=kw) for kw in keywords)
                    )
                conditions.append(kw_q)

        if color := smart_filter.get("color"):
            if isinstance(color, str) and color:
                conditions.append(Q(color=color))

        if sources := smart_filter.get("source"):
            if isinstance(sources, list) and sources:
                conditions.append(Q(source__in=sources))

        if not conditions:
            # BI-2: 无有效条件时返回 Q() 匹配所有，而非零结果
            return Q()

        combiner = op_or if match_mode == "any" else op_and
        return reduce(combiner, conditions)

    # ── Memo CRUD ──

    @transaction.atomic(using=TABMEMO_DB)
    def create_memo(
        self,
        organization_id: str,
        space_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        content_json: Optional[Dict[str, Any]] = None,
        content_markdown: str = "",
        content_plaintext_override: str = "",
        tags: Optional[List[str]] = None,
        ai_tags: Optional[List[str]] = None,
        color: str = "",
        memo_type: str = "note",
        importance: Optional[int] = None,
        source: str = "manual",
        source_url: str = "",
        bookmark_url: str = "",
        collection_id: Optional[str] = None,
    ) -> Memo:
        # 创建操作需要 editor 权限（viewer 不应能创建内容）
        if not self.check_organization_permission(organization_id, "editor"):
            raise ServiceError(ErrorCode.PERMISSION_DENIED, _("auth.insufficient_permissions"), status=403)

        assert_organization_resource_write_allowed_optional(organization_id)

        if space_id:
            try:
                ensure_space_in_organization(organization_id, space_id)
            except ValueError as e:
                raise ServiceError("SPACE_ORGANIZATION_MISMATCH", str(e), status=404) from e

        content_json = content_json or {}
        plaintext = self._extract_plaintext(content_json)
        if not plaintext and content_markdown:
            plaintext = content_markdown
        if content_plaintext_override:
            plaintext = content_plaintext_override

        # FIX-S3-P1-12: sanitize text fields to prevent psycopg2 crashes
        content_markdown = _sanitize_text(content_markdown)
        plaintext = _sanitize_text(plaintext)
        source_url = _sanitize_text(source_url)
        bookmark_url = _sanitize_text(bookmark_url)
        if tags:
            tags = [_sanitize_text(t) for t in tags]

        # 校验 memo_type
        valid_types = {c[0] for c in Memo.MemoType.choices}
        if memo_type not in valid_types:
            memo_type = Memo.MemoType.NOTE
        if memo_type == Memo.MemoType.DIARY and not agent_id:
            raise ServiceError(
                ErrorCode.INVALID_INPUT,
                "diary 类型必须关联 agent_id",
                status=400,
            )
        if agent_id and not _is_valid_uuid(str(agent_id)):
            raise ServiceError(
                ErrorCode.INVALID_INPUT,
                "agent_id 格式非法",
                status=400,
            )

        # 校验 importance
        if importance is not None:
            importance = max(1, min(int(importance), 5))

        if ai_tags:
            ai_tags = [_sanitize_text(t) for t in ai_tags]

        memo = Memo.objects.using(TABMEMO_DB).create(
            organization_id=organization_id,
            space_id=space_id,
            agent_id=agent_id or None,
            owner_id=self.user.id if self.user else None,
            content_json=content_json,
            content_plaintext=plaintext,
            content_markdown=content_markdown,
            tags=tags or [],
            ai_tags=ai_tags or [],
            color=color,
            memo_type=memo_type,
            importance=importance,
            source=source,
            source_url=source_url,
            bookmark_url=bookmark_url,
            created_by=self.user,
            updated_by=self.user,
        )

        self._update_search_vector(memo)

        _warnings: list[str] = []
        if collection_id and _is_valid_uuid(collection_id):
            try:
                coll = MemoCollection.objects.using(TABMEMO_DB).get(
                    id=collection_id, organization_id=organization_id
                )
                if not coll.is_smart:
                    MemoCollectionMembership.objects.using(TABMEMO_DB).create(
                        memo=memo, collection=coll
                    )
            except MemoCollection.DoesNotExist:
                # BC-44: 不再静默忽略，返回警告信息
                _warnings.append(f"collection_id={collection_id} not found, memo created without collection")
                logger.warning("create_memo: collection %s not found, skipped", collection_id)

        self._notify_bridge("created", memo)
        self._schedule_auto_tag(memo)
        memo._warnings = _warnings  # type: ignore[attr-defined]
        return memo

    def _schedule_auto_tag(self, memo: Memo) -> None:
        """在事务提交后异步触发 AI 打标。空白内容跳过以避免无谓 LLM 调用。"""
        has_content = bool(
            (memo.content_plaintext and memo.content_plaintext.strip())
            or (memo.content_json and memo.content_json.get("content"))
        )
        if not has_content:
            return
        memo_id = str(memo.id)
        transaction.on_commit(
            lambda: self._dispatch_auto_tag(memo_id), using=TABMEMO_DB
        )

    @staticmethod
    def _dispatch_auto_tag(memo_id: str) -> None:
        try:
            from apps.tabmemo.tasks import auto_tag_memo
            auto_tag_memo.delay(memo_id)
        except Exception as exc:
            from apps.maintenance.celery_utils import is_broker_connection_error
            if not is_broker_connection_error(exc):
                logger.warning(
                    "Failed to dispatch auto_tag for memo %s",
                    memo_id,
                    exc_info=True,
                    extra={"alert": "tabmemo_dispatch_failed", "memo_id": memo_id},
                )

    @staticmethod
    def _dispatch_access_count_increment(memo_ids: List[str]) -> None:
        """agent 记忆召回命中后异步递增 access_count。

        access_count 恒为 0 会让 importance_adjust 把"创建早但近期仍被注入命中"
        的 memo 误归档。这里在 agent 召回命中后投递 increment_access_count_task，
        让归档判据 ``access_count == 0`` 能真正区分"未被使用"的记忆。

        与 _dispatch_auto_tag 同款 try/except + broker 错误兜底，检索主路径
        不被 Celery 投递失败拖累。
        """
        try:
            from apps.services.agent_engine.tasks.memory.access_count import (
                increment_access_count_task,
            )
            increment_access_count_task.delay(memo_ids)
        except Exception as exc:
            from apps.maintenance.celery_utils import is_broker_connection_error
            if not is_broker_connection_error(exc):
                logger.warning(
                    "Failed to dispatch increment_access_count for %d memos: %s",
                    len(memo_ids), exc,
                    exc_info=True,
                    extra={"alert": "tabmemo_access_count_dispatch_failed"},
                )

    def retag_memo(self, memo_id: str) -> None:
        """手动触发重新 AI 打标。"""
        memo = self._get_memo(memo_id, required_role="editor")
        from django.core.cache import cache
        from apps.tabmemo.tasks import auto_tag_lock_key
        cache_key = auto_tag_lock_key(str(memo.id))
        if cache.get(cache_key):
            logger.info("[retag] memo %s 已有 pending 任务，跳过重复派发", memo.id)
            return
        self._dispatch_auto_tag(str(memo.id))

    @transaction.atomic(using=TABMEMO_DB)
    def update_memo(
        self,
        memo_id: str,
        content_json: Optional[Dict[str, Any]] = None,
        content_markdown: Optional[str] = None,
        tags: Optional[List[str]] = None,
        color: Optional[str] = None,
        is_pinned: Optional[bool] = None,
        memo_type: Optional[str] = None,
        importance=_UNSET,
        bookmark_url: Optional[str] = None,
        bookmark_title: Optional[str] = None,
        bookmark_description: Optional[str] = None,
        bookmark_image: Optional[str] = None,
        source_url: Optional[str] = None,
    ) -> Memo:
        _apply_update_memo_db_timeouts()
        try:
            memo = self._get_memo(
                memo_id,
                required_role="editor",
                for_update=True,
                for_update_nowait=True,
            )
        except DatabaseError as exc:
            if not _is_nowait_lock_error(exc):
                raise
            # 行锁冲突 ≠ 乐观锁版本冲突；客户端应按 SAVE_BUSY 退避，勿当 VERSION_CONFLICT。
            raise ServiceError(
                ErrorCode.SAVE_BUSY,
                "这条笔记正在保存，请稍后重试",
                status=409,
            ) from exc
        update_fields: list[str] = ["updated_at", "updated_by"]

        # FIX-S3-P1-12: sanitize text fields (same as create_memo)
        if content_markdown is not None:
            content_markdown = _sanitize_text(content_markdown)
        if bookmark_url is not None:
            bookmark_url = _sanitize_text(bookmark_url)
        if bookmark_title is not None:
            bookmark_title = _sanitize_text(bookmark_title)
        if bookmark_description is not None:
            bookmark_description = _sanitize_text(bookmark_description)
        if source_url is not None:
            source_url = _sanitize_text(source_url)
        if tags is not None:
            tags = [_sanitize_text(t) for t in tags]

        # 校验 memo_type
        if memo_type is not None:
            valid_types = {c[0] for c in Memo.MemoType.choices}
            if memo_type not in valid_types:
                memo_type = None  # 非法值跳过更新

        # importance 支持三种语义：
        #   _UNSET (默认) / None → 不更新（向后兼容 API 层）
        #   0                    → 显式清除为 None
        #   1-5                  → 设置具体值
        if importance is not _UNSET and importance is not None:
            importance = int(importance)
            if importance == 0:
                setattr(memo, "importance", None)
            else:
                setattr(memo, "importance", max(1, min(importance, 5)))
            update_fields.append("importance")

        _SIMPLE_FIELDS = {
            "tags": tags,
            "color": color,
            "is_pinned": is_pinned,
            "memo_type": memo_type,
            "bookmark_url": bookmark_url,
            "bookmark_title": bookmark_title,
            "bookmark_description": bookmark_description,
            "bookmark_image": bookmark_image,
            "source_url": source_url,
        }
        for field_name, value in _SIMPLE_FIELDS.items():
            if value is not None:
                setattr(memo, field_name, value)
                update_fields.append(field_name)

        need_search_update = False
        if content_json is not None:
            memo.content_json = content_json
            memo.content_plaintext = self._extract_plaintext(content_json)
            update_fields.extend(["content_json", "content_plaintext"])
            need_search_update = True
        if content_markdown is not None:
            memo.content_markdown = content_markdown
            update_fields.append("content_markdown")
            if (content_json is None or not memo.content_plaintext) and content_markdown:
                memo.content_plaintext = content_markdown
                if "content_plaintext" not in update_fields:
                    update_fields.append("content_plaintext")
            need_search_update = True

        _SEARCH_FIELDS = {"tags", "ai_tags", "bookmark_title", "bookmark_description"}
        if not need_search_update and _SEARCH_FIELDS & set(update_fields):
            need_search_update = True

        memo.updated_by = self.user
        memo.save(update_fields=update_fields)

        if need_search_update:
            # 搜索向量 UPDATE 挪到 on_commit，避免与行锁叠在同一临界区里拉长持锁。
            self._schedule_search_vector_refresh(memo.id)

        # BC-51/BI-26: 内容实质性变更时重新触发 AI 打标
        _CONTENT_FIELDS = {"content_json", "content_plaintext", "content_markdown"}
        if _CONTENT_FIELDS & set(update_fields):
            self._schedule_auto_tag(memo)

        self._notify_bridge("updated", memo)
        return memo

    @transaction.atomic(using=TABMEMO_DB)
    def archive_memo(self, memo_id: str) -> None:
        memo = self._get_memo(memo_id, required_role="editor")
        memo.status = Memo.Status.ARCHIVED
        memo.is_pinned = False
        memo.updated_by = self.user
        memo.save(update_fields=["status", "is_pinned", "updated_by", "updated_at"])
        self._notify_bridge("archived", memo)

    @transaction.atomic(using=TABMEMO_DB)
    def trash_memo(self, memo_id: str) -> None:
        """将碎片移入回收站（支持 active 和 archived 状态的 memo）。

        ：源已 trashed 时幂等成功，仅补齐 ContextItem 投影。
        """
        memo = self._get_memo_any_status(memo_id, required_role="editor")
        if memo.status == Memo.Status.TRASHED:
            self._notify_bridge("trashed", memo)
            return
        memo.updated_by = self.user
        memo.trash(user_id=self.user.id if self.user else None, save=False)
        memo.save(update_fields=[
            "status", "trashed_at", "trashed_by", "previous_status",
            "updated_by", "updated_at",
        ])
        self._notify_bridge("trashed", memo)

        # XC-29: 移入回收站时 deactivate FileUsage，释放存储计量
        _memo_id = str(memo.id)
        _organization_id = str(memo.organization_id) if hasattr(memo, 'organization_id') else ''
        _user_id = str(self.user.id) if self.user else ''

        def _do_deactivate():
            try:
                from apps.services.oss.services.deactivate_utils import deactivate_file_usages_and_release_storage
                deactivate_file_usages_and_release_storage(
                    module='tabmemo',
                    context_filter={
                        'context_type': 'memo_attachment',
                        'context_id': _memo_id,
                    },
                    organization_id=_organization_id,
                    user_id=_user_id,
                    biz_type='tabmemo_trash_release',
                    biz_id=_memo_id,
                    log_prefix='[TabMemo Trash]',
                )
            except Exception as e:
                logger.error("trash_memo FileUsage deactivate 失败: memo=%s, %s", _memo_id, e, exc_info=True)

        transaction.on_commit(_do_deactivate, using=TABMEMO_DB)

    @transaction.atomic(using=TABMEMO_DB)
    def restore_memo_from_trash(self, memo_id: str) -> Memo:
        """从回收站恢复碎片"""
        try:
            memo = Memo.objects.using(TABMEMO_DB).get(id=memo_id, status=Memo.Status.TRASHED)
        except Memo.DoesNotExist:
            raise ServiceError(ErrorCode.MEMO_NOT_FOUND, _("tabmemo.memo_not_found_or_not_in_trash"), status=404)
        self._check_memo_access(memo, "editor")
        ResourceBridge.check_restore_quota(memo)
        memo.restore_from_trash()
        memo.updated_by = self.user
        memo.save(update_fields=[
            "status", "trashed_at", "trashed_by", "previous_status",
            "updated_by", "updated_at",
        ])
        self._notify_bridge("restored", memo)

        # XC-29: 恢复时 reactivate FileUsage，恢复存储计量
        _memo_id = str(memo.id)
        _organization_id = str(memo.organization_id) if hasattr(memo, 'organization_id') else ''
        _user_id = str(self.user.id) if self.user else ''

        def _do_reactivate():
            try:
                from apps.services.oss.services.reactivate_utils import reactivate_file_usages_and_restore_storage
                reactivate_file_usages_and_restore_storage(
                    module='tabmemo',
                    context_filter={
                        'context_type': 'memo_attachment',
                        'context_id': _memo_id,
                    },
                    organization_id=_organization_id,
                    user_id=_user_id,
                    biz_type='tabmemo_restore_storage',
                    biz_id=_memo_id,
                    log_prefix='[TabMemo Restore]',
                )
            except Exception as e:
                logger.error("restore_memo FileUsage reactivate 失败: memo=%s, %s", _memo_id, e, exc_info=True)

        transaction.on_commit(_do_reactivate, using=TABMEMO_DB)

        return memo

    @transaction.atomic(using=TABMEMO_DB)
    def permanent_delete_memo(self, memo_id: str) -> None:
        """永久删除碎片（仅限回收站中的碎片）"""
        memo = self._get_memo_any_status(memo_id, required_role="editor")
        if memo.status != Memo.Status.TRASHED:
            raise ServiceError(ErrorCode.INVALID_INPUT, _("tabmemo.only_delete_trashed"), status=400)

        user_id = getattr(self.user, "id", None)
        logger.debug(
            "[PermanentDelete] module=tabmemo resource=%s name=%r user=%s",
            memo.id, getattr(memo, "title", ""), user_id,
        )

        memo_repr = f"{type(memo).__name__}({memo.id})"
        _memo_id = str(memo.id)
        _organization_id = str(memo.organization_id) if hasattr(memo, 'organization_id') else ''
        _user_id = str(user_id) if user_id else ''
        user_ref = self.user
        memo.delete()

        def _bridge_cleanup():
            try:
                if not ResourceBridge.on_delete(memo, user=user_ref):
                    logger.warning(
                        "[PermanentDelete] ResourceBridge.on_delete 返回 False, "
                        "ContextItem 可能未清理: %s", memo_repr,
                    )
            except Exception:
                logger.exception(
                    "[PermanentDelete] ResourceBridge.on_delete 异常: %s", memo_repr,
                )

            # W4-F3: 兜底 deactivate memo 附件的 FileUsage（即使 trash 阶段已 deactivate，幂等安全）
            try:
                from apps.services.oss.services.deactivate_utils import deactivate_file_usages_and_release_storage
                deactivate_file_usages_and_release_storage(
                    module='tabmemo',
                    context_filter={
                        'context_type': 'memo_attachment',
                        'context_id': _memo_id,
                    },
                    organization_id=_organization_id,
                    user_id=_user_id,
                    biz_type='tabmemo_permanent_delete_release',
                    biz_id=_memo_id,
                    log_prefix='[TabMemo PermanentDelete]',
                )
            except Exception as e:
                logger.error(
                    "[PermanentDelete] FileUsage deactivate 失败: memo=%s, %s",
                    _memo_id, e, exc_info=True,
                )

        transaction.on_commit(_bridge_cleanup, using=TABMEMO_DB)

    @transaction.atomic(using=TABMEMO_DB)
    def restore_memo(self, memo_id: str) -> Memo:
        try:
            memo = Memo.objects.using(TABMEMO_DB).get(id=memo_id, status=Memo.Status.ARCHIVED)
        except Memo.DoesNotExist:
            raise ServiceError(ErrorCode.MEMO_NOT_FOUND, _("tabmemo.memo_not_found_or_not_archived"), status=404)
        self._check_memo_access(memo, "editor")
        memo.status = Memo.Status.ACTIVE
        memo.updated_by = self.user
        memo.save(update_fields=["status", "updated_by", "updated_at"])
        self._notify_bridge("restored", memo)
        return memo

    def get_memo_detail(self, memo_id: str, include_trashed: bool = False) -> Memo:
        allowed_statuses = [Memo.Status.ACTIVE, Memo.Status.ARCHIVED]
        if include_trashed:
            allowed_statuses.append(Memo.Status.TRASHED)
        try:
            memo = (
                Memo.objects.using(TABMEMO_DB)
                .prefetch_related("attachments", "collection_memberships__collection")
                .get(
                    id=memo_id,
                    status__in=allowed_statuses,
                )
            )
        except Memo.DoesNotExist:
            raise ServiceError(ErrorCode.MEMO_NOT_FOUND, _("tabmemo.memo_not_found"), status=404)
        self._check_memo_access(memo, "viewer")
        return memo

    @transaction.atomic(using=TABMEMO_DB)
    def pin_memo(self, memo_id: str, pinned: bool) -> Memo:
        memo = self._get_memo(memo_id, required_role="editor")
        memo.is_pinned = pinned
        memo.updated_by = self.user
        memo.save(update_fields=["is_pinned", "updated_by", "updated_at"])
        self._notify_bridge("updated", memo)
        return memo

    def list_memos(
        self,
        organization_id: str,
        space_id: Optional[str] = None,
        search: str = "",
        tags: Optional[List[str]] = None,
        ai_tags: Optional[List[str]] = None,
        color: str = "",
        memo_type: str = "",
        agent_id: Optional[str] = None,
        collection_id: str = "",
        status: str = "active",
        sort: str = DEFAULT_SORT,
        cursor: str = "",
        limit: int = DEFAULT_PAGE_SIZE,
        created_after: Optional[str] = None,
        created_before: Optional[str] = None,
        source: Optional[str] = None,
        for_recall: bool = False,
    ) -> dict:
        """
        列出 memo 记录。

        ``source`` 取值（W13c D7.1）：
          - ``None`` / 不传：保持现有语义（不按 source 过滤），向后兼容。
          - ``"agent"``：仅返回 ``Memo.source == "agent"`` 的记录，对齐
            ``utils.memory_constants.get_agent_memo_queryset`` 的 Agent 记忆视图，
            供本地 Runtime 的 ``memory_search`` 工具使用。
          - ``"user"``：返回所有非 Agent 来源的记录（manual/browser/share/api/voice）。
          - 其他枚举值（manual/browser/share/api/voice）：精确匹配单一来源。

        ``source`` 参数与隐私模型一致：Agent 写的 memo（source=agent）跟用户私人
        memo（source!=agent）严格隔离，两者分别归不同视图，确保 Agent 拿不到
        用户私人内容、用户 TabMemo 浏览界面也看不到 Agent 笔记。

        ``for_recall``：仅当为 True（Agent 真正的召回注入 /
        memory_search 工具）时命中 memo 才异步递增 access_count；用户在 UI 浏览
        （含 source="agent" 的"Agent 日记"视图）默认 False，不计数——避免浏览污染
        importance_adjust 的 access_count==0 归档信号。
        """
        # organization 级权限检查
        if not self.check_organization_permission(organization_id, "viewer"):
            raise ServiceError(ErrorCode.PERMISSION_DENIED, _("auth.insufficient_permissions"), status=403)

        user_id = str(self.user.id) if self.user else None
        qs = Memo.objects.using(TABMEMO_DB).filter(organization_id=organization_id)

        if space_id:
            # 校验用户是否为该 Space 的成员（防止任意 space_id 泄露数据）
            if not self.check_space_permission(space_id, "viewer"):
                raise ServiceError(ErrorCode.PERMISSION_DENIED, _("auth.insufficient_permissions"), status=403)
            # Agent 场景或向下兼容：仅返回该 space 的 memo + 通过 Grant 授权的
            qs = qs.filter(
                Q(space_id=space_id)
                | Q(id__in=self._get_granted_memo_ids(organization_id, space_id))
            )
        else:
            # 个人场景：仅返回自己创建的
            qs = qs.filter(
                Q(owner_id=user_id) | Q(created_by_id=user_id)
            )

        if status == "archived":
            _status_val = Memo.Status.ARCHIVED
        elif status == "trashed":
            _status_val = Memo.Status.TRASHED
        else:
            _status_val = Memo.Status.ACTIVE
        qs = qs.filter(status=_status_val)

        # W13c D7.1：source 过滤——Agent 与用户 memo 严格隔离。
        # 'agent' / 'user' 是聚合视图；其它枚举值精确匹配单一来源。
        # 此处直接用字符串字面量（与 ``Memo.Source.AGENT`` 的 value 同义），
        # 避免 service 在 mock 测试里因 Memo 整体被 patch 导致取到 MagicMock。
        if source:
            if source == "agent":
                qs = qs.filter(source="agent")
            elif source == "user":
                qs = qs.exclude(source="agent")
            else:
                qs = qs.filter(source=source)

        _search_rank_applied = False
        _search_uses_offset = False
        if search:
            _icontains_q = (
                Q(content_plaintext__icontains=search)
                | Q(content_markdown__icontains=search)
                | Q(bookmark_title__icontains=search)
            )
            _is_pg = connections[TABMEMO_DB].vendor == 'postgresql'
            _has_cjk = any("\u4e00" <= ch <= "\u9fff" or "\u3040" <= ch <= "\u30ff" or "\uac00" <= ch <= "\ud7af" for ch in search)
            if _is_pg and not _has_cjk:
                from django.contrib.postgres.search import SearchQuery, SearchRank
                search_query = SearchQuery(search, config="simple")
                qs = qs.filter(Q(search_vector=search_query) | _icontains_q)
                qs = qs.annotate(_search_rank=SearchRank("search_vector", search_query))
                _search_rank_applied = True
                _search_uses_offset = True
            else:
                qs = qs.filter(_icontains_q)

        # BC-22 / 移动端 Memo 首页：时间范围半开区间 [created_after, created_before)。
        # created_before 用 __lt（不是 __lte）——客户端传「次日本地零点」即可覆盖整天，
        # 避免闭区间 + 毫秒截断漏掉边界行，也避免客户端用「减一毫秒」规避精度问题。
        if created_after:
            qs = qs.filter(created_at__gte=created_after)
        if created_before:
            qs = qs.filter(created_at__lt=created_before)

        if tags:
            for tag in tags:
                qs = qs.filter(tags__contains=[tag])

        if ai_tags:
            for tag in ai_tags:
                qs = qs.filter(ai_tags__contains=[tag])

        if color:
            qs = qs.filter(color=color)

        if memo_type:
            valid_types = {c[0] for c in Memo.MemoType.choices}
            if ',' in memo_type:
                types = [t.strip() for t in memo_type.split(',') if t.strip() in valid_types]
                if types:
                    qs = qs.filter(memo_type__in=types)
            elif memo_type in valid_types:
                qs = qs.filter(memo_type=memo_type)

        if agent_id:
            # Agent 维度过滤仅作为显式查询条件。task_summary 仍是用户层小结，
            # 不在默认列表中因 agent_id 变成 Agent 私有记忆。
            qs = qs.filter(agent_id=agent_id)

        if collection_id:
            if not _is_valid_uuid(collection_id):
                raise ServiceError(
                    ErrorCode.INVALID_INPUT, _("tabmemo.invalid_collection_id"), status=400
                )
            try:
                coll = MemoCollection.objects.using(TABMEMO_DB).get(
                    id=collection_id, organization_id=organization_id
                )
            except MemoCollection.DoesNotExist:
                raise ServiceError(
                    ErrorCode.COLLECTION_NOT_FOUND, _("tabmemo.collection_not_found"), status=404
                )
            if coll.is_smart and coll.smart_filter:
                qs = qs.filter(self._build_smart_filter_q(coll.smart_filter))
            else:
                memo_ids = MemoCollectionMembership.objects.using(TABMEMO_DB).filter(
                    collection_id=collection_id
                ).values_list("memo_id", flat=True)
                qs = qs.filter(id__in=memo_ids)

        if sort not in ALLOWED_SORT_FIELDS:
            sort = DEFAULT_SORT

        if _search_rank_applied:
            # BC-21: 搜索结果优先按相关性排序
            qs = qs.order_by("-is_pinned", "-_search_rank", sort, "-id")
        else:
            qs = qs.order_by("-is_pinned", sort, "-id")

        qs = qs.annotate(attachment_count=Count("attachments"))

        if _search_uses_offset and cursor:
            # 搜索排序下 cursor 语义不稳定，改用 offset 分页
            try:
                _offset = int(cursor)
            except (TypeError, ValueError):
                _offset = 0
            qs = qs[_offset:]
        elif cursor:
            if not _is_valid_uuid(cursor):
                raise ServiceError(ErrorCode.INVALID_CURSOR, _("tabmemo.invalid_cursor"), status=400)
            # BC-17: 合并为一次查询，同时取 created_at 和 updated_at
            cursor_vals = (
                Memo.objects.using(TABMEMO_DB).filter(
                    id=cursor,
                    organization_id=organization_id,
                    status=_status_val,
                )
                .values_list("is_pinned", "created_at", "updated_at", "id")
                .first()
            )
            if cursor_vals:
                c_pinned, c_created, c_updated, c_id = cursor_vals
                descending = sort.startswith("-")
                sort_field = sort.lstrip("-")
                c_sort_val = c_updated if sort_field == "updated_at" else c_created

                if descending:
                    qs = qs.filter(
                        Q(is_pinned__lt=c_pinned)
                        | Q(
                            is_pinned=c_pinned,
                            **{f"{sort_field}__lt": c_sort_val},
                        )
                        | Q(
                            is_pinned=c_pinned,
                            **{sort_field: c_sort_val},
                            id__lt=c_id,
                        )
                    )
                else:
                    qs = qs.filter(
                        Q(is_pinned__lt=c_pinned)
                        | Q(
                            is_pinned=c_pinned,
                            **{f"{sort_field}__gt": c_sort_val},
                        )
                        | Q(
                            is_pinned=c_pinned,
                            **{sort_field: c_sort_val},
                            id__gt=c_id,
                        )
                    )

        limit = min(max(limit, 1), MAX_PAGE_SIZE)
        items = list(qs[:limit + 1])
        has_more = len(items) > limit
        if has_more:
            items = items[:limit]

        if _search_uses_offset:
            _current_offset = int(cursor) if cursor and cursor.isdigit() else 0
            next_cursor = str(_current_offset + limit) if has_more else ""
        else:
            next_cursor = str(items[-1].id) if items and has_more else ""

        # ：agent 召回命中后异步递增 access_count，避免"创建早但近期
        # 仍被注入/召回"的 memo 因 access_count==0 被 importance_adjust 误归档。
        # 只对**真正的 Agent 召回**（for_recall=True）+ active 状态计数。
        #
        # bugbot 复核：不能只看 source=="agent"——Electron TabMemo 的
        # "Agent 日记"视图（useTabMemoStore presetForView('agentDiary')）也传
        # source="agent" 走同一个 GET /tabmemo/memos/，用户仅浏览 UI 就会误增
        # access_count，污染 importance_adjust 的归档信号。用 for_recall 显式标记
        # 区分"Agent 召回注入/搜索"（memory-injector + memory_search 工具会传
        # for_recall=True）与"用户 UI 浏览"（不传，默认 False）。
        if for_recall and status == "active" and items:
            _hit_memo_ids = [str(m.id) for m in items]
            transaction.on_commit(
                lambda: self._dispatch_access_count_increment(_hit_memo_ids),
                using=TABMEMO_DB,
            )

        return {
            "items": items,
            "next_cursor": next_cursor,
            "has_more": has_more,
        }

    # ── Collection CRUD ──

    @transaction.atomic(using=TABMEMO_DB)
    def create_collection(
        self,
        organization_id: str,
        space_id: Optional[str] = None,
        title: str = "",
        description: str = "",
        icon: str = "",
        color: str = "",
        is_smart: bool = False,
        smart_filter: Optional[Dict[str, Any]] = None,
    ) -> MemoCollection:
        # 创建操作需要 editor 权限（viewer 不应能创建内容）
        if not self.check_organization_permission(organization_id, "editor"):
            raise ServiceError(ErrorCode.PERMISSION_DENIED, _("auth.insufficient_permissions"), status=403)

        coll = MemoCollection.objects.using(TABMEMO_DB).create(
            organization_id=organization_id,
            space_id=space_id,  # 可能为 None
            title=title,
            description=description,
            icon=icon,
            color=color,
            is_smart=is_smart,
            smart_filter=smart_filter or {},
            created_by=self.user,
        )
        user = self.user
        transaction.on_commit(
            lambda: ResourceBridge.on_create(coll, user=user), using=TABMEMO_DB
        )
        return coll

    def list_collections(
        self,
        organization_id: str,
        space_id: Optional[str] = None,  # BI-5: None 时操作个人集合
    ) -> list:
        """列出集合。返回的每个 MemoCollection 实例包含 smart_filter 字段（BI-6）。"""
        # organization 级权限检查
        if not self.check_organization_permission(organization_id, "viewer"):
            raise ServiceError(ErrorCode.PERMISSION_DENIED, _("auth.insufficient_permissions"), status=403)

        user_id = str(self.user.id) if self.user else None
        qs = MemoCollection.objects.using(TABMEMO_DB).filter(
            organization_id=organization_id,
            status=MemoCollection.Status.ACTIVE,
        )

        if space_id:
            # 校验用户是否为该 Space 的成员（防止任意 space_id 泄露数据）
            if not self.check_space_permission(space_id, "viewer"):
                raise ServiceError(ErrorCode.PERMISSION_DENIED, _("auth.insufficient_permissions"), status=403)
            # Agent 场景或向下兼容：返回该 space 的 collection + 授权的
            from apps.tabmemo.models import MemoAgentGrant
            granted_coll_ids = MemoAgentGrant.objects.using(TABMEMO_DB).filter(
                organization_id=organization_id,
                target_space_id=space_id,
                collection__isnull=False,
            ).values_list("collection_id", flat=True)
            qs = qs.filter(
                Q(space_id=space_id) | Q(id__in=granted_coll_ids)
            )
        else:
            # 个人场景：仅返回自己创建的
            qs = qs.filter(created_by_id=user_id)

        colls = list(
            qs.annotate(
                memo_count=Count(
                    "memo_memberships",
                    filter=Q(memo_memberships__memo__status=Memo.Status.ACTIVE),
                )
            )
            .order_by("sort_order", "created_at")
        )

        smart_colls = [c for c in colls if c.is_smart and c.smart_filter]
        if smart_colls:
            base_qs = Memo.objects.using(TABMEMO_DB).filter(
                organization_id=organization_id,
                status=Memo.Status.ACTIVE,
            )
            if space_id:
                # BI-24: 将 granted memo IDs 纳入计数范围
                granted_ids = self._get_granted_memo_ids(organization_id, space_id)
                base_qs = base_qs.filter(
                    Q(space_id=space_id) | Q(id__in=granted_ids)
                )
            else:
                # 个人场景：仅统计自己的 memo（BI-17: 复用 user_id）
                base_qs = base_qs.filter(
                    Q(owner_id=user_id) | Q(created_by_id=user_id)
                )
            # 合并所有智能集合的过滤条件为一次聚合查询
            aggregates = {}
            for i, coll in enumerate(smart_colls):
                q = self._build_smart_filter_q(coll.smart_filter)
                aggregates[f"sc_{i}"] = Count("id", filter=q)
            counts = base_qs.aggregate(**aggregates)
            for i, coll in enumerate(smart_colls):
                coll.memo_count = counts.get(f"sc_{i}", 0) or 0

        return colls

    @transaction.atomic(using=TABMEMO_DB)
    def update_collection(
        self,
        collection_id: str,
        title: Optional[str] = None,
        description: Optional[str] = None,
        icon: Optional[str] = None,
        color: Optional[str] = None,
        is_smart: Optional[bool] = None,
        smart_filter: Optional[Dict[str, Any]] = None,
    ) -> MemoCollection:
        coll = self._get_collection(collection_id, required_role="editor")

        _FIELDS = {
            "title": title,
            "description": description,
            "icon": icon,
            "color": color,
            "is_smart": is_smart,
            "smart_filter": smart_filter,
        }
        update_fields: list[str] = ["updated_at"]
        for field_name, value in _FIELDS.items():
            if value is not None:
                setattr(coll, field_name, value)
                update_fields.append(field_name)

        # BI-3: is_smart 从 True→False 时清空 smart_filter 残留数据
        if is_smart is False and coll.smart_filter:
            coll.smart_filter = {}
            if "smart_filter" not in update_fields:
                update_fields.append("smart_filter")

        coll.save(update_fields=update_fields)
        user = self.user
        transaction.on_commit(
            lambda: ResourceBridge.on_update(coll, user=user), using=TABMEMO_DB
        )
        return coll

    @transaction.atomic(using=TABMEMO_DB)
    def delete_collection(self, collection_id: str) -> None:
        coll = self._get_collection(collection_id, required_role="editor")
        user_id = str(self.user.id) if self.user else None
        coll.trash(user_id=user_id)

    def restore_collection(self, collection_id: str) -> MemoCollection:
        """从回收站恢复集合。"""
        try:
            coll = (
                MemoCollection.objects.using(TABMEMO_DB)
                .filter(status=MemoCollection.Status.TRASHED)
                .get(id=collection_id)
            )
        except MemoCollection.DoesNotExist:
            raise ServiceError(
                ErrorCode.COLLECTION_NOT_FOUND, _("tabmemo.collection_not_found"), status=404
            )
        self._check_collection_access(coll, required_role="editor")
        coll.restore_from_trash()
        return coll

    @transaction.atomic(using=TABMEMO_DB)
    def add_memos_to_collection(
        self, collection_id: str, memo_ids: List[str]
    ) -> int:
        coll = self._get_collection(collection_id, required_role="editor")
        if coll.is_smart:
            raise ServiceError(
                ErrorCode.SMART_COLLECTION_NO_MANUAL,
                _("tabmemo.smart_collection_no_manual_add"),
                status=400,
            )

        safe_ids = [m for m in memo_ids if _is_valid_uuid(str(m))]
        memo_q = Q(id__in=safe_ids, organization_id=coll.organization_id, status=Memo.Status.ACTIVE)
        if coll.space_id:
            memo_q &= Q(space_id=coll.space_id)
        valid_memo_ids = set(
            Memo.objects.using(TABMEMO_DB).filter(memo_q).values_list("id", flat=True)
        )

        existing = set(
            MemoCollectionMembership.objects.using(TABMEMO_DB).filter(
                collection=coll, memo_id__in=valid_memo_ids
            ).values_list("memo_id", flat=True)
        )

        to_create = [
            MemoCollectionMembership(memo_id=mid, collection=coll)
            for mid in valid_memo_ids
            if mid not in existing
        ]

        if to_create:
            MemoCollectionMembership.objects.using(TABMEMO_DB).bulk_create(
                to_create, ignore_conflicts=True
            )
        return len(to_create)

    @transaction.atomic(using=TABMEMO_DB)
    def remove_memo_from_collection(
        self, collection_id: str, memo_id: str
    ) -> None:
        coll = self._get_collection(collection_id, required_role="editor")
        if coll.is_smart:
            raise ServiceError(
                ErrorCode.SMART_COLLECTION_NO_MANUAL,
                _("tabmemo.smart_collection_no_manual_remove"),
                status=400,
            )
        MemoCollectionMembership.objects.using(TABMEMO_DB).filter(
            collection=coll, memo_id=memo_id
        ).delete()

    # ── Batch Operations ──

    @transaction.atomic(using=TABMEMO_DB)
    def batch_operate_memos(
        self,
        organization_id: str,
        space_id: Optional[str] = None,
        memo_ids: Optional[List[str]] = None,
        action: str = "",
        tags: Optional[List[str]] = None,
        collection_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """批量操作碎片：archive / trash / tag / move_to_collection。"""
        # 批量操作需要 editor 权限
        if not self.check_organization_permission(organization_id, "editor"):
            raise ServiceError(ErrorCode.PERMISSION_DENIED, _("auth.insufficient_permissions"), status=403)

        safe_ids = [mid for mid in (memo_ids or []) if _is_valid_uuid(mid)]
        # trash 操作也应包含 archived 状态的 memo
        allowed_statuses = [Memo.Status.ACTIVE]
        if action == "trash":
            allowed_statuses.append(Memo.Status.ARCHIVED)
        q = Q(id__in=safe_ids, organization_id=organization_id, status__in=allowed_statuses)
        if space_id:
            # 校验 space 成员权限
            if not self.check_space_permission(space_id, "editor"):
                raise ServiceError(ErrorCode.PERMISSION_DENIED, _("auth.insufficient_permissions"), status=403)
            # 包括该 space 自身的 memo + 通过 Grant 授权的 memo
            granted_ids = self._get_granted_memo_ids(organization_id, space_id, permission="write")
            q &= (Q(space_id=space_id) | Q(id__in=granted_ids))
        else:
            # 个人场景：仅允许操作自己的 memo
            user_id = str(self.user.id) if self.user else None
            q &= (Q(owner_id=user_id) | Q(created_by_id=user_id))
        memos = list(Memo.objects.using(TABMEMO_DB).filter(q))
        affected = 0

        if action == "archive":
            memo_pks = [m.id for m in memos]
            if memo_pks:
                affected = Memo.objects.using(TABMEMO_DB).filter(id__in=memo_pks).update(
                    status=Memo.Status.ARCHIVED,
                    is_pinned=False,
                    updated_by=self.user,
                )
                for memo in memos:
                    memo.status = Memo.Status.ARCHIVED
                    memo.is_pinned = False
                    self._notify_bridge("archived", memo)

        elif action == "tag":
            if not tags:
                raise ServiceError(ErrorCode.INVALID_INPUT, _("tabmemo.tags_required"), status=400)
            changed_memos: list[Memo] = []
            for memo in memos:
                existing = set(memo.tags or [])
                new_tags = set(tags) - existing
                if new_tags:
                    memo.tags = list(existing | new_tags)
                    memo.updated_by = self.user
                    changed_memos.append(memo)
            if changed_memos:
                from django.utils import timezone as _tz
                _now = _tz.now()
                for memo in changed_memos:
                    memo.updated_at = _now
                Memo.objects.using(TABMEMO_DB).bulk_update(
                    changed_memos, ["tags", "updated_by", "updated_at"],
                )
                for memo in changed_memos:
                    self._update_search_vector(memo)
                    self._notify_bridge("updated", memo)
            affected = len(changed_memos)

        elif action == "move_to_collection":
            if not collection_id or not _is_valid_uuid(collection_id):
                raise ServiceError(
                    ErrorCode.INVALID_INPUT, _("tabmemo.invalid_collection_id"), status=400
                )
            coll = self._get_collection(collection_id, required_role="editor")
            if coll.is_smart:
                raise ServiceError(
                    ErrorCode.SMART_COLLECTION_NO_MANUAL,
                    _("tabmemo.smart_collection_no_manual_add"),
                    status=400,
                )
            existing = set(
                MemoCollectionMembership.objects.using(TABMEMO_DB).filter(
                    collection=coll, memo_id__in=[m.id for m in memos]
                ).values_list("memo_id", flat=True)
            )
            to_create = [
                MemoCollectionMembership(memo_id=m.id, collection=coll)
                for m in memos
                if m.id not in existing
            ]
            if to_create:
                MemoCollectionMembership.objects.using(TABMEMO_DB).bulk_create(
                    to_create, ignore_conflicts=True
                )
            affected = len(to_create)

        elif action == "trash":
            memo_pks = [m.id for m in memos]
            if memo_pks:
                from django.utils import timezone
                now = timezone.now()
                user_id = self.user.id if self.user else None
                from django.db.models import Case, When, Value, CharField
                affected = Memo.objects.using(TABMEMO_DB).filter(id__in=memo_pks).update(
                    previous_status=Case(
                        *[When(id=m.id, then=Value(m.status)) for m in memos],
                        output_field=CharField(),
                    ),
                    status=Memo.Status.TRASHED,
                    trashed_at=now,
                    trashed_by=user_id,
                    updated_by=self.user,
                )
                for memo in memos:
                    memo.status = Memo.Status.TRASHED
                    self._notify_bridge("trashed", memo)

        else:
            raise ServiceError(
                ErrorCode.INVALID_INPUT,
                _("tabmemo.unsupported_action", action=action),
                status=400,
            )

        return {"action": action, "affected": affected}

    # ── Attachment ──

    @transaction.atomic(using=TABMEMO_DB)
    def add_attachment(
        self,
        memo_id: str,
        file_record_id: str,
        file_type: str = "",
        sort_order: int = 0,
    ) -> MemoAttachment:
        """将已上传的 OSS 文件关联为 memo 附件"""
        if not _is_valid_uuid(file_record_id):
            raise ServiceError(
                ErrorCode.INVALID_INPUT, _("tabmemo.invalid_file_record_id"), status=400
            )

        memo = self._get_memo(memo_id, required_role="editor")

        from apps.services.oss.models import FileRecord

        try:
            fr = FileRecord.objects.using("default").get(id=file_record_id)
        except FileRecord.DoesNotExist:
            raise ServiceError(ErrorCode.RESOURCE_NOT_FOUND, _("tabmemo.file_record_not_found"), status=404)

        if fr.status != "completed":
            raise ServiceError(
                ErrorCode.RESOURCE_NOT_FOUND, _("tabmemo.file_not_uploaded"), status=400
            )
        if not fr.access_url:
            raise ServiceError(
                ErrorCode.RESOURCE_NOT_FOUND, _("tabmemo.file_url_unavailable"), status=400
            )

        current_count = MemoAttachment.objects.using(TABMEMO_DB).filter(memo=memo).count()
        if current_count >= MAX_ATTACHMENT_COUNT:
            raise ServiceError(
                ErrorCode.ATTACHMENT_LIMIT_EXCEEDED,
                _("tabmemo.attachment_limit_exceeded", max_count=MAX_ATTACHMENT_COUNT),
                status=400,
            )

        if not file_type:
            file_type = self._infer_file_type(fr.mime_type or "")

        att = MemoAttachment.objects.using(TABMEMO_DB).create(
            memo=memo,
            file_type=file_type,
            file_url=fr.access_url,
            file_name=fr.file_name,
            file_size=fr.file_size,
            mime_type=fr.mime_type or "",
            thumbnail_url="",
            sort_order=sort_order,
        )

        # TMEMO-1: 注册 FileUsage（on_commit 以避免跨库事务不一致）
        _fr_id = str(fr.id)
        _memo_id = str(memo.id)
        _user_id = str(self.user.id) if self.user else ''

        def _do_register():
            try:
                from apps.services.oss.models import FileRecord, FileUsage
                rec = FileRecord.objects.filter(id=_fr_id, status='completed').first()
                if rec:
                    FileUsage.add_usage(
                        file_record=rec,
                        user_id=_user_id,
                        module='tabmemo',
                        context_type='memo_attachment',
                        context_id=_memo_id,
                    )
            except Exception as e:
                logger.error("TabMemo FileUsage 注册失败: memo=%s, file=%s, error=%s", _memo_id, _fr_id, e, exc_info=True)
        transaction.on_commit(_do_register, using=TABMEMO_DB)

        self._notify_bridge("updated", memo)
        return att

    @transaction.atomic(using=TABMEMO_DB)
    def delete_attachment(self, memo_id: str, attachment_id: str) -> None:
        """删除 memo 附件并释放 OSS 引用"""
        memo = self._get_memo(memo_id, required_role="editor")
        try:
            att = MemoAttachment.objects.using(TABMEMO_DB).get(id=attachment_id, memo=memo)
        except MemoAttachment.DoesNotExist:
            raise ServiceError(ErrorCode.RESOURCE_NOT_FOUND, _("tabmemo.attachment_not_found"), status=404)

        att_file_url = att.file_url
        att.delete()

        # TMEMO-1: deactivate 该附件对应的 FileUsage（在 ORM 删除后执行，避免回滚不一致）
        def _do_deactivate():
            try:
                from apps.services.oss.models import FileRecord
                from apps.services.oss.services.deactivate_utils import deactivate_file_usages_and_release_storage
                user_id = str(self.user.id) if self.user else ''
                organization_id = str(memo.organization_id) if hasattr(memo, 'organization_id') else ''
                fr = FileRecord.objects.filter(access_url=att_file_url, status='completed').first()
                if not fr:
                    return
                deactivate_file_usages_and_release_storage(
                    module='tabmemo',
                    context_filter={
                        'context_type': 'memo_attachment',
                        'context_id': str(memo.id),
                        'file_record_id': str(fr.id),
                    },
                    organization_id=organization_id,
                    user_id=user_id,
                    biz_type='memo_attachment_delete',
                    biz_id=str(attachment_id),
                    log_prefix='[TabMemo]',
                )
            except Exception as e:
                logger.error("TabMemo FileUsage deactivate 失败: memo=%s, att=%s, error=%s",
                             memo.id, attachment_id, e, exc_info=True)
        transaction.on_commit(_do_deactivate, using=TABMEMO_DB)
        self._notify_bridge("updated", memo)

    @staticmethod
    def _infer_file_type(mime_type: str) -> str:
        if mime_type.startswith("image/"):
            return "image"
        if mime_type.startswith("video/"):
            return "video"
        if mime_type.startswith("audio/"):
            return "audio"
        return "file"

    # ── Agent Grant ──

    def _get_granted_memo_ids(
        self, organization_id: str, space_id: str, permission: str = "read"
    ) -> list:
        """获取通过 MemoAgentGrant 授权给指定 space 的 memo IDs

        BI-12: 增加 permission 参数过滤，读操作传 'read'，写操作传 'write'。
        'read' 匹配 read 和 write 权限；'write' 仅匹配 write 权限。
        """
        from apps.tabmemo.models import MemoAgentGrant

        perm_q = Q(permission="write") if permission == "write" else Q(permission__in=["read", "write"])

        # 直接授权的 memo
        direct_ids = list(MemoAgentGrant.objects.using(TABMEMO_DB).filter(
            perm_q,
            organization_id=organization_id,
            target_space_id=space_id,
            memo__isnull=False,
        ).values_list("memo_id", flat=True))

        # 通过 collection 授权的 memo
        granted_coll_ids = MemoAgentGrant.objects.using(TABMEMO_DB).filter(
            perm_q,
            organization_id=organization_id,
            target_space_id=space_id,
            collection__isnull=False,
        ).values_list("collection_id", flat=True)

        coll_memo_ids = list(MemoCollectionMembership.objects.using(TABMEMO_DB).filter(
            collection_id__in=granted_coll_ids
        ).values_list("memo_id", flat=True))

        return list(set(direct_ids + coll_memo_ids))

    @transaction.atomic(using=TABMEMO_DB)
    def create_grants(
        self,
        organization_id: str,
        target_space_id: str,
        memo_ids: Optional[List[str]] = None,
        collection_ids: Optional[List[str]] = None,
        permission: str = "read",
    ) -> List:
        """为指定 Space 创建 Memo/Collection 访问授权"""
        from apps.tabmemo.models import MemoAgentGrant

        # 创建授权需要 editor 权限（viewer 不应能授权他人访问）
        if not self.check_organization_permission(organization_id, "editor"):
            raise ServiceError(ErrorCode.PERMISSION_DENIED, _("auth.insufficient_permissions"), status=403)

        # BI-11: 验证 target_space_id 对应的 Space 存在且属于同一 organization
        from apps.tabtinspace.services.host_resolver import host_organization_id
        host_org_id = host_organization_id(target_space_id)
        if host_org_id is None or str(host_org_id) != str(organization_id):
            raise ServiceError(
                ErrorCode.INVALID_INPUT,
                _("tabmemo.invalid_target_space"),
                status=400,
            )

        user_id = self.user.id if self.user else None
        to_create: list[MemoAgentGrant] = []

        if memo_ids:
            safe_ids = [mid for mid in memo_ids if _is_valid_uuid(mid)]
            valid_memos = list(Memo.objects.using(TABMEMO_DB).filter(
                id__in=safe_ids, organization_id=organization_id,
            ))
            for memo in valid_memos:
                self._check_memo_access(memo, "editor")
            existing_pairs = set(
                MemoAgentGrant.objects.using(TABMEMO_DB).filter(
                    memo_id__in=[m.id for m in valid_memos],
                    target_space_id=target_space_id,
                ).values_list("memo_id", flat=True)
            )
            for memo in valid_memos:
                if memo.id not in existing_pairs:
                    to_create.append(MemoAgentGrant(
                        memo_id=memo.id,
                        target_space_id=target_space_id,
                        organization_id=organization_id,
                        permission=permission,
                        granted_by=user_id,
                    ))

        if collection_ids:
            safe_ids = [cid for cid in collection_ids if _is_valid_uuid(cid)]
            valid_colls = list(MemoCollection.objects.using(TABMEMO_DB).filter(
                id__in=safe_ids, organization_id=organization_id,
            ))
            for coll in valid_colls:
                self._check_collection_access(coll, "editor")
            existing_pairs = set(
                MemoAgentGrant.objects.using(TABMEMO_DB).filter(
                    collection_id__in=[c.id for c in valid_colls],
                    target_space_id=target_space_id,
                ).values_list("collection_id", flat=True)
            )
            for coll in valid_colls:
                if coll.id not in existing_pairs:
                    to_create.append(MemoAgentGrant(
                        collection_id=coll.id,
                        target_space_id=target_space_id,
                        organization_id=organization_id,
                        permission=permission,
                        granted_by=user_id,
                    ))

        grants = []
        if to_create:
            grants = MemoAgentGrant.objects.using(TABMEMO_DB).bulk_create(
                to_create, ignore_conflicts=True,
            )
        return grants

    def list_grants(self, organization_id: str, space_id: Optional[str] = None) -> list:
        """列出 Grant 列表。Admin 可见全部，普通用户仅看自己创建的（管理者视角）。"""
        from apps.tabmemo.models import MemoAgentGrant
        qs = MemoAgentGrant.objects.using(TABMEMO_DB).filter(
            organization_id=organization_id,
        ).select_related("memo", "collection")
        if space_id:
            qs = qs.filter(target_space_id=space_id)
        if not self.check_organization_permission(organization_id, "admin"):
            user_id = self.user.id if self.user else None
            qs = qs.filter(granted_by=user_id)
        return list(qs.order_by("-created_at"))

    def list_received_grants(self, organization_id: str, target_space_id: str,
                             *, limit: int = 20, offset: int = 0) -> dict:
        """列出某 Space 被授权访问的 Grant（消费者视角）。

        与 list_grants 的区别：list_grants 是管理者视角（看我授了什么），
        此方法是消费者视角（看我被授了什么）。仅返回 target_space_id 命中的记录。
        """
        from apps.tabmemo.models import MemoAgentGrant
        qs = (
            MemoAgentGrant.objects.using(TABMEMO_DB)
            .filter(organization_id=organization_id, target_space_id=target_space_id)
            .select_related("memo", "collection")
            .order_by("-created_at")
        )
        total = qs.count()
        safe_limit = max(1, min(limit, 100))
        safe_offset = max(0, offset)
        page = list(qs[safe_offset:safe_offset + safe_limit])
        return {"items": page, "total": total}

    @transaction.atomic(using=TABMEMO_DB)
    def delete_grant(self, grant_id: str) -> None:
        """撤销授权"""
        from apps.tabmemo.models import MemoAgentGrant
        try:
            grant = MemoAgentGrant.objects.using(TABMEMO_DB).get(id=grant_id)
        except MemoAgentGrant.DoesNotExist:
            raise ServiceError(ErrorCode.GRANT_NOT_FOUND, _("tabmemo.grant_not_found"), status=404)
        user_id = str(self.user.id) if self.user else None
        if str(grant.granted_by) != user_id:
            if not self.check_organization_permission(str(grant.organization_id), "admin"):
                raise ServiceError(ErrorCode.PERMISSION_DENIED, _("auth.insufficient_permissions"), status=403)
        grant.delete()

    def get_agent_memo_stats(
        self, organization_id: str, space_id: str,
    ) -> Dict[str, int]:
        """按 memo_type 统计 Agent 写入的活跃记忆条数。

        Returns:
            {"about_you": N, "insight": N, "task_summary": N, "diary": N, "total": N}
        """
        if not self.check_space_permission(space_id, "viewer"):
            raise ServiceError(
                ErrorCode.PERMISSION_DENIED,
                _("auth.insufficient_permissions"),
                status=403,
            )

        AGENT_TYPES = ["about_you", "insight", "task_summary", "diary"]
        qs = (
            Memo.objects.using(TABMEMO_DB)
            .filter(
                organization_id=organization_id,
                space_id=space_id,
                source=Memo.Source.AGENT,
                status=Memo.Status.ACTIVE,
                memo_type__in=AGENT_TYPES,
            )
            .values("memo_type")
            .annotate(cnt=Count("id"))
        )

        result: Dict[str, int] = {t: 0 for t in AGENT_TYPES}
        total = 0
        for row in qs:
            result[row["memo_type"]] = row["cnt"]
            total += row["cnt"]
        result["total"] = total
        return result
