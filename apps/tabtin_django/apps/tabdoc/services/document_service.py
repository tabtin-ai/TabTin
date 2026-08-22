from __future__ import annotations

import base64
import json
import logging
import re
import time
import zlib
from datetime import timedelta
from typing import Iterable, Optional
from uuid import UUID

from django.conf import settings
from django.contrib.postgres.search import SearchVector
from django.db import connections, models, router, transaction
from django.db.models import QuerySet
from django.utils.dateparse import parse_datetime
from django.utils import timezone

from apps.tabdoc.models import (
    DocChunk,
    DocHistory,
    DocUpdate,
    Document,
    DocumentRecoveryDraft,
    DocumentPermission,
    DocumentShare,
    DocumentRevision,
    DocumentVersion,
    HISTORY_MIN_INTERVAL,
    HISTORY_SNAPSHOT_EVERY,
    HISTORY_SNAPSHOT_MAX_AGE,
    MAX_VERSIONS_PER_DOC,
)
from apps.tabdoc.services.markdown_exchange import (
    ensure_top_level_block_ids,
    markdown_to_pm_json,
)
from apps.tabdoc.services.metrics import get_tabdoc_metrics
from apps.tabtinspace.models import Collection, Space
from apps.tabtinspace.services.asset_host import asset_host_q
from apps.tabtinspace.services.base import ASSIGNABLE_ROLES, BaseService, ROLE_LEVELS
from apps.i18n import _
from apps.services.common.db_router import postgres_app_db_alias
from apps.tabtinspace.services.resource_bridge import ResourceBridge

logger = logging.getLogger("tabdoc.service")
TABDOC_MERGE_DEBOUNCE_SECONDS = 5

# ：分享链接编辑（share_grant）是已授权、但访客通常非文档协作者的写入。
# 把这类已授权变更同步进在线 Y.Doc 时，走 collab 的 system trusted_internal 通道
# （与版本恢复 system:collab_restore 同套路），editor_id 用稳定内部标识，便于
# save_content 的 vh/version 去重标记与 onStore 回流身份对齐。
SHARE_COLLAB_SYNC_EDITOR_ID = "system:share_sync"


def _document_permission_level(role: str) -> int:
    """历史 owner 权限不再代表真实 owner，最多按 admin 级访问。"""
    if role == "owner":
        return ROLE_LEVELS["admin"]
    return ROLE_LEVELS.get(role, 0)


def _schedule_doc_merge_debounce(document_id: str) -> None:
    if not getattr(settings, "TABDOC_DEBOUNCE_MERGE_ENABLED", False):
        return
    try:
        from django.core.cache import cache
        from apps.tabdoc.tasks import merge_doc_for_document

        key = f"tabdoc:merge:debounce:{document_id}"
        if not cache.add(key, "1", timeout=TABDOC_MERGE_DEBOUNCE_SECONDS):
            return
        merge_doc_for_document.apply_async(
            args=[document_id],
            countdown=TABDOC_MERGE_DEBOUNCE_SECONDS,
            queue="doc_merge",
            expires=180,
        )
    except Exception:
        logger.warning(
            "schedule_doc_merge_debounce failed; fallback sweep will retry. doc=%s",
            document_id,
            exc_info=True,
        )


def _document_permission_role(role: str) -> str:
    if role == "owner":
        return "admin"
    return role


# ── collab-live HTTP 客户端 ──

from apps.services.common.live_api import call_live_api  # noqa: E402
from apps.services.oss.services.public_assets import normalize_public_asset_ref


def _decompress_history_blob(blob: bytes) -> bytes:
    """
    解压 DocHistory blob，兼容旧的未压缩数据。

    新数据使用 zlib 压缩存储；旧数据是原始 Y.js binary 或 JSON。
    """
    if not blob:
        return b""
    try:
        return zlib.decompress(blob)
    except zlib.error:
        return blob


# ── 内容状态判定与规范化 ──


def _has_meaningful_json_content(pm_json: dict | None) -> bool:
    """pm_json 是否包含非空文档内容"""
    if not pm_json or not isinstance(pm_json, dict):
        return False
    content = pm_json.get("content", [])
    return isinstance(content, list) and len(content) > 0


def _has_meaningful_text(text: str | None) -> bool:
    if not text:
        return False
    stripped = text.strip()
    if not stripped or stripped in ("<p></p>",):
        return False
    without_headings = re.sub(r"^#{1,6}\s*$", "", stripped, flags=re.MULTILINE).strip()
    if not without_headings:
        return False
    return True


def _json_has_tabdata_blocks(pm_json: dict | None) -> bool:
    if not isinstance(pm_json, dict):
        return False
    content = pm_json.get("content", [])
    if not isinstance(content, list):
        return False
    return any(
        isinstance(node, dict) and node.get("type") == "tabdataBlock"
        for node in content
    )


def classify_tabdoc_content_state(
    *,
    description_json: dict | None = None,
    description_markdown: str | None = None,
    description_plaintext: str | None = None,
    latest_version: int | None = None,
    latest_revision_version: int | None = None,
    has_description_binary: bool = False,
) -> str:
    """
    判定文档内容状态。

    返回值:
      - "has_primary_content": 文档有实质内容
      - "intentionally_empty": 文档被用户清空（版本已推进或无旧 Revision）
      - "legacy_needs_fallback": 旧数据，需回退到 Revision
    """
    if (
        _has_meaningful_json_content(description_json)
        or _has_meaningful_text(description_markdown)
        or _has_meaningful_text(description_plaintext)
    ):
        return "has_primary_content"

    v = latest_version or 0
    rv = latest_revision_version
    if rv is None or v > rv or has_description_binary:
        return "intentionally_empty"
    return "legacy_needs_fallback"


def should_fallback_to_latest_revision(
    *,
    description_json: dict | None = None,
    description_markdown: str | None = None,
    description_plaintext: str | None = None,
    latest_version: int | None = None,
    latest_revision_version: int | None = None,
    has_description_binary: bool = False,
) -> bool:
    """文档是否应回退到最新 Revision 内容"""
    return classify_tabdoc_content_state(
        description_json=description_json,
        description_markdown=description_markdown,
        description_plaintext=description_plaintext,
        latest_version=latest_version,
        latest_revision_version=latest_revision_version,
        has_description_binary=has_description_binary,
    ) == "legacy_needs_fallback"


def normalize_tabdata_markdown(markdown: str) -> str:
    """
    规范化 markdown 中的 tabdata block 标记。

    仅处理行首的实际块标记，不改写正文、代码块或 HTML 属性中的引用。
    对于已使用 :::tabdata{} 指令格式的内容，原样返回。
    """
    if not markdown:
        return markdown
    return markdown


def normalize_tabdata_snapshot(
    pm_json: dict | None,
    markdown: str,
) -> tuple[dict | None, str]:
    """
    规范化文档快照，确保 pm_json 与 markdown 中的 tabdata 内容一致。

    如果 pm_json 包含 tabdataBlock 节点但 markdown 缺少对应的 :::tabdata 指令，
    从 pm_json 重新生成 markdown。
    """
    pm_json = pm_json or {}
    if not pm_json and not markdown:
        return pm_json, markdown

    if _json_has_tabdata_blocks(pm_json) and ":::tabdata{" not in (markdown or ""):
        try:
            from apps.tabdoc.services.markdown_exchange import pm_json_to_markdown
            markdown = pm_json_to_markdown(pm_json)
        except Exception:
            logger.debug("normalize_tabdata_snapshot: pm_json_to_markdown failed", exc_info=True)

    markdown = normalize_tabdata_markdown(markdown)
    return pm_json, markdown


class ConflictError(Exception):
    """并发版本冲突"""


MAX_DOCUMENT_PARENT_DEPTH = 10


class DocumentService(BaseService):
    """
    Tabdoc 核心业务服务

    设计说明:
    - 文档"删除"统一使用 archive_document（软删除，status → archived），
      不提供硬删除接口。归档后调用 ResourceBridge.on_archive 通知 ContextItem。
    - 如果未来需要物理删除（如 GDPR 合规），应新增 delete_document 方法，
      并在 document.delete() 前调用 ResourceBridge.on_delete(document, user=self.user)。
    """

    _SPACE_ROLE_CACHE_TTL = 300  # 秒

    # INF-01: is_private 列可能尚未迁移（0007 pending），缓存检测结果
    _is_private_col_available: Optional[bool] = None

    @classmethod
    def _is_private_safe(cls) -> bool:
        """检测 is_private 列是否已在 PostgreSQL 中可用（结果缓存至进程生命周期）"""
        if cls._is_private_col_available is not None:
            return cls._is_private_col_available
        try:
            from apps.tabdoc.models import Document
            # 空 LIMIT 0 查询，仅验证列是否存在
            list(Document.objects.filter(is_private=False).values("id")[:0])
            cls._is_private_col_available = True
        except Exception:
            logger.warning(
                "[DocumentService] is_private column not available — "
                "run `python manage.py migrate tabdoc 0007 --database=postgresql` to fix"
            )
            cls._is_private_col_available = False
        return cls._is_private_col_available

    def __init__(self, user=None, *, editor_type: str = ""):
        super().__init__(user=user)
        self._editor_type_override = editor_type
        self._space_role_cache: dict[str, tuple[Optional[str], float]] = {}

    @staticmethod
    def _get_document_depth(document: Document) -> int:
        depth = 0
        current = document
        seen: set[UUID] = set()
        while current.parent_id is not None:
            if current.parent_id in seen:
                break
            seen.add(current.parent_id)
            depth += 1
            try:
                current = Document.objects.only("id", "parent_id").get(id=current.parent_id)
            except Document.DoesNotExist:
                break
        return depth

    @staticmethod
    def _is_document_descendant_of(candidate: Document, ancestor: Document) -> bool:
        current = candidate
        seen: set[UUID] = set()
        while current.parent_id is not None:
            if current.parent_id == ancestor.id:
                return True
            if current.parent_id in seen:
                break
            seen.add(current.parent_id)
            try:
                current = Document.objects.only("id", "parent_id").get(id=current.parent_id)
            except Document.DoesNotExist:
                break
        return False

    def _validate_document_parent(self, document: Document, parent_doc: Document) -> None:
        if parent_doc.id == document.id:
            raise ValueError(_("tabdoc.parent_cannot_be_self"))
        if str(parent_doc.organization_id) != str(document.organization_id):
            raise ValueError(_("tabdoc.parent_not_in_same_space"))
        if self._is_document_descendant_of(parent_doc, document):
            raise ValueError(_("tabdoc.parent_circular_ref"))
        if self._get_document_depth(parent_doc) + 1 >= MAX_DOCUMENT_PARENT_DEPTH:
            raise ValueError(_("tabdoc.parent_max_depth_exceeded"))

    def _parse_uuid(self, value: str, field_name: str) -> UUID:
        try:
            return UUID(str(value))
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{field_name} 不是合法 UUID") from exc

    def _ensure_space_context(self, organization_id: str, space_id: str) -> Space:
        from apps.tabtinspace.services.base import ensure_space_in_organization
        return ensure_space_in_organization(organization_id, space_id)

    # ── 文档状态门禁 ──

    def assert_document_viewable(self, document: Document) -> None:
        if getattr(document, "trashed_at", None) is not None:
            raise ValueError(_("tabdoc.document_in_trash_not_accessible"))

    def assert_document_content_editable(self, document: Document) -> None:
        if getattr(document, "trashed_at", None) is not None:
            raise ValueError(_("tabdoc.document_in_trash_not_editable"))
        if document.status == "archived":
            raise ValueError(_("tabdoc.document_archived_not_editable"))

    def assert_document_collab_writable(self, document: Document) -> None:
        if getattr(document, "trashed_at", None) is not None:
            raise ValueError(_("tabdoc.document_in_trash_no_collab"))
        if document.status != "active":
            raise ValueError(_("tabdoc.document_not_active_no_collab"))

    def _normalize_plaintext(self, markdown: str, fallback: str = "") -> str:
        text = markdown or fallback or ""
        text = re.sub(r"```[\s\S]*?```", " ", text)
        text = re.sub(r"`([^`]*)`", r"\1", text)
        text = re.sub(r"[#>*_\-\[\]\(\)]", " ", text)
        text = re.sub(r"\s+", " ", text)
        return text.strip()

    def _resolve_space_role(self, space_id: Optional[UUID]) -> Optional[str]:
        if not space_id or not self.user or not hasattr(self.user, 'id'):
            return None

        cache_key = str(space_id)
        now = time.monotonic()
        if cache_key in self._space_role_cache:
            cached_role, cached_at = self._space_role_cache[cache_key]
            if now - cached_at < self._SPACE_ROLE_CACHE_TTL:
                return cached_role
            # TTL 过期，删除条目
            del self._space_role_cache[cache_key]

        role = self._do_resolve_space_role(space_id)
        self._space_role_cache[cache_key] = (role, now)
        return role

    def _resolve_organization_role(self, organization_id) -> Optional[str]:
        """解析当前用户在组织上的角色（owner/admin/editor/viewer）。"""
        if not self.user or not hasattr(self.user, "id") or not organization_id:
            return None
        for candidate in ("owner", "admin", "editor", "viewer"):
            if self.check_organization_permission(str(organization_id), required_role=candidate):
                return candidate
        return None

    def _do_resolve_space_role(self, space_id: UUID) -> Optional[str]:
        from apps.tabtinspace.services.host_resolver import resolve_host
        from apps.tabtinspace.services.membership_utils import get_host_member_role

        space = resolve_host(space_id)
        if not space:
            return None

        # CAP-012: 双宿主成员角色（Workspace→SpaceMembership / Project→ProjectMembership）
        return get_host_member_role(space.id, self.user.id)

    def _validate_permission_entries(self, entries: Iterable[dict]) -> list[dict]:
        normalized: list[dict] = []
        seen = set()
        valid_roles = ASSIGNABLE_ROLES | {"owner"}
        for entry in entries:
            subject_type = str(entry.get("subject_type", "")).strip()
            subject_id = str(entry.get("subject_id", "")).strip()
            permission = str(entry.get("permission", "")).strip()
            is_active = bool(entry.get("is_active", True))

            if subject_type not in {"user", "role"}:
                raise ValueError(_("tabdoc.invalid_subject_type"))
            if not subject_id:
                raise ValueError(_("tabdoc.subject_id_required"))
            if permission not in ROLE_LEVELS:
                raise ValueError(_("tabdoc.invalid_permission_role"))
            if subject_type == "role" and subject_id not in valid_roles:
                raise ValueError(_("tabdoc.invalid_role_subject_id"))

            dedup_key = (subject_type, subject_id)
            if dedup_key in seen:
                raise ValueError(_("tabdoc.duplicate_permission_entry", subject=f"{subject_type}:{subject_id}"))
            seen.add(dedup_key)

            normalized.append(
                {
                    "subject_type": subject_type,
                    "subject_id": subject_id,
                    "permission": permission,
                    "is_active": is_active,
                }
            )
        return normalized

    def _update_search_vector(self, document: Document, plaintext: str = "") -> None:
        """更新文档的全文搜索向量（标题 A 权重 + 正文 B 权重）。"""
        db_alias = (
            getattr(getattr(document, "_state", None), "db", None)
            or router.db_for_write(Document, instance=document)
            or "postgresql"
        )
        try:
            # 使用 simple 配置，适用于中英文混合搜索（不做词干还原）
            Document.objects.using(db_alias).filter(pk=document.pk).update(
                search_vector=(
                    SearchVector("title", weight="A", config="simple")
                ),
            )
            # 如果有纯文本正文，额外拼接进去（SearchVector 不支持动态值，用 raw SQL）
            if plaintext:
                truncated = plaintext[:10000]  # 限制索引文本长度
                conn = connections[db_alias]
                if conn.vendor != "postgresql":
                    logger.warning(
                        "skip search_vector raw update on non-postgresql connection: doc=%s db=%s vendor=%s",
                        document.pk,
                        db_alias,
                        conn.vendor,
                    )
                    return
                with conn.cursor() as cursor:
                    cursor.execute(
                        """
                        UPDATE tabdoc_document
                        SET search_vector = (
                            setweight(to_tsvector('simple', COALESCE(title, '')), 'A') ||
                            setweight(to_tsvector('simple', %s), 'B')
                        )
                        WHERE id = %s
                        """,
                        [truncated, str(document.pk)],
                    )
        except Exception:
            # 搜索索引更新失败不应阻断主流程
            logger.warning(
                "update search_vector failed: doc=%s db=%s",
                document.pk,
                db_alias,
                exc_info=True,
            )

    def get_document(
        self, document_id: str, required_role: str = "viewer", *, allow_trashed: bool = False,
    ) -> Document:
        doc_uuid = self._parse_uuid(document_id, "document_id")
        document = (
            Document.objects.select_related("parent")
            .prefetch_related("permissions")
            .filter(id=doc_uuid)
            .first()
        )
        if not document:
            raise ValueError(_("tabdoc.document_not_found"))

        if not self.check_document_permission(document, required_role=required_role):
            raise PermissionError(_("tabdoc.no_permission_to_access_document"))

        if not allow_trashed and getattr(document, "trashed_at", None) is not None:
            raise ValueError(_("tabdoc.document_in_trash_not_accessible"))

        return document

    def get_trashed_document_for_personal_trash(self, document_id: str) -> Document:
        """个人回收站取文档：须在回收站且当前用户为删除者。"""
        doc_uuid = self._parse_uuid(document_id, "document_id")
        document = (
            Document.objects.select_related("parent")
            .prefetch_related("permissions")
            .filter(id=doc_uuid)
            .first()
        )
        if not document:
            raise ValueError(_("tabdoc.document_not_found"))
        if not getattr(document, "trashed_at", None):
            raise ValueError(_("tabdoc.document_not_in_trash"))
        if not self._can_manage_personal_trashed_document(document):
            raise PermissionError(_("tabdoc.no_permission_to_access_document"))
        return document

    # ── outline / block 大纲读取 ──────────────────────────────────
    #
    # `list_outline_blocks` 用于「省 token 看大纲」场景：返回文档顶层 block 列
    # 表（id / type / level / preview / index），让 LLM 决定下一步读哪个段落
    # 后再调 `tabtin doc read` 拿全文。
    #
    # 历史背景：Wave 11 前由 `apps/services/tools/domains/tabdoc/document_tools.py`
    # 的 `TabdocListBlocksTool` 在 BaseTool 层自己解 PM JSON。Wave 12（2026-05-04
    # tabdoc CLI 退役）抽到 Service 层，让 HTTP endpoint
    # `GET /api/tabdoc/documents/{id}/blocks` 与 BaseTool 共用同一份逻辑——LLM
    # 主路径走 CLI（HTTP endpoint），BaseTool 主要服务于 ToolHub UI 列表。
    #
    # **已知缺口**：当前实现**不**处理 `description_binary`（仅有 binary、JSON
    # 未落盘的极少场景下会返回空列表）；这与
    # `DocumentExchangeService._resolve_document_content` 的 binary 路径行为
    # 不一致，跟 BaseTool 历史行为对齐。生产实测如触发再补。
    @staticmethod
    def _extract_pm_node_text(node: dict) -> str:
        """递归提取 PM JSON 节点的纯文本（preview 用）。"""
        if not isinstance(node, dict):
            return ""
        parts: list[str] = []
        text = node.get("text")
        if isinstance(text, str):
            parts.append(text)
        for child in node.get("content", []) or []:
            if isinstance(child, dict):
                parts.append(DocumentService._extract_pm_node_text(child))
        return " ".join(parts).strip()

    def _resolve_pm_json_for_outline(
        self,
        document: Document,
        *,
        allow_v1_fallback: bool = True,
    ) -> dict:
        """outline 用的 PM JSON 解析链：description_json → markdown → V1 Revision。"""
        from apps.tabdoc.services.markdown_exchange import markdown_to_pm_json

        pm_json = document.description_json or {}
        if isinstance(pm_json, dict) and pm_json.get("content"):
            return pm_json

        markdown = (getattr(document, "description_markdown", "") or "").strip()
        if markdown:
            try:
                return markdown_to_pm_json(markdown)
            except Exception:
                logger.warning(
                    "[Outline] markdown→PM JSON conversion failed: doc=%s",
                    document.id,
                    exc_info=True,
                )

        revision = self.get_latest_revision(document)
        if revision and isinstance(revision.content_pm_json, dict) and revision.content_pm_json.get("content"):
            if not allow_v1_fallback:
                return {}
            logger.warning(
                "[Outline] V1 Revision fallback: doc=%s rev_version=%s",
                document.id,
                getattr(revision, "version", None),
            )
            return revision.content_pm_json

        return pm_json if isinstance(pm_json, dict) else {}

    def list_outline_blocks(
        self,
        document: Document,
        *,
        allow_v1_fallback: bool = True,
    ) -> list[dict]:
        """列出文档顶层 block 大纲。

        Returns:
            list of dicts，每项含 id / type / level / preview / index 字段。
        """
        pm_json = self._resolve_pm_json_for_outline(document, allow_v1_fallback=allow_v1_fallback)
        blocks: list[dict] = []
        for i, node in enumerate(pm_json.get("content", []) or []):
            if not isinstance(node, dict):
                continue
            attrs = node.get("attrs") or {}
            attrs_dict = attrs if isinstance(attrs, dict) else {}
            block_id = attrs_dict.get("blockId") or f"auto_{i}"
            node_type = node.get("type", "unknown")
            level = attrs_dict.get("level")
            preview = self._extract_pm_node_text(node)[:80]
            blocks.append(
                {
                    "id": block_id,
                    "type": node_type,
                    "level": level,
                    "preview": preview,
                    "index": i,
                }
            )
        return blocks

    def get_latest_revision(self, document: Document) -> Optional[DocumentRevision]:
        """[兼容-待废弃] 优先从 Document 表读取内容，回退到旧 Revision 表"""
        revision = document.revisions.order_by("-version").first()
        if not revision:
            return None

        should_fallback = should_fallback_to_latest_revision(
            description_json=document.description_json,
            description_markdown=document.description_markdown,
            description_plaintext=document.description_plaintext,
            latest_version=document.latest_version,
            latest_revision_version=revision.version,
            has_description_binary=bool(document.description_binary),
        )
        if not should_fallback:
            return None

        logger.warning(
            "V1 Revision 回退: doc=%s rev=%s — description_json 为空，"
            "需在 Phase 1 数据修补中处理",
            document.id, revision.version,
        )
        return revision

    def normalize_document_content_if_needed(self, document: Document) -> bool:
        """
        规范化文档中的旧版 tabdata 派生字段（幂等）。

        检查 pm_json 中是否包含 tabdataBlock 节点，若有则:
        1. 确保 markdown 包含 :::tabdata{} 指令格式（缺少则从 pm_json 重新生成）
        2. 绝不因含 tabdataBlock 而清空 description_binary

        : description_binary 是协作真源。旧逻辑在存在 tabdataBlock 时无条件
        失效 binary，导致 GET /binary → collab-live 重新生成随机身份 Yjs 并与旧
        state merge，正文指数翻倍直至客户端卡死。

        返回 True 表示派生字段已变更并写入 DB。
        """
        pm_json = document.description_json or {}
        if not _json_has_tabdata_blocks(pm_json):
            return False

        update_fields: dict = {}
        markdown = document.description_markdown or ""

        if ":::tabdata{" not in markdown:
            try:
                from apps.tabdoc.services.markdown_exchange import pm_json_to_markdown
                new_markdown = pm_json_to_markdown(pm_json)
                if new_markdown and new_markdown != markdown:
                    update_fields["description_markdown"] = new_markdown
                    document.description_markdown = new_markdown
            except Exception:
                logger.debug(
                    "normalize_document_content_if_needed: markdown regen failed doc=%s",
                    document.id, exc_info=True,
                )

        if update_fields:
            Document.objects.filter(id=document.id).update(**update_fields)
            return True
        return False

    def _has_project_task_preview_access(self, document: Document) -> bool:
        """#7261：完成前候选文档对 Project 成员放行只读。"""
        cache = getattr(self, "_project_task_preview_access_cache", None)
        if cache is None:
            cache = {}
            self._project_task_preview_access_cache = cache
        cache_key = str(document.id)
        if cache_key in cache:
            return cache[cache_key]
        try:
            from apps.tabtinspace.services.project_task_preview_access import (
                user_can_preview_project_task_document,
            )
            allowed = user_can_preview_project_task_document(self.user, document)
        except Exception:
            logger.warning(
                "project task preview access check failed: doc=%s",
                document.id,
                exc_info=True,
            )
            allowed = False
        cache[cache_key] = allowed
        return allowed

    def _allow_project_task_document_preview(
        self,
        document: Document,
        required_level: int,
    ) -> bool:
        return (
            required_level <= ROLE_LEVELS["viewer"]
            and self._has_project_task_preview_access(document)
        )

    def check_document_permission(
        self,
        document: Document,
        required_role: str = "viewer",
        *,
        allow_embedded_access: bool = True,
    ) -> bool:
        if not self.user or not hasattr(self.user, 'id'):
            return False

        owner_id = getattr(document, "owner_id", None)
        if owner_id and str(owner_id) == str(self.user.id):
            return True

        required_level = ROLE_LEVELS.get(required_role, ROLE_LEVELS["viewer"])
        permissions_qs = document.permissions.filter(is_active=True)
        inherited_role = None
        if allow_embedded_access:
            from apps.tabdoc.services.embedded_access import (
                get_current_parent_document_resource_role,
            )

            inherited_role = get_current_parent_document_resource_role(
                user=self.user,
                resource_type="document",
                resource=document,
            )

        matched_roles: list[str] = []

        user_id_text = str(self.user.id)
        matched_roles.extend(
            list(
                permissions_qs.filter(subject_type="user", subject_id=user_id_text).values_list(
                    "permission", flat=True
                )
            )
        )

        # role ACL：优先命中组织角色；历史宿主角色仍兼容
        org_role = self._resolve_organization_role(document.organization_id)
        if org_role:
            matched_roles.extend(
                list(
                    permissions_qs.filter(subject_type="role", subject_id=org_role).values_list(
                        "permission", flat=True
                    )
                )
            )
        space_role = self._resolve_space_role(document.space_id)
        if space_role and space_role != org_role:
            matched_roles.extend(
                list(
                    permissions_qs.filter(subject_type="role", subject_id=space_role).values_list(
                        "permission", flat=True
                    )
                )
            )

        if inherited_role:
            matched_roles.append(inherited_role)

        if matched_roles:
            # 命中本人 user/role ACL 时按级别比较；不足则不抬权，但  可 viewer 预览
            effective_level = max(_document_permission_level(role) for role in matched_roles)
            if effective_level >= required_level:
                return True
            return self._allow_project_task_document_preview(document, required_level)

        # ：云盘默认私有——无本人 ACL 命中即拒绝，不再回退组织角色
        # （撤销  org fallback；Organization 只做归属边界）。
        # ：唯一显式兜底——完成前 Project Task 候选文档对同 Project 有效成员
        # 放行 viewer 只读预览（不写 ACL、不改归属，任务完成或取消即失效）。
        if self._allow_project_task_document_preview(document, required_level):
            return True
        return False

    def compute_user_document_role(self, document: Document) -> Optional[str]:
        """返回当前用户在该文档上的有效角色（Wave 5 §D canManage 后端回填）。

        返回值 ∈ {``'owner'``, ``'admin'``, ``'editor'``, ``'viewer'``, ``None``}。
        优先级（与 ``check_document_permission`` 对齐）：
        1. ``document.owner_id == self.user.id`` → ``'owner'``
        2. DocumentPermission(subject_type='user', is_active=True) → 该 permission 值
        3. DocumentPermission(subject_type='role', is_active=True) → 命中的 role
        4. 父 TabDoc 继承角色；与子文档自身权限取最高级别。
        5. Project Task 候选文档只读预览。
        """
        if not self.user or not hasattr(self.user, "id"):
            return None

        owner_id = getattr(document, "owner_id", None)
        if owner_id and str(owner_id) == str(self.user.id):
            return "owner"

        user_id_text = str(self.user.id)
        active = document.permissions.filter(is_active=True)

        matched: list[str] = list(
            active.filter(subject_type="user", subject_id=user_id_text).values_list(
                "permission", flat=True,
            )
        )

        org_role = self._resolve_organization_role(document.organization_id)
        if org_role:
            matched.extend(
                list(
                    active.filter(subject_type="role", subject_id=org_role).values_list(
                        "permission", flat=True,
                    )
                )
            )
        space_role = self._resolve_space_role(document.space_id)
        if space_role and space_role != org_role:
            matched.extend(
                list(
                    active.filter(subject_type="role", subject_id=space_role).values_list(
                        "permission", flat=True,
                    )
                )
            )

        from apps.tabdoc.services.embedded_access import (
            get_current_parent_document_resource_role,
        )

        inherited_role = get_current_parent_document_resource_role(
            user=self.user,
            resource_type="document",
            resource=document,
        )
        if inherited_role:
            matched.append(inherited_role)

        if matched:
            # 取所有命中里级别最高的一档
            best_role = max(matched, key=_document_permission_level)
            return _document_permission_role(best_role)

        # ：无 ACL 命中 → 无角色（不回退 Organization）。
        # ：完成前 Project Task 候选文档对同 Project 有效成员回填 viewer。
        if self._has_project_task_preview_access(document):
            return "viewer"
        return None

    def _build_permission_filter_q(
        self,
        space_id=None,
        required_role: str = "viewer",
        *,
        organization_id=None,
    ) -> models.Q:
        """
        构建 SQL 层权限过滤条件，替代逐条 check_document_permission。

        逻辑等价于 check_document_permission：
        1. owner_id 命中
        2. 当前用户 user/role ACL 命中且级别 >= required_role
        3. 命中但级别不足 → 排除（不抬权）
        4. **无**组织角色回退
        """
        from django.db.models import Exists, OuterRef

        if not self.user or not hasattr(self.user, 'id'):
            return models.Q(pk__in=[])

        required_level = ROLE_LEVELS.get(required_role, ROLE_LEVELS["viewer"])
        qualifying_roles = [
            role
            for role, level in ROLE_LEVELS.items()
            if level >= required_level and (role != "owner" or required_role != "owner")
        ]

        user_id_text = str(self.user.id)
        org_role = self._resolve_organization_role(organization_id) if organization_id else None
        space_role = self._resolve_space_role(space_id)
        owner_match = models.Q(owner_id=self.user.id)

        role_subjects: list[str] = []
        if org_role:
            role_subjects.append(org_role)
        if space_role and space_role not in role_subjects:
            role_subjects.append(space_role)

        # 条件 2：当前用户匹配足够级别的 user ACL
        user_perm_q = DocumentPermission.objects.filter(
            document_id=OuterRef("pk"),
            is_active=True,
            subject_type="user",
            subject_id=user_id_text,
            permission__in=qualifying_roles,
        )
        user_perm_match = Exists(user_perm_q)

        # 条件 3：显式 role ACL（须文档上写了 role 行才命中；组织角色本身不隐式授权）
        role_perm_match = models.Q(pk__in=[])
        if role_subjects:
            role_perm_q = DocumentPermission.objects.filter(
                document_id=OuterRef("pk"),
                is_active=True,
                subject_type="role",
                subject_id__in=role_subjects,
                permission__in=qualifying_roles,
            )
            role_perm_match = Exists(role_perm_q)

        return owner_match | user_perm_match | role_perm_match

    def list_documents(
        self,
        organization_id: str,
        space_id: Optional[str] = None,
        parent_id: Optional[str] = None,
        include_archived: bool = False,
        scope: str = "organization",
        page: int = 1,
        page_size: int = 200,
    ) -> tuple[list[Document], int]:
        """列出文档（统一返回 (documents, total) 元组，DB 层分页）。

        ：列表只按 Organization；``space_id`` / ``scope=space`` 已废弃并忽略。
        """
        organization_uuid = self._parse_uuid(organization_id, "organization_id")
        if space_id or scope == "space":
            logger.info(
                "list_documents: ignoring deprecated space filter "
                "(space_id=%s scope=%s) ",
                space_id, scope,
            )
        return self._list_documents_organization(
            organization_uuid, parent_id, include_archived,
            page=page, page_size=page_size,
        )

    def build_organization_permission_q(self, organization_uuid) -> tuple[models.Q, bool]:
        """构建 organization scope 下的文档权限 Q 条件。

        返回 (combined_q, has_access)。has_access=False 表示用户无组织查看权限。
        供 _list_documents_organization 和 DocumentSearchService._build_organization_base_qs 共用。
        """
        if not self.user:
            return models.Q(pk__in=[]), False

        if not self.check_organization_permission(str(organization_uuid), required_role="viewer"):
            return models.Q(pk__in=[]), False

        perm_q = self._build_permission_filter_q(
            organization_id=organization_uuid,
            required_role="viewer",
        )
        return perm_q, True

    def _list_documents_organization(
        self,
        organization_uuid,
        parent_id: Optional[str],
        include_archived: bool,
        page: int = 1,
        page_size: int = 200,
    ) -> tuple[list[Document], int]:
        """Organization 级文档列表：返回组织内用户可访问的全部文档。"""
        if not self.user:
            raise PermissionError(_("tabdoc.no_permission_to_access_space_documents"))

        combined_q, has_access = self.build_organization_permission_q(organization_uuid)
        if not has_access:
            return [], 0

        qs: QuerySet[Document] = Document.objects.filter(
            organization_id=organization_uuid,
        ).filter(combined_q)

        if parent_id:
            qs = qs.filter(parent_id=self._parse_uuid(parent_id, "parent_id"))
        qs = qs.filter(trashed_at__isnull=True)
        if not include_archived:
            qs = qs.filter(status="active")

        qs = qs.distinct().order_by("-updated_at")
        total = qs.count()
        offset = (page - 1) * page_size
        return list(qs[offset:offset + page_size]), total

    def create_document(
        self,
        organization_id: str,
        space_id: Optional[str] = None,
        parent_id: Optional[str] = None,
        title: str = "",
        initial_content_pm_json: Optional[dict] = None,
        initial_content_markdown: str = "",
        initial_content_plaintext: str = "",
        icon: str = "",
        cover_image: str = "",
        collection_id: Optional[str] = None,
        parent_item_id: Optional[str] = None,
    ) -> Document:
        """创建文档。

        ：文档只挂 Organization。``space_id`` 参数已废弃——传入会被忽略，
        落库恒为 ``NULL``，不做 Space 宿主校验。

        ：``parent_item_id`` 写入 ContextItem.parent（知识库 UI 树），
        与 ``parent_id``（Document 内部页面树）互不影响。
        """
        if not self.check_organization_permission(organization_id, required_role="editor"):
            raise PermissionError(_("tabdoc.no_permission_to_create_document"))

        if space_id:
            logger.info(
                "create_document: ignoring deprecated space_id=%s (org-only )",
                space_id,
            )

        parent: Optional[Document] = None
        if parent_id:
            parent = self.get_document(parent_id, required_role="viewer")
            if str(parent.organization_id) != organization_id:
                raise ValueError(_("tabdoc.parent_not_in_same_space"))
            if self._get_document_depth(parent) + 1 >= MAX_DOCUMENT_PARENT_DEPTH:
                raise ValueError(_("tabdoc.parent_max_depth_exceeded"))

        collection_uuid = None
        if collection_id:
            collection_uuid = self._parse_uuid(collection_id, "collection_id")
            # Collection 仍挂 Workspace/Project；只校验同 org，不再按 space 对齐
            collection_qs = Collection.objects.filter(
                id=collection_uuid,
            ).filter(
                models.Q(workspace__organization_id=organization_id)
                | models.Q(project__organization_id=organization_id)
                | models.Q(organization_id=organization_id)
            )
            if not collection_qs.exists():
                raise ValueError(_("tabdoc.collection_not_in_same_space"))

        parent_item_uuid = None
        if parent_item_id:
            from apps.tabtinspace.models import ContextItem as CtxItem
            from apps.tabtinspace.services.context_item_parent import (
                resolve_parent_item,
                validate_parent_for_item,
            )

            parent_item_uuid = self._parse_uuid(parent_item_id, "parent_item_id")
            parent_ctx = resolve_parent_item(parent_item_uuid)
            host_stub = CtxItem(
                organization_id=self._parse_uuid(organization_id, "organization_id"),
                item_type="tabdoc",
            )
            validate_parent_for_item(item=None, parent=parent_ctx, host_item=host_stub)

        title_text = (title or "").strip() or "未命名文档"
        cover_ref = normalize_public_asset_ref(cover_image or "")
        markdown_text = initial_content_markdown or ""
        plaintext_text = initial_content_plaintext or self._normalize_plaintext(markdown_text)
        pm_json = initial_content_pm_json or {}
        if not pm_json.get("content") and markdown_text:
            try:
                converted = markdown_to_pm_json(markdown_text)
                if not isinstance(converted, dict) or not converted.get("content"):
                    raise ValueError("initial_content_markdown 转换结果为空")
                pm_json = converted
            except ValueError:
                raise
            except Exception as exc:
                logger.warning(
                    "create_document: markdown→pm_json 转换失败: title=%s",
                    title_text,
                    exc_info=True,
                )
                raise ValueError("initial_content_markdown 转换失败") from exc

        # ：落库前补齐顶层 blockId，文档从创建起就带稳定锚点，
        # list-blocks 不再吐 auto_N 位置别名（避免后续 block 操作指错块）。
        ensure_top_level_block_ids(pm_json)

        safe_user = self._safe_user_for_fk()
        owner_id = getattr(safe_user, "id", None)
        db_alias = postgres_app_db_alias()
        with transaction.atomic(using=db_alias):
            from apps.services.billing.services.entitlement_limits_service import EntitlementLimitsService
            from apps.tabtinspace.models import Organization

            Organization.objects.using(db_alias).select_for_update().get(
                id=self._parse_uuid(organization_id, "organization_id"),
            )
            EntitlementLimitsService.check_document_limit(
                organization_id,
                actor=self.user,
            )
            document = Document.objects.create(
                organization_id=self._parse_uuid(organization_id, "organization_id"),
                space_id=None,
                owner_id=owner_id,
                parent=parent,
                title=title_text,
                icon=icon or "",
                cover_image=cover_ref,
                description_json=pm_json,
                description_markdown=markdown_text,
                description_plaintext=plaintext_text,
                latest_version=1,
                created_by=safe_user,
                updated_by=safe_user,
            )
            from apps.tabdoc.services.image_asset_service import ImageAssetService

            ImageAssetService.adopt_document_import_job_images(
                document,
                pm_json,
                user_id=owner_id,
            )
            logger.info(
                "create_document: doc=%s organization=%s user=%s title=%s",
                document.id, organization_id, self._get_editor_id(), title_text,
            )
            # CAP-004: 为创建者写入 owner 权限记录，确保 is_private=True 时仍可访问
            if self.user:
                DocumentPermission.objects.create(
                    document=document,
                    subject_type="user",
                    subject_id=str(self.user.id),
                    permission="owner",
                    is_active=True,
                    created_by=safe_user,
                    granted_by=str(self.user.id),
                )
            transaction.on_commit(
                lambda: ResourceBridge.on_create(
                    document,
                    user=safe_user,
                    collection_id=collection_uuid,
                    parent_item_id=parent_item_uuid,
                ),
                using="postgresql",
            )

            _doc_id_for_vh = document.id
            _organization_uuid = document.organization_id
            _pm_json_for_vh = pm_json
            _md_for_vh = markdown_text
            _pt_for_vh = plaintext_text
            _editor_id_for_vh = self._get_editor_id()
            # 归因须在请求上下文内同步求值：AgentRunContextMiddleware 把 run_id 还原到
            # ContextVar，而 _create_initial_vh 经 on_commit 延迟执行。复用 _get_editor_type()
            # （正确的 platform_context import + 尊重 editor_type override），不要在此内联
            # 重写——历史上内联版误从 agent_engine.execution_context 导入，import 永久失败被
            # except 吞掉，导致 Agent 建的文档初始版本一律记成 user。
            _editor_type_for_vh = self._get_editor_type()
            # on_commit 执行时请求级 ContextVar 可能已被 middleware 清理，必须在事务内
            # 同步捕获真实 run/session。仅真实 run_id 存在时才写 Agent create ChangeLog，
            # 避免显式 editor_type=agent 但并非 Agent run 的系统调用被错误纳入整轮撤销。
            _agent_run_id_for_vh = ""
            _session_id_for_vh = ""
            try:
                from apps.services.common.platform_context import (
                    get_current_run_id,
                    get_current_session_id,
                )

                _agent_run_id_for_vh = get_current_run_id() or ""
                _session_id_for_vh = get_current_session_id() or ""
            except ImportError:
                pass

            def _create_initial_vh():
                try:
                    snapshot_data = {
                        "format": "json_snapshot",
                        "title": title_text,
                        "description_json": _pm_json_for_vh,
                        "description_markdown": _md_for_vh,
                        "description_plaintext": _pt_for_vh,
                    }
                    if _editor_type_for_vh == "agent" and _agent_run_id_for_vh:
                        DocumentService._record_content_history(
                            document,
                            change_type="create",
                            snapshot_data=snapshot_data,
                            editor_type=_editor_type_for_vh,
                            editor_id=_editor_id_for_vh,
                            agent_run_id=_agent_run_id_for_vh,
                            session_id=_session_id_for_vh,
                            summary="Agent 创建文档",
                            changes={"title": title_text},
                            use_locked_create=True,
                            skip_throttle=True,
                        )
                    else:
                        from apps.collab.adapters.docs import DocsCollabAdapter
                        from apps.collab.service import VersionHistoryService

                        adapter = DocsCollabAdapter()
                        svc = VersionHistoryService(adapter)
                        svc.create_history(
                            resource_id=_doc_id_for_vh,
                            data=snapshot_data,
                            editor_info={"editor_type": _editor_type_for_vh, "editor_id": _editor_id_for_vh},
                            force_snapshot=True,
                            organization_id=_organization_uuid,
                        )
                    logger.info(
                        "create_document: initial VH created for doc=%s",
                        _doc_id_for_vh,
                    )
                except Exception:
                    logger.warning(
                        "create_document: failed to create initial VH for doc=%s (non-blocking)",
                        _doc_id_for_vh, exc_info=True,
                    )

            transaction.on_commit(_create_initial_vh, using="postgresql")

        self._update_search_vector(document, plaintext=plaintext_text)

        # 同步写 binary，避免 UI 立刻打开时 collab-live 用 lossy markdown 迁移并回写洗样式。
        # 失败不阻塞创建：description_json 已落库，fetch 侧应优先 pm_json→binary。
        DocumentService._init_description_binary(document, pm_json)

        if cover_ref:
            _doc_id = str(document.id)
            _cover = cover_ref
            transaction.on_commit(
                lambda: self._create_cover_file_usage(_doc_id, _cover),
                using="postgresql",
            )

        return document

    def update_document(
        self,
        document: Document,
        *,
        base_version: Optional[int] = None,
        base_updated_at: Optional[str] = None,
        title: Optional[str] = None,
        parent_id: Optional[str] = None,
        collection_id: Optional[str] = None,
        status: Optional[str] = None,
        icon: Optional[str] = None,
        cover_image: Optional[str] = None,
        cover_position: Optional[float] = None,
        tags: Optional[list] = None,
        properties: Optional[dict] = None,
        is_full_width: Optional[bool] = None,
        font_style: Optional[str] = None,
        is_private: Optional[bool] = None,
    ) -> Document:
        self.assert_document_content_editable(document)
        if not self.check_document_permission(document, required_role="editor"):
            raise PermissionError(_("tabdoc.no_permission_to_edit"))

        current_version = int(document.latest_version or 0)
        if base_version is not None and int(base_version) != current_version:
            raise ConflictError(
                _("tabdoc.version_conflict", current=str(current_version), expected=int(base_version))
            )
        db_alias = (
            getattr(getattr(document, "_state", None), "db", None)
            or router.db_for_write(Document, instance=document)
            or "postgresql"
        )

        expected_updated_at = getattr(document, "updated_at", None)
        if base_updated_at is not None:
            parsed_updated_at = parse_datetime(base_updated_at)
            if parsed_updated_at is None:
                raise ValueError("base_updated_at is invalid")
            expected_updated_at = parsed_updated_at

        update_fields = {}
        changed = False

        if title is not None:
            text = title.strip()
            if not text:
                raise ValueError(_("tabdoc.title_cannot_be_empty"))
            if document.title != text:
                document.title = text
                update_fields["title"] = text
                changed = True

        if status is not None:
            # CAP-005: 禁止通过 update_document 直接修改 status，
            # 必须走 archive_document / restore_document 等专用流程，
            # 以确保 ResourceBridge 回调和 FileUsage 计量正确触发
            raise ValueError(_("tabdoc.status_change_not_allowed_via_update"))

        if parent_id is not None:
            if parent_id == "":
                if document.parent_id is not None:
                    document.parent = None
                    update_fields["parent_id"] = None
                    changed = True
            else:
                parent_doc = self.get_document(parent_id, required_role="viewer")
                self._validate_document_parent(document, parent_doc)
                if document.parent_id != parent_doc.id:
                    document.parent = parent_doc
                    update_fields["parent_id"] = parent_doc.id
                    changed = True

        if collection_id is not None:
            from apps.tabtinspace.models import ContextItem

            if collection_id == "":
                target_collection_id = None
            else:
                target_collection_id = self._parse_uuid(collection_id, "collection_id")
                collection_qs = Collection.objects.filter(id=target_collection_id).filter(
                    models.Q(workspace__organization_id=document.organization_id)
                    | models.Q(project__organization_id=document.organization_id)
                )
                if not collection_qs.exists():
                    raise ValueError(_("tabdoc.collection_not_in_same_space"))

            ctx_item = ContextItem.objects.filter(
                item_type="tabdoc",
                resource_id=str(document.id),
                organization_id=document.organization_id,
            ).first()
            if ctx_item and ctx_item.collection_id != target_collection_id:
                ctx_item.collection_id = target_collection_id
                ctx_item.save(update_fields=["collection_id", "updated_at"])

        # ── 文档属性 ──
        if icon is not None:
            if document.icon != icon:
                document.icon = icon
                update_fields["icon"] = icon
                changed = True
        if cover_image is not None:
            cover_ref = normalize_public_asset_ref(cover_image)
            if document.cover_image != cover_ref:
                old_cover_url = document.cover_image
                document.cover_image = cover_ref
                update_fields["cover_image"] = cover_ref
                changed = True
                # TDOC-3: 封面更换/删除时 deactivate 旧封面的 FileUsage，防止 OSS 泄漏
                if old_cover_url:
                    _doc_id = str(document.id)
                    _old_url = old_cover_url
                    transaction.on_commit(
                        lambda: self._deactivate_old_cover_file_usage(_doc_id, _old_url),
                        using="postgresql",
                    )
                if cover_ref:
                    _doc_id2 = str(document.id)
                    _new_url = cover_ref
                    transaction.on_commit(
                        lambda: self._create_cover_file_usage(_doc_id2, _new_url),
                        using="postgresql",
                    )
        if cover_position is not None:
            normalized_cover_position = max(0.0, min(1.0, cover_position))
            if document.cover_position != normalized_cover_position:
                document.cover_position = normalized_cover_position
                update_fields["cover_position"] = normalized_cover_position
                changed = True
        if tags is not None:
            if document.tags != tags:
                document.tags = tags
                update_fields["tags"] = tags
                changed = True
        if properties is not None:
            if document.properties != properties:
                document.properties = properties
                update_fields["properties"] = properties
                changed = True
        if is_full_width is not None:
            if bool(document.is_full_width) != bool(is_full_width):
                document.is_full_width = is_full_width
                update_fields["is_full_width"] = is_full_width
                changed = True
        if font_style is not None:
            if font_style not in {"default", "serif", "mono"}:
                raise ValueError(_("tabdoc.invalid_font_style"))
            if document.font_style != font_style:
                document.font_style = font_style
                update_fields["font_style"] = font_style
                changed = True
        # INF-01: is_private 列可能未迁移，安全降级
        if is_private is not None and self._is_private_safe():
            if bool(getattr(document, "is_private", False)) != bool(is_private):
                document.is_private = is_private
                update_fields["is_private"] = is_private
                changed = True

        if not changed:
            return document

        try:
            db_alias = postgres_app_db_alias()
            with transaction.atomic(using=db_alias):
                update_query = Document.objects.using(db_alias).filter(id=document.id, latest_version=current_version)
                if expected_updated_at is not None:
                    update_query = update_query.filter(updated_at=expected_updated_at)

                updated_rows = update_query.update(
                    **update_fields,
                    updated_by=self._safe_user_for_fk(),
                    updated_at=timezone.now(),
                )
                if updated_rows == 0:
                    latest_db_version = (
                        Document.objects.using(db_alias).filter(id=document.id)
                        .values_list("latest_version", flat=True)
                        .first()
                    )
                    latest_text = _("common.unknown") if latest_db_version is None else str(latest_db_version)
                    expected_text = current_version if base_version is None else int(base_version)
                    raise ConflictError(
                        _("tabdoc.version_conflict", current=latest_text, expected=expected_text)
                    )
        except ConflictError:
            raise

        document.updated_by = self._safe_user_for_fk()
        if hasattr(document, "refresh_from_db"):
            document.refresh_from_db(using=db_alias, fields=["updated_at"])
        ResourceBridge.on_update(document, user=self._safe_user_for_fk())
        self._update_search_vector(document, plaintext=document.description_plaintext or "")
        return document

    @transaction.atomic(using="postgresql")
    def archive_document(self, document: Document) -> Document:
        self.assert_document_viewable(document)
        # CAP-006: 已归档文档不可重复归档，防止重复 ResourceBridge 回调和 FileUsage 计量异常
        if document.status == "archived":
            raise ValueError(_("tabdoc.document_already_archived"))
        if not self.check_document_permission(document, required_role="editor"):
            raise PermissionError(_("tabdoc.no_permission_to_archive"))
        document.status = "archived"
        document.updated_by = self._safe_user_for_fk()
        document.save(update_fields=["status", "updated_by", "updated_at"])
        ResourceBridge.on_archive(document, user=self._safe_user_for_fk())
        logger.info(
            "archive_document: doc=%s space=%s organization=%s user=%s",
            document.id, document.space_id, document.organization_id, self._get_editor_id(),
        )

        # CAP-001: FileUsage 在 MySQL，不能放在 PostgreSQL 事务内操作
        # 移到 on_commit 确保 PostgreSQL 提交成功后再操作 MySQL
        transaction.on_commit(
            lambda: self._deactivate_document_file_usages(document),
            using="postgresql",
        )

        return document

    @transaction.atomic(using="postgresql")
    def unarchive_document(self, document: Document) -> Document:
        """TDOC-6: 从归档状态恢复文档并 reactivate FileUsage。"""
        if document.status != "archived":
            raise ValueError(_("tabdoc.document_not_archived"))
        if not self.check_document_permission(document, required_role="editor"):
            raise PermissionError(_("tabdoc.no_permission_to_restore"))

        ResourceBridge.check_restore_quota(document)

        document.status = "active"
        document.updated_by = self._safe_user_for_fk()
        document.save(update_fields=["status", "updated_by", "updated_at"])

        ResourceBridge.on_restore(document, user=self._safe_user_for_fk())
        logger.info(
            "unarchive_document: doc=%s space=%s organization=%s user=%s",
            document.id, document.space_id, document.organization_id, self._get_editor_id(),
        )

        transaction.on_commit(
            lambda: self._reactivate_document_file_usages(document),
            using="postgresql",
        )
        return document

    @transaction.atomic(using="postgresql")
    def trash_document(self, document: Document) -> Document:
        # CAP-008: 允许归档文档直接进回收站（assert_document_viewable 不阻止 archived 状态），
        # 归档 = "冷存储不再活跃使用"，trash 是用户清理归档内容的合理操作路径。
        # ：trash 仅 owner / resource admin（与 can_trash 能力位对齐）
        if not self.check_document_permission(document, required_role="admin"):
            raise PermissionError(_("tabdoc.no_permission_to_trash"))

        # ：源已在回收站时视为成功，仅补齐 ContextItem 投影（幽灵 CI 自愈）
        if getattr(document, "trashed_at", None) is not None:
            if not ResourceBridge.on_trash(document, user=self._safe_user_for_fk()):
                raise ValueError(_("tabdoc.trash_context_sync_failed"))
            logger.info(
                "trash_document_idempotent: doc=%s space=%s organization=%s user=%s",
                document.id, document.space_id, document.organization_id,
                self._get_editor_id(),
            )
            return document

        self.assert_document_viewable(document)

        from_archived = document.status == "archived"
        user_id = getattr(self.user, "id", None)
        document.trash(user_id=user_id, save=False)
        document.updated_by = self._safe_user_for_fk()
        document.save(update_fields=[
            "status", "trashed_at", "trashed_by", "previous_status",
            "updated_by", "updated_at",
        ])

        # ：源资源与 ContextItem 必须同步 trash，否则整笔事务回滚
        if not ResourceBridge.on_trash(document, user=self._safe_user_for_fk()):
            raise ValueError(_("tabdoc.trash_context_sync_failed"))
        logger.info(
            "trash_document: doc=%s space=%s organization=%s user=%s from_archived=%s",
            document.id, document.space_id, document.organization_id,
            self._get_editor_id(), from_archived,
        )
        # CAP-001: FileUsage 在 MySQL，移到 on_commit 避免跨库事务
        transaction.on_commit(
            lambda: self._deactivate_document_file_usages(document),
            using="postgresql",
        )
        return document

    def _can_manage_personal_trashed_document(self, document: Document) -> bool:
        """个人回收站：删除者可恢复/永删（历史空 trashed_by 回退 owner）。"""
        from apps.tabtinspace.services.cloud_resource_acl import is_personal_trash_operator

        return is_personal_trash_operator(
            self.user,
            trashed_by=getattr(document, "trashed_by", None),
            created_by_id=getattr(document, "owner_id", None),
        )

    @transaction.atomic(using="postgresql")
    def restore_document(self, document: Document) -> Document:
        if not getattr(document, "trashed_at", None):
            raise ValueError(_("tabdoc.document_not_in_trash"))
        if not self._can_manage_personal_trashed_document(document):
            raise PermissionError(_("tabdoc.no_permission_to_restore"))

        from apps.tabtinspace.services.cloud_resource_acl import check_restore_count_quota

        check_restore_count_quota(
            "tabdoc",
            getattr(document, "organization_id", None),
            self.user,
        )
        ResourceBridge.check_restore_quota(document)

        document.restore_from_trash(save=False)
        document.updated_by = self._safe_user_for_fk()
        document.save(update_fields=[
            "status", "trashed_at", "trashed_by", "previous_status",
            "updated_by", "updated_at",
        ])

        ResourceBridge.on_restore(document, user=self._safe_user_for_fk())
        logger.info(
            "restore_document: doc=%s space=%s organization=%s user=%s",
            document.id, document.space_id, document.organization_id, self._get_editor_id(),
        )
        # CAP-001: FileUsage 在 MySQL，移到 on_commit 避免跨库事务
        transaction.on_commit(
            lambda: self._reactivate_document_file_usages(document),
            using="postgresql",
        )
        return document

    @transaction.atomic
    def permanent_delete_document(self, document: Document, *, system_call: bool = False) -> None:
        """永久删除已进回收站的文档。

        单库模式下必须与 ResourceBridge / ContextItem 使用同一连接（default）。
        若外层 ``atomic(using="postgresql")`` 而 ContextItem 走 default，两边是
        同库不同连接——Document 删除失败回滚时 ContextItem 已提交，会出现
        「toast 失败但回收站列表已空」的假失败。
        """
        if not getattr(document, "trashed_at", None):
            raise ValueError(_("tabdoc.only_trashed_can_be_permanently_deleted"))
        if not system_call and not self._can_manage_personal_trashed_document(document):
            raise PermissionError(_("tabdoc.no_permission_to_permanently_delete"))

        user_id = getattr(self.user, "id", None)
        # CAP-009: 区分系统自动删除与人工删除，便于事后审计
        logger.info(
            "[PermanentDelete] module=tabdoc resource=%s name=%r user=%s system_call=%s",
            document.id, getattr(document, "title", ""), user_id, system_call,
        )

        # CAP-002: RAG 清理失败不阻断删除（向量数据可重建），但升级为 error 以便告警
        try:
            from apps.tabdoc.services.document_embedding_service import DocumentEmbeddingService
            with transaction.atomic():
                DocumentEmbeddingService.delete_document_index(str(document.id))
        except Exception:
            logger.error("permanent_delete: RAG 索引清理失败，向量数据需后续补偿清理: doc=%s", document.id, exc_info=True)

        # TDOC-5: 兜底 deactivate — trash 阶段的 deactivate 可能因单条异常被静默 catch，
        # 导致永久删除后仍有活跃 FileUsage 残留。在物理删除前再次清理。
        try:
            self._deactivate_document_file_usages(document)
        except Exception:
            logger.error(
                "[PermanentDelete] 兜底 FileUsage deactivate 失败: doc=%s",
                document.id, exc_info=True,
            )

        # CAP-007: ResourceBridge.on_delete 返回 False 表示 ContextItem 清理失败，
        # 此时中止物理删除防止产生孤儿引用；调用方可重试
        if not ResourceBridge.on_delete(document, user=self._safe_user_for_fk()):
            logger.error(
                "[PermanentDelete] ResourceBridge.on_delete 返回 False, "
                "中止物理删除以防止孤儿 ContextItem: %s(%s)",
                type(document).__name__, document.id,
            )
            raise ValueError(
                _("tabdoc.resource_bridge_delete_failed")
            )
        # 与外层 atomic / ResourceBridge 同走 default，避免 .using("postgresql") 跨连接
        Document.objects.filter(id=document.id).delete()

    @staticmethod
    def _deactivate_document_file_usages(document) -> None:
        """归档文档时 deactivate 其关联的 FileUsage 并释放存储计量。"""
        try:
            from apps.services.oss.models import FileUsage
            usages = FileUsage.objects.filter(
                module='tabdoc',
                context_type__in=['document', 'document_cover'],
                context_id=str(document.id),
                is_active=True,
            ).select_related("file_record")

            organization_id = str(getattr(document, "organization_id", ""))
            user_id = str(getattr(document, "created_by_id", "") or "")

            count = 0
            billing_reconciliation_needed = False
            for usage in usages:
                try:
                    file_size = usage.file_record.file_size if usage.file_record else 0
                    usage.deactivate()
                    count += 1

                    if organization_id and file_size > 0:
                        try:
                            from apps.services.billing.services import OrganizationStorageBillingService
                            OrganizationStorageBillingService.apply_storage_delta(
                                organization_id=organization_id,
                                file_id=str(usage.file_record_id),
                                delta_bytes=-file_size,
                                user_id=user_id,
                                biz_type="tabdoc_archive_release",
                                biz_id=str(document.id),
                            )
                        except Exception as billing_exc:
                            logger.warning(
                                "TabDoc 归档释放存储计量失败: doc=%s, file=%s, err=%s",
                                document.id, usage.file_record_id, billing_exc,
                            )
                            billing_reconciliation_needed = True
                            try:
                                from apps.services.billing.services.degradation_tracker import (
                                    track_billing_degradation,
                                )
                                track_billing_degradation(
                                    meter_key="storage.release",
                                    organization_id=organization_id,
                                    biz_type="tabdoc_archive_release",
                                    error=str(billing_exc),
                                )
                            except Exception:
                                pass
                except Exception as usage_exc:
                    logger.warning(
                        "TabDoc 归档 deactivate 单条失败: doc=%s, usage=%s, err=%s",
                        document.id, usage.id, usage_exc,
                    )

            if billing_reconciliation_needed:
                try:
                    from apps.services.billing.tasks import (
                        schedule_storage_snapshot_reconciliation,
                    )
                    schedule_storage_snapshot_reconciliation(
                        organization_id,
                        reason="tabdoc_archive_release",
                    )
                except Exception as schedule_exc:
                    logger.error(
                        "TabDoc 归档存储补偿任务安排失败: doc=%s, err=%s",
                        document.id, schedule_exc,
                    )

            if count:
                logger.info(
                    "TabDoc 归档清理: document_id=%s, deactivated %d FileUsage(s)",
                    document.id, count,
                )
        except Exception as e:
            logger.error(
                "TabDoc 归档清理 FileUsage 失败: %s", e, exc_info=True,
            )

    @staticmethod
    def _reactivate_document_file_usages(document) -> None:
        """从回收站恢复文档时 reactivate 其关联的 FileUsage 并恢复存储计量。"""
        try:
            from apps.services.oss.services.reactivate_utils import reactivate_file_usages_and_restore_storage

            result = reactivate_file_usages_and_restore_storage(
                module="tabdoc",
                context_filter={"context_id": str(document.id)},
                organization_id=str(getattr(document, "organization_id", "")),
                user_id=str(getattr(document, "created_by_id", "") or ""),
                biz_type="tabdoc_restore_storage",
                biz_id=str(document.id),
                log_prefix="TabDoc 恢复",
            )
            if result.has_failures:
                logger.warning(
                    "TabDoc 恢复 FileUsage 部分失败: doc=%s, %d 个文件不可恢复",
                    document.id, len(result.failed_files),
                )
        except Exception as e:
            logger.error("TabDoc 恢复 FileUsage 失败: %s", e, exc_info=True)

    @staticmethod
    def _create_cover_file_usage(document_id: str, cover_url: str) -> None:
        """INT-23: 为封面图片创建 FileUsage 记录，确保归档/删除时引用正确递减。"""
        if not cover_url:
            return
        try:
            from apps.services.oss.models import FileRecord, FileUsage
            from django.db.models import Q

            file_record = FileRecord.objects.filter(
                Q(file_key=cover_url) | Q(access_url=cover_url) | Q(cdn_url=cover_url)
            ).first()
            if not file_record:
                return

            exists = FileUsage.objects.filter(
                file_record=file_record,
                module="tabdoc",
                context_type="document_cover",
                context_id=document_id,
                is_active=True,
            ).exists()
            if exists:
                return

            FileUsage.add_usage(
                file_record=file_record,
                user_id="system",
                module="tabdoc",
                context_type="document_cover",
                context_id=document_id,
            )
            logger.debug("封面 FileUsage 创建: doc=%s", document_id)
        except Exception as e:
            logger.warning("封面 FileUsage 创建失败: doc=%s, err=%s", document_id, e)

    @staticmethod
    def _deactivate_old_cover_file_usage(document_id: str, old_cover_url: str) -> None:
        """TDOC-3: 封面更换/删除时 deactivate 旧封面对应的 FileUsage。"""
        try:
            from apps.services.oss.models import FileRecord, FileUsage
            from django.db.models import Q

            file_record = FileRecord.objects.filter(
                Q(file_key=old_cover_url) | Q(access_url=old_cover_url) | Q(cdn_url=old_cover_url)
            ).first()
            if not file_record:
                return

            usages = FileUsage.objects.filter(
                file_record=file_record,
                module='tabdoc',
                context_type='document_cover',
                context_id=document_id,
                is_active=True,
            )
            organization_id = str(file_record.organization_id or "")
            file_size = int(file_record.file_size or 0)
            count = 0
            for usage in usages:
                try:
                    from django.db import transaction
                    with transaction.atomic():
                        usage.deactivate()
                        if organization_id and file_size > 0:
                            try:
                                from apps.services.billing.services import OrganizationStorageBillingService
                                OrganizationStorageBillingService.apply_storage_delta(
                                    organization_id=organization_id,
                                    file_id=str(file_record.id),
                                    delta_bytes=-file_size,
                                    user_id="system",
                                    biz_type="tabdoc_cover_replace",
                                    biz_id=document_id,
                                )
                            except Exception as billing_exc:
                                logger.warning(
                                    "封面计量释放失败: doc=%s, err=%s",
                                    document_id, billing_exc,
                                )
                    count += 1
                except Exception as exc:
                    logger.warning(
                        "封面 FileUsage deactivate 失败: doc=%s, usage=%s, err=%s",
                        document_id, usage.id, exc,
                    )
            if count:
                logger.info(
                    "封面更换清理: document_id=%s, deactivated %d old cover FileUsage(s)",
                    document_id, count,
                )
        except Exception as e:
            logger.warning("封面 FileUsage 清理失败: doc=%s, err=%s", document_id, e)

    def create_recovery_draft(
        self,
        document: Document,
        *,
        base_version: int | None,
        content_pm_json: dict,
        content_markdown: str,
        content_plaintext: str,
    ) -> DocumentRecoveryDraft:
        """Persist a local divergent draft without modifying canonical content."""
        if not self.user or not getattr(self.user, "id", None):
            raise PermissionError("Authenticated editor is required to preserve a recovery draft")
        markdown = content_markdown or ""
        plaintext = content_plaintext or self._normalize_plaintext(markdown)
        if len(markdown.encode("utf-8")) > 5 * 1024 * 1024:
            raise ValueError("Recovery draft exceeds the 5MB content limit")
        draft = DocumentRecoveryDraft.objects.create(
            document=document,
            organization_id=document.organization_id,
            creator=self.user,
            base_version=base_version,
            content_pm_json=content_pm_json or {},
            content_markdown=markdown,
            content_plaintext=plaintext,
            expires_at=timezone.now() + timedelta(days=7),
        )
        logger.info(
            "document recovery draft preserved: doc=%s recovery=%s user=%s base_version=%s",
            document.id, draft.id, self.user.id, base_version,
        )
        return draft

    def list_recovery_drafts(self, document: Document, *, limit: int = 50) -> list[DocumentRecoveryDraft]:
        now = timezone.now()
        DocumentRecoveryDraft.objects.filter(
            document=document,
            status=DocumentRecoveryDraft.STATUS_ACTIVE,
            expires_at__lte=now,
        ).update(status=DocumentRecoveryDraft.STATUS_EXPIRED)
        return list(
            DocumentRecoveryDraft.objects.filter(document=document)
            .select_related("creator")
            .order_by("-created_at")[:max(1, min(limit, 100))]
        )

    def restore_recovery_draft(
        self,
        document: Document,
        recovery_id: str,
        *,
        base_version: int | None,
        base_updated_at: str | None,
    ) -> Document:
        """Explicitly promote a preserved draft through the normal audited save path."""
        recovery = DocumentRecoveryDraft.objects.filter(
            id=recovery_id,
            document=document,
            organization_id=document.organization_id,
            status=DocumentRecoveryDraft.STATUS_ACTIVE,
            expires_at__gt=timezone.now(),
        ).first()
        if recovery is None:
            raise ValueError("Recovery draft is unavailable or has expired")
        updated = self.save_content(
            document,
            base_version=base_version,
            base_updated_at=base_updated_at,
            content_pm_json=recovery.content_pm_json,
            content_markdown=recovery.content_markdown,
            content_plaintext=recovery.content_plaintext,
        )
        recovery.status = DocumentRecoveryDraft.STATUS_RESTORED
        recovery.restored_at = timezone.now()
        recovery.save(update_fields=["status", "restored_at", "updated_at"])
        logger.info(
            "document recovery draft restored: doc=%s recovery=%s user=%s",
            document.id, recovery.id, getattr(self.user, "id", None),
        )
        return updated

    def save_content(
        self,
        document: Document,
        *,
        share_grant: Optional[DocumentShare] = None,
        base_version: Optional[int],
        base_updated_at: Optional[str] = None,
        title: Optional[str] = None,
        content_pm_json: dict,
        content_markdown: str,
        content_plaintext: str,
    ) -> Document:
        """
        保存文档内容 — 原地更新 Document 表，不再追加 Revision 行。

        返回更新后的 Document（不再返回 Revision）。
        版本历史由 Celery 任务异步创建到 DocumentVersion 表。

        ``share_grant``：公开/团队分享链路的编辑授权。当 share.permission=edit
        且 share 仍 active 时，跳过常规协作者权限校验（允许匿名公开编辑）。
        """
        self.assert_document_content_editable(document)
        if share_grant is not None:
            if (
                share_grant.permission != "edit"
                or not getattr(share_grant, "is_active", True)
                or str(share_grant.document_id) != str(document.id)
            ):
                raise PermissionError(_("tabdoc.no_permission_to_edit"))
        elif not self.check_document_permission(document, required_role="editor"):
            raise PermissionError(_("tabdoc.no_permission_to_edit"))

        metrics = get_tabdoc_metrics()
        current_version = int(document.latest_version or 0)
        expected_version = current_version if base_version is None else int(base_version)
        # latest_version 是客户端并发契约的主 CAS；有 base_version 时忽略客户端
        # base_updated_at，避免序列化/数据库精度产生伪冲突。但仍保留本次服务端
        # 读取到的 updated_at 作为内部 CAS，防止读取后的元数据更新被正文保存覆盖。
        expected_updated_at = getattr(document, "updated_at", None)
        if base_version is None and base_updated_at is not None:
            parsed_updated_at = parse_datetime(base_updated_at)
            if parsed_updated_at is None:
                raise ValueError("base_updated_at is invalid")
            expected_updated_at = parsed_updated_at

        if base_version is not None and expected_version != current_version:
            metrics.record_save_conflict()
            raise ConflictError(_("tabdoc.version_conflict", current=current_version, expected=expected_version))

        markdown_text = content_markdown or ""
        plaintext_text = content_plaintext or self._normalize_plaintext(markdown_text)
        pm_json = content_pm_json or {}
        # 兼容 markdown-only 旧客户端：只有请求明确携带 PM content 时，才把 PM
        # 视为三份正文投影的真源。字段仍照旧接收，不改变 HTTP 请求契约。
        client_supplied_pm_json = (
            isinstance(content_pm_json, dict)
            and isinstance(content_pm_json.get("content"), list)
        )
        # 调用方只给 markdown（如 CLI `doc save-content --markdown`）、没给 PM JSON 时，
        # 在此补一次 markdown → PM JSON 转换。否则：
        #   1) description_json 会存成空 {}，block 工具读不到、VH 快照保真打折；
        #   2) 更要命：push_and_update_binary 开头 `if not pm_json: return` 会早退，
        #      整篇替换（TD-2 /docs/replace-content）根本不会推到协作编辑器，
        #      协作态下开着的 Tab 看不到 Agent 改动。
        # 与 api.py agent-push 端点（markdown→pm_json）行为对齐。
        if not pm_json.get("content") and markdown_text:
            try:
                from apps.tabdoc.services.markdown_exchange import markdown_to_pm_json
                converted = markdown_to_pm_json(markdown_text)
                if converted:
                    pm_json = converted
            except ValueError:
                # 业务输入校验（例如非法/空 :::tabdata tableId）必须由 API 映射为
                # 400，不能降级成空 PM JSON 后继续 200 保存。
                raise
            except Exception:
                logger.warning(
                    "save_content: markdown→pm_json 非业务异常，沿用空 pm_json: doc=%s",
                    document.id, exc_info=True,
                )
        # ：落库前补齐顶层 blockId，保证 list-blocks 返回稳定锚点而非 auto_N 位置别名，
        # 后续 insert/update/delete-block 才能精准定位、不随并发编辑漂移指错块。
        from apps.tabdoc.services.markdown_exchange import repair_leaked_htmlblock_in_pm_json
        pm_json, _htmlblock_repaired = repair_leaked_htmlblock_in_pm_json(pm_json)
        from apps.tabdoc.services.image_asset_service import ImageAssetService

        normalized_pm_json = ImageAssetService.normalize_pm_json_for_storage(
            document,
            pm_json,
            existing_pm_json=getattr(document, "description_json", None) or {},
        )
        should_derive_text_from_pm = (
            client_supplied_pm_json
            or normalized_pm_json != pm_json
            or ImageAssetService.pm_json_contains_file_assets(normalized_pm_json)
        )
        if should_derive_text_from_pm:
            from apps.tabdoc.services.markdown_exchange import (
                pm_json_to_markdown,
                pm_json_to_plaintext,
            )

            pm_json = normalized_pm_json
            markdown_text = pm_json_to_markdown(pm_json)
            plaintext_text = pm_json_to_plaintext(pm_json)
        ensure_top_level_block_ids(pm_json)
        next_version = expected_version + 1
        normalized_title = None
        if title is not None:
            normalized_title = title.strip()
            if not normalized_title:
                raise ValueError(_("tabdoc.title_cannot_be_empty"))

        old_markdown = document.description_markdown or ""

        try:
            db_alias = postgres_app_db_alias()
            with transaction.atomic(using=db_alias):
                # CAS（Compare-And-Set）更新，防止并发写入互相覆盖。
                update_query = Document.objects.filter(id=document.id, latest_version=expected_version)
                if expected_updated_at is not None:
                    update_query = update_query.filter(updated_at=expected_updated_at)

                updated_rows = update_query.update(
                    description_json=pm_json,
                    description_markdown=markdown_text,
                    description_plaintext=plaintext_text,
                    title=normalized_title if normalized_title is not None else document.title,
                    latest_version=next_version,
                    last_editor_type=self._get_editor_type(),
                    last_editor_id=self._get_editor_id(),
                    updated_by=self._safe_user_for_fk(),
                    updated_at=timezone.now(),
                )
                if updated_rows == 0:
                    latest_db_version = (
                        Document.objects.filter(id=document.id)
                        .values_list("latest_version", flat=True)
                        .first()
                    )
                    metrics.record_save_conflict()
                    latest_text = _("common.unknown") if latest_db_version is None else str(latest_db_version)
                    raise ConflictError(
                        _("tabdoc.version_conflict", current=latest_text, expected=expected_version)
                    )
        except ConflictError:
            raise
        except Exception:
            metrics.record_save_failure()
            raise

        # 同步内存对象，避免后续逻辑使用旧值。
        document.description_json = pm_json
        document.description_markdown = markdown_text
        document.description_plaintext = plaintext_text
        if normalized_title is not None:
            document.title = normalized_title
        document.latest_version = next_version
        document.last_editor_type = self._get_editor_type()
        document.last_editor_id = self._get_editor_id()
        document.updated_by = self._safe_user_for_fk()
        if hasattr(document, "refresh_from_db"):
            document.refresh_from_db(fields=["updated_at"])

        metrics.record_save_success()
        ResourceBridge.on_update(document, user=self._safe_user_for_fk())
        self._update_search_vector(document, plaintext=plaintext_text)

        try:
            from apps.tabdoc.services.doc_event_service import doc_event_service
            doc_id_str = str(document.id)
            editor_id_str = self._get_editor_id()
            editor_type = self._get_editor_type()

            def _publish_save_after_commit():
                try:
                    doc_event_service.publish_save(
                        doc_id_str,
                        editor_type=editor_type,
                        editor_id=editor_id_str,
                        latest_version=next_version,
                        document=document,
                    )
                except Exception:
                    logger.warning("publish_save failed after commit: doc=%s", doc_id_str, exc_info=True)

            # A daemon thread can publish before the DB transaction is visible or
            # disappear during process shutdown.  on_commit makes the event's
            # version observable before subscribers receive it.
            transaction.on_commit(_publish_save_after_commit)
        except Exception:
            logger.warning("Failed to register save event publication for doc=%s", document.id, exc_info=True)

        if old_markdown != markdown_text:
            editor_type = self._get_editor_type()
            editor_id = self._get_editor_id()

            # ：分享链接编辑经 share_grant 授权，但访客通常不是文档协作者，
            # 无法通过 collab apply-ops 的常规主体权限校验（resolve_write_subject
            # 对 editor_type=share 解析不出主体 → collab_subject_not_resolved），
            # 导致整篇替换推不进在线 Y.Doc，文档所有者协作态看不到访客改动。
            # 与版本恢复一致，改走 system trusted_internal 内部传播这次已授权的变更；
            # 去重标记同步用该 system 身份，让 onStore 回流命中标记、保持版本 +1 / 单条 VH。
            # VH 行本身仍按 share/访客归因（下方 _create_fallback_version_history），
            # 记录真实作者，不受推送身份影响。
            is_share_write = share_grant is not None
            push_editor_type = "system" if is_share_write else editor_type
            push_editor_id = SHARE_COLLAB_SYNC_EDITOR_ID if is_share_write else editor_id
            push_system_policy = "trusted_internal" if is_share_write else ""

            # ISSUE-C Phase 1: DB-first 写入后通知 collab-live，与 save_from_agent 对齐。
            try:
                from apps.collab.api import _invalidate_or_force_close
                _invalidate_or_force_close("docs", str(document.id), next_version)
            except Exception:
                logger.warning(
                    "save_content: notify collab-live version sync 失败 (doc=%s version=%d)",
                    document.id, next_version, exc_info=True,
                )

            # TD-1 / H-1：VersionHistory 不再是 push 的副产品。内容变更后**同步**写入
            # VersionHistory + ChangeLog，不依赖 push / onStore 成败，确保任意来源
            # （CLI / Agent / REST）改正文都一定留痕、可回滚、可审计。
            # flag 关闭时回退到旧行为（仅 push 失败才兜底补 VH），便于灰度 / 回滚。
            sync_vh_enabled = getattr(settings, "TABDOC_SYNC_VH_ON_SAVE_CONTENT", True)
            if sync_vh_enabled:
                vh = self._create_fallback_version_history(
                    document, pm_json, editor_type=editor_type, editor_id=editor_id,
                )
                if vh is not None:
                    # TD-4 Phase 4b（路线 A）：H-1 已同步写权威 VH。打一个短键标记，
                    # 让本次变更随后经 push → collab-live → onStore(collab_persist) 回流时，
                    # onStore 跳过重复写 VH/CL（消除双写）。归因随标记带上，去重时按同源校验。
                    # ：分享写入以 system 身份推送，标记须用同一身份，onStore 才命中。
                    self._mark_vh_synced_for_onstore(
                        document, editor_type=push_editor_type, editor_id=push_editor_id,
                    )

            # TD-4 Phase 4e-2：本次 save_content 已对 latest_version 做过 DB-first +1。
            # 打一个版本去重标记，让随后经 push → collab-live → onStore(save_from_hocuspocus)
            # 回流的那次落库**跳过版本 +1**，避免版本号双跳（v17→v18→v19）。
            # 与 VH 同步 flag 解耦：双跳是版本号自身问题，flag 关闭时同样会双跳，故无条件打标。
            # ：分享写入以 system 身份推送，标记须用同一身份，onStore 才命中。
            self._mark_version_synced_for_onstore(
                document, editor_type=push_editor_type, editor_id=push_editor_id,
            )

            # push 仅负责 Y.js 协作态同步；VH 已由上一步保证，except 不再承担留痕职责。
            try:
                self.push_and_update_binary(
                    document, pm_json,
                    agent_id=push_editor_id,
                    editor_type=push_editor_type,
                    system_policy=push_system_policy,
                )
            except Exception:
                logger.warning(
                    "save_content: Y.js push + binary update failed (non-blocking%s): doc=%s",
                    "，VH 已同步写入" if sync_vh_enabled else "",
                    document.id, exc_info=True,
                )
                # push 失败 → 本次内容不会经 collab-live → onStore 回流，上面打的
                # vh_synced / ver_synced 去重标记不会被对应 onStore 消费。主动清除，
                # 避免残留标记在 TTL 内误伤后续无关 onStore（如同 run 的 Y-first 写入）
                # ——否则会把那次本该 +1 的 onStore 误判为「已同步」而跳过，造成版本欠号 /
                # 漏写 VH。replace 已应用但 HTTP 响应丢失的罕见场景下，代价仅是本次版本号
                # 多跳一档（无内容丢失），可接受。
                self._clear_synced_markers_for_onstore(document)
                if not sync_vh_enabled:
                    self._create_fallback_version_history(
                        document, pm_json, editor_type=editor_type, editor_id=editor_id,
                    )

        return document

    # ═══════════════════════════════════════════════════════════════════
    # V3 新增方法 — Hocuspocus / Agent / 合并 / 历史
    # ═══════════════════════════════════════════════════════════════════

    def save_from_hocuspocus(
        self,
        document: Document,
        *,
        update_blob: bytes,
        editor_type: str = "user",
        editor_id: str = "",
        description_html: str = None,  # type: ignore[assignment]  # collab-live store 方向传入的是真 HTML
        description_json: dict = None,
    ) -> Optional[DocUpdate]:
        """
        Hocuspocus onStoreDocument 回调 — 写入 DocUpdate 队列 + 更新快照。

        collab-live 的 Database Extension 在 store 时附带格式转换结果，
        Django 直接落库到 Document，省去后续 merge 的转换开销。

        注意：参数 description_html 来自 collab-live，内容为 ProseMirror 序列化
        的真 HTML，映射到 DB 字段 description_markdown。
        """
        # CAP-010: 统一权限检查 — 无论 editor_type 是 user 还是 agent，
        # 只要有 editor_id 就尝试解析 User 并校验文档权限。
        if editor_type == "share":
            from apps.services.common.public_share.collab_token import parse_share_guest_id
            from apps.services.common.public_share.exceptions import ShareExpiredError, ShareNotFoundError
            from apps.tabdoc.services.share_service import DocumentShareService

            share_id, user_id = parse_share_guest_id(editor_id)
            if not share_id or not user_id:
                raise PermissionError(_("tabdoc.no_permission_to_edit"))
            try:
                share = DocumentShareService.get_share_by_id(share_id)
            except (ShareNotFoundError, ShareExpiredError):
                raise PermissionError(_("tabdoc.no_permission_to_edit")) from None
            if getattr(share, "permission", "view") != "edit":
                raise PermissionError(_("tabdoc.no_permission_to_edit"))
            resource = DocumentShareService._resource_from_share(share)
            if str(resource.id) != str(document.id):
                raise PermissionError(_("tabdoc.no_permission_to_edit"))
            from django.contrib.auth import get_user_model
            User = get_user_model()
            try:
                editor_user = User.objects.get(id=user_id)
            except (User.DoesNotExist, ValueError, TypeError):
                raise PermissionError(_("tabdoc.no_permission_to_edit")) from None
            editor_service = DocumentService(user=editor_user, editor_type="share")
            editor_service.assert_document_collab_writable(document)
        elif editor_id:
            from django.contrib.auth import get_user_model
            User = get_user_model()
            try:
                editor_user = User.objects.get(id=editor_id)
            except (User.DoesNotExist, ValueError, TypeError):
                # ValueError/TypeError: editor_id 不是合法 UUID（如 agent 实体 ID "system:restore_history"）
                if editor_type == "user":
                    raise PermissionError(_("tabdoc.no_permission_to_edit"))
                # agent editor_id 可能不是 User UUID（如 Agent 实体 ID），
                # collab-live 已通过 shared secret 在传输层认证，此处记录审计日志。
                logger.info(
                    "save_from_hocuspocus: non-user editor_id=%s editor_type=%s doc=%s, "
                    "trusted internal service path",
                    editor_id, editor_type, document.id,
                )
            else:
                editor_service = DocumentService(user=editor_user)
                if not editor_service.check_document_permission(document, required_role="editor"):
                    raise PermissionError(_("tabdoc.no_permission_to_edit"))
        elif self.user:
            if not self.check_document_permission(document, required_role="editor"):
                raise PermissionError(_("tabdoc.no_permission_to_edit"))
        else:
            # 无 user 且无 editor_id：仅 collab-live shared secret 认证的内部回调应到达此路径
            logger.warning(
                "save_from_hocuspocus: no user and no editor_id, "
                "editor_type=%s doc=%s — permission check bypassed (internal service path)",
                editor_type, document.id,
            )

        self.assert_document_collab_writable(document)

        # TD-4 Phase 4e-2：消费 save_content 打的版本去重标记。若本次 onStore 落库来自
        # save_content（DB-first 已 +1）推上来的同一次变更，则跳过版本 +1，避免双跳。
        # 在 binary_unchanged 短路之前消费，确保标记一定被一次性清掉（即便本次 binary
        # 未变、提前 return），不残留误伤后续无关 onStore。同源校验只认本次来源，纯人手 /
        # Agent Y-first 的 onStore 无标记，照常 +1。Redis get/delete 在 DB 事务外执行。
        skip_version_bump = False
        try:
            from apps.collab.api import _consume_version_synced_marker
            marker_run_id, _ = self._resolve_history_attribution(editor_type, editor_id)
            skip_version_bump = _consume_version_synced_marker(
                "docs", str(document.id),
                editor_type=editor_type,
                editor_id=editor_id,
                agent_run_id=marker_run_id,
            )
        except Exception:
            logger.warning(
                "TD-4 4e-2: 消费 ver_synced 标记失败 (doc=%s, non-fatal)，按正常 +1 处理",
                document.id, exc_info=True,
            )
            skip_version_bump = False

        binary_unchanged = (
            document.description_binary is not None
            and bytes(document.description_binary) == bytes(update_blob)
        )
        if binary_unchanged:
            return None

        # BE-11 修复：select_for_update + CAS 版本比对，防止并发覆盖
        # CRT-05 修复：HTTP 调用（call_live_api）移到事务外，
        # 避免持锁期间等待 collab-live 导致 DB 连接池耗尽
        db_alias = router.db_for_write(Document, instance=document) or "postgresql"
        needs_format_conversion = False
        existing_pm_for_preserve: dict | None = None
        with transaction.atomic(using=db_alias):
            locked_doc = (
                Document.objects.using(db_alias)
                .select_for_update()
                .get(id=document.id)
            )

            # CAS：数据库版本与调用方持有版本不一致 → 并发冲突
            if locked_doc.latest_version != document.latest_version:
                raise ConflictError(
                    f"Version conflict on document {document.id}: "
                    f"expected {document.latest_version}, got {locked_doc.latest_version}"
                )

            # Delay creating the audit row until after semantic no-op detection.

            # TD-4 Phase 4e-2：命中版本去重标记则不再 +1（本版本号已由 save_content
            # 的 DB-first +1 推进过），仅落 binary / 格式字段；否则照常 +1（纯人手 / agent
            # Y-first / 各类协作编辑的正常路径）。
            new_version = locked_doc.latest_version if skip_version_bump else locked_doc.latest_version + 1
            if skip_version_bump:
                logger.info(
                    "TD-4 4e-2: onStore skip latest_version bump for doc=%s "
                    "(already bumped by save_content), keeping v=%d",
                    document.id, new_version,
                )
            update_fields = {
                "description_binary": update_blob,
                "last_editor_type": editor_type,
                "last_editor_id": editor_id,
                "updated_at": timezone.now(),
                "latest_version": new_version,
            }
            existing_pm_for_preserve = getattr(locked_doc, "description_json", None) or {}

            if description_json is not None:
                from apps.tabdoc.services.image_asset_service import ImageAssetService

                description_json = ImageAssetService.normalize_pm_json_for_storage(
                    locked_doc,
                    description_json,
                    existing_pm_json=existing_pm_for_preserve,
                )
                #  / : stale collab snapshots may omit htmlBlock blockId
                # after share management adopted a client UUID. Preserve unambiguous
                # stable ids from the locked DB snapshot before overwrite.
                try:
                    from apps.tabdoc.services.markdown_exchange import (
                        preserve_stable_html_block_ids,
                    )

                    description_json = preserve_stable_html_block_ids(
                        description_json,
                        existing_pm_for_preserve,
                    ) or description_json
                except Exception:
                    logger.warning(
                        "save_from_hocuspocus: preserve_stable_html_block_ids failed "
                        "(non-fatal). doc=%s",
                        document.id,
                        exc_info=True,
                    )
                update_fields["description_json"] = description_json
                plaintext = self._extract_plaintext_from_json(description_json) if description_json else ""
                update_fields["description_plaintext"] = plaintext
                try:
                    from apps.tabdoc.services.markdown_exchange import pm_json_to_markdown
                    update_fields["description_markdown"] = pm_json_to_markdown(description_json)
                except Exception:
                    if description_html is not None:
                        update_fields["description_markdown"] = description_html

                # Y.js 客户端在打开文档时可能回放 IndexedDB 缓存或补写 schema
                # 元数据。此类更新会改变 binary，但没有改变用户可见内容，不能
                # 创建新版本、刷新 updated_at 或触发资源“已更新”通知。
                if description_json == (locked_doc.description_json or {}):
                    logger.info(
                        "save_from_hocuspocus: semantic no-op for doc=%s; skipping metadata update",
                        document.id,
                    )
                    return None
            else:
                needs_format_conversion = True

            doc_update = DocUpdate.objects.create(
                document=document,
                blob=update_blob,
                editor_type=editor_type,
                editor_id=editor_id,
            )

            Document.objects.using(db_alias).filter(id=document.id).update(**update_fields)
            transaction.on_commit(
                lambda doc_id=str(document.id): _schedule_doc_merge_debounce(doc_id),
                using=db_alias,
            )

        # CRT-05: 事务外执行 collab-live HTTP 转换，不再持有行级锁
        # 乐观锁：仅当 latest_version 未被并发写入更新时才写格式字段
        if needs_format_conversion:
            try:
                import base64 as _b64
                from apps.tabdoc.services.markdown_exchange import (
                    preserve_stable_html_block_ids,
                )

                blob_b64 = _b64.b64encode(update_blob).decode()
                formats = call_live_api("/convert/binary-to-formats", {
                    "binary_b64": blob_b64,
                })
                converted_json = formats.get("json", {}) or {}
                from apps.tabdoc.services.image_asset_service import ImageAssetService

                converted_json = ImageAssetService.normalize_pm_json_for_storage(
                    document,
                    converted_json,
                    existing_pm_json=existing_pm_for_preserve,
                )
                from apps.tabdoc.services.markdown_exchange import pm_json_to_markdown
                try:
                    converted_json = preserve_stable_html_block_ids(
                        converted_json,
                        existing_pm_for_preserve or {},
                    ) or converted_json
                except Exception:
                    logger.warning(
                        "save_from_hocuspocus: preserve after format conversion failed "
                        "(non-fatal). doc=%s",
                        document.id,
                        exc_info=True,
                    )
                rows = Document.objects.using(db_alias).filter(
                    id=document.id, latest_version=new_version,
                ).update(
                    description_json=converted_json,
                    description_markdown=pm_json_to_markdown(converted_json),
                    description_plaintext=formats.get("plaintext", ""),
                )
                if rows == 0:
                    logger.info(
                        "save_from_hocuspocus: version changed during format conversion, "
                        "skipping stale update. doc=%s expected_version=%d",
                        document.id, new_version,
                    )
            except RuntimeError:
                logger.warning(
                    "save_from_hocuspocus: collab-live unavailable for format conversion, "
                    "description_json may be stale. doc=%s",
                    document.id,
                )
                if description_html is not None:
                    Document.objects.using(db_alias).filter(
                        id=document.id, latest_version=new_version,
                    ).update(
                        description_markdown=description_html,
                    )

        logger.debug(
            "DocUpdate created + snapshot updated: doc=%s editor=%s/%s size=%d has_formats=%s v=%d",
            document.id, editor_type, editor_id, len(update_blob),
            bool(description_html), new_version,
        )

        # 协作路径用 queryset .update()，不触发 Django 信号，手动通知 ContextItem。
        # 只在内容（plaintext 或 binary）实际落库后才推，避免空保存也刷新。
        try:
            refreshed_doc = Document.objects.using(db_alias).get(id=document.id)
            ResourceBridge.on_update(refreshed_doc, user=None)
        except Exception:
            logger.warning(
                "save_from_hocuspocus: ResourceBridge.on_update failed (non-fatal). doc=%s",
                document.id, exc_info=True,
            )

        return doc_update

    @staticmethod
    def _extract_plaintext_from_json(pm_json: dict) -> str:
        """从 ProseMirror JSON 提取纯文本"""
        parts = []

        def _walk(node):
            if isinstance(node, dict):
                text = node.get("text")
                if text:
                    parts.append(str(text))
                for child in node.get("content", []):
                    _walk(child)

        _walk(pm_json)
        return "\n".join(parts).strip()

    def push_from_agent(
        self,
        document: Document,
        *,
        content_pm_json: dict,
        content_html: str = "",
        content_plaintext: str = "",
        agent_id: str = "",
    ) -> Document:
        """
        Y.js-first Agent 写入 — 变更先注入 Y.Doc，由 onStore 自动持久化。

        调用链: Agent → push_from_agent → _push_to_hocuspocus
                → collab-live /docs/push-changes → Y.Doc → 自动 onStore → DB

        如果 Y.js-first 未启用或 collab-live 不可用，自动降级到 save_from_agent。
        """
        if not self.check_document_permission(document, required_role="editor"):
            raise PermissionError(_("tabdoc.no_permission_to_edit"))
        self.assert_document_content_editable(document)
        from apps.services.common.config import is_yjs_first_enabled

        if not is_yjs_first_enabled("tabdoc"):
            return self.save_from_agent(
                document,
                content_pm_json=content_pm_json,
                content_html=content_html,
                content_plaintext=content_plaintext,
                agent_id=agent_id,
            )

        try:
            from apps.tabdoc.services.doc_event_service import doc_event_service
            doc_event_service.publish_editor_change(
                str(document.id), editor_type="agent", editor_id=agent_id,
                action="start", document=document,
            )
        except Exception:
            logger.debug("push_from_agent: publish_editor_change(start) failed: doc=%s", document.id, exc_info=True)

        try:
            self._push_to_hocuspocus(
                document, content_pm_json, agent_id=agent_id,
            )
            logger.info(
                "Y.js-first push_from_agent succeeded: doc=%s agent=%s",
                document.id, agent_id,
            )

            # ISSUE-C Phase 2（TD-2）：replace 后 description_binary 由 onStore →
            # save_from_hocuspocus 用正确 clock 回写，不再用 clock 从 0 起的 binary
            # 直写做兜底（DOC-001：直写会导致下次 fetch 合并重复/乱序）。

            plaintext = content_plaintext or self._normalize_plaintext(content_html)
            self._update_search_vector(document, plaintext=plaintext)

            document.last_editor_type = "agent"
            document.last_editor_id = agent_id

            self._write_sync_changelog(
                document, content_pm_json,
                editor_type="agent", editor_id=agent_id,
            )

            try:
                import threading as _th
                from apps.tabdoc.services.doc_event_service import doc_event_service
                _did = str(document.id)
                _aid = agent_id

                def _notify():
                    try:
                        doc_event_service.publish_editor_change(
                            _did, editor_type="agent", editor_id=_aid,
                            action="stop", document=document,
                        )
                    except Exception:
                        logger.debug("push_from_agent: publish_editor_change failed: doc=%s", _did, exc_info=True)

                _th.Thread(target=_notify, daemon=True).start()
            except Exception:
                pass

            return document
        except Exception as push_err:
            logger.warning(
                "Y.js-first push_from_agent failed, falling back to DB-first: doc=%s error=%s",
                document.id, push_err,
            )
            return self.save_from_agent(
                document,
                content_pm_json=content_pm_json,
                content_html=content_html,
                content_plaintext=content_plaintext,
                agent_id=agent_id,
            )

    def save_from_agent(
        self,
        document: Document,
        *,
        content_pm_json: dict,
        content_html: str = "",
        content_plaintext: str = "",
        agent_id: str = "",
    ) -> Document:
        """
        DB-first Agent 写入（降级路径 / 向后兼容）。

        接收已转换的 PM JSON，直接写 DB 并推送到 Y.Doc。
        Y.js-first 架构下优先使用 push_from_agent()。
        """
        if not self.check_document_permission(document, required_role="editor"):
            raise PermissionError(_("tabdoc.no_permission_to_edit"))
        self.assert_document_content_editable(document)
        metrics = get_tabdoc_metrics()
        current_version = int(document.latest_version or 0)
        next_version = current_version + 1

        plaintext = content_plaintext or self._normalize_plaintext(content_html)

        # ：Agent DB-first 写入同样补齐顶层 blockId，与 save_content / create_document
        # 口径一致，保证任意来源落库的文档都带稳定锚点。
        ensure_top_level_block_ids(content_pm_json)

        old_json = document.description_json

        try:
            with transaction.atomic(using="postgresql"):
                updated_rows = Document.objects.filter(
                    id=document.id, latest_version=current_version
                ).update(
                    description_json=content_pm_json,
                    description_markdown=content_html,
                    description_plaintext=plaintext,
                    latest_version=next_version,
                    last_editor_type="agent",
                    last_editor_id=agent_id,
                    updated_at=timezone.now(),
                )
                if updated_rows == 0:
                    metrics.record_save_conflict()
                    raise ConflictError(_("tabdoc.agent_write_conflict"))
        except ConflictError:
            raise
        except Exception:
            metrics.record_save_failure()
            raise

        document.description_json = content_pm_json
        document.description_markdown = content_html
        document.description_plaintext = plaintext
        document.latest_version = next_version
        document.last_editor_type = "agent"
        document.last_editor_id = agent_id

        metrics.record_save_success()
        ResourceBridge.on_update(document, user=self._safe_user_for_fk())
        self._update_search_vector(document, plaintext=plaintext)

        # E2E-022 + VS-002 fix: DB-first 写入后通知 collab-live 更新 Y.Doc version。
        # 使用统一降级函数：invalidate 失败或 updated=false 时自动降级为 force-close。
        try:
            from apps.collab.api import _invalidate_or_force_close
            _invalidate_or_force_close("docs", str(document.id), next_version)
        except Exception:
            logger.warning(
                "save_from_agent: notify collab-live version sync 失败 (doc=%s version=%d)",
                document.id, next_version, exc_info=True,
            )

        if old_json != content_pm_json:
            logger.debug("save_from_agent: content changed for doc=%s, VH will be written by collab/fallback path", document.id)

        try:
            self.push_and_update_binary(document, content_pm_json, agent_id=agent_id, editor_type="agent")
        except Exception:
            logger.warning(
                "save_from_agent: Y.js push + binary update failed (non-blocking): doc=%s",
                document.id, exc_info=True,
            )
            self._create_fallback_version_history(
                document, content_pm_json, editor_type="agent", editor_id=agent_id,
            )

        self._write_sync_changelog(
            document, content_pm_json,
            editor_type="agent", editor_id=agent_id,
        )

        try:
            import threading as _th
            from apps.tabdoc.services.doc_event_service import doc_event_service
            _did = str(document.id)
            _aid = agent_id
            _ver = next_version

            def _publish_agent_save():
                try:
                    doc_event_service.publish_save(
                        _did, editor_type="agent", editor_id=_aid,
                        latest_version=_ver, document=document,
                    )
                except Exception:
                    logger.warning("save_from_agent: publish_save failed: doc=%s", _did, exc_info=True)
                try:
                    doc_event_service.publish_editor_change(
                        _did, editor_type="agent", editor_id=_aid,
                        action="stop", document=document,
                    )
                except Exception:
                    logger.debug("save_from_agent: publish_editor_change failed: doc=%s", _did, exc_info=True)

            _th.Thread(target=_publish_agent_save, daemon=True).start()
        except Exception:
            logger.warning("Failed to publish events for agent save: doc=%s", document.id, exc_info=True)

        return document

    @staticmethod
    def _pm_json_has_collab_lossy_marks(pm_json: dict | None) -> bool:
        """Marks / attrs that markdown↔Yjs cannot round-trip (docx import fidelity)."""
        lossy_marks = {"textStyle", "highlight", "superscript", "subscript"}

        def walk(node: object) -> bool:
            if isinstance(node, dict):
                attrs = node.get("attrs")
                if isinstance(attrs, dict) and attrs.get("textAlign") not in (None, "", "left"):
                    return True
                for mark in node.get("marks") or []:
                    if isinstance(mark, dict) and mark.get("type") in lossy_marks:
                        return True
                return any(walk(value) for value in node.values())
            if isinstance(node, list):
                return any(walk(item) for item in node)
            return False

        return walk(pm_json or {})

    @staticmethod
    def _pm_json_to_update_b64(
        pm_json: dict,
        *,
        fragment_name: str = "default",
        max_retries: int = 1,
    ) -> str:
        """Convert PM JSON to a Y.js update without lossy Markdown as the primary path."""
        try:
            result = call_live_api("/convert/pm-json-to-update", {
                "pm_json": pm_json,
                "fragment_name": fragment_name,
            }, max_retries=max_retries)
            update_b64 = result.get("update_b64", "")
            if update_b64:
                return update_b64
        except Exception:
            # Docx import may carry textStyle/highlight/script marks. Falling back to
            # markdown here would strip them and onStore would persist the plain doc.
            if DocumentService._pm_json_has_collab_lossy_marks(pm_json):
                logger.error(
                    "pm-json-to-update failed for rich pm_json; "
                    "refusing markdown fallback to preserve import fidelity",
                    exc_info=True,
                )
                raise
            logger.warning(
                "pm-json-to-update failed, falling back to markdown conversion",
                exc_info=True,
            )

        from apps.tabdoc.services.markdown_exchange import pm_json_to_markdown

        markdown = pm_json_to_markdown(pm_json)
        if not markdown or not markdown.strip():
            return ""
        result = call_live_api("/convert/markdown-to-update", {
            "markdown": markdown,
            "fragment_name": fragment_name,
        }, max_retries=max_retries)
        return result.get("update_b64", "")

    @staticmethod
    def _replace_in_hocuspocus(
        document: Document,
        pm_json: dict,
        *,
        agent_id: str = "",
        editor_type: str = "agent",
        system_policy: str = "",
    ) -> None:
        """
        整篇替换语义：PM JSON → Y.js update → collab-live apply-ops xml.fragment.replace。

        TD-2 / ：collab-live 已移除 legacy replace-content 端点，与 restore deferred
        push 对齐，经 CollabApplyOpsService 在 Y.Doc 内清空 default fragment 后插入
        新正文（真 replace），再由 onStore 回写 DB。区别于 y.update.apply（merge）——
        后者在协作态会残留旧段落。

        失败时抛出异常（由调用方决定是否降级 / 非阻塞吞掉）。
        """
        from uuid import uuid4

        from apps.collab.apply_ops import CollabApplyOpsService
        from apps.services.common.platform_context import get_current_run_id

        update_b64 = DocumentService._pm_json_to_update_b64(pm_json, fragment_name="default")
        if not update_b64:
            raise RuntimeError("pm-json-to-update returned empty update")

        agent_run_id = get_current_run_id() or ""
        editor_id = agent_id or editor_type
        op_id = f"docs:{document.id}:replace:{agent_run_id or editor_id}:{uuid4().hex[:8]}"

        result = CollabApplyOpsService.apply_docs_ops(
            document_id=str(document.id),
            op_id=op_id,
            ops=[{
                "op": "xml.fragment.replace",
                "fragment": "default",
                "update_b64": update_b64,
            }],
            editor_type=editor_type,
            editor_id=editor_id,
            agent_run_id=agent_run_id,
            system_policy=system_policy,
        )
        if "error" in result or result.get("status") == "error":
            raise RuntimeError(
                result.get("error")
                or result.get("message")
                or result.get("code")
                or "apply_docs_ops failed",
            )

    def _push_to_hocuspocus(
        self,
        document: Document,
        content_pm_json: dict,
        agent_id: str = "",
    ) -> None:
        """
        将 Agent 写入的内容整篇替换到 collab-live Y.Doc。

        ISSUE-C Phase 2（TD-2 / ）：save-content 语义是整段 replace，走 apply-ops
        的 xml.fragment.replace，不再用 y.update.apply（merge，协作态残留旧段落）。
        description_binary 由 Hocuspocus onStore → save_from_hocuspocus 回写。
        失败时抛出异常（由调用方决定是否降级）。
        """
        self._replace_in_hocuspocus(
            document, content_pm_json, agent_id=agent_id, editor_type="agent",
        )
        logger.info("Replaced agent content in hocuspocus: doc=%s agent=%s", document.id, agent_id)

    @staticmethod
    def _init_description_binary(document: Document, pm_json: dict) -> None:
        """
        为新创建的文档生成 description_binary（Y.js state）。

        确保协作模式首次打开时 onFetch 能拿到初始内容，
        而不是看到空白文档。

        容错策略：
        1. call_live_api 重试 1 次（在用户请求线程中，最多额外 0.5s）
        2. 优先使用 PM JSON 直转 Yjs update，避免 Markdown 中转丢失富样式；
           若接口不可用再降级 Markdown
        3. 若全部失败，description_markdown 已在 create_document
           中持久化，collab-live 的 fetchDocument 会在用户首次打开
           文档时自动从 markdown 迁移生成 binary
        4. 也可通过 manage.py fix_missing_binary 批量修复
        """
        if not pm_json:
            return
        try:
            update_b64 = DocumentService._pm_json_to_update_b64(pm_json, max_retries=1)
            if update_b64:
                binary_data = base64.b64decode(update_b64)
                Document.objects.filter(id=document.id).update(
                    description_binary=binary_data,
                )
                logger.info("Initialized description_binary for doc=%s", document.id)
        except Exception:
            has_markdown_fallback = bool(document.description_markdown and document.description_markdown.strip())
            logger.error(
                "Failed to init description_binary for doc=%s "
                "(markdown_fallback=%s, will be migrated on first open)",
                document.id,
                has_markdown_fallback,
                exc_info=True,
            )

    @staticmethod
    def ensure_description_binary(document_id) -> bool:
        """
        为缺失 description_binary 的文档补充生成。

        用于：
        - 后台修复任务：批量修复 collab-live 宕机期间创建的文档
        - API 读取前的按需修复

        Returns:
            True 如果成功生成或已存在，False 如果失败
        """
        doc = Document.objects.filter(id=document_id).only(
            "id", "description_binary", "description_markdown", "description_json",
        ).first()
        if not doc:
            return False
        if doc.description_binary:
            return True

        markdown = (doc.description_markdown or "").strip()
        if doc.description_json:
            try:
                update_b64 = DocumentService._pm_json_to_update_b64(doc.description_json)
                if update_b64:
                    binary_data = base64.b64decode(update_b64)
                    Document.objects.filter(id=document_id).update(
                        description_binary=binary_data,
                    )
                    logger.info("Repaired description_binary from pm_json for doc=%s", document_id)
                    return True
            except Exception:
                logger.warning(
                    "ensure_description_binary: pm_json conversion failed for doc=%s",
                    document_id, exc_info=True,
                )

        if not markdown.strip():
            return True

        try:
            result = call_live_api("/convert/markdown-to-update", {
                "markdown": markdown,
            })
            update_b64 = result.get("update_b64", "")
            if update_b64:
                binary_data = base64.b64decode(update_b64)
                Document.objects.filter(id=document_id).update(
                    description_binary=binary_data,
                )
                logger.info("Repaired description_binary for doc=%s", document_id)
                return True
        except Exception:
            logger.warning(
                "ensure_description_binary failed for doc=%s", document_id, exc_info=True,
            )
        return False

    @staticmethod
    def push_and_update_binary(
        document: Document, pm_json: dict, agent_id: str = "", editor_type: str = "agent",
        *, system_policy: str = "",
    ) -> None:
        """
        将整篇内容替换推送到 Hocuspocus，由 onStoreDocument 回写 description_binary。

        ISSUE-C Phase 2（TD-2 / ）: 走 apply-ops xml.fragment.replace（Y 层 fragment 清空+重插）
        而非 /docs/push-changes（Y.applyUpdate = merge）——save-content / agent 写入
        的产品语义是整段替换，merge 会在协作态残留旧段落。
        Hocuspocus replace 后通过 save_from_hocuspocus 将正确的 CRDT 状态写回 DB。

        DOC-001: 不直接写 description_binary。转换接口创建的 Y.Doc clock 从 0 开始，
        直接写入 DB 会与 Hocuspocus 内存 Y.Doc 的 clock 不兼容，导致下次 fetch 时
        CRDT 合并产生内容重复或乱序。replace 同样由 onStore 回写 binary。

        editor_type: "user" | "agent" | "system"，标识操作来源，影响 persist 权限校验路径。
        """
        if not pm_json:
            return
        try:
            DocumentService._replace_in_hocuspocus(
                document, pm_json, agent_id=agent_id, editor_type=editor_type,
                system_policy=system_policy,
            )
            logger.debug(
                "Replaced doc content in Hocuspocus: doc=%s editor_type=%s editor_id=%s "
                "(binary will be updated by onStore callback)",
                document.id, editor_type, agent_id,
            )
        except Exception:
            logger.warning(
                "push_and_update_binary failed (non-blocking): doc=%s",
                document.id, exc_info=True,
            )

    def merge_updates(self, document: Document) -> bool:
        """
        合并 DocUpdate 队列到 Document 快照。

        由 Celery merge_doc_updates 任务调用。
        返回 True 如果有更新被合并，否则 False。

        合并流程:
        1. 查询该文档所有待合并的 DocUpdate
        2. 调用 collab-live HTTP 端点合并 Y.js binaries
        3. 更新 Document 快照（binary + 派生格式）
        4. 触发 History 创建
        5. 删除已合并的 DocUpdate
        """
        # BE-12 修复：使用 select_for_update 串行化同一文档的合并操作
        # CRT-05 修复：HTTP 调用移到事务外，避免持锁期间等待 collab-live
        db_alias = router.db_for_write(Document, instance=document) or "postgresql"
        # DOC-004: 记录事务内版本号，用于事务外乐观锁（替代 updated_at 时间戳）
        merge_version = None
        with transaction.atomic(using=db_alias):
            locked_doc = (
                Document.objects.using(db_alias)
                .select_for_update()
                .get(id=document.id)
            )

            updates = list(locked_doc.updates.order_by("created_at"))
            if not updates:
                return False

            last_update = updates[-1]
            editor_type = last_update.editor_type
            editor_id = last_update.editor_id

            latest_update = updates[-1]
            latest_blob = bytes(latest_update.blob) if latest_update.blob else b""

            merge_version = locked_doc.latest_version
            merge_ts = timezone.now()
            if latest_blob:
                Document.objects.using(db_alias).filter(id=document.id).update(
                    description_binary=latest_blob,
                    last_editor_type=editor_type,
                    last_editor_id=editor_id,
                    updated_at=merge_ts,
                )

            update_ids = [u.id for u in updates]
            DocUpdate.objects.filter(id__in=update_ids).delete()

        # CRT-05: 事务外执行 collab-live 格式转换，不再持有行级锁
        # DOC-004: 乐观锁使用 latest_version（整数计数器），替代 updated_at（时间戳）。
        # updated_at 毫秒精度在高频写入下可能碰撞，latest_version 无此问题。
        if latest_blob:
            try:
                import base64
                blob_b64 = base64.b64encode(latest_blob).decode()
                formats = call_live_api("/convert/binary-to-formats", {
                    "binary_b64": blob_b64,
                })
                rows = Document.objects.using(db_alias).filter(
                    id=document.id, latest_version=merge_version,
                ).update(
                    description_markdown=formats.get("markdown", ""),
                    description_json=formats.get("json", {}),
                    description_plaintext=formats.get("plaintext", ""),
                )
                if rows == 0:
                    logger.info(
                        "merge_updates: doc updated during format conversion, "
                        "skipping stale format write. doc=%s",
                        document.id,
                    )
            except RuntimeError:
                logger.warning(
                    "merge_updates: collab-live unavailable, binary saved without format conversion. doc=%s",
                    document.id,
                )

        logger.info(
            "Merged %d updates for doc=%s, last_editor=%s/%s",
            len(updates), document.id, editor_type, editor_id,
        )
        return True

    @staticmethod
    def _resolve_history_attribution(editor_type: str, editor_id: str) -> tuple[str, str]:
        """
        从 ContextVar 解析 (agent_run_id, session_id)，供四处恢复/降级路径共用。

        逐字节保持原各处行为：仅 agent 编辑才读取 run_id 并在缺失时回退 editor_id；
        session_id 始终尝试从 ContextVar 读取（QC-05，与 agent_run_id 对称）。
        """
        agent_run_id = ""
        if editor_type == "agent":
            try:
                from apps.services.common.platform_context import get_current_run_id
                agent_run_id = get_current_run_id() or ""
            except ImportError:
                pass
            if not agent_run_id and editor_id:
                agent_run_id = editor_id

        # QC-05: session_id 与 agent_run_id 对称从 ContextVar 读取
        session_id = ""
        try:
            from apps.services.common.platform_context import get_current_session_id
            session_id = get_current_session_id() or ""
        except ImportError:
            pass

        return agent_run_id, session_id

    @staticmethod
    def _record_content_history(
        document: Document,
        *,
        change_type: str,
        snapshot_data=None,
        editor_type: str = "",
        editor_id: str = "",
        agent_run_id: str = "",
        session_id: str = "",
        summary: str = "",
        changes: Optional[dict] = None,
        force_snapshot: bool = True,
        use_locked_create: bool = False,
        require_vh_for_changelog: bool = True,
        skip_throttle: bool = False,
    ):
        """
        TD-4 Phase 4a：构造「VersionHistory + ChangeLog」并在同一
        transaction.atomic 事务写入，收敛 _create_fallback_version_history /
        restore_history / restore_to_version_full / _post_restore_cleanup 四处
        近乎同构的写入逻辑。四处差异全部通过参数承载（见各调用点）。

        本方法**不吞异常**——失败由调用方按各自语义记录日志（四处的成功/失败
        日志级别与告警副作用不同，保留在调用点）。返回创建的 VersionHistory
        （可能为 None）。

        参数差异说明：
          snapshot_data:
              None  → 由本方法内部 adapter.get_version_data(document) 计算
                      （restore 三处原行为）
              非 None → 直接使用调用方传入的快照（fallback 用手工 json_snapshot dict）
          use_locked_create:
              False → svc._do_create_history（直写、无锁，restore 三处原行为）
              True  → svc.create_history（带 create_history_lock + restore_lock
                      检查 + 节流，可抛 RestoreInProgress / HistoryLockContention
                      等异常，对应 _create_fallback_version_history 原行为）
          require_vh_for_changelog:
              True  → 仅当 VH 非 None 才写 ChangeLog（restore 三处原行为）
              False → 无条件写 ChangeLog（fallback 原行为）
        """
        from apps.collab.models import ChangeLog
        from apps.collab.service import VersionHistoryService

        if use_locked_create:
            from apps.collab.registry import get_adapter_or_raise
            adapter = get_adapter_or_raise("docs")
        else:
            from apps.collab.adapters.docs import DocsCollabAdapter
            adapter = DocsCollabAdapter()

        svc = VersionHistoryService(adapter)

        if snapshot_data is None:
            snapshot_data = adapter.get_version_data(document)

        editor_info = {"editor_type": editor_type, "editor_id": editor_id}

        with transaction.atomic(using="postgresql"):
            if use_locked_create:
                vh = svc.create_history(
                    resource_id=document.id,
                    data=snapshot_data,
                    editor_info=editor_info,
                    force_snapshot=force_snapshot,
                    organization_id=getattr(document, "organization_id", None),
                    skip_throttle=skip_throttle,
                )
            else:
                vh = svc._do_create_history(
                    document.id,
                    snapshot_data,
                    editor_info,
                    force_snapshot=force_snapshot,
                    organization_id=getattr(document, "organization_id", None),
                )

            if vh is not None or not require_vh_for_changelog:
                ChangeLog.objects.using("postgresql").create(
                    resource_type="docs",
                    resource_id=document.id,
                    change_type=change_type,
                    summary=summary,
                    changes=changes if changes is not None else {},
                    editor_type=editor_type,
                    editor_id=editor_id,
                    agent_run_id=agent_run_id,
                    session_id=session_id,
                    version_history=vh,
                )

        return vh

    @staticmethod
    def _mark_vh_synced_for_onstore(
        document: Document,
        *,
        editor_type: str = "",
        editor_id: str = "",
    ) -> None:
        """
        TD-4 Phase 4b（路线 A）：标记「本文档本次变更的 VH 已由 save_content(H-1)
        同步写过」，供 collab_persist(onStore) 去重，消除 H-1 + onStore 双写。

        标记携带与 H-1 写入一致的归因（editor_type / editor_id / agent_run_id），
        collab_persist 据此做同源校验，确保只跳过「本次 save_content 触发」的那条
        onStore VH，而不误伤并发的纯人手 / 他人编辑。best-effort，失败不影响主流程。
        """
        try:
            agent_run_id, _session_id = DocumentService._resolve_history_attribution(
                editor_type, editor_id,
            )
            from apps.collab.api import mark_vh_synced
            mark_vh_synced(
                "docs", str(document.id),
                editor_type=editor_type,
                editor_id=editor_id,
                agent_run_id=agent_run_id,
            )
        except Exception:
            logger.warning(
                "TD-4 4b: 设置 vh_synced 标记失败 (doc=%s, non-fatal)",
                document.id, exc_info=True,
            )

    @staticmethod
    def _mark_version_synced_for_onstore(
        document: Document,
        *,
        editor_type: str = "",
        editor_id: str = "",
    ) -> None:
        """
        TD-4 Phase 4e-2：标记「本文档本次变更的 latest_version 已由 save_content
        做过 DB-first +1」，供 save_from_hocuspocus(onStore) 去重，消除版本号双跳。

        标记携带与 save_content 一致的归因（editor_type / editor_id / agent_run_id）
        及目标版本号，onStore 据此做同源校验，只跳过「本次 save_content 触发」的那次
        onStore +1，而不误伤并发的纯人手 / 他人编辑。best-effort，失败不影响主流程。
        """
        try:
            agent_run_id, _session_id = DocumentService._resolve_history_attribution(
                editor_type, editor_id,
            )
            from apps.collab.api import mark_version_synced
            mark_version_synced(
                "docs", str(document.id),
                editor_type=editor_type,
                editor_id=editor_id,
                agent_run_id=agent_run_id,
                version=int(document.latest_version or 0),
            )
        except Exception:
            logger.warning(
                "TD-4 4e-2: 设置 ver_synced 标记失败 (doc=%s, non-fatal)",
                document.id, exc_info=True,
            )

    @staticmethod
    def _clear_synced_markers_for_onstore(document: Document) -> None:
        """
        TD-4 4b / 4e-2：清除本文档的 vh_synced / ver_synced 去重标记。

        save_content push collab-live 失败时调用——此时内容不会经 onStore 回流，
        标记不会被对应 onStore 消费；主动清除避免残留标记在 TTL 内误伤后续无关
        onStore（同源校验只挡其他 editor，挡不住同一 run 的后续 Y-first 写入）。
        best-effort，失败不影响主流程。
        """
        try:
            from apps.collab.api import clear_synced_markers
            clear_synced_markers("docs", str(document.id))
        except Exception:
            logger.debug(
                "TD-4: 清除 onStore 去重标记失败 (doc=%s, non-fatal)",
                document.id, exc_info=True,
            )

    @staticmethod
    def _create_fallback_version_history(
        document: Document,
        data: dict,
        *,
        editor_type: str = "",
        editor_id: str = "",
    ):
        """
        在 DB 写入边界内同步创建 VersionHistory + ChangeLog。

        TD-4 Phase 4b 后这是 save_content（H-1）内容变更的**权威**版本记录来源
        （与 onStore 经共享锁 + 同源标记去重，onStore 检测到已写则跳过），同时也兜底
        collab-live push 失败、Y.js 不可用的场景——两种情况下 DB 写入都有版本记录与变更审计。

        AP-007: ChangeLog 携带 agent_run_id，使 rollback_agent_run 可感知此路径的变更。
        """
        try:
            snapshot_data = {
                "format": "json_snapshot",
                "title": document.title,
                "description_json": data,
                "description_markdown": document.description_markdown or "",
                "description_plaintext": getattr(document, "description_plaintext", None) or "",
            }

            agent_run_id, session_id = DocumentService._resolve_history_attribution(
                editor_type, editor_id,
            )

            vh = DocumentService._record_content_history(
                document,
                change_type="update",
                snapshot_data=snapshot_data,
                editor_type=editor_type,
                editor_id=editor_id,
                agent_run_id=agent_run_id,
                session_id=session_id,
                summary="内容更新",
                changes={"fallback": True},
                use_locked_create=True,
                require_vh_for_changelog=False,
                skip_throttle=(editor_type == "agent"),
            )

            if vh is not None:
                logger.info(
                    "Created fallback VersionHistory + ChangeLog for doc=%s editor=%s agent_run=%s",
                    document.id, editor_type, agent_run_id,
                )
            else:
                logger.warning(
                    "Fallback VersionHistory not created for doc=%s editor=%s agent_run=%s; "
                    "ChangeLog was written without version_history",
                    document.id, editor_type, agent_run_id,
                )
            return vh
        except Exception:
            logger.warning(
                "Failed to create fallback VersionHistory for doc=%s",
                document.id, exc_info=True,
            )
            return None

    @staticmethod
    def _write_sync_changelog(
        document: Document,
        data: dict,
        *,
        editor_type: str = "",
        editor_id: str = "",
    ) -> None:
        """
        同步写入 ChangeLog，消除 collab-live 异步回调的竞态窗口。

        AP-006: collab-live onStore 回调写 ChangeLog 是异步的，工具返回成功时记录
        可能尚未存在。在 save_from_agent() 中同步写入，确保 rollback_agent_run
        在工具返回后立即可查到变更记录。
        """
        try:
            from apps.collab.models import ChangeLog

            agent_run_id = ""
            got_from_context = False
            if editor_type == "agent":
                try:
                    from apps.services.common.platform_context import get_current_run_id
                    agent_run_id = get_current_run_id() or ""
                    got_from_context = bool(agent_run_id)
                except ImportError:
                    pass
                if not agent_run_id and editor_id:
                    agent_run_id = editor_id

            # QC-05: session_id 对称从 ContextVar 读取（sync_changelog 路径是 Agent
            # 在线 push 后的轻量标记，session_id 在 base_agent._start_run 已设置）
            session_id = ""
            try:
                from apps.services.common.platform_context import get_current_session_id
                session_id = get_current_session_id() or ""
            except ImportError:
                pass

            if not agent_run_id:
                if editor_type == "agent":
                    # CSC-010: editor_type=agent 但 agent_run_id 仍为空时，不静默返回。
                    # 打 warning 日志并以 editor_id 兜底写入 ChangeLog，
                    # 确保 rollback_agent_run 不会完全丢失此次操作。
                    logger.warning(
                        "_write_sync_changelog: editor_type=agent but agent_run_id is empty "
                        "(editor_id=%s, doc=%s); writing ChangeLog with agent_run_id_missing=True",
                        editor_id, document.id,
                    )
                else:
                    # 非 agent 操作（如 user 操作），不写 sync ChangeLog
                    return

            ChangeLog.objects.using("postgresql").create(
                resource_type="docs",
                resource_id=document.id,
                change_type="update",
                summary="",
                changes={
                    "sync_changelog": True,
                    **({"agent_run_id_missing": True} if (editor_type == "agent" and not got_from_context) else {}),
                },
                editor_type=editor_type,
                editor_id=editor_id,
                agent_run_id=agent_run_id or editor_id,
                session_id=session_id,
            )
        except Exception:
            logger.warning(
                "Failed to write sync ChangeLog for doc=%s",
                document.id, exc_info=True,
            )

    def _compute_yjs_diff(self, base_snapshot: DocHistory, new_binary: bytes) -> Optional[bytes]:
        """
        通过 collab-live 计算 Y.js 增量 diff。

        返回 diff 的原始 bytes（未压缩），失败返回 None。
        """
        try:
            base_binary = _decompress_history_blob(base_snapshot.blob)
            old_b64 = base64.b64encode(base_binary).decode()
            new_b64 = base64.b64encode(new_binary).decode()

            result = call_live_api("/yjs/compute-diff", {
                "old_binary_b64": old_b64,
                "new_binary_b64": new_b64,
            }, max_retries=0, timeout=5)

            diff_b64 = result.get("diff_b64", "")
            if not diff_b64:
                return None

            return base64.b64decode(diff_b64)
        except Exception:
            logger.warning(
                "Failed to compute yjs diff for doc history base=%s",
                base_snapshot.id, exc_info=True,
            )
            return None

    # ── 版本历史查询与恢复（统一走 VersionHistory） ──

    def list_histories(
        self, document: Document, limit: int = 50, offset: int = 0,
    ) -> dict:
        """列出文档版本历史，统一从 VersionHistory 查询。"""
        if not self.check_document_permission(document, required_role="viewer"):
            raise PermissionError(_("tabdoc.no_permission_to_access_history"))
        normalized_limit = max(1, min(int(limit), 200))
        normalized_offset = max(0, int(offset))
        from apps.collab.models import VersionHistory
        from django.db.models import Q
        qs = (
            VersionHistory.objects.using("postgresql")
            .filter(resource_type="docs", resource_id=document.id)
            .filter(Q(expired_at__isnull=True) | Q(expired_at__gt=timezone.now()))
            .order_by("-created_at")
        )
        total = qs.count()
        items = list(qs[normalized_offset:normalized_offset + normalized_limit])
        return {"items": items, "total": total, "limit": normalized_limit, "offset": normalized_offset}

    RESTORE_LOCK_TTL = 120

    def _acquire_best_effort_restore_lock(self, resource_id) -> bool:
        """Best-effort Redis 恢复锁，与 collab 层共享 key 格式。

        Returns True if lock acquired, False if failed (caller should still proceed).
        """
        from django.core.cache import cache
        lock_key = f"collab:restore_lock:docs:{resource_id}"
        try:
            acquired = cache.add(lock_key, 1, self.RESTORE_LOCK_TTL)
            if not acquired:
                logger.warning(
                    "restore_history: concurrent restore blocked for docs:%s, "
                    "proceeding without lock (best-effort)",
                    resource_id,
                )
            return acquired
        except Exception:
            logger.warning(
                "restore_history: Redis unavailable for restore lock docs:%s, "
                "proceeding without lock (best-effort)",
                resource_id, exc_info=True,
            )
            return False

    def _release_best_effort_restore_lock(self, resource_id) -> None:
        from django.core.cache import cache
        lock_key = f"collab:restore_lock:docs:{resource_id}"
        try:
            cache.delete(lock_key)
        except Exception:
            logger.warning(
                "restore_history: failed to release restore lock docs:%s",
                resource_id, exc_info=True,
            )

    def restore_history(
        self,
        document: Document,
        history_id: str,
        *,
        base_version: Optional[int] = None,
        base_updated_at: Optional[str] = None,
    ) -> Document:
        """
        从 DocHistory 恢复文档内容。

        恢复流程:
        1. 找到目标 History 记录
        2. 解析 blob（JSON snapshot 或 Y.js binary）
        3. 更新 Document 的所有内容字段
        """
        self.assert_document_content_editable(document)
        if not self.check_document_permission(document, required_role="editor"):
            raise PermissionError(_("tabdoc.no_permission_to_restore_version"))

        # P1-05: best-effort Redis 恢复锁，与 collab 层路径 A 共享锁 key
        lock_acquired = self._acquire_best_effort_restore_lock(document.id)
        try:
            return self._do_restore_history(
                document, history_id,
                base_version=base_version, base_updated_at=base_updated_at,
            )
        finally:
            if lock_acquired:
                self._release_best_effort_restore_lock(document.id)

    def _do_restore_history(
        self,
        document: Document,
        history_id: str,
        *,
        base_version: Optional[int] = None,
        base_updated_at: Optional[str] = None,
    ) -> Document:
        """restore_history 的实际执行逻辑（由 restore_history 在锁保护下调用）。"""
        history_uuid = self._parse_uuid(history_id, "history_id")

        restored = self._resolve_history_content_by_id(document, history_id)
        if not restored:
            raise ValueError(_("tabdoc.target_history_not_found"))
        current_version = int(document.latest_version or 0)
        if base_version is not None and int(base_version) != current_version:
            raise ConflictError(
                _("tabdoc.version_conflict", current=str(current_version), expected=int(base_version))
            )

        expected_updated_at = getattr(document, "updated_at", None)
        if base_updated_at is not None:
            parsed_updated_at = parse_datetime(base_updated_at)
            if parsed_updated_at is None:
                raise ValueError("base_updated_at is invalid")
            expected_updated_at = parsed_updated_at

        update_fields = {
            "latest_version": current_version + 1,
            "last_editor_type": self._get_editor_type(),
            "last_editor_id": self._get_editor_id(),
            "updated_at": timezone.now(),
        }

        _format_degraded = False

        if restored.get("format") == "json_snapshot":
            update_fields["description_json"] = restored.get("description_json", {})
            # 0013 迁移前写入的历史 blob 中 key 为 "description_html"，需兼容
            update_fields["description_markdown"] = (
                restored.get("description_markdown")
                or restored.get("description_html", "")
            )
            update_fields["description_plaintext"] = restored.get("description_plaintext", "")
            update_fields["description_binary"] = None
            if "title" in restored:
                update_fields["title"] = restored["title"]
        else:
            binary_data = restored.get("binary", b"")
            update_fields["description_binary"] = binary_data
            if binary_data:
                import base64
                try:
                    blob_b64 = base64.b64encode(binary_data).decode()
                    formats = call_live_api("/convert/binary-to-formats", {
                        "binary_b64": blob_b64,
                    })
                    update_fields["description_markdown"] = formats.get("markdown", "")
                    update_fields["description_json"] = formats.get("json", {})
                    update_fields["description_plaintext"] = formats.get("plaintext", "")
                except RuntimeError:
                    # CSC-004: collab-live 不可用时保留旧值而非清空，防止 Agent 读取到空内容。
                    # 旧的 description_json/markdown 虽然对应恢复前的版本，但比空值更安全。
                    # 通过 _restore_format_degraded 标记让 API 层返回可感知的警告。
                    update_fields["description_markdown"] = document.description_markdown or ""
                    update_fields["description_json"] = document.description_json or {}
                    update_fields["description_plaintext"] = document.description_plaintext or ""
                    _format_degraded = True
                    logger.warning(
                        "restore: collab-live unavailable, binary restored but text fields kept as-is. doc=%s",
                        document.id,
                    )

        with transaction.atomic(using="postgresql"):
            update_query = Document.objects.filter(id=document.id, latest_version=current_version)
            if expected_updated_at is not None:
                update_query = update_query.filter(updated_at=expected_updated_at)

            updated_rows = update_query.update(**update_fields)
            if updated_rows == 0:
                latest_db_version = (
                    Document.objects.filter(id=document.id)
                    .values_list("latest_version", flat=True)
                    .first()
                )
                latest_text = _("common.unknown") if latest_db_version is None else str(latest_db_version)
                expected_text = current_version if base_version is None else int(base_version)
                raise ConflictError(
                    _("tabdoc.version_conflict", current=latest_text, expected=expected_text)
                )
            DocUpdate.objects.filter(document=document).delete()

        document.refresh_from_db()
        ResourceBridge.on_update(document, user=self._safe_user_for_fk())
        self._update_search_vector(document, plaintext=document.description_plaintext or "")

        # CRT-21: 在 document 对象上标记降级状态，API 层可据此在响应中携带警告
        if _format_degraded:
            document._restore_format_degraded = True

        # TD-2 Phase 4c：restore 统一走 /docs/replace-content（replace 语义），与主写入链一致，
        # 不再用 /docs/push-changes（Y.applyUpdate = merge，协作态会残留旧段落）。
        # yjs_binary 恢复时 binary 已在上面经 /convert/binary-to-formats 转成 description_json
        # 写入 DB，这里复用 push_and_update_binary（内部 replace-content），由 onStore 回写干净
        # 的 CRDT 状态。直写到 DB 的历史 binary 只是过渡值，replace 后会被 onStore 覆盖，
        # 因此 DOC-001「不直写 binary（markdownToUpdate clock-0）」不变量保持不变。
        restored_json = update_fields.get("description_json") or document.description_json

        if _format_degraded:
            # CSC-004: collab-live 不可用，binary 已写 DB、文本字段保留旧值；此时无法 replace
            # （推送也会失败），跳过推送，待 collab-live 恢复后由首次打开迁移生成。
            logger.warning(
                "restore_history: collab-live degraded, skip replace push (binary kept in DB): doc=%s",
                document.id,
            )
        elif restored_json:
            for attempt in range(2):
                try:
                    self.push_and_update_binary(
                        document, restored_json, agent_id="system:restore_history",
                        editor_type="system",
                    )
                    break
                except Exception:
                    if attempt == 0:
                        import time
                        time.sleep(0.5)
                    else:
                        logger.error(
                            "restore_history: replace-content push failed after 2 attempts (non-blocking): doc=%s",
                            document.id, exc_info=True,
                        )

        # CSC-006: 强制断开在线用户连接，防止在线用户基于旧状态编辑覆盖恢复内容。
        # NEW-002: 捕获 force_close 结果，通过 _restore_collab_sync_warning 属性传递给 API 层，
        # 使前端能感知 force-close 失败并提示用户。
        try:
            from apps.collab.api import _force_close_collab_document
            fc_result = _force_close_collab_document("docs", str(document.id))
            if not fc_result.get("success"):
                document._restore_collab_sync_warning = "force_close_failed"
            elif not fc_result.get("loaded"):
                document._restore_collab_sync_warning = "document_not_loaded"
        except Exception:
            logger.warning(
                "restore_history: force_close_collab_document failed (non-blocking): doc=%s",
                document.id, exc_info=True,
            )
            document._restore_collab_sync_warning = "force_close_failed"

        # CSC-001: 补写 VersionHistory + ChangeLog，使 rollback_agent_run 可感知此次恢复操作。
        try:
            from apps.collab.constants import CHANGE_TYPE_RESTORE

            editor_type = self._get_editor_type()
            editor_id = self._get_editor_id()
            agent_run_id, session_id = self._resolve_history_attribution(editor_type, editor_id)

            self._record_content_history(
                document,
                change_type=CHANGE_TYPE_RESTORE,
                editor_type=editor_type,
                editor_id=editor_id,
                agent_run_id=agent_run_id,
                session_id=session_id,
                summary=f"从历史记录恢复（DocHistory {str(history_uuid)[:8]}）",
                changes={"restored_from_history": str(history_uuid)},
            )
        except Exception as exc:
            # P1-03: VH+CL 写入失败 → 升级为 error，并通过 _restore_audit_warning 通知 API 层
            logger.error(
                "[CRITICAL] restore_history: failed to write VersionHistory+ChangeLog, "
                "restore succeeded but audit trail is missing: doc=%s err=%s",
                document.id, exc, exc_info=True,
            )
            document._restore_audit_warning = (
                "version_history_write_failed: restore succeeded but audit trail is missing"
            )

        return document

    def _resolve_history_content_by_id(self, document: Document, history_id: str) -> dict | None:
        """按 history_id 查找并解析内容。优先查 VersionHistory，回退查 DocHistory。

        [只读兼容路径] DocHistory 的写入已下线，但存量旧数据仍可能通过此方法读取。
        当所有 DocHistory 数据迁移到 VersionHistory 完成后，可移除 DocHistory 回退分支。
        """
        from uuid import UUID
        try:
            hid = UUID(history_id)
        except ValueError:
            return None

        from apps.collab.models import VersionHistory
        vh = VersionHistory.objects.using("postgresql").filter(
            id=hid, resource_type="docs", resource_id=document.id,
        ).first()
        if vh:
            return self._resolve_vh_content(vh)

        try:
            history = document.histories.using("postgresql").get(id=hid)
        except (DocHistory.DoesNotExist, ValueError):
            return None
        return self._resolve_history_content(history)

    def _resolve_vh_content(self, vh) -> dict:
        """解析 VersionHistory blob 为内容（与 _resolve_history_content 格式一致）。"""
        import zlib, json
        if not vh.blob:
            return {"format": "json_snapshot", "description_json": {}, "description_markdown": ""}
        try:
            raw = zlib.decompress(bytes(vh.blob))
        except (zlib.error, TypeError):
            raw = bytes(vh.blob) if vh.blob else b""
        try:
            data = json.loads(raw)
            if isinstance(data, dict):
                if data.get("format") == "binary_snapshot":
                    from apps.collab.adapters.docs import unwrap_binary_snapshot
                    return {"format": "yjs_binary", "binary": unwrap_binary_snapshot(raw)[0]}
                if data.get("format") == "json_snapshot":
                    return data
                return {
                    "format": "json_snapshot",
                    "description_json": data.get("description_json", data),
                    "description_markdown": data.get("description_markdown", ""),
                }
        except (json.JSONDecodeError, UnicodeDecodeError):
            pass
        return {"format": "yjs_binary", "binary": raw}

    def _resolve_history_content(self, history: DocHistory) -> dict:
        """
        解析 DocHistory blob 为内容。

        支持 zlib 压缩和未压缩的旧数据（自动检测）。

        返回:
        - {"format": "json_snapshot", "description_json": ..., "description_markdown": ..., ...}
        - {"format": "yjs_binary", "binary": bytes}
        """
        raw_blob = bytes(history.blob) if history.blob else b""
        if not raw_blob:
            return {"format": "json_snapshot", "description_json": {}, "description_markdown": "", "description_plaintext": ""}

        decompressed = _decompress_history_blob(raw_blob)

        # 尝试作为 JSON snapshot 解析
        try:
            text = decompressed.decode("utf-8")
            parsed = json.loads(text)
            if isinstance(parsed, dict) and parsed.get("format") == "json_snapshot":
                return parsed
            if isinstance(parsed, dict) and parsed.get("format") == "binary_snapshot":
                from apps.collab.adapters.docs import unwrap_binary_snapshot
                return {"format": "yjs_binary", "binary": unwrap_binary_snapshot(decompressed)[0]}
        except (UnicodeDecodeError, json.JSONDecodeError):
            pass

        # 全量快照: 直接返回
        if history.is_snapshot:
            return {"format": "yjs_binary", "binary": decompressed}

        # CAP-003: 增量 diff 缺少基线快照时快失败
        if not history.base_history:
            raise ValueError(f"缺少基线快照: DocHistory {history.id} 无 base_history")

        diff_chain: list[bytes] = [decompressed]
        current = history
        base_binary: Optional[bytes] = None
        MAX_DIFF_CHAIN_DEPTH = 100

        while current.base_history_id:
            if len(diff_chain) > MAX_DIFF_CHAIN_DEPTH:
                raise ValueError(
                    f"增量链过深 (>{MAX_DIFF_CHAIN_DEPTH}): DocHistory {history.id}，可能存在循环引用"
                )
            try:
                base_hist = DocHistory.objects.get(id=current.base_history_id)
            except DocHistory.DoesNotExist:
                # CAP-003: 增量链损坏时快失败
                raise ValueError(f"增量链已损坏: DocHistory {current.id} -> 缺失 {current.base_history_id}")

            base_blob = _decompress_history_blob(bytes(base_hist.blob) if base_hist.blob else b"")

            if base_hist.is_snapshot:
                from apps.collab.adapters.docs import unwrap_binary_snapshot
                base_binary = unwrap_binary_snapshot(base_blob)[0]
                break

            diff_chain.append(base_blob)
            current = base_hist

        if base_binary is None:
            raise ValueError(f"增量链已损坏: DocHistory {history.id} 链上无快照锚点")

        # 通过 collab-live 合并 base + diffs
        try:
            base_b64 = base64.b64encode(base_binary).decode()
            diffs_b64 = [base64.b64encode(d).decode() for d in reversed(diff_chain)]

            result = call_live_api("/yjs/apply-diff", {
                "base_binary_b64": base_b64,
                "diffs_b64": diffs_b64,
            })

            merged_b64 = result.get("merged_b64", "")
            if merged_b64:
                return {"format": "yjs_binary", "binary": base64.b64decode(merged_b64)}
        except Exception as exc:
            # CAP-003: 合并失败时快失败，不静默回退
            raise ValueError(f"增量合并失败: DocHistory {history.id}, collab-live 错误: {exc}") from exc

        # merged_b64 为空也视为合并失败
        raise ValueError(f"增量合并失败: DocHistory {history.id}, collab-live 返回空结果")

    # ── 命名版本（手动保存）──

    def create_named_version(
        self,
        document: Document,
        name: str = "",
        *,
        base_version: Optional[int] = None,
        base_updated_at: Optional[str] = None,
    ) -> "VersionHistory":
        """
        用户手动保存当前文档为命名版本（永久保留，不受 TTL/降采样影响）。
        """
        self.assert_document_content_editable(document)
        if not self.check_document_permission(document, required_role="editor"):
            raise PermissionError(_("tabdoc.no_permission_to_save_version"))

        # CAP-017: 每文档命名版本数量上限，防止 Agent 高频调用无限膨胀
        # P0-04: 命名版本已统一写入 VersionHistory，须查 VH 而非废弃的 DocHistory
        MAX_NAMED_VERSIONS_PER_DOC = 50
        from apps.collab.models import VersionHistory
        named_count = VersionHistory.objects.using("postgresql").filter(
            resource_type="docs",
            resource_id=str(document.id),
            is_named=True,
        ).filter(
            models.Q(expired_at__isnull=True) | models.Q(expired_at__gt=timezone.now())
        ).count()
        if named_count >= MAX_NAMED_VERSIONS_PER_DOC:
            raise ValueError(
                _("tabdoc.named_version_limit_reached", limit=MAX_NAMED_VERSIONS_PER_DOC)
            )

        # CAP-017: 版本名称长度校验，避免超过 DB max_length=200 时抛 500
        version_name = (name or "").strip()
        if len(version_name) > 200:
            raise ValueError(_("tabdoc.version_name_too_long"))

        current_version = int(document.latest_version or 0)
        expected_version = current_version if base_version is None else int(base_version)
        if base_version is not None and expected_version != current_version:
            raise ConflictError(_("tabdoc.version_conflict", current=current_version, expected=expected_version))

        expected_updated_at = getattr(document, "updated_at", None)
        if base_updated_at is not None:
            parsed_updated_at = parse_datetime(base_updated_at)
            if parsed_updated_at is None:
                raise ValueError("base_updated_at is invalid")
            expected_updated_at = parsed_updated_at

        snapshot_query = Document.objects.filter(id=document.id, latest_version=current_version)
        if expected_updated_at is not None:
            snapshot_query = snapshot_query.filter(updated_at=expected_updated_at)

        snapshot = snapshot_query.values(
            "organization_id",
            "title",
            "description_binary",
            "description_json",
            "description_markdown",
            "description_plaintext",
        ).first()
        if snapshot is None:
            latest_db_version = (
                Document.objects.filter(id=document.id)
                .values_list("latest_version", flat=True)
                .first()
            )
            latest_text = _("common.unknown") if latest_db_version is None else str(latest_db_version)
            raise ConflictError(_("tabdoc.version_conflict", current=latest_text, expected=expected_version))

        # 构造 blob
        title = snapshot.get("title") or document.title
        description_binary = snapshot.get("description_binary")
        description_json = snapshot.get("description_json") or {}
        description_markdown = snapshot.get("description_markdown") or ""
        description_plaintext = snapshot.get("description_plaintext") or ""

        if description_binary:
            blob_data = bytes(description_binary)
        elif description_json or description_markdown:
            content_snapshot = {
                "format": "json_snapshot",
                "title": title,
                "description_json": description_json,
                "description_markdown": description_markdown,
                "description_plaintext": description_plaintext,
            }
            blob_data = json.dumps(content_snapshot, ensure_ascii=False).encode("utf-8")
        else:
            raise ValueError(_("tabdoc.document_empty_cannot_save_version"))

        # BE-14: 历史 blob 统一用 zlib 压缩存储
        compressed_blob = zlib.compress(blob_data, level=6)

        from apps.collab.registry import get_adapter
        from apps.collab.service import VersionHistoryService
        adapter = get_adapter("docs")
        if adapter:
            svc = VersionHistoryService(adapter)
            editor_info = {
                "editor_type": self._get_editor_type(),
                "editor_id": self._get_editor_id(),
            }
            vh = svc.create_named_version(
                document.id,
                version_name,
                {
                    "format": "json_snapshot",
                    "title": title,
                    "description_json": description_json,
                    "description_markdown": description_markdown,
                    "description_plaintext": description_plaintext,
                },
                editor_info,
                organization_id=snapshot.get("organization_id"),
            )
            if vh:
                logger.info(
                    "Named version created via VH: doc=%s name=%r vh=%s",
                    document.id, version_name, vh.id,
                )
                return vh

        # P2: 私有 DocHistory 写入路径已下线。
        # VH create_named_version 失败时不再 fallback 到 DocHistory，直接抛出异常。
        raise RuntimeError(
            f"VersionHistory create_named_version 失败，无法为文档 {document.id} "
            f"创建命名版本 {version_name!r}。私有 DocHistory 写入路径已下线。"
        )

    def rename_version(self, document: Document, history_id: str, name: str):
        """重命名一个命名版本（支持 VersionHistory 和 DocHistory）。"""
        self.assert_document_content_editable(document)
        if not self.check_document_permission(document, required_role="editor"):
            raise PermissionError(_("tabdoc.no_permission_to_rename_version"))

        from uuid import UUID
        history_uuid = self._parse_uuid(history_id, "history_id")
        new_name = (name or "").strip()

        from apps.collab.models import VersionHistory
        vh = VersionHistory.objects.using("postgresql").filter(
            id=history_uuid, resource_type="docs", resource_id=document.id, is_named=True,
        ).first()
        if vh:
            vh.name = new_name
            vh.save(update_fields=["name"])
            return vh

        history = document.histories.filter(id=history_uuid, is_named=True).first()
        if not history:
            raise ValueError(_("tabdoc.named_version_not_found"))

        history.name = new_name
        history.save(update_fields=["name"])
        return history

    def delete_named_version(self, document: Document, history_id: str) -> None:
        """软删除命名版本（支持 VersionHistory 和 DocHistory）。"""
        self.assert_document_content_editable(document)
        if not self.check_document_permission(document, required_role="editor"):
            raise PermissionError(_("tabdoc.no_permission_to_delete_version"))

        from uuid import UUID
        history_uuid = self._parse_uuid(history_id, "history_id")

        from apps.collab.models import VersionHistory
        vh = VersionHistory.objects.using("postgresql").filter(
            id=history_uuid, resource_type="docs", resource_id=document.id, is_named=True,
        ).first()
        if vh:
            vh.expired_at = timezone.now()
            vh.is_named = False
            vh.save(update_fields=["expired_at", "is_named"])
            logger.info("Named version soft-deleted (VH): doc=%s vh=%s", document.id, history_id)
            return

        history = document.histories.filter(id=history_uuid, is_named=True).first()
        if not history:
            raise ValueError(_("tabdoc.named_version_not_found"))

        history.expired_at = timezone.now()
        history.is_named = False
        history.save(update_fields=["expired_at", "is_named"])
        logger.info("Named version soft-deleted: doc=%s history=%s", document.id, history_id)

    def _get_editor_type(self) -> str:
        """根据当前上下文判断编辑者类型（collab 标准 user/agent/system）。

        优先级：显式 override → Agent run 上下文 → 默认 user。

        TD-1/H-2：CLI/Agent 经 REST 改文档时，`AgentRunContextMiddleware` 会从
        `X-Tabtin-Agent-Run-Id` 头把 run_id 还原到 ContextVar。这里据此把归因
        修正为 `agent`，让版本历史 / ChangeLog 的 editor_type 与 agent_run_id 对齐，
        rollback_agent_run 可定位（替代「CLI 走用户 JWT 被误记为 user」的旧行为）。
        """
        if self._editor_type_override:
            return self._editor_type_override
        try:
            from apps.services.common.platform_context import get_current_run_id
            if get_current_run_id():
                return "agent"
        except Exception:
            pass
        return "user"

    def _get_editor_id(self) -> str:
        """获取当前编辑者 ID"""
        if not self.user:
            return ""
        uid = getattr(self.user, 'id', None)
        return str(uid) if uid is not None else ""

    def _safe_user_for_fk(self):
        """返回适合作为 FK 赋值的 User 实例，否则 None"""
        from django.contrib.auth import get_user_model
        User = get_user_model()
        return self.user if isinstance(self.user, User) else None

    # ═══════════════════════════════════════════════════════════════════
    # 大文档分块加载
    # ═══════════════════════════════════════════════════════════════════

    def list_chunks(self, document: Document) -> list[dict]:
        """
        列出文档的所有分块元数据（不含 blob），供客户端决定按需加载。
        """
        if not self.check_document_permission(document, required_role="viewer"):
            raise PermissionError(_("tabdoc.no_permission_to_access"))

        chunks = DocChunk.objects.filter(document=document).order_by("chunk_index")
        return [
            {
                "chunk_index": c.chunk_index,
                "chunk_key": c.chunk_key,
                "blob_size": c.blob_size,
                "block_count": c.block_count,
                "plaintext_preview": c.plaintext_preview,
            }
            for c in chunks
        ]

    def get_chunks(
        self,
        document: Document,
        *,
        start_index: int = 0,
        end_index: Optional[int] = None,
    ) -> list[dict]:
        """
        获取指定范围的文档分块（含 blob）。

        客户端首屏加载前 N 个 chunk，滚动时请求后续 chunk。
        """
        if not self.check_document_permission(document, required_role="viewer"):
            raise PermissionError(_("tabdoc.no_permission_to_access"))

        qs = DocChunk.objects.filter(
            document=document,
            chunk_index__gte=start_index,
        ).order_by("chunk_index")

        if end_index is not None:
            qs = qs.filter(chunk_index__lt=end_index)

        result = []
        for c in qs:
            blob_data = bytes(c.blob) if c.blob else b""
            decompressed = _decompress_history_blob(blob_data)
            blob_b64 = base64.b64encode(decompressed).decode()
            result.append({
                "chunk_index": c.chunk_index,
                "chunk_key": c.chunk_key,
                "blob_b64": blob_b64,
                "blob_size": c.blob_size,
                "block_count": c.block_count,
            })
        return result

    # ═══════════════════════════════════════════════════════════════════
    # 以下为 V2 兼容方法（保留向后兼容，V3 全面上线后可移除）
    # ═══════════════════════════════════════════════════════════════════

    def list_versions(self, document: Document, limit: int = 20) -> list[DocumentVersion]:
        """列出文档的版本历史（新架构 DocumentVersion）"""
        if not self.check_document_permission(document, required_role="viewer"):
            raise PermissionError(_("tabdoc.no_permission_to_access_versions"))
        normalized_limit = max(1, min(int(limit), MAX_VERSIONS_PER_DOC))
        return list(document.versions.order_by("-created_at")[:normalized_limit])

    def list_revisions(self, document: Document, limit: int = 20, offset: int = 0) -> list:
        """[兼容] 优先返回 DocumentVersion，回退到旧 DocumentRevision"""
        if not self.check_document_permission(document, required_role="viewer"):
            raise PermissionError(_("tabdoc.no_permission_to_access_versions"))
        normalized_limit = max(1, min(int(limit), 200))
        normalized_offset = max(0, int(offset))
        # 先尝试新 Version 表
        versions = list(document.versions.order_by("-created_at")[normalized_offset:normalized_offset + normalized_limit])
        if versions or normalized_offset > 0:
            return versions
        # 回退到旧 Revision 表（仅在 offset=0 且新表为空时回退）
        return list(document.revisions.order_by("-version")[:normalized_limit])

    def restore_to_version_full(
        self,
        document: Document,
        target_version: DocumentVersion,
        *,
        skip_permission_check: bool = False,
    ) -> Document:
        """
        完整恢复文档到指定 DocumentVersion（含 binary/markdown/json/plaintext）。

        与 restore_version 不同，此方法会恢复 description_binary 字段，
        并自动处理 ResourceBridge 通知、搜索向量更新和异步版本创建。

        Args:
            document: 目标文档
            target_version: 要恢复到的 DocumentVersion 实例
            skip_permission_check: 为 True 时跳过权限检查（仅限 admin 内部调用）
        """
        if not skip_permission_check:
            if not self.check_document_permission(document, required_role="editor"):
                raise PermissionError(_("tabdoc.no_permission_to_restore_version"))

        old_markdown = document.description_markdown or ''
        restored_markdown = target_version.description_markdown or ''
        restored_plaintext = target_version.description_plaintext or ''

        with transaction.atomic(using="postgresql"):
            document.description_binary = target_version.description_binary
            document.description_markdown = restored_markdown
            document.description_json = target_version.description_json or {}
            document.description_plaintext = restored_plaintext
            document.latest_version = max(
                int(document.latest_version or 0) + 1,
                int(target_version.version or 0) + 1,
                1,
            )
            document.updated_by = self._safe_user_for_fk()
            document.save(
                update_fields=[
                    'description_binary',
                    'description_markdown',
                    'description_json',
                    'description_plaintext',
                    'latest_version',
                    'updated_by',
                    'updated_at',
                ]
            )

        ResourceBridge.on_update(document, user=self._safe_user_for_fk())
        self._update_search_vector(document, plaintext=restored_plaintext)

        if old_markdown != restored_markdown:
            try:
                from apps.tabdoc.tasks import create_document_version

                user_obj = self._safe_user_for_fk()
                create_document_version.delay(
                    str(document.id),
                    str(user_obj.id) if user_obj else None,
                )
            except Exception:
                logger.warning("restore_to_version_full: 异步创建版本失败 doc=%s", document.id)

        # CSC-001: 补写 VersionHistory + ChangeLog，与 restore_history 对齐
        try:
            from apps.collab.constants import CHANGE_TYPE_RESTORE

            editor_type = self._get_editor_type()
            editor_id = self._get_editor_id()
            agent_run_id, session_id = self._resolve_history_attribution(editor_type, editor_id)

            self._record_content_history(
                document,
                change_type=CHANGE_TYPE_RESTORE,
                editor_type=editor_type,
                editor_id=editor_id,
                agent_run_id=agent_run_id,
                session_id=session_id,
                summary=f"从 DocumentVersion 恢复（version {target_version.version}）",
                changes={"restored_version_id": str(target_version.id)},
            )
        except Exception:
            logger.warning(
                "restore_to_version_full: 补写 VH/CL 失败 (non-blocking): doc=%s",
                document.id, exc_info=True,
            )

        document.refresh_from_db()
        return document

    def restore_version(
        self,
        document: Document,
        version_id: str,
        *,
        base_version: Optional[int] = None,
        base_updated_at: Optional[str] = None,
    ) -> Document:
        """从 DocumentVersion 恢复内容。

        @deprecated: Use collab API POST /collab/v1/docs/{id}/restore instead.
        P0-05: 补全还原三件套（force_close + DocUpdate 清理 + VH/CL 写入）。
        """
        logger.warning(
            "Deprecated restore path C used (restore_version): doc=%s version_id=%s",
            document.id, version_id,
        )
        if not self.check_document_permission(document, required_role="editor"):
            raise PermissionError(_("tabdoc.no_permission_to_restore_version"))

        version_uuid = self._parse_uuid(version_id, "version_id")
        target = document.versions.filter(id=version_uuid).first()
        if not target:
            raise ValueError(_("tabdoc.target_version_not_found"))

        updated_doc = self.save_content(
            document,
            base_version=base_version if base_version is not None else document.latest_version,
            base_updated_at=base_updated_at,
            content_pm_json=target.description_json,
            content_markdown=target.description_markdown,
            content_plaintext=target.description_plaintext,
        )

        self._post_restore_cleanup(
            updated_doc,
            restore_source=f"DocumentVersion {version_id}",
            restore_changes={"restored_version_id": str(version_uuid)},
        )
        return updated_doc

    def restore_revision(
        self,
        document: Document,
        version: int,
        *,
        base_version: Optional[int] = None,
        base_updated_at: Optional[str] = None,
    ) -> Document:
        """[兼容] 从旧 DocumentRevision 恢复。

        @deprecated: Use collab API POST /collab/v1/docs/{id}/restore instead.
        P0-05: 补全还原三件套（force_close + DocUpdate 清理 + VH/CL 写入）。
        """
        logger.warning(
            "Deprecated restore path D used (restore_revision): doc=%s version=%s",
            document.id, version,
        )
        if not self.check_document_permission(document, required_role="editor"):
            raise PermissionError(_("tabdoc.no_permission_to_restore_version"))

        target = document.revisions.filter(version=version).first()
        if not target:
            raise ValueError(_("tabdoc.target_version_not_found"))

        updated_doc = self.save_content(
            document,
            base_version=base_version if base_version is not None else document.latest_version,
            base_updated_at=base_updated_at,
            content_pm_json=target.content_pm_json,
            content_markdown=target.content_markdown,
            content_plaintext=target.content_plaintext,
        )

        self._post_restore_cleanup(
            updated_doc,
            restore_source=f"DocumentRevision v{version}",
            restore_changes={"restored_revision_version": version},
        )
        return updated_doc

    def _post_restore_cleanup(
        self,
        document: Document,
        *,
        restore_source: str,
        restore_changes: dict,
    ) -> None:
        """P0-05: 还原路径 C/D 的共享三件套（force_close + DocUpdate 清理 + VH/CL 写入）。"""
        # 1. 清理残留 DocUpdate 队列
        try:
            DocUpdate.objects.filter(document=document).delete()
        except Exception:
            logger.warning(
                "_post_restore_cleanup: DocUpdate cleanup failed (non-blocking): doc=%s",
                document.id, exc_info=True,
            )

        # 2. 强制断开在线用户连接
        try:
            from apps.collab.api import _force_close_collab_document
            _force_close_collab_document("docs", str(document.id))
        except Exception:
            logger.warning(
                "_post_restore_cleanup: force_close_collab_document failed (non-blocking): doc=%s",
                document.id, exc_info=True,
            )

        # 3. 补写 VersionHistory + ChangeLog
        try:
            from apps.collab.constants import CHANGE_TYPE_RESTORE

            editor_type = self._get_editor_type()
            editor_id = self._get_editor_id()
            agent_run_id, session_id = self._resolve_history_attribution(editor_type, editor_id)

            self._record_content_history(
                document,
                change_type=CHANGE_TYPE_RESTORE,
                editor_type=editor_type,
                editor_id=editor_id,
                agent_run_id=agent_run_id,
                session_id=session_id,
                summary=f"从 {restore_source} 恢复（路径 C/D）",
                changes=restore_changes,
            )
        except Exception:
            logger.error(
                "_post_restore_cleanup: failed to write VH+CL (non-blocking): doc=%s",
                document.id, exc_info=True,
            )

    def list_permissions(self, document: Document) -> list[DocumentPermission]:
        if not self.check_document_permission(document, required_role="admin"):
            raise PermissionError(_("tabdoc.no_permission_to_view_permissions"))
        return list(document.permissions.order_by("-updated_at"))

    def replace_permissions(self, document: Document, entries: Iterable[dict]) -> list[DocumentPermission]:
        if not self.check_document_permission(document, required_role="admin"):
            raise PermissionError(_("tabdoc.no_permission_to_update_permissions"))

        normalized = self._validate_permission_entries(entries)

        # CAP-011: 禁止空列表清空全部权限（self-lockout 防护）
        if not normalized:
            raise ValueError(_("tabdoc.permission_entries_cannot_be_empty"))

        # CAP-011: 确保调用者自身保留 admin 权限，防止 self-lockout
        if self.user and hasattr(self.user, "id"):
            caller_id = str(self.user.id)
            caller_has_admin = any(
                e["subject_type"] == "user"
                and e["subject_id"] == caller_id
                and ROLE_LEVELS.get(e["permission"], 0) >= ROLE_LEVELS["admin"]
                for e in normalized
            )
            if not caller_has_admin:
                raise ValueError(_("tabdoc.permission_must_retain_caller_admin"))

        # CAP-013: DocumentPermission 在 PostgreSQL，事务必须指定 using
        with transaction.atomic(using="postgresql"):
            document.permissions.all().delete()
            created = []
            for entry in normalized:
                created.append(
                    DocumentPermission.objects.create(
                        document=document,
                        subject_type=entry["subject_type"],
                        subject_id=entry["subject_id"],
                        permission=entry["permission"],
                        is_active=entry["is_active"],
                        created_by=self._safe_user_for_fk(),
                        granted_by=self._get_editor_id(),
                    )
                )
        return created
