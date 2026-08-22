"""
Link 数据完整性检查与修复服务

定期检查 JSONB 缓存 (record.data) 与 LinkRecord 之间的一致性，
修复因并发、中断等异常导致的数据不一致。

检查项：
1. JSONB 中引用了不存在的 LinkRecord（幽灵引用）
2. LinkRecord 存在但 JSONB 中缺少对应条目（遗漏引用）
3. 对称字段 LinkRecord 不对称（A→B 存在但 B→A 缺失）
4. 已删除记录仍被 LinkRecord 引用（孤儿链接）
"""

import logging
from collections import defaultdict
from typing import Any, Dict, List, Set, Tuple

from django.db import transaction
from django.utils import timezone

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import LinkRecord, Table, TableField, TableRecord

logger = logging.getLogger(__name__)


class LinkIntegrityService:
    """Link 字段数据完整性检查与修复"""

    @classmethod
    def run_full_check(
        cls,
        *,
        dry_run: bool = False,
        table_id: str | None = None,
    ) -> Dict[str, Any]:
        """
        执行全量完整性检查。

        Args:
            dry_run: True 则仅检查不修复
            table_id: 指定表 ID（可选，为空则检查所有表）

        Returns:
            检查报告 dict
        """
        start_time = timezone.now()
        report: Dict[str, Any] = {
            'started_at': start_time.isoformat(),
            'dry_run': dry_run,
            'checks': {},
        }

        # 获取所有 link 字段
        link_fields_qs = TableField.objects.using(TABDATA_DB_ALIAS).filter(
            field_type='link', is_deleted=False,
        ).select_related('table')

        if table_id:
            link_fields_qs = link_fields_qs.filter(table_id=table_id)

        link_fields = list(link_fields_qs)
        report['total_link_fields'] = len(link_fields)

        if not link_fields:
            report['finished_at'] = timezone.now().isoformat()
            return report

        # 1. 检查孤儿 LinkRecord（引用已删除记录）
        orphan_result = cls._check_orphan_links(link_fields, dry_run=dry_run)
        report['checks']['orphan_links'] = orphan_result

        # 2. 检查 JSONB ↔ LinkRecord 一致性
        consistency_result = cls._check_jsonb_consistency(link_fields, dry_run=dry_run)
        report['checks']['jsonb_consistency'] = consistency_result

        # 3. 检查对称字段 LinkRecord 对称性
        symmetry_result = cls._check_symmetry(link_fields, dry_run=dry_run)
        report['checks']['symmetry'] = symmetry_result

        report['finished_at'] = timezone.now().isoformat()
        elapsed = (timezone.now() - start_time).total_seconds()
        report['elapsed_seconds'] = round(elapsed, 2)

        # 汇总
        total_issues = sum(
            r.get('issues_found', 0) for r in report['checks'].values()
        )
        total_fixed = sum(
            r.get('issues_fixed', 0) for r in report['checks'].values()
        )
        report['total_issues_found'] = total_issues
        report['total_issues_fixed'] = total_fixed

        level = logging.WARNING if total_issues > 0 else logging.INFO
        logger.log(
            level,
            "Link 完整性检查完成: %d 个 link 字段, %d 个问题, %d 个已修复, 耗时 %.2fs (dry_run=%s)",
            len(link_fields), total_issues, total_fixed, elapsed, dry_run,
        )

        if not dry_run and total_fixed > 0:
            affected_table_ids = {str(f.table_id) for f in link_fields}
            for tid in affected_table_ids:
                try:
                    from apps.tabdata.utils.ydoc_sync import batch_sync_all_records_to_ydoc
                    from uuid import UUID as _UUID
                    batch_sync_all_records_to_ydoc(
                        _UUID(tid), source="link_integrity_check",
                    )
                except Exception as exc:
                    logger.warning("link_integrity Y.js sync failed table=%s: %s", tid, exc)

        return report

    # ──────────────────────────────────────────────────────
    # 检查 1: 孤儿 LinkRecord
    # ──────────────────────────────────────────────────────

    @classmethod
    def _check_orphan_links(
        cls, link_fields: List[TableField], *, dry_run: bool,
    ) -> Dict[str, Any]:
        """
        检查引用已删除/不存在记录的 LinkRecord。
        """
        result = {'issues_found': 0, 'issues_fixed': 0, 'details': []}

        for field in link_fields:
            # self_record 已删除
            orphan_self = LinkRecord.objects.using(TABDATA_DB_ALIAS).filter(
                link_field=field,
                self_record__is_deleted=True,
            )
            count_self = orphan_self.count()

            # foreign_record 已删除
            orphan_foreign = LinkRecord.objects.using(TABDATA_DB_ALIAS).filter(
                link_field=field,
                foreign_record__is_deleted=True,
            )
            count_foreign = orphan_foreign.count()

            total = count_self + count_foreign
            if total == 0:
                continue

            result['issues_found'] += total

            if not dry_run:
                with transaction.atomic(using=TABDATA_DB_ALIAS):
                    del_self, _ = orphan_self.delete()
                    del_foreign, _ = orphan_foreign.delete()
                    fixed = del_self + del_foreign
                    result['issues_fixed'] += fixed
                    logger.info(
                        "修复孤儿 LinkRecord: field=%s, 删除 %d 条 (self_deleted=%d, foreign_deleted=%d)",
                        field.id, fixed, del_self, del_foreign,
                    )

            result['details'].append({
                'field_id': str(field.id),
                'table_id': str(field.table_id),
                'orphan_self_deleted': count_self,
                'orphan_foreign_deleted': count_foreign,
            })

        return result

    # ──────────────────────────────────────────────────────
    # 检查 2: JSONB ↔ LinkRecord 一致性
    # ──────────────────────────────────────────────────────

    @classmethod
    def _check_jsonb_consistency(
        cls, link_fields: List[TableField], *, dry_run: bool,
    ) -> Dict[str, Any]:
        """
        检查 record.data[field_id] 中的 ID 列表是否与 LinkRecord 一致。
        不一致时以 LinkRecord 为真实来源重建 JSONB 缓存。
        """
        from apps.tabdata.constants import DEFAULT_LINK_RELATIONSHIP, MULTI_VALUE_RELATIONSHIPS
        from apps.tabdata.services.link_field_service import LinkFieldService

        result = {'issues_found': 0, 'issues_fixed': 0, 'details': []}

        for field in link_fields:
            config = field.config or {}
            relationship = config.get('relationship', DEFAULT_LINK_RELATIONSHIP)
            is_multi = relationship in MULTI_VALUE_RELATIONSHIPS
            field_id_str = str(field.id)

            # 获取该字段的所有 LinkRecord（按 self_record 分组）
            link_records = LinkRecord.objects.using(TABDATA_DB_ALIAS).filter(
                link_field=field,
            ).values_list('self_record_id', 'foreign_record_id')

            # 构建真实映射: self_record_id → {foreign_record_ids}
            truth_map: Dict[str, Set[str]] = defaultdict(set)
            for self_id, foreign_id in link_records:
                truth_map[str(self_id)].add(str(foreign_id))

            # 获取含有此字段数据的记录
            records = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=field.table_id, is_deleted=False,
            ).only('id', 'data')

            mismatches = 0
            records_to_update: list = []

            for rec in records.iterator(chunk_size=500):
                rec_id_str = str(rec.id)
                data = rec.__dict__.get('data') or {}
                cell_value = data.get(field_id_str)

                jsonb_ids = cls._extract_ids_from_cell(cell_value)
                truth_ids = truth_map.get(rec_id_str, set())

                if jsonb_ids != truth_ids:
                    mismatches += 1
                    if not dry_run:
                        new_cell = LinkFieldService._build_cell_value(field, rec)
                        data[field_id_str] = new_cell
                        rec.__dict__['data'] = data
                        rec._skip_record_history = True
                        records_to_update.append(rec)

                        if len(records_to_update) >= 200:
                            TableRecord.objects.using(TABDATA_DB_ALIAS).bulk_update(
                                records_to_update, ['data', 'updated_at'], batch_size=100,
                            )
                            for r in records_to_update:
                                if hasattr(r, '_skip_record_history'):
                                    delattr(r, '_skip_record_history')
                            records_to_update = []

                elif not cell_value and truth_ids:
                    mismatches += 1
                    if not dry_run:
                        new_cell = LinkFieldService._build_cell_value(field, rec)
                        data = dict(rec.__dict__.get('data') or {})
                        data[field_id_str] = new_cell
                        rec.__dict__['data'] = data
                        rec._skip_record_history = True
                        records_to_update.append(rec)

            # 处理剩余批次
            if records_to_update:
                TableRecord.objects.using(TABDATA_DB_ALIAS).bulk_update(
                    records_to_update, ['data', 'updated_at'], batch_size=100,
                )
                for r in records_to_update:
                    if hasattr(r, '_skip_record_history'):
                        delattr(r, '_skip_record_history')

            if mismatches > 0:
                result['issues_found'] += mismatches
                if not dry_run:
                    result['issues_fixed'] += mismatches
                result['details'].append({
                    'field_id': str(field.id),
                    'table_id': str(field.table_id),
                    'mismatches': mismatches,
                })

        return result

    # ──────────────────────────────────────────────────────
    # 检查 3: 对称字段 LinkRecord 对称性
    # ──────────────────────────────────────────────────────

    @classmethod
    def _check_symmetry(
        cls, link_fields: List[TableField], *, dry_run: bool,
    ) -> Dict[str, Any]:
        """
        对于双向 link 字段，检查 LinkRecord 的对称性：
        如果 A→B 存在于 field F，则 B→A 必须存在于 symmetric field S。
        """
        from apps.tabdata.services.link_field_service import LinkFieldService

        result = {'issues_found': 0, 'issues_fixed': 0, 'details': []}

        # 只检查非单向的字段（避免重复检查正反两个字段）
        checked_pairs: Set[Tuple[str, str]] = set()

        for field in link_fields:
            config = field.config or {}
            is_one_way = config.get('isOneWay', False)
            sym_field_id = config.get('symmetricFieldId')

            if is_one_way or not sym_field_id:
                continue

            # 避免重复检查 (field, sym) 和 (sym, field)
            pair = tuple(sorted([str(field.id), str(sym_field_id)]))
            if pair in checked_pairs:
                continue
            checked_pairs.add(pair)

            # 验证对称字段存在
            try:
                sym_field = TableField.objects.using(TABDATA_DB_ALIAS).get(id=sym_field_id, is_deleted=False)
            except TableField.DoesNotExist:
                result['issues_found'] += 1
                result['details'].append({
                    'field_id': str(field.id),
                    'issue': 'symmetric_field_missing',
                    'missing_sym_field_id': sym_field_id,
                })
                continue

            # 获取正向 LinkRecord
            forward_links = set(
                LinkRecord.objects.using(TABDATA_DB_ALIAS).filter(link_field=field)
                .values_list('self_record_id', 'foreign_record_id')
            )

            # 获取反向 LinkRecord
            reverse_links = set(
                LinkRecord.objects.using(TABDATA_DB_ALIAS).filter(link_field=sym_field)
                .values_list('self_record_id', 'foreign_record_id')
            )

            # 正向的反转应该在反向中
            expected_reverse = {(b, a) for a, b in forward_links}
            missing_reverse = expected_reverse - reverse_links

            # 反向的反转应该在正向中
            expected_forward = {(b, a) for a, b in reverse_links}
            missing_forward = expected_forward - forward_links

            total_missing = len(missing_reverse) + len(missing_forward)
            if total_missing == 0:
                continue

            result['issues_found'] += total_missing

            if not dry_run:
                with transaction.atomic(using=TABDATA_DB_ALIAS):
                    fixed = 0

                    # 补充缺失的反向 LinkRecord
                    if missing_reverse:
                        new_links = []
                        for self_id, foreign_id in missing_reverse:
                            # 检查记录是否存在
                            if not TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                                id=self_id, is_deleted=False,
                            ).exists():
                                continue
                            max_order = (
                                LinkRecord.objects.using(TABDATA_DB_ALIAS).filter(
                                    link_field=sym_field, self_record_id=self_id,
                                ).order_by('-order').values_list('order', flat=True).first()
                            ) or 0
                            new_links.append(LinkRecord(
                                link_field=sym_field,
                                self_record_id=self_id,
                                foreign_record_id=foreign_id,
                                order=max_order + 1,
                            ))
                        if new_links:
                            LinkRecord.objects.using(TABDATA_DB_ALIAS).bulk_create(new_links, ignore_conflicts=True)
                            fixed += len(new_links)

                    # 补充缺失的正向 LinkRecord
                    if missing_forward:
                        new_links = []
                        for self_id, foreign_id in missing_forward:
                            if not TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                                id=self_id, is_deleted=False,
                            ).exists():
                                continue
                            max_order = (
                                LinkRecord.objects.using(TABDATA_DB_ALIAS).filter(
                                    link_field=field, self_record_id=self_id,
                                ).order_by('-order').values_list('order', flat=True).first()
                            ) or 0
                            new_links.append(LinkRecord(
                                link_field=field,
                                self_record_id=self_id,
                                foreign_record_id=foreign_id,
                                order=max_order + 1,
                            ))
                        if new_links:
                            LinkRecord.objects.using(TABDATA_DB_ALIAS).bulk_create(new_links, ignore_conflicts=True)
                            fixed += len(new_links)

                    # 重建受影响的 JSONB
                    if fixed > 0:
                        affected_records = set()
                        for self_id, _ in missing_reverse:
                            affected_records.add((str(sym_field.id), self_id))
                        for self_id, _ in missing_forward:
                            affected_records.add((str(field.id), self_id))

                        cls._rebuild_affected_cells(affected_records, {
                            str(field.id): field,
                            str(sym_field.id): sym_field,
                        })

                    result['issues_fixed'] += fixed

            result['details'].append({
                'field_id': str(field.id),
                'sym_field_id': str(sym_field_id),
                'missing_reverse': len(missing_reverse),
                'missing_forward': len(missing_forward),
            })

        return result

    # ──────────────────────────────────────────────────────
    # 辅助方法
    # ──────────────────────────────────────────────────────

    @staticmethod
    def _extract_ids_from_cell(cell_value: Any) -> Set[str]:
        """从 JSONB cell value 中提取关联记录 ID 集合"""
        if cell_value is None:
            return set()
        if isinstance(cell_value, dict):
            rid = cell_value.get('id')
            return {str(rid)} if rid else set()
        if isinstance(cell_value, list):
            ids = set()
            for item in cell_value:
                if isinstance(item, dict) and item.get('id'):
                    ids.add(str(item['id']))
            return ids
        return set()

    @classmethod
    def _rebuild_affected_cells(
        cls,
        affected: Set[Tuple[str, Any]],
        fields_map: Dict[str, TableField],
    ) -> None:
        """重建受影响的 JSONB cell values"""
        from apps.tabdata.services.link_field_service import LinkFieldService

        # 按 record 分组
        record_ids = {rec_id for _, rec_id in affected}
        records_map = {
            rec.id: rec
            for rec in TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                id__in=record_ids, is_deleted=False,
            )
        }

        records_to_update = []
        for field_id_str, rec_id in affected:
            field = fields_map.get(field_id_str)
            rec = records_map.get(rec_id)
            if not field or not rec:
                continue
            cell_value = LinkFieldService._build_cell_value(field, rec)
            data = dict(rec.__dict__.get('data') or {})
            data[field_id_str] = cell_value
            rec.__dict__['data'] = data
            rec._skip_record_history = True
            records_to_update.append(rec)

        if records_to_update:
            TableRecord.objects.using(TABDATA_DB_ALIAS).bulk_update(
                records_to_update, ['data', 'updated_at'], batch_size=100,
            )
            for r in records_to_update:
                if hasattr(r, '_skip_record_history'):
                    delattr(r, '_skip_record_history')
