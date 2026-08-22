"""TabData 模块的 Checkpoint Contributor 实现 (TD-2 / TD-3 / Wave 1.1)。

Charter §3.2 / §3.3 协议方向（D2）下，本模块**实现**
:class:`apps.collab.services.contributors.ResourceContributor` /
:class:`apps.collab.services.contributors.ImpactContributor` 协议，
在 :class:`apps.tabdata.apps.TabdataConfig.ready` 时通过
:func:`register_resource_contributor` / :func:`register_impact_contributor`
注册到 collab 的 contributor 注册中心。

设计要点
--------

1. **协议方向（D2）**：tabdata 不主动调 ``daemon_checkpoint_service``，
   仅被动响应 ``collect_resources(agent_run_ids)``。
2. **数据源**：
   - ResourceContributor → 反查 ``ChangeLog WHERE agent_run_id IN (...)
     AND resource_type='table'`` 拿到本 turn 涉及的 ``table_id``，再对每个
     ``table_id`` 取最新 ``VersionHistory.id``（Charter §3.2 算法）。
   - ImpactContributor → 复用同一 ChangeLog 反查 + 聚合 ``record_count`` /
     ``record_ids`` 给前端展示用（Charter §3.3）。
3. **PG 性能**：所有反查都用 ChangeLog.``agent_run_id`` 的 ``db_index``
   单字段索引（W0-1 已存在），单 SQL 一次拉清单；最新 VH 用
   ``DISTINCT ON (resource_id)`` PG 原生窗口查询，避免 N+1。
4. **Fail-safe**：任何 contributor 抛异常时 collab 收集器层会捕获
   （:func:`apps.collab.services.contributors.collect_contributed_resources`
   已实现），本模块只负责"读不到就返回空"，不抛业务异常。
5. **W0-1 ``expand_agent_run_ids``**：本模块假设 caller 已经展开过子 Agent
   级联（Charter §3.2 + W0-1 P0-B 修复），不重复展开。
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Mapping, Optional

from apps.collab.services.contributors import ResourceContributor, ResourceRef

logger = logging.getLogger(__name__)


# resource_type 字面量（与 collab.constants.RESOURCE_TYPES 中的 'table' 对齐）
_RESOURCE_TYPE_TABLE = "table"

# ChangeLog / VersionHistory 都在 PG（与 apps.collab.service.DB_ALIAS 对齐）
_COLLAB_DB_ALIAS = "postgresql"


class TableResourceContributor:
    """Charter §3.2 / TD-2：tabdata 资源版本锚点贡献者。

    在 SpaceCheckpoint 创建钩子里被
    :func:`apps.collab.services.contributors.collect_contributed_resources`
    调用，返回本轮 turn 涉及的 ``(table_id → latest VersionHistory id)``
    列表。Checkpoint 模块据此把 ``table:table_id`` 写入
    ``SpaceCheckpoint.version_refs``，回滚时
    :func:`apps.collab.service.restore_to_version_with_lock_held`
    会自动路由到 :class:`apps.collab.adapters.table.TableCollabAdapter`。
    """

    name: str = "tabdata"

    def collect_resources(self, agent_run_ids: List[str]) -> List[ResourceRef]:
        """按 ``agent_run_ids`` 反查涉及的 ``table_id`` 并取最新 VH。

        :param agent_run_ids: 已用 ``expand_agent_run_ids`` 展开的全量 run id 列表
            （含子 Agent 级联）。允许空列表，直接返回 ``[]``。
        :returns: ``[{resource_type:'table', resource_id:..., version_history_id:...}, ...]``
            （类型对齐 :class:`ResourceRef` TypedDict）。
        """
        if not agent_run_ids:
            return []

        # 1) 反查涉及的 table_id —— 走 ChangeLog.agent_run_id 单字段索引
        # （已存在 ``apps/collab/models.py:208`` ``db_index=True``）
        try:
            from apps.collab.models import ChangeLog

            table_ids = list(
                ChangeLog.objects.using(_COLLAB_DB_ALIAS)
                .filter(
                    agent_run_id__in=agent_run_ids,
                    resource_type=_RESOURCE_TYPE_TABLE,
                )
                .values_list("resource_id", flat=True)
                .distinct()
            )
        except Exception:
            logger.warning(
                "TableResourceContributor: ChangeLog reverse-lookup failed "
                "(returning empty), agent_run_ids=%s",
                agent_run_ids[:3],
                exc_info=True,
            )
            return []

        if not table_ids:
            return []

        # 2) 对每个 table_id 取最新 VersionHistory.id —— PG 原生 DISTINCT ON
        # （resource_id）单 SQL 拉清单，O(n log n) 避免 N+1。
        try:
            from apps.collab.models import VersionHistory

            # PostgreSQL DISTINCT ON 要求 ORDER BY 的第一列与 distinct 列一致；
            # 第二列 ``-created_at`` 选择最新；id 字段直接 values 出来供构造 ref。
            latest_pairs = (
                VersionHistory.objects.using(_COLLAB_DB_ALIAS)
                .filter(
                    resource_type=_RESOURCE_TYPE_TABLE,
                    resource_id__in=table_ids,
                )
                .order_by("resource_id", "-created_at")
                .distinct("resource_id")
                .values_list("resource_id", "id")
            )
            refs: List[ResourceRef] = []
            for resource_id, vh_id in latest_pairs:
                refs.append({
                    "resource_type": _RESOURCE_TYPE_TABLE,
                    "resource_id": str(resource_id),
                    "version_history_id": str(vh_id),
                })
            return refs
        except Exception:
            logger.warning(
                "TableResourceContributor: VersionHistory latest-pick failed "
                "(returning empty), table_ids=%s",
                table_ids[:3],
                exc_info=True,
            )
            return []


class TableImpactContributor:
    """Charter §3.3 / DC-W0-1-1：tabdata 维度的影响摘要贡献者。

    在 ``build_checkpoint_impact`` 中被
    :func:`apps.collab.services.contributors.collect_contributed_impact`
    调用，给前端 ``CheckpointContextCard`` / ``RewindPreviewPanel``
    （DC-W0-1-1 / D15 方案 A）提供"本次操作影响 N 张表 / N 行"摘要。

    返回结构对齐 [Charter §3.3]::

        {
            "tables_affected": [
                {
                    "table_id": "tbl_xxx",
                    "table_name": "...",
                    "changes": {
                        "records_inserted": 0,
                        "records_updated": 1203,
                        "records_deleted": 0,
                        "fields_added": [],
                        "fields_removed": [],
                    },
                },
                ...
            ]
        }
    """

    name: str = "tabdata"

    # 与 ChangeLogSubscriber._EVENT_CHANGE_TYPE 对齐的 change_type 分类
    _CREATE_TYPES = frozenset({"create_record", "batch_create_records"})
    _UPDATE_TYPES = frozenset({"update_record", "batch_update_records", "import_data"})
    _DELETE_TYPES = frozenset({"delete_record", "batch_delete_records"})
    _RESTORE_TYPES = frozenset({"restore"})
    # P1 修复（Wave 1.3 Review §6）：C1 字段 undo 写入的 ChangeLog change_type,
    # 让 contributor 反查能聚合"恢复 N 个字段"摘要给前端 RewindPreviewPanel
    _FIELD_RESTORE_TYPES = frozenset({"restore_field"})

    def collect_impact(self, agent_run_ids: List[str]) -> Optional[Mapping[str, Any]]:
        """按 ``agent_run_ids`` 反查 ChangeLog 聚合得 tabdata 维度影响摘要。

        :returns: 影响摘要 dict，或 ``None`` / 空 dict 表示"本 turn 无 tabdata 变更"。
        """
        if not agent_run_ids:
            return None

        try:
            from apps.collab.models import ChangeLog

            rows = list(
                ChangeLog.objects.using(_COLLAB_DB_ALIAS)
                .filter(
                    agent_run_id__in=agent_run_ids,
                    resource_type=_RESOURCE_TYPE_TABLE,
                )
                .values("resource_id", "change_type", "changes")
            )
        except Exception:
            logger.warning(
                "TableImpactContributor: ChangeLog reverse-lookup failed "
                "(returning empty), agent_run_ids=%s",
                agent_run_ids[:3],
                exc_info=True,
            )
            return None

        if not rows:
            return None

        # 按 table_id 聚合
        per_table: Dict[str, Dict[str, Any]] = {}
        for row in rows:
            tid = str(row["resource_id"])
            change_type = row.get("change_type") or ""
            changes = row.get("changes") or {}
            entry = per_table.setdefault(tid, {
                "table_id": tid,
                "table_name": "",
                "changes": {
                    "records_inserted": 0,
                    "records_updated": 0,
                    "records_deleted": 0,
                    "fields_added": [],
                    "fields_removed": [],
                },
            })
            count = int(changes.get("record_count") or 0) or (
                int(changes.get("created_count") or 0)
                + int(changes.get("updated_count") or 0)
            )
            if not count:
                # 单条操作 ChangeLog 的 changes 不一定带 record_count；按 1 兜底
                count = 1

            if change_type in self._CREATE_TYPES:
                entry["changes"]["records_inserted"] += count
            elif change_type in self._UPDATE_TYPES:
                # import_data 的 changes 含 created+updated 拆分
                entry["changes"]["records_inserted"] += int(changes.get("created_count") or 0)
                entry["changes"]["records_updated"] += int(changes.get("updated_count") or 0) or count
            elif change_type in self._DELETE_TYPES:
                entry["changes"]["records_deleted"] += count
            elif change_type in self._RESTORE_TYPES:
                # restore 视作"恢复" → 算作 updated 的一种
                entry["changes"]["records_updated"] += count
            elif change_type in self._FIELD_RESTORE_TYPES:
                # P1 修复（Wave 1.3 Review §6）：C1 字段 undo
                # changes 含 field_name + field_type,加进 fields_added 列表
                field_name = changes.get("field_name") or ""
                if field_name:
                    entry["changes"]["fields_added"].append(field_name)

        # 回填 table_name —— 单 SQL 一次拉，避免 N+1
        if per_table:
            try:
                from apps.tabdata.models import Table
                from apps.tabdata.constants import TABDATA_DB_ALIAS

                name_map = dict(
                    Table.objects.using(TABDATA_DB_ALIAS)
                    .filter(id__in=list(per_table.keys()))
                    .values_list("id", "name")
                )
                for tid, entry in per_table.items():
                    name = name_map.get(tid) or name_map.get(tid.replace("-", ""))
                    if name:
                        entry["table_name"] = str(name)
            except Exception:
                # 名称回填失败不影响摘要主体
                logger.debug(
                    "TableImpactContributor: name lookup failed; entries=%d",
                    len(per_table),
                    exc_info=True,
                )

        return {"tables_affected": list(per_table.values())}
