"""关联字段引用追踪与标题传播。"""

import logging
from collections import defaultdict, deque
from typing import Any, Dict, List, Optional, Set, Tuple
from uuid import UUID

from django.db import connections

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import FieldReference, LinkRecord, TableField, TableRecord
from apps.tabdata.utils.record_data_access import skip_record_history

logger = logging.getLogger(__name__)


# ─── 图算法工具 ──────────────────────────────────────────────────


def has_cycle(edges: List[Tuple[str, str]]) -> bool:
    """
    DFS 三色标记检测有向图是否含环。

    Args:
        edges: [(from_id, to_id), ...] — from → to 表示 "to 依赖 from"
    """
    adj: Dict[str, List[str]] = defaultdict(list)
    nodes: Set[str] = set()
    for src, dst in edges:
        adj[src].append(dst)
        nodes.add(src)
        nodes.add(dst)

    WHITE, GRAY, BLACK = 0, 1, 2
    color: Dict[str, int] = {n: WHITE for n in nodes}

    def dfs(node: str) -> bool:
        color[node] = GRAY
        for nb in adj[node]:
            if color[nb] == GRAY:
                return True  # 回边 = 环
            if color[nb] == WHITE and dfs(nb):
                return True
        color[node] = BLACK
        return False

    return any(color[n] == WHITE and dfs(n) for n in nodes)


def topological_sort_layers(
    field_ids: List[str],
    edges: List[Tuple[str, str]],
) -> List[List[str]]:
    """
    按拓扑序将字段分层（Kahn 算法）。

    Layer 0: 无依赖的 leaf 字段
    Layer N: 所有依赖已在前 N-1 层解决的字段

    Args:
        field_ids: 待排序的字段 ID 列表
        edges: [(from_id, to_id)] — "to 依赖 from"

    Returns:
        [[layer0_ids], [layer1_ids], ...]
        若存在环则返回尽可能多的层 + 剩余节点在最后一层
    """
    field_set = set(field_ids)
    adj: Dict[str, List[str]] = defaultdict(list)
    indegree: Dict[str, int] = {fid: 0 for fid in field_ids}

    for src, dst in edges:
        if src in field_set and dst in field_set:
            adj[src].append(dst)
            indegree[dst] = indegree.get(dst, 0) + 1

    layers: List[List[str]] = []
    queue = deque(fid for fid in field_ids if indegree.get(fid, 0) == 0)
    visited: Set[str] = set()

    while queue:
        layer = list(queue)
        layers.append(layer)
        visited.update(layer)
        next_queue: List[str] = []
        for node in layer:
            for nb in adj[node]:
                indegree[nb] -= 1
                if indegree[nb] == 0:
                    next_queue.append(nb)
        queue = deque(next_queue)

    # 兜底：如果有未处理节点（环），放入最后一层
    remaining = [fid for fid in field_ids if fid not in visited]
    if remaining:
        logger.warning("Topological sort: %d nodes remain (possible cycle)", len(remaining))
        layers.append(remaining)

    return layers


# ─── 依赖图注册 ─────────────────────────────────────────────────


class FieldReferenceManager:
    """字段依赖边的增删管理"""

    @staticmethod
    def register_references(to_field_id: str, from_field_ids: List[str]) -> None:
        """
        为 to_field 注册依赖边：to_field 依赖 from_field_ids 中的每个字段。

        幂等操作：先删旧边再创建新边。
        """
        to_uuid = UUID(str(to_field_id))
        from_uuids: List[UUID] = []
        seen: Set[UUID] = set()
        for fid in from_field_ids:
            if not fid:
                continue
            from_uuid = UUID(str(fid))
            if from_uuid == to_uuid:
                raise ValueError(f'字段 {to_uuid} 不能依赖自身')
            if from_uuid in seen:
                continue
            seen.add(from_uuid)
            from_uuids.append(from_uuid)

        # 强制循环依赖检测（按“替换 to_field 的 incoming 边”语义）
        if FieldReferenceManager._check_cycle_for_replace(to_uuid, from_uuids):
            raise ValueError(f'检测到循环依赖，字段 {to_uuid} 的依赖配置无效')

        # 先清理该字段的所有 incoming 边
        FieldReference.objects.using(TABDATA_DB_ALIAS).filter(to_field_id=to_uuid).delete()

        if not from_uuids:
            return

        refs = [
            FieldReference(from_field_id=fid, to_field_id=to_uuid)
            for fid in from_uuids
        ]
        FieldReference.objects.using(TABDATA_DB_ALIAS).bulk_create(refs, ignore_conflicts=True)

    @staticmethod
    def _check_cycle_for_replace(to_field_id: UUID, from_field_ids: List[UUID]) -> bool:
        """
        检测“替换 to_field 的 incoming 边”后是否会产生环。

        关键点：先排除当前 to_field 的旧 incoming 边，再加入新边检测，
        避免旧边导致的误报。
        """
        all_refs = list(
            FieldReference.objects.using(TABDATA_DB_ALIAS).exclude(
                to_field_id=to_field_id,
            ).values_list('from_field_id', 'to_field_id')
        )
        edges = [(str(f), str(t)) for f, t in all_refs]
        edges.extend((str(fid), str(to_field_id)) for fid in from_field_ids)
        return has_cycle(edges)

    @staticmethod
    def deregister_field(field_id: str) -> None:
        """删除某字段涉及的所有依赖边（作为 from 或 to）。"""
        fid = UUID(str(field_id))
        FieldReference.objects.using(TABDATA_DB_ALIAS).filter(
            models_Q_from_or_to(fid)
        ).delete()

    @staticmethod
    def check_cycle_before_add(to_field_id: str, from_field_ids: List[str]) -> bool:
        """
        在注册新边之前检测是否会引入环。

        Returns:
            True 如果会产生环
        """
        to_uuid = UUID(str(to_field_id))
        from_uuids = [UUID(str(fid)) for fid in from_field_ids if fid]
        return FieldReferenceManager._check_cycle_for_replace(to_uuid, from_uuids)


def models_Q_from_or_to(fid):
    """构建 Q(from_field_id=fid) | Q(to_field_id=fid)"""
    from django.db.models import Q
    return Q(from_field_id=fid) | Q(to_field_id=fid)


# ─── 级联服务核心 ────────────────────────────────────────────────


class CascadeService:
    """沿 Link 引用关系刷新缓存标题。"""

    MAX_CTE_DEPTH = 20

    # ── 依赖字段发现（递归 CTE）──

    @staticmethod
    def get_dependent_fields(
        start_field_ids: List[str],
    ) -> Dict[str, Set[str]]:
        """
        通过递归 CTE 查找所有下游依赖字段。

        Args:
            start_field_ids: 发生变化的源字段 ID 列表

        Returns:
            {table_id: {field_id, ...}} — 需要重算的字段按表分组
        """
        if not start_field_ids:
            return {}

        connection = connections[TABDATA_DB_ALIAS]
        pk_field = TableField._meta.get_field('id')
        db_start_field_ids: List[str] = []
        for fid in start_field_ids:
            try:
                normalized_fid = UUID(str(fid))
            except (TypeError, ValueError):
                logger.warning("Cascade 收到无效字段 ID: %s", fid)
                continue
            db_start_field_ids.append(
                pk_field.get_db_prep_value(normalized_fid, connection)
            )

        if not db_start_field_ids:
            return {}

        placeholders = ', '.join(['%s'] * len(db_start_field_ids))
        reference_table = FieldReference._meta.db_table
        field_table = TableField._meta.db_table
        sql = f"""
        WITH RECURSIVE dep_graph(from_field_id, to_field_id, depth) AS (
            SELECT r0.from_field_id, r0.to_field_id, 1
            FROM {reference_table} r0
            JOIN {field_table} ff0 ON ff0.id = r0.from_field_id
            WHERE r0.from_field_id IN ({placeholders})
              AND ff0.is_deleted = false

            UNION

            SELECT r.from_field_id, r.to_field_id, d.depth + 1
            FROM {reference_table} r
            JOIN dep_graph d ON r.from_field_id = d.to_field_id
            JOIN {field_table} ff ON ff.id = r.from_field_id
            WHERE d.depth < {CascadeService.MAX_CTE_DEPTH}
              AND ff.is_deleted = false
        )
        SELECT DISTINCT dg.to_field_id, f.table_id
        FROM dep_graph dg
        JOIN {field_table} f ON f.id = dg.to_field_id
        WHERE f.is_deleted = false
          AND f.field_type = 'link'
        """
        params = db_start_field_ids

        def _normalize_uuid(value: Any) -> str:
            try:
                return str(UUID(str(value)))
            except (TypeError, ValueError):
                return str(value)

        result: Dict[str, Set[str]] = defaultdict(set)
        with connection.cursor() as cursor:
            cursor.execute(sql, params)
            for row in cursor.fetchall():
                to_field_id = _normalize_uuid(row[0])
                table_id = _normalize_uuid(row[1])
                result[table_id].add(to_field_id)

        total_fields = sum(len(fids) for fids in result.values())
        if total_fields > 100:
            logger.warning(
                "get_dependent_fields: 下游依赖字段数量过多 (%d), "
                "start_fields=%s, tables=%d",
                total_fields, start_field_ids[:5], len(result),
            )

        return dict(result)


    # ── LinkRecord BFS 传播 ──

    MAX_BFS_DEPTH = 15
    MAX_AFFECTED_RECORDS = 50_000

    @staticmethod
    def resolve_link_closure(
        seeds: Dict[str, Set[str]],
        impacted_table_ids: Set[str],
    ) -> Dict[str, Set[str]]:
        """
        BFS 沿 LinkRecord 传播受影响记录。

        Args:
            seeds: {table_id: {record_id, ...}} — 初始受影响记录
            impacted_table_ids: 需要追踪的表 ID 集合

        Returns:
            {table_id: {record_id, ...}} — 扩展后的受影响记录
        """
        if not seeds:
            return {}

        # 加载所有相关 link 字段的元数据
        link_fields = list(
            TableField.objects.using(TABDATA_DB_ALIAS).filter(
                field_type='link',
                is_deleted=False,
                table_id__in=impacted_table_ids | set(seeds.keys()),
            ).values('id', 'table_id', 'config')
        )

        # 构建 link 边：(source_table, target_table, link_field_id, is_outgoing)
        edges = []
        for lf in link_fields:
            config = lf['config'] or {}
            foreign_table_id = config.get('foreignTableId')
            if not foreign_table_id:
                continue
            # outgoing: self_record 在 lf.table_id, foreign_record 在 foreign_table_id
            edges.append({
                'src_table': str(lf['table_id']),
                'dst_table': str(foreign_table_id),
                'link_field_id': str(lf['id']),
                'direction': 'outgoing',  # self → foreign
            })
            # incoming: foreign → self。单向关联没有 symmetricFieldId，但 LinkRecord
            # 仍指向 foreign_record；漏掉这条边会导致 B 字段变化时找不到 A 上引用行，
            # 否则 link title 传播会静默跳过。
            edges.append({
                'src_table': str(foreign_table_id),
                'dst_table': str(lf['table_id']),
                'link_field_id': str(lf['id']),
                'direction': 'incoming',  # foreign → self
            })

        # 按源表分组
        edges_by_src: Dict[str, list] = defaultdict(list)
        for e in edges:
            edges_by_src[e['src_table']].append(e)

        visited: Dict[str, Set[str]] = defaultdict(set)
        for table_id, record_ids in seeds.items():
            visited[table_id].update(str(rid) for rid in record_ids)

        total_records = sum(len(v) for v in visited.values())

        queue: deque = deque()
        for table_id, record_ids in seeds.items():
            queue.append((table_id, set(str(rid) for rid in record_ids), 0))

        truncated = False
        while queue:
            src_table, src_record_ids, depth = queue.popleft()

            if depth > CascadeService.MAX_BFS_DEPTH:
                logger.warning(
                    "resolve_link_closure: BFS depth exceeded %d, truncating",
                    CascadeService.MAX_BFS_DEPTH,
                )
                truncated = True
                break

            if total_records > CascadeService.MAX_AFFECTED_RECORDS:
                logger.warning(
                    "resolve_link_closure: affected records exceeded %d (current %d), truncating",
                    CascadeService.MAX_AFFECTED_RECORDS, total_records,
                )
                truncated = True
                break

            for edge in edges_by_src.get(src_table, []):
                dst_table = edge['dst_table']
                link_field_id = edge['link_field_id']
                direction = edge['direction']

                # 通过 LinkRecord 查找目标记录
                src_id_list = list(src_record_ids)
                BATCH_SIZE = 500
                new_dst_ids: Set[str] = set()

                for i in range(0, len(src_id_list), BATCH_SIZE):
                    batch = src_id_list[i:i + BATCH_SIZE]

                    if direction == 'outgoing':
                        rows = LinkRecord.objects.using(TABDATA_DB_ALIAS).filter(
                            link_field_id=link_field_id,
                            self_record_id__in=batch,
                        ).values_list('foreign_record_id', flat=True)
                    else:
                        rows = LinkRecord.objects.using(TABDATA_DB_ALIAS).filter(
                            link_field_id=link_field_id,
                            foreign_record_id__in=batch,
                        ).values_list('self_record_id', flat=True)

                    for rid in rows:
                        rid_str = str(rid)
                        if rid_str not in visited[dst_table]:
                            visited[dst_table].add(rid_str)
                            new_dst_ids.add(rid_str)

                if new_dst_ids:
                    total_records += len(new_dst_ids)
                    queue.append((dst_table, new_dst_ids, depth + 1))

                if total_records > CascadeService.MAX_AFFECTED_RECORDS:
                    break

            if truncated:
                break

        return dict(visited)

    # ── 主入口：关联标题传播 ──

    @classmethod
    def propagate_cell_changes(
        cls,
        table_id: str,
        changed_field_ids: List[str],
        record_ids: List[str],
        *,
        skip_field_ids: Optional[Set[str]] = None,
    ) -> List[Dict[str, Any]]:
        """
        主入口：当 cell 值变化后刷新受影响的 Link 标题缓存。

        本方法不自行开启事务。调用方必须保证已在
        ``transaction.atomic(using=TABDATA_DB_ALIAS)`` 上下文内调用。

        Args:
            table_id: 源表 ID
            changed_field_ids: 变化的字段 ID 列表
            record_ids: 变化的记录 ID 列表
            skip_field_ids: 跳过的字段（如源字段本身）

        Returns:
            需要发送 WS 通知的 [{table_id, record_ids}] 列表

        Raises:
            RuntimeError: 调用时不在 ``transaction.atomic(using=TABDATA_DB_ALIAS)``
                上下文内(用 RuntimeError 而非 assert,确保 ``python -O`` 优化模式
                下断言不被剥离;W0-4 §3.0 / §6.1)。
        """
        if not connections[TABDATA_DB_ALIAS].in_atomic_block:
            raise RuntimeError(
                "CascadeService.propagate_cell_changes 必须在 "
                "transaction.atomic(using=TABDATA_DB_ALIAS) 上下文内调用 "
                "（关联标题传播必须与记录写入处于同一事务）"
            )

        if not changed_field_ids or not record_ids:
            return []

        skip = skip_field_ids or set()
        str_table_id = str(table_id)
        str_field_ids = [str(fid) for fid in changed_field_ids]
        str_record_ids = [str(rid) for rid in record_ids]

        # 1. 查找所有下游依赖字段
        dep_by_table = cls.get_dependent_fields(str_field_ids)
        if not dep_by_table:
            return []

        logger.info(
            "Cascade: %d source fields → %d downstream tables",
            len(str_field_ids),
            len(dep_by_table),
        )

        # 2. 收集需要追踪的表
        all_table_ids = set(dep_by_table.keys()) | {str_table_id}

        # 3. BFS 传播受影响记录
        seeds: Dict[str, Set[str]] = {str_table_id: set(str_record_ids)}

        # 如果 changed_field_ids 中包含 link 字段，也把对侧记录加入种子
        link_fields_changed = list(
            TableField.objects.using(TABDATA_DB_ALIAS).filter(
                id__in=str_field_ids,
                field_type='link',
                is_deleted=False,
            ).values('id', 'config')
        )
        for lf in link_fields_changed:
            config = lf['config'] or {}
            foreign_table_id = config.get('foreignTableId')
            if foreign_table_id:
                # 通过 LinkRecord 找到对侧受影响记录
                foreign_rids = set(
                    str(rid) for rid in
                    LinkRecord.objects.using(TABDATA_DB_ALIAS).filter(
                        link_field_id=lf['id'],
                        self_record_id__in=str_record_ids,
                    ).values_list('foreign_record_id', flat=True)
                )
                if foreign_rids:
                    seeds.setdefault(str(foreign_table_id), set()).update(foreign_rids)

        record_sets = cls.resolve_link_closure(seeds, all_table_ids)

        # 4. 获取依赖边用于拓扑排序
        all_dep_field_ids: List[str] = []
        for fids in dep_by_table.values():
            all_dep_field_ids.extend(fids)

        if not all_dep_field_ids:
            return []

        # 加载这些字段之间的依赖边
        dep_edges = list(
            FieldReference.objects.using(TABDATA_DB_ALIAS).filter(
                to_field_id__in=all_dep_field_ids,
            ).values_list('from_field_id', 'to_field_id')
        )
        edges_str = [(str(f), str(t)) for f, t in dep_edges]

        # 5. 拓扑排序分层
        layers = topological_sort_layers(all_dep_field_ids, edges_str)

        # 6. 逐层执行重算
        ws_notifications: List[Dict[str, Any]] = []

        for layer_idx, layer_field_ids in enumerate(layers):
            if not layer_field_ids:
                continue

            # 按表分组
            fields_by_table: Dict[str, List[str]] = defaultdict(list)
            for fid in layer_field_ids:
                if fid in skip:
                    continue
                for tid, fids in dep_by_table.items():
                    if fid in fids:
                        fields_by_table[tid].append(fid)
                        break

            for tid, fids in fields_by_table.items():
                affected_rids = record_sets.get(tid, set())
                if not affected_rids:
                    continue

                updated = cls._evaluate_fields_for_records(
                    table_id=tid,
                    field_ids=fids,
                    record_ids=list(affected_rids),
                )
                if updated:
                    ws_notifications.append({
                        'table_id': tid,
                        'record_ids': updated,
                    })

        return ws_notifications

    # ── 内部：逐字段重算 ──

    @classmethod
    def _evaluate_fields_for_records(
        cls,
        table_id: str,
        field_ids: List[str],
        record_ids: List[str],
    ) -> List[str]:
        """
        对指定字段和记录刷新 Link 标题缓存。

        支持 Link 字段 title 重建。

        Returns:
            实际更新的 record_id 列表
        """
        fields = list(
            TableField.objects.using(TABDATA_DB_ALIAS).filter(
                id__in=field_ids,
                is_deleted=False,
            )
        )
        if not fields:
            return []

        records = list(
            TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                id__in=record_ids,
                is_deleted=False,
            )
        )
        if not records:
            return []

        updated_rids: Set[str] = set()

        for field in fields:
            if field.field_type == 'link':
                # Link 字段 title 重建
                cls._rebuild_link_titles_for_records(field, records)
                updated_rids.update(str(r.id) for r in records)

        if updated_rids and records:
            try:
                from apps.tabdata.utils.ydoc_sync import sync_records_to_ydoc
                updated_records = [r for r in records if str(r.id) in updated_rids]
                sync_records_to_ydoc(
                    UUID(table_id), updated_records, fields, source="cascade_service",
                )
            except Exception as exc:
                logger.warning("Cascade Y.js sync failed (non-blocking): %s", exc)

        return list(updated_rids)

    @staticmethod
    def _rebuild_link_titles_for_records(
        link_field: TableField,
        records: List[TableRecord],
    ) -> None:
        """重建 link cell value 中的 title（当关联目标的主字段变化时）。"""
        from apps.tabdata.services.link_field_service import LinkFieldService

        field_id_str = str(link_field.id)
        field_id_hex = link_field.id.hex
        records_to_update = []

        _pf_cache: Dict[str, Optional['TableField']] = {}
        for rec in records:
            new_cell = LinkFieldService._build_cell_value(link_field, rec, _primary_field_cache=_pf_cache)
            data = dict(rec.__dict__.get('data') or {})
            current = data.get(field_id_hex) if field_id_hex in data else data.get(field_id_str)
            if current != new_cell:
                # hex/dashed 双写，避免只更新一侧留下陈旧 title
                data[field_id_hex] = new_cell
                data[field_id_str] = new_cell
                rec.__dict__['data'] = data
                records_to_update.append(rec)

        if records_to_update:
            with skip_record_history(*records_to_update):
                TableRecord.objects.using(TABDATA_DB_ALIAS).bulk_update(
                    records_to_update, ['data', 'updated_at'], batch_size=100,
                )
            try:
                from apps.tabdata.native.record_io import NativeRecordIO
                from apps.tabdata.native.value_converter import python_to_pg
                from apps.tabdata.native.ddl_manager import resolve_schema_partition_id
                table = link_field.table
                native_io = NativeRecordIO(resolve_schema_partition_id(table), table.id)
                for rec in records_to_update:
                    data = rec.__dict__.get('data', {}) or {}
                    cell = data.get(field_id_hex) if field_id_hex in data else data.get(field_id_str)
                    pg_val = python_to_pg(
                        cell,
                        link_field.field_type, link_field.config,
                    )
                    native_io.update_record(
                        record_id=rec.id,
                        field_values={field_id_hex: pg_val},
                    )
            except Exception as exc:
                import logging
                logging.getLogger(__name__).warning(
                    "cascade _rebuild_link_cell_titles native sync failed: %s", exc,
                )
