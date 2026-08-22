"""
VersionHistoryService — 统一版本管理服务

基于 HistoryServiceBase 的通用策略逻辑 + CollabAdapter 的模块差异化实现，
为所有创作模块提供统一的版本历史操作：

- create_history(): 创建版本（自动判断全量/增量）
- rebuild_data(): 从 diff 链重建数据
- list_versions(): 列出版本历史
- restore_to_version(): 恢复到指定版本
- create_named_version(): 创建命名版本
- 以及 TTL、降采样等维护操作
"""
import logging
from typing import Any, Optional
from uuid import UUID

from django.core.cache import cache
from django.db import transaction
from django.utils import timezone

from apps.i18n import _
from apps.services.common.version_history import (
    HistoryServiceBase,
    serialize_history_item,
    serialize_history_list,
)
from .adapters.base import CollabAdapter
from .constants import (
    HISTORY_MIN_INTERVAL,
    MEMBERSHIP_TIER_MAP,
    TTL_TIERS,
    CHANGE_TYPE_RESTORE,
)
from .models import ChangeLog, VersionHistory

logger = logging.getLogger("collab.service")

DB_ALIAS = "postgresql"


def _call_collab_live_collab_first_restore(
    table_id: str,
    snapshot: dict,
    editor_info: dict,
) -> dict:
    """: 调用 collab-live collab-first 表格还原端点。"""
    from apps.services.common.live_api import call_live_api_safe

    document_id = f"table:{table_id}"
    result = call_live_api_safe(
        "/admin/collab-first-restore",
        {
            "document_id": document_id,
            "snapshot": snapshot,
            "editor_type": editor_info.get("editor_type", "user"),
            "editor_id": editor_info.get("editor_id", ""),
            "editor_name": editor_info.get("editor_name", ""),
        },
        timeout=30,
        max_retries=1,
        source="collab.restore_collab_first",
    )
    if "error" in result:
        logger.warning(
            "collab-first restore live API failed for %s: %s",
            document_id,
            result["error"],
        )
        return {"success": False, "loaded": False, "persisted": False}

    data = result.get("data", result)
    return {
        "success": bool(data.get("success", True)),
        "loaded": bool(data.get("loaded", False)),
    }


class RebuildError(Exception):
    """rebuild_data 链路重建失败时的诊断异常。

    携带 error_code 和 context 字典，便于调用方区分失败原因
    （cleanup 并发删除 / 数据损坏 / 链路断裂 / diff 应用失败等）。
    """

    CHAIN_TOO_DEEP = "CHAIN_TOO_DEEP"
    CHAIN_BROKEN = "CHAIN_BROKEN"
    ANCHOR_MISSING = "ANCHOR_MISSING"
    ANCHOR_CORRUPT = "ANCHOR_CORRUPT"
    DIFF_ENTRY_MISSING = "DIFF_ENTRY_MISSING"
    DIFF_APPLY_FAILED = "DIFF_APPLY_FAILED"
    DIFF_APPLY_NULL = "DIFF_APPLY_NULL"

    def __init__(self, error_code: str, message: str, context: dict | None = None):
        self.error_code = error_code
        self.context = context or {}
        super().__init__(f"[{error_code}] {message}")


class RestoreError(Exception):
    """restore_to_version 失败时抛出，携带结构化错误类型。"""

    VERSION_NOT_FOUND = "version_not_found"
    REBUILD_FAILED = "rebuild_failed"
    RESOURCE_NOT_FOUND = "resource_not_found"
    LOCK_CONTENTION = "lock_contention"
    HISTORY_WRITE_FAILED = "history_write_failed"

    def __init__(self, error_type: str, message: str, context: dict | None = None):
        self.error_type = error_type
        self.context = context or {}
        super().__init__(message)

class HistoryLockContention(Exception):
    """create_history 锁竞争：另一个写入正在进行中，客户端可重试。"""


class HistoryServiceUnavailable(Exception):
    """create_history 所依赖的 Redis 不可用，无法安全执行并发写入。"""


class RestoreInProgress(Exception):
    """资源正在执行版本恢复，create_history 被跳过以保护版本链完整性。"""


CREATE_HISTORY_LOCK_TTL = 120

# DC-019: 链路回溯深度上限，防止异常 FK 链导致无界内存/CPU 消耗
MAX_CHAIN_DEPTH = 200


class VersionHistoryService(HistoryServiceBase):
    """
    统一版本管理服务。

    使用方式:
        adapter = SlideCollabAdapter()
        svc = VersionHistoryService(adapter)
        svc.create_history(resource_id, data, editor_info)
    """

    def __init__(self, adapter: CollabAdapter):
        self.adapter = adapter
        self.resource_type = adapter.resource_type

    def _get_db_alias(self) -> str:
        return DB_ALIAS

    def _base_qs(self, resource_id: UUID) -> "QuerySet[VersionHistory]":
        return VersionHistory.objects.using(DB_ALIAS).filter(
            resource_type=self.resource_type,
            resource_id=resource_id,
        )

    # ── 创建版本 ────────────────────────────────────

    @staticmethod
    def _safe_editor_info(editor_info: dict) -> dict:
        """显式提取 editor_info 字段，防止意外键覆盖 ORM 字段。"""
        editor_type = editor_info.get("editor_type", "user")
        if editor_type == "human":
            editor_type = "user"
        return {
            "editor_type": editor_type,
            "editor_id": editor_info.get("editor_id", ""),
            "editor_name": editor_info.get("editor_name", ""),
        }

    def create_history(
        self,
        resource_id: UUID,
        data: Any,
        editor_info: dict,
        *,
        force_snapshot: bool = False,
        is_named: bool = False,
        name: str = "",
        tier: str = "free",
        organization_id: UUID = None,
        skip_throttle: bool = False,
        extra_metadata: Optional[dict] = None,
    ) -> Optional[VersionHistory]:
        """
        创建一条版本历史记录。

        自动判断全量快照或增量 diff（除非 force_snapshot=True 或 is_named=True）。
        命名版本始终为全量快照且 expired_at=NULL。

        skip_throttle=True 时跳过 is_too_recent 节流检查，
        确保 Agent 高频写入不会被丢弃。

        使用 cache 锁对同一 resource 序列化写入，
        防止并发请求同时通过 should_create_snapshot 判断后写出兄弟 diff。
        """
        # CC-008: restore 进行中时拒绝，防止 diff 指向 restore 前快照导致版本链断裂。
        # 使用 == 1 精确匹配 restore_to_version 写入的值，
        # 避免被 mock/fallback cache 的默认返回值误触发。
        restore_lock_key = f"collab:restore_lock:{self.resource_type}:{resource_id}"
        try:
            if cache.get(restore_lock_key) == 1:
                logger.info(
                    "Restore in progress for %s:%s, deferring create_history",
                    self.resource_type, resource_id,
                )
                raise RestoreInProgress(
                    f"Restore in progress for {self.resource_type}:{resource_id}, "
                    f"deferring create_history to protect version chain integrity"
                )
        except RestoreInProgress:
            raise
        except Exception:
            pass

        # P1-04 fix: 命名版本使用独立锁 key，避免与普通 VH 创建竞争
        if is_named:
            lock_key = f"collab:create_named_lock:{self.resource_type}:{resource_id}"
        else:
            lock_key = f"collab:create_history_lock:{self.resource_type}:{resource_id}"
        # CC-021: Redis 不可用时 cache.add 可能异常或误返回 True，
        # 直接拒绝以防止并发写入兄弟 diff 破坏链路
        # P1-04 fix: 命名版本 Redis 不可用时 fallback 到无锁写入
        # （全量快照无兄弟 diff 竞争风险），而非静默返回 None
        lock_backend_available = True
        try:
            acquired = cache.add(lock_key, 1, CREATE_HISTORY_LOCK_TTL)
        except Exception:
            if is_named:
                logger.warning(
                    "Redis unavailable for create_named_version lock %s:%s, "
                    "proceeding without lock (named versions are full snapshots)",
                    self.resource_type, resource_id,
                )
                acquired = True
                lock_backend_available = False
            else:
                logger.warning(
                    "Redis unavailable for create_history lock %s:%s, "
                    "skipping to prevent sibling diffs",
                    self.resource_type, resource_id,
                )
                raise HistoryServiceUnavailable(
                    f"Redis unavailable, cannot acquire create_history lock "
                    f"for {self.resource_type}:{resource_id}"
                )

        if not acquired:
            logger.warning(
                "Concurrent create_history blocked for %s:%s, skipping",
                self.resource_type, resource_id,
            )
            raise HistoryLockContention(
                f"Concurrent create_history blocked for "
                f"{self.resource_type}:{resource_id}"
            )

        try:
            # 与 acquire_restore_lock 的双向复验共同关闭这个窗口：create_history
            # 可能在首次检查 restore_lock 后、拿到自身写锁前，被一次恢复插入。
            # 拿到写锁后再看一次；若恢复已占位，本次版本写必须零副作用退出。
            if lock_backend_available:
                try:
                    if cache.get(restore_lock_key) == 1:
                        raise RestoreInProgress(
                            f"Restore in progress for {self.resource_type}:{resource_id}, "
                            f"deferring create_history to protect version chain integrity"
                        )
                except RestoreInProgress:
                    raise
                except Exception as exc:
                    raise HistoryServiceUnavailable(
                        f"Redis unavailable while rechecking restore lock for "
                        f"{self.resource_type}:{resource_id}"
                    ) from exc
            return self._do_create_history(
                resource_id, data, editor_info,
                force_snapshot=force_snapshot,
                is_named=is_named,
                name=name,
                tier=tier,
                organization_id=organization_id,
                skip_throttle=skip_throttle,
                extra_metadata=extra_metadata,
            )
        finally:
            try:
                cache.delete(lock_key)
            except Exception:
                logger.warning(
                    "Failed to release create_history lock for %s:%s "
                    "(will auto-expire in %ds)",
                    self.resource_type, resource_id, CREATE_HISTORY_LOCK_TTL,
                )

    def _do_create_history(
        self,
        resource_id: UUID,
        data: Any,
        editor_info: dict,
        *,
        force_snapshot: bool = False,
        is_named: bool = False,
        name: str = "",
        tier: str = "free",
        organization_id: UUID = None,
        skip_throttle: bool = False,
        extra_metadata: Optional[dict] = None,
    ) -> Optional[VersionHistory]:
        # VH-TTL-FIX: 当 tier 为默认值 "free" 且 organization_id 可用时，
        # 从会员等级查询实际套餐。历史上所有调用方都传 organization_id 但
        # 未传 tier，导致所有 VH 记录统一使用 7 天 free TTL，
        # pro/team 用户的版本历史被提前清理。
        if tier == "free" and organization_id:
            tier = self._resolve_tier_from_organization(organization_id)

        qs = self._base_qs(resource_id)

        if not force_snapshot and not is_named and not skip_throttle and self.is_too_recent(qs):
            return None

        should_snap = is_named or self.should_create_snapshot(qs, force=force_snapshot)
        safe_editor = self._safe_editor_info(editor_info)
        metadata = self.adapter.get_content_stats(data)
        if extra_metadata:
            metadata = {**metadata, **extra_metadata}

        common = {
            "resource_type": self.resource_type,
            "resource_id": resource_id,
            "organization_id": organization_id,
            "metadata": metadata,
            **safe_editor,
        }

        if should_snap:
            blob = self.adapter.serialize_snapshot(data)
            vh = VersionHistory(
                blob=blob,
                blob_size=len(blob),
                is_snapshot=True,
                base_history=None,
                is_named=is_named,
                name=name if is_named else "",
                expired_at=None if is_named else self._compute_ttl(tier),
                **common,
            )
        else:
            base = self.find_last_snapshot(qs)
            if not base:
                blob = self.adapter.serialize_snapshot(data)
                vh = VersionHistory(
                    blob=blob,
                    blob_size=len(blob),
                    is_snapshot=True,
                    base_history=None,
                    expired_at=self._compute_ttl(tier),
                    **common,
                )
            else:
                base_data = self.adapter.deserialize_snapshot(base.blob)
                if base_data is None:
                    if base.blob:
                        logger.error(
                            "[VH] base snapshot blob 解压/反序列化失败: "
                            "base_vh_id=%s, resource=%s/%s, blob_size=%d",
                            base.id, self.resource_type, resource_id,
                            len(base.blob) if base.blob else 0,
                        )
                    blob = self.adapter.serialize_snapshot(data)
                    vh = VersionHistory(
                        blob=blob,
                        blob_size=len(blob),
                        is_snapshot=True,
                        base_history=None,
                        expired_at=self._compute_ttl(tier),
                        **common,
                    )
                else:
                    compute_failed = False
                    try:
                        diff_blob = self.adapter.compute_diff(base_data, data)
                    except Exception:
                        logger.warning(
                            "compute_diff failed for %s:%s, creating fallback snapshot",
                            self.resource_type, resource_id, exc_info=True,
                        )
                        diff_blob = None
                        compute_failed = True

                    if diff_blob is None and not compute_failed:
                        if type(base_data) is not type(data):
                            logger.info(
                                "[VH] base/current 数据类型不兼容（%s vs %s），"
                                "降级写全量快照: %s:%s",
                                type(base_data).__name__, type(data).__name__,
                                self.resource_type, resource_id,
                            )
                            blob = self.adapter.serialize_snapshot(data)
                            vh = VersionHistory(
                                blob=blob,
                                blob_size=len(blob),
                                is_snapshot=True,
                                base_history=None,
                                expired_at=self._compute_ttl(tier),
                                **common,
                            )
                        else:
                            logger.debug("No diff detected, skipping history creation")
                            return None
                    elif diff_blob is None:
                        blob = self.adapter.serialize_snapshot(data)
                        vh = VersionHistory(
                            blob=blob,
                            blob_size=len(blob),
                            is_snapshot=True,
                            base_history=None,
                            expired_at=self._compute_ttl(tier),
                            **common,
                        )
                    else:
                        # [Design: 扁平 diff 链] base_history 始终指向最近的全量
                        # snapshot 锚点（而非上一个 diff），形成 diff→snapshot 的
                        # 扁平结构，链深度恒为 1。rebuild_data 中的回溯循环虽然
                        # 可处理多级 diff→diff→snapshot 链路，但那是防御性兼容，
                        # 当前写入策略不会产生多级链。

                        snapshot_blob = self.adapter.serialize_snapshot(data)
                        if len(diff_blob) > len(snapshot_blob):
                            logger.info(
                                "[VH] diff(%d bytes) > snapshot(%d bytes)，"
                                "改用全量快照: %s:%s",
                                len(diff_blob), len(snapshot_blob),
                                self.resource_type, resource_id,
                            )
                            vh = VersionHistory(
                                blob=snapshot_blob,
                                blob_size=len(snapshot_blob),
                                is_snapshot=True,
                                base_history=None,
                                expired_at=self._compute_ttl(tier),
                                **common,
                            )
                        else:
                            # CC-020: diff 的 expired_at 不得早于其 base snapshot，
                            # 否则 diff 先过期被删后 snapshot 失去引用保护，
                            # cleanup 删除 snapshot 导致其他 diff 悬空
                            diff_ttl = self._compute_ttl(tier)
                            if base.expired_at and diff_ttl and diff_ttl < base.expired_at:
                                diff_ttl = base.expired_at
                            vh = VersionHistory(
                                blob=diff_blob,
                                blob_size=len(diff_blob),
                                is_snapshot=False,
                                base_history=base,
                                expired_at=diff_ttl,
                                **common,
                            )

        _BLOB_WARN_BYTES = 5 * 1024 * 1024   # 5 MB
        _BLOB_ERROR_BYTES = 10 * 1024 * 1024  # 10 MB
        if vh.blob_size > _BLOB_ERROR_BYTES:
            logger.error(
                "VH blob exceeds 10 MB: resource_type=%s resource_id=%s "
                "blob_size=%d is_snapshot=%s",
                self.resource_type, resource_id, vh.blob_size, vh.is_snapshot,
            )
        elif vh.blob_size > _BLOB_WARN_BYTES:
            logger.warning(
                "VH blob exceeds 5 MB: resource_type=%s resource_id=%s "
                "blob_size=%d is_snapshot=%s",
                self.resource_type, resource_id, vh.blob_size, vh.is_snapshot,
            )

        vh.save(using=DB_ALIAS)
        logger.info(
            "Created %s history %s for %s:%s",
            "snapshot" if vh.is_snapshot else "diff",
            vh.id,
            self.resource_type,
            resource_id,
        )
        return vh

    # ── 重建数据 ────────────────────────────────────

    def rebuild_data(self, history: VersionHistory) -> Optional[Any]:
        """
        从版本记录重建完整数据。

        全量快照: 直接反序列化。
        增量 diff: 沿 base_history 链回溯到最近全量锚点，依次应用 diff。

        DC-019: 原 CO-62 方案全量加载资源所有版本元数据到 parent_map，
        记录极多时内存无界。改为迭代式单步回溯：每步仅查询一条记录的
        (is_snapshot, base_history_id)，内存 = O(chain_depth) 而非
        O(total_records)。链深度通常为 1（扁平 diff 链），极少超过 3，
        因此 N+1 查询开销可忽略。MAX_CHAIN_DEPTH 硬限制防御异常链路。

        两阶段查询包裹在 transaction.atomic 内，
        缩小 cleanup 在两次查询之间删除锚点的竞态窗口。
        """
        if history.is_snapshot:
            result = self.adapter.deserialize_snapshot(history.blob)
            if result is None and history.blob:
                logger.error(
                    "[VH] blob 解压/反序列化失败: vh_id=%s, resource=%s/%s, "
                    "blob_size=%d, is_named=%s",
                    history.id, self.resource_type, history.resource_id,
                    len(history.blob) if history.blob else 0, history.is_named,
                )
            return result

        # CC-010: diff 的 base_history_id 为 None 说明 FK 被 SET_NULL
        # （通常因 cleanup/downsample 误删了其引用的 snapshot），
        # 直接抛出诊断异常而非进入通用链路回溯
        if history.base_history_id is None:
            raise RebuildError(
                RebuildError.CHAIN_BROKEN,
                f"CC-010: Diff {history.id} for {self.resource_type}:{history.resource_id} "
                f"has base_history=NULL (FK SET_NULL — referenced snapshot was likely "
                f"deleted by cleanup/downsample). Data unrecoverable.",
                {
                    "history_id": str(history.id),
                    "resource_type": self.resource_type,
                    "resource_id": str(history.resource_id),
                    "break_reason": "fk_set_null_direct",
                },
            )

        with transaction.atomic(using=DB_ALIAS):
            # 阶段1: 迭代式回溯链路，每步查询一条元数据
            # [Design: 扁平 diff 链] 当前写入策略（见 _do_create_history）
            # 保证每个 diff 直接指向 snapshot，链深度为 1。此处使用通用
            # while 循环而非直接取 parent 的原因：
            # 1. 防御性兼容——历史数据或未来策略变更可能产生多级链
            # 2. visited 集合防止 FK 自引用/环形链导致死循环
            chain_ids = []
            anchor_id = None
            cur_id = history.id
            visited = set()
            missing_id = None
            while cur_id and cur_id not in visited:
                if len(chain_ids) >= MAX_CHAIN_DEPTH:
                    raise RebuildError(
                        RebuildError.CHAIN_TOO_DEEP,
                        f"Rebuild chain exceeded MAX_CHAIN_DEPTH ({MAX_CHAIN_DEPTH}) "
                        f"for {self.resource_type}:{history.resource_id} "
                        f"history {history.id}",
                        {
                            "history_id": str(history.id),
                            "resource_type": self.resource_type,
                            "resource_id": str(history.resource_id),
                            "max_depth": MAX_CHAIN_DEPTH,
                            "chain_length": len(chain_ids),
                        },
                    )
                visited.add(cur_id)
                if cur_id != history.id:
                    row = (
                        VersionHistory.objects.using(DB_ALIAS)
                        .filter(id=cur_id)
                        .values_list("is_snapshot", "base_history_id")
                        .first()
                    )
                    if row is None:
                        missing_id = cur_id
                        break
                    is_snap, base_id = row
                    if is_snap:
                        anchor_id = cur_id
                        break
                    chain_ids.append(cur_id)
                    if base_id is None:
                        missing_id = cur_id
                        break
                    cur_id = base_id
                else:
                    chain_ids.append(cur_id)
                    cur_id = history.base_history_id

            if anchor_id is None:
                if missing_id and (
                    VersionHistory.objects.using(DB_ALIAS)
                    .filter(base_history_id=missing_id)
                    .exclude(id=history.id)
                    .exists()
                ):
                    break_reason = "fk_set_null_by_cleanup"
                elif missing_id is not None:
                    break_reason = "record_not_found"
                elif not cur_id:
                    break_reason = "base_history_null"
                elif cur_id in visited:
                    break_reason = "cycle_detected"
                else:
                    break_reason = "unknown"
                raise RebuildError(
                    RebuildError.CHAIN_BROKEN,
                    f"Broken diff chain for {self.resource_type}:{history.resource_id} "
                    f"history {history.id}, no snapshot anchor found "
                    f"(reason={break_reason})",
                    {
                        "history_id": str(history.id),
                        "resource_type": self.resource_type,
                        "resource_id": str(history.resource_id),
                        "chain_ids": [str(x) for x in chain_ids],
                        "break_reason": break_reason,
                        "missing_id": str(missing_id) if missing_id else None,
                        "last_cur_id": str(cur_id) if cur_id else None,
                    },
                )

            # 阶段2: 仅获取链路条目的完整数据（单次批量查询）
            needed_ids = chain_ids + [anchor_id]
            entries = {
                vh.id: vh
                for vh in VersionHistory.objects.using(DB_ALIAS).filter(id__in=needed_ids)
            }

        anchor = entries.get(anchor_id)
        if not anchor:
            # CL-018 诊断：anchor 在阶段1存在但阶段2消失，区分竞态 vs 数据异常
            diag_row = (
                VersionHistory.objects.using(DB_ALIAS)
                .filter(id=anchor_id)
                .values_list("id", "expired_at", "is_named", "pinned")
                .first()
            )
            if diag_row is None:
                probable_cause = "concurrent_cleanup_deleted"
                diag_detail = (
                    "anchor 在阶段1查询时存在但阶段2批量查询时已消失，"
                    "且事务外确认记录已不存在 — 极大概率被 cleanup_expired "
                    "并发删除（TOCTOU 竞态，参见 CL-011/CL-018）"
                )
            else:
                probable_cause = "transaction_read_anomaly"
                diag_detail = (
                    f"anchor 仍存在于 DB（expired_at={diag_row[1]}, "
                    f"is_named={diag_row[2]}, pinned={diag_row[3]}），"
                    f"READ COMMITTED 事务隔离下出现读取异常"
                )

            raise RebuildError(
                RebuildError.ANCHOR_MISSING,
                f"Snapshot anchor {anchor_id} found in stage-1 but missing "
                f"in stage-2 batch query for {self.resource_type}:"
                f"{history.resource_id} "
                f"(probable_cause={probable_cause})",
                {
                    "history_id": str(history.id),
                    "resource_type": self.resource_type,
                    "resource_id": str(history.resource_id),
                    "anchor_id": str(anchor_id),
                    "chain_ids": [str(x) for x in chain_ids],
                    "probable_cause": probable_cause,
                    "diagnostic_detail": diag_detail,
                    "anchor_exists_outside_tx": diag_row is not None,
                },
            )

        data = self.adapter.deserialize_snapshot(anchor.blob)
        if data is None:
            raise RebuildError(
                RebuildError.ANCHOR_CORRUPT,
                f"Snapshot anchor {anchor_id} blob deserialization failed "
                f"for {self.resource_type}:{history.resource_id}",
                {
                    "history_id": str(history.id),
                    "resource_type": self.resource_type,
                    "resource_id": str(history.resource_id),
                    "anchor_id": str(anchor_id),
                    "blob_size": len(anchor.blob) if anchor.blob else 0,
                },
            )

        for diff_id in reversed(chain_ids):
            diff_entry = entries.get(diff_id)
            if not diff_entry:
                raise RebuildError(
                    RebuildError.DIFF_ENTRY_MISSING,
                    f"Missing diff entry {diff_id} in chain "
                    f"for {self.resource_type}:{history.resource_id}",
                    {
                        "history_id": str(history.id),
                        "resource_type": self.resource_type,
                        "resource_id": str(history.resource_id),
                        "missing_diff_id": str(diff_id),
                        "chain_ids": [str(x) for x in chain_ids],
                    },
                )
            try:
                data = self.adapter.apply_diff(data, diff_entry.blob)
            except Exception as exc:
                raise RebuildError(
                    RebuildError.DIFF_APPLY_FAILED,
                    f"Failed to apply diff {diff_id} "
                    f"for {self.resource_type}:{history.resource_id}: {exc}",
                    {
                        "history_id": str(history.id),
                        "resource_type": self.resource_type,
                        "resource_id": str(history.resource_id),
                        "failed_diff_id": str(diff_id),
                    },
                ) from exc
            if data is None:
                raise RebuildError(
                    RebuildError.DIFF_APPLY_NULL,
                    f"apply_diff returned None for diff {diff_id} "
                    f"for {self.resource_type}:{history.resource_id}",
                    {
                        "history_id": str(history.id),
                        "resource_type": self.resource_type,
                        "resource_id": str(history.resource_id),
                        "null_diff_id": str(diff_id),
                    },
                )

        return data

    # ── 列表与查询 ──────────────────────────────────

    def list_versions(
        self,
        resource_id: UUID,
        *,
        limit: int = 50,
        offset: int = 0,
        named_only: bool = False,
    ) -> list[dict]:
        qs = self._base_qs(resource_id)
        if named_only:
            qs = qs.filter(is_named=True)
        qs = qs.order_by("-pinned", "-created_at")
        histories = list(qs[offset : offset + limit])
        return serialize_history_list(histories, module=self.resource_type)

    def get_version(
        self, version_id: UUID, resource_id: UUID = None
    ) -> Optional[VersionHistory]:
        qs = VersionHistory.objects.using(DB_ALIAS).filter(
            id=version_id,
            resource_type=self.resource_type,
        )
        if resource_id is not None:
            qs = qs.filter(resource_id=resource_id)
        return qs.first()

    def count_versions(self, resource_id: UUID, *, named_only: bool = False) -> int:
        qs = self._base_qs(resource_id)
        if named_only:
            qs = qs.filter(is_named=True)
        return qs.count()

    # ── 恢复 ────────────────────────────────────────

    RESTORE_LOCK_TTL = 120

    def _restore_lock_key(self, resource_id: UUID) -> str:
        return f"collab:restore_lock:{self.resource_type}:{resource_id}"

    def acquire_restore_lock(self, resource_id: UUID, version_id: UUID) -> None:
        """在 DB 事务外申请 Redis 恢复锁。

        E2E-009: 将锁申请移到事务外，防止 Redis 不可用时整个批量事务回滚。
        调用方负责在完成后调用 release_restore_lock。

        Raises:
            RestoreError(LOCK_CONTENTION): Redis 不可用或锁已被持有。
        """
        lock_key = self._restore_lock_key(resource_id)
        # CC-021: Redis 不可用时中止恢复，防止无锁并发恢复
        try:
            acquired = cache.add(lock_key, 1, self.RESTORE_LOCK_TTL)
        except Exception:
            logger.error(
                "Redis unavailable for restore lock %s:%s, aborting restore",
                self.resource_type, resource_id,
            )
            raise RestoreError(
                RestoreError.LOCK_CONTENTION,
                f"Redis unavailable, cannot acquire restore lock for "
                f"{self.resource_type}:{resource_id}",
            )

        if not acquired:
            logger.warning(
                "Concurrent restore blocked for %s:%s (version %s)",
                self.resource_type, resource_id, version_id,
            )
            raise RestoreError(
                RestoreError.LOCK_CONTENTION,
                f"Concurrent restore blocked for {self.resource_type}:{resource_id}",
            )

        # create_history 可能已经通过了它的首次 restore_lock 检查。
        # 在恢复锁占位后检查两类版本写锁；对端拿到锁后也会
        # 二次检查 restore_lock，从而保证两个方向不能同时进入写阶段。
        create_lock_keys = (
            f"collab:create_history_lock:{self.resource_type}:{resource_id}",
            f"collab:create_named_lock:{self.resource_type}:{resource_id}",
        )
        try:
            writer_active = any(cache.get(key) == 1 for key in create_lock_keys)
        except Exception as exc:
            try:
                cache.delete(lock_key)
            except Exception:
                pass
            raise RestoreError(
                RestoreError.LOCK_CONTENTION,
                f"Redis unavailable while checking version writers for "
                f"{self.resource_type}:{resource_id}",
            ) from exc
        if writer_active:
            try:
                cache.delete(lock_key)
            except Exception:
                logger.warning(
                    "Failed to release restore lock after version-writer contention for %s:%s",
                    self.resource_type,
                    resource_id,
                )
            raise RestoreError(
                RestoreError.LOCK_CONTENTION,
                f"Version history write in progress for {self.resource_type}:{resource_id}",
            )

    def release_restore_lock(self, resource_id: UUID) -> None:
        """释放 Redis 恢复锁。失败时仅记录警告，锁会自动过期。"""
        lock_key = self._restore_lock_key(resource_id)
        try:
            cache.delete(lock_key)
        except Exception:
            logger.warning(
                "Failed to release restore lock for %s:%s "
                "(will auto-expire in %ds)",
                self.resource_type, resource_id, self.RESTORE_LOCK_TTL,
            )

    def try_collab_first_table_restore(
        self,
        resource_id: UUID,
        version_id: UUID,
        editor_info: dict,
        *,
        resource=None,
        user=None,
    ) -> Optional[VersionHistory]:
        """: 表格 collab-first 恢复。

        在线 Y.Doc 由 collab-live 用 VH 快照直接更新；PostgreSQL 由 Django
        restore_from_snapshot 写入（restore 语义，非 diff persist 逐条 delete）。
        文档未加载时返回 None，调用方回退 DB-first 路径。
        """
        if self.resource_type != "table":
            return None

        self.acquire_restore_lock(resource_id, version_id)
        try:
            target = self.get_version(version_id, resource_id=resource_id)
            if not target:
                raise RestoreError(
                    RestoreError.VERSION_NOT_FOUND,
                    f"Version {version_id} not found for table:{resource_id}",
                )

            try:
                data = self.rebuild_data(target)
            except RebuildError as e:
                raise RestoreError(
                    RestoreError.REBUILD_FAILED,
                    f"Failed to rebuild data for version {version_id}: {e}",
                    context=e.context,
                ) from e

            if data is None or not isinstance(data, dict):
                raise RestoreError(
                    RestoreError.REBUILD_FAILED,
                    f"Failed to rebuild data for version {version_id}",
                )

            if data.get("is_truncated"):
                logger.info(
                    "collab-first restore skipped for table:%s: truncated snapshot",
                    resource_id,
                )
                return None

            if not data.get("fields"):
                raise RestoreError(
                    RestoreError.REBUILD_FAILED,
                    f"Table restore snapshot for {resource_id} has no field definitions",
                )

            if resource is None:
                resource = self.adapter.get_resource(str(resource_id))
            if not resource:
                raise RestoreError(
                    RestoreError.RESOURCE_NOT_FOUND,
                    f"Resource table:{resource_id} not found",
                )

            prepare_snapshot = getattr(
                self.adapter, "prepare_collab_first_restore_snapshot", None,
            )
            if not callable(prepare_snapshot):
                return None

            snapshot = prepare_snapshot(resource, data)
            cf_result = _call_collab_live_collab_first_restore(
                str(resource_id), snapshot, editor_info,
            )

            if not cf_result.get("loaded"):
                logger.info(
                    "collab-first restore: table:%s not loaded in collab-live, "
                    "falling back to DB-first",
                    resource_id,
                )
                return None

            restore_metadata = target.metadata if isinstance(target.metadata, dict) else {}
            safe_editor = self._safe_editor_info(editor_info)
            prepared = self.adapter.prepare_restore(resource, data)
            if isinstance(prepared, dict) and prepared:
                prepared["_vh_created_at"] = target.created_at

            with transaction.atomic(using=DB_ALIAS):
                metadata_attached = False
                if restore_metadata:
                    try:
                        setattr(resource, "_version_history_restore_metadata", restore_metadata)
                        metadata_attached = True
                    except Exception:
                        logger.debug(
                            "try_collab_first_table_restore: resource rejects temp metadata",
                            exc_info=True,
                        )
                try:
                    self.adapter.restore(resource, data, prepared=prepared, user=user)
                finally:
                    if metadata_attached and hasattr(resource, "_version_history_restore_metadata"):
                        delattr(resource, "_version_history_restore_metadata")

                vh = self._do_create_history(
                    resource_id,
                    data,
                    editor_info,
                    force_snapshot=True,
                    extra_metadata=restore_metadata or None,
                )
                if vh is None:
                    raise RuntimeError(
                        f"_do_create_history returned None during collab-first restore "
                        f"of table:{resource_id}"
                    )

                _restore_session_id = ""
                _restore_agent_run_id = ""
                try:
                    from apps.services.common.platform_context import (
                        get_current_run_id, get_current_session_id,
                    )
                    _restore_session_id = get_current_session_id() or ""
                    _restore_agent_run_id = get_current_run_id() or ""
                except Exception:
                    logger.debug(
                        "try_collab_first_table_restore: failed to read ContextVar",
                        exc_info=True,
                    )

                _version_label = target.name or str(target.id)[:8]
                ChangeLog.objects.using(DB_ALIAS).create(
                    resource_type=self.resource_type,
                    resource_id=resource_id,
                    change_type=CHANGE_TYPE_RESTORE,
                    summary=_("collab.restore_summary", version_label=_version_label),
                    changes={"restored_from": str(target.id), "sync_mode": "collab_first"},
                    **safe_editor,
                    agent_run_id=_restore_agent_run_id,
                    session_id=_restore_session_id,
                    version_history=vh,
                )

            logger.info(
                "collab-first restore succeeded for table:%s version %s → VH %s",
                resource_id, version_id, vh.id,
            )
            return vh
        finally:
            self.release_restore_lock(resource_id)

    def restore_to_version(
        self,
        resource_id: UUID,
        version_id: UUID,
        editor_info: dict,
        *,
        resource=None,
        target: "Optional[VersionHistory]" = None,
        tier: str = "free",
        organization_id: UUID = None,
        user=None,
    ) -> Optional[VersionHistory]:
        """
        恢复资源到指定版本。

        流程:
        1. 获取资源级别的恢复锁（防止并发恢复竞态）
        2. 重建目标版本的数据
        3. 调用 adapter.restore() 写回数据库
        4. 创建一条新的全量快照标记为"恢复操作"
        5. 写入 ChangeLog

        CC-028/CC-029: target 参数允许调用方传入预取的 VersionHistory，
        跳过 _do_restore 内的单条 get_version 查询，支持批量场景。
        """
        self.acquire_restore_lock(resource_id, version_id)
        try:
            return self._do_restore(
                resource_id, version_id, editor_info,
                resource=resource, target=target,
                tier=tier, organization_id=organization_id,
                user=user,
            )
        except RestoreError:
            raise
        except RuntimeError:
            logger.error(
                "Restore rolled back for %s:%s version %s "
                "— _do_create_history failed within transaction",
                self.resource_type, resource_id, version_id,
                exc_info=True,
            )
            raise RestoreError(
                RestoreError.HISTORY_WRITE_FAILED,
                f"_do_create_history failed during restore of "
                f"{self.resource_type}:{resource_id} version {version_id}",
            )
        finally:
            self.release_restore_lock(resource_id)

    def restore_to_version_with_lock_held(
        self,
        resource_id: UUID,
        version_id: UUID,
        editor_info: dict,
        *,
        resource=None,
        target: "Optional[VersionHistory]" = None,
        tier: str = "free",
        organization_id: UUID = None,
        user=None,
    ) -> Optional[VersionHistory]:
        """在调用方已持有 Redis 锁的前提下执行恢复（跳过锁申请）。

        E2E-009: 供批量回滚场景使用——调用方在 DB 事务外预先申请所有锁，
        在 DB 事务内调用此方法，避免 Redis IO 在事务内执行。
        调用方负责在完成后调用 release_restore_lock。
        """
        try:
            return self._do_restore(
                resource_id, version_id, editor_info,
                resource=resource, target=target,
                tier=tier, organization_id=organization_id,
                user=user,
            )
        except RestoreError:
            raise
        except RuntimeError:
            logger.error(
                "Restore rolled back for %s:%s version %s "
                "— _do_create_history failed within transaction",
                self.resource_type, resource_id, version_id,
                exc_info=True,
            )
            raise RestoreError(
                RestoreError.HISTORY_WRITE_FAILED,
                f"_do_create_history failed during restore of "
                f"{self.resource_type}:{resource_id} version {version_id}",
            )

    def _do_restore(
        self,
        resource_id: UUID,
        version_id: UUID,
        editor_info: dict,
        *,
        resource=None,
        target: "Optional[VersionHistory]" = None,
        tier: str = "free",
        organization_id: UUID = None,
        user=None,
    ) -> Optional[VersionHistory]:
        if target is None:
            target = self.get_version(version_id, resource_id=resource_id)
        if not target:
            logger.warning("Version %s not found for %s:%s", version_id, self.resource_type, resource_id)
            raise RestoreError(
                RestoreError.VERSION_NOT_FOUND,
                f"Version {version_id} not found for {self.resource_type}:{resource_id}",
            )

        try:
            data = self.rebuild_data(target)
        except RebuildError as e:
            logger.error(
                "Failed to rebuild data for %s:%s version %s: %s | context=%s",
                self.resource_type, resource_id, version_id, e, e.context,
            )
            raise RestoreError(
                RestoreError.REBUILD_FAILED,
                f"Failed to rebuild data for version {version_id}: {e}",
                context=e.context,
            ) from e
        if data is None:
            logger.error(
                "rebuild_data returned None for %s:%s version %s "
                "(snapshot deserialization failure)",
                self.resource_type, resource_id, version_id,
            )
            raise RestoreError(
                RestoreError.REBUILD_FAILED,
                f"Failed to rebuild data for version {version_id} "
                f"(snapshot deserialization returned None)",
            )

        if resource is None:
            resource = self.adapter.get_resource(str(resource_id))
        if not resource:
            logger.error("Resource %s:%s not found", self.resource_type, resource_id)
            raise RestoreError(
                RestoreError.RESOURCE_NOT_FOUND,
                f"Resource {self.resource_type}:{resource_id} not found",
            )

        safe_editor = self._safe_editor_info(editor_info)

        # AP-011: 在事务外执行 HTTP IO（如 docs 的 binary→formats 转换），
        # 避免 DB 事务持锁期间等待跨服务 HTTP 调用导致连接池耗尽
        prepared = self.adapter.prepare_restore(resource, data)

        # TR-001: 将 VH 创建时间注入 prepared，供 adapter 在截断快照场景下
        # fallback 到 RecordHistory 回放时定位正确的历史时间点
        # P0-01 fix: 不再将 prepared=None 转为 {}，避免绕过 adapter 的
        # CSC-005 fallback（保留旧值而非写入空内容）
        if isinstance(prepared, dict) and prepared:
            prepared['_vh_created_at'] = target.created_at

        restore_metadata = target.metadata if isinstance(target.metadata, dict) else {}
        history_data = data
        history_metadata = restore_metadata
        if self.resource_type == "docs" and isinstance(data, dict) and data.get("format") == "binary_snapshot":
            try:
                import base64

                history_data = base64.b64decode(data.get("binary_b64", ""))
                history_metadata = dict(history_metadata or {})
                if "title" in data:
                    history_metadata["tabdoc_title"] = data.get("title") or ""
            except Exception:
                logger.warning(
                    "restore_to_version: failed to normalize legacy TabDoc binary_snapshot",
                    exc_info=True,
                )
                history_data = data

        with transaction.atomic(using=DB_ALIAS):
            metadata_attached = False
            if restore_metadata:
                try:
                    setattr(resource, "_version_history_restore_metadata", restore_metadata)
                    metadata_attached = True
                except Exception:
                    logger.debug(
                        "restore_to_version: resource does not accept temporary metadata",
                        exc_info=True,
                    )
            try:
                self.adapter.restore(resource, data, prepared=prepared, user=user)
            finally:
                if metadata_attached and hasattr(resource, "_version_history_restore_metadata"):
                    delattr(resource, "_version_history_restore_metadata")

            # SR-017: 直接调用 _do_create_history 绕过 Redis 锁，
            # 避免在 DB 事务内执行 cache.add/cache.delete（Redis IO）。
            # _do_restore 已由 restore_to_version 的 restore_lock 保护，
            # 且 force_snapshot=True 不涉及 diff 判断的并发竞争。
            vh = self._do_create_history(
                resource_id,
                history_data,
                editor_info,
                force_snapshot=True,
                tier=tier,
                organization_id=organization_id,
                extra_metadata=history_metadata or None,
            )

            if vh is None:
                raise RuntimeError(
                    f"_do_create_history returned None during restore of "
                    f"{self.resource_type}:{resource_id} "
                    f"(unexpected: force_snapshot=True should always create)"
                )

            # QC-05 / B-1：恢复路径通常由用户发起（editor_type='user'），但若 Agent
            # 内部触发恢复（例如对话中"回到 v5"），ContextVar 的 agent_run_id /
            # session_id 仍可用；W0-2 audit §3.4.2 要求二者一并写入——本入口
            # 服务于 table/docs/canvas/video/file 全部资源类型，影响面最广。
            _restore_session_id = ""
            _restore_agent_run_id = ""
            try:
                from apps.services.common.platform_context import (
                    get_current_run_id, get_current_session_id,
                )
                _restore_session_id = get_current_session_id() or ""
                _restore_agent_run_id = get_current_run_id() or ""
            except Exception:
                logger.debug(
                    "restore_to_version: failed to read ContextVar (run/session)",
                    exc_info=True,
                )

            _version_label = target.name or str(target.id)[:8]
            ChangeLog.objects.using(DB_ALIAS).create(
                resource_type=self.resource_type,
                resource_id=resource_id,
                change_type=CHANGE_TYPE_RESTORE,
                summary=_("collab.restore_summary", version_label=_version_label),
                changes={"restored_from": str(target.id)},
                **safe_editor,
                agent_run_id=_restore_agent_run_id,
                session_id=_restore_session_id,
                version_history=vh,
            )

        return vh

    # ── 命名版本 ─────────────────────────────────────

    def create_named_version(
        self,
        resource_id: UUID,
        name: str,
        data: Any,
        editor_info: dict,
        *,
        organization_id: UUID = None,
    ) -> Optional[VersionHistory]:
        """创建一个命名版本（全量快照，永不过期）。"""
        return self.create_history(
            resource_id,
            data,
            editor_info,
            force_snapshot=True,
            is_named=True,
            name=name,
            organization_id=organization_id,
        )

    def rename_version(self, version_id: UUID, new_name: str) -> bool:
        updated = (
            VersionHistory.objects.using(DB_ALIAS)
            .filter(id=version_id)
            .update(name=new_name)
        )
        return updated > 0

    def toggle_pin(self, version_id: UUID, pinned: bool) -> bool:
        updates = {"pinned": pinned}
        if pinned:
            updates["expired_at"] = None

        updated = (
            VersionHistory.objects.using(DB_ALIAS)
            .filter(id=version_id)
            .update(**updates)
        )

        if not pinned and updated > 0:
            VersionHistory.objects.using(DB_ALIAS).filter(
                id=version_id,
                is_named=False,
            ).update(
                expired_at=timezone.now() + TTL_TIERS["team"],
            )

        return updated > 0

    # ── 维护 ─────────────────────────────────────────

    def cleanup_expired_versions(self, batch_size: int = 500) -> int:
        """
        CC-009: 覆盖基类 cleanup_expired，使用 Exists 子查询替代
        referenced_ids Python 集合，消除 TOCTOU 窗口。

        基类将 referenced_ids 加载到 Python set 后再做 exclude，
        窗口期内新写入的 diff 引用的 snapshot 可能被误删。
        Exists 子查询在 DELETE 执行时由 PostgreSQL 在线评估，
        引用关系在删除瞬间仍然准确。

        分批删除：每批最多 batch_size 条，独立事务，避免长时间锁表。
        """
        import time

        from django.db.models import Exists, OuterRef

        now = timezone.now()
        total_deleted = 0

        is_referenced = VersionHistory.objects.using(DB_ALIAS).filter(
            base_history_id=OuterRef("pk"),
        )

        # P1-06 fix: 排除被 SpaceCheckpoint 引用的 VH，防止 checkpoint
        # 回滚时因引用的 VH 已被 cleanup 删除而导致数据丢失。
        # 正常情况下 checkpoint 创建时会将被引用 VH 的 expired_at 设为 NULL
        # （免于 expired_at__lt=now 过滤），此处为防御性安全网。
        from .models import SpaceCheckpoint
        checkpoint_protected_vh_ids: set[UUID] = set()
        for refs in SpaceCheckpoint.objects.using(DB_ALIAS).values_list(
            "version_refs", flat=True
        ):
            if refs:
                for vid_str in refs.values():
                    try:
                        checkpoint_protected_vh_ids.add(UUID(vid_str))
                    except (ValueError, TypeError):
                        pass

        while True:
            with transaction.atomic(using=DB_ALIAS):
                qs = (
                    VersionHistory.objects.using(DB_ALIAS)
                    .filter(expired_at__lt=now, is_named=False, pinned=False)
                    .exclude(Exists(is_referenced))
                )
                # P1-06 fix: 排除被 SpaceCheckpoint 引用的 VH
                if checkpoint_protected_vh_ids:
                    qs = qs.exclude(id__in=checkpoint_protected_vh_ids)
                batch_ids = list(
                    qs.select_for_update(skip_locked=True)
                    .values_list("id", flat=True)[:batch_size]
                )
                if not batch_ids:
                    break
                deleted, _ = (
                    VersionHistory.objects.using(DB_ALIAS)
                    .filter(id__in=batch_ids)
                    .delete()
                )

            total_deleted += deleted
            logger.info(
                "cleanup_expired_versions: 本批删除 %d 条，累计 %d 条",
                deleted, total_deleted,
            )
            if len(batch_ids) < batch_size:
                break
            time.sleep(0.1)

        if total_deleted:
            logger.info("cleanup_expired_versions: 总计删除 %d 条过期版本", total_deleted)

        return total_deleted

    def downsample_versions(self) -> int:
        """
        分级降采样，按 (resource_type, resource_id) 分组。

        覆盖基类方法，因为通用 VersionHistory 无 FK 字段，
        基类的 _find_resource_field 会返回 None 导致跳过。

        DC-019: 原方案全表查询 referenced_ids 到 Python 集合，
        记录量大时内存无界。改用 Exists 子查询下推到数据库，
        由 PostgreSQL 利用 base_history_id 索引在线过滤，
        Python 侧零额外内存。每个 group 的删除操作包裹在
        transaction.atomic 内，确保排除和 delete 的一致性。
        """
        from datetime import timedelta

        from django.db.models import Count, Exists, OuterRef
        from django.db.models.functions import TruncDay, TruncHour, TruncWeek

        now = timezone.now()
        total = 0

        # Exists 子查询：检查某条 VH 是否被其他记录作为 base_history 引用
        is_referenced = VersionHistory.objects.using(DB_ALIAS).filter(
            base_history_id=OuterRef("pk"),
        )

        # CC-019: 新增 30-90 天 TruncWeek 区间，覆盖 team 用户（TTL=90天）
        ranges = [
            (now - timedelta(days=7), now - timedelta(days=1), TruncHour),
            (now - timedelta(days=30), now - timedelta(days=7), TruncDay),
            (now - timedelta(days=90), now - timedelta(days=30), TruncWeek),
        ]

        for start, end, TruncFunc in ranges:
            qs = VersionHistory.objects.using(DB_ALIAS).filter(
                created_at__gte=start,
                created_at__lt=end,
                is_named=False,
                pinned=False,
            )
            if not qs.exists():
                continue

            groups = (
                qs.annotate(bucket=TruncFunc("created_at"))
                .values("resource_type", "resource_id", "bucket")
                .annotate(cnt=Count("id"))
                .filter(cnt__gt=1)
            )

            for g in groups:
                with transaction.atomic(using=DB_ALIAS):
                    bucket_qs = qs.filter(
                        resource_type=g["resource_type"],
                        resource_id=g["resource_id"],
                    ).annotate(bucket=TruncFunc("created_at")).filter(bucket=g["bucket"])

                    keep_id = bucket_qs.order_by("-created_at", "-id").values_list("id", flat=True).first()
                    # is_snapshot=False 既是业务语义（只降采样 diff），也是安全网：
                    # 即使子查询有竞态延迟，快照锚点也不会被误删
                    to_delete = (
                        bucket_qs
                        .exclude(id=keep_id)
                        .filter(is_snapshot=False)
                        .exclude(Exists(is_referenced))
                    )

                    cnt = to_delete.count()
                    if cnt > 0:
                        to_delete.delete()
                        total += cnt

        return total

    # ── 内部工具 ─────────────────────────────────────

    @staticmethod
    def _resolve_tier_from_organization(organization_id) -> str:
        """根据组织的会员等级解析实际套餐 tier。

        查询 OrganizationMembership 获取 tier_type，映射为 TTL_TIERS 的 key。
        查询失败或无有效会员时 fallback 到 "free"。
        结果缓存 60 秒，减少高频写入场景下的 DB 查询。
        """
        if not organization_id:
            return "free"

        cache_key = f"vh:tier:{organization_id}"
        try:
            cached = cache.get(cache_key)
        except Exception:
            cached = None
        if cached is not None:
            return cached

        tier = "free"
        try:
            from apps.users.membership.models import OrganizationMembership

            ws = (
                OrganizationMembership.objects
                .select_related("tier")
                .filter(organization_id=str(organization_id), status="active")
                .first()
            )
            if ws is not None:
                if ws.end_date is None or ws.end_date >= timezone.now():
                    tier_type = getattr(ws.tier, "tier_type", None)
                    tier = MEMBERSHIP_TIER_MAP.get(tier_type, "free")
        except Exception:
            logger.debug(
                "Failed to resolve organization tier for %s, using free TTL",
                organization_id, exc_info=True,
            )

        try:
            cache.set(cache_key, tier, timeout=60)
        except Exception:
            logger.debug("cache.set failed for %s", cache_key, exc_info=True)

        return tier

    @staticmethod
    def _compute_ttl(tier: str):
        delta = TTL_TIERS.get(tier, TTL_TIERS["free"])
        return timezone.now() + delta
