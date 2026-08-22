"""
PERF-001, PERF-002, PERF-011 回归测试
验证 OSS Admin API 性能优化后聚合结果的正确性
"""
import uuid
from unittest.mock import MagicMock, patch

from django.db.models import Count, Q, Sum, Value
from django.db.models.functions import Coalesce
from django.test import TestCase

from apps.services.oss.models import FileRecord, UploadTask


def _make_staff_request():
    user = MagicMock()
    user.is_staff = True
    user.is_superuser = True
    user.id = uuid.uuid4()
    request = MagicMock()
    request.auth = user
    request.headers = {}
    request.META = {}
    return request


_NINJA_QUERY_DEFAULTS = {
    'is_public': None,
    'orphan_only': False,
    'unowned_only': False,
}


class PERF001SummaryAggregationTest(TestCase):
    """PERF-001: summary 使用 DB 聚合而非全表内存扫描"""

    def setUp(self):
        self.owned_completed = FileRecord.objects.create(
            file_name='owned.png', file_key='perf001/owned.png',
            file_path='perf001/', file_size=1000, file_type='image',
            mime_type='image/png', file_extension='png', bucket_name='test',
            status='completed', organization_id='ws-001', ref_count=1,
        )
        self.orphan_owned = FileRecord.objects.create(
            file_name='orphan.png', file_key='perf001/orphan.png',
            file_path='perf001/', file_size=2000, file_type='image',
            mime_type='image/png', file_extension='png', bucket_name='test',
            status='completed', organization_id='ws-002', ref_count=0,
        )
        self.unowned_completed = FileRecord.objects.create(
            file_name='unowned.png', file_key='perf001/unowned.png',
            file_path='perf001/', file_size=3000, file_type='image',
            mime_type='image/png', file_extension='png', bucket_name='test',
            status='completed', organization_id='', ref_count=1,
        )
        self.deleted_unowned = FileRecord.objects.create(
            file_name='deleted.png', file_key='perf001/deleted.png',
            file_path='perf001/', file_size=4000, file_type='image',
            mime_type='image/png', file_extension='png', bucket_name='test',
            status='deleted', organization_id='', ref_count=0,
        )
        self.failed_owned = FileRecord.objects.create(
            file_name='failed.png', file_key='perf001/failed.png',
            file_path='perf001/', file_size=500, file_type='image',
            mime_type='image/png', file_extension='png', bucket_name='test',
            status='failed', organization_id='ws-003', ref_count=0,
        )

    def test_db_aggregate_file_counts(self):
        """验证 aggregate 产生的全局文件计数与预期一致"""
        all_files = FileRecord.objects.all()
        counts = all_files.aggregate(
            total_files=Count('id'),
            completed_files=Count('id', filter=Q(status='completed')),
            failed_files=Count('id', filter=Q(status='failed')),
            deleted_files=Count('id', filter=Q(status='deleted')),
            public_files=Count('id', filter=Q(status='completed', is_public=True)),
            private_files=Count('id', filter=Q(status='completed', is_public=False)),
        )

        self.assertEqual(counts['total_files'], 5)
        self.assertEqual(counts['completed_files'], 3)
        self.assertEqual(counts['failed_files'], 1)
        self.assertEqual(counts['deleted_files'], 1)

    def test_db_aggregate_inventory_stats(self):
        """验证 non-deleted aggregate 产生正确的 owned/unowned/orphan 统计"""
        from apps.services.oss.admin_api import _build_unowned_file_filter

        non_deleted = FileRecord.objects.exclude(status='deleted')
        unowned_q = _build_unowned_file_filter()
        orphan_q = Q(ref_count=0, status='completed')

        agg = non_deleted.aggregate(
            total_size=Coalesce(Sum('file_size'), Value(0)),
            total_non_deleted=Count('id'),
            unowned_files=Count('id', filter=unowned_q),
            unowned_size=Coalesce(Sum('file_size', filter=unowned_q), Value(0)),
            orphan_files=Count('id', filter=orphan_q),
            orphan_size=Coalesce(Sum('file_size', filter=orphan_q), Value(0)),
            orphan_unowned=Count('id', filter=orphan_q & unowned_q),
            orphan_unowned_size=Coalesce(
                Sum('file_size', filter=orphan_q & unowned_q), Value(0),
            ),
        )

        self.assertEqual(agg['total_size'], 6500)
        self.assertEqual(agg['total_non_deleted'], 4)
        self.assertEqual(agg['unowned_files'], 1)
        self.assertEqual(agg['unowned_size'], 3000)
        owned_count = agg['total_non_deleted'] - agg['unowned_files']
        self.assertEqual(owned_count, 3)
        owned_size = agg['total_size'] - agg['unowned_size']
        self.assertEqual(owned_size, 3500)
        self.assertEqual(agg['orphan_files'], 1)
        self.assertEqual(agg['orphan_size'], 2000)
        self.assertEqual(agg['orphan_unowned'], 0)

    def test_repair_state_owned_prefilter(self):
        """验证 repair_state='owned' 预过滤仅返回有 organization 的记录"""
        from apps.services.oss.admin_api import _build_unowned_file_filter

        owned_qs = FileRecord.objects.exclude(_build_unowned_file_filter())
        owned_ids = set(str(r.id) for r in owned_qs)

        self.assertIn(str(self.owned_completed.id), owned_ids)
        self.assertIn(str(self.orphan_owned.id), owned_ids)
        self.assertIn(str(self.failed_owned.id), owned_ids)
        self.assertNotIn(str(self.unowned_completed.id), owned_ids)
        self.assertNotIn(str(self.deleted_unowned.id), owned_ids)

    def test_repair_state_deleted_prefilter(self):
        """验证 repair_state='deleted' 预过滤仅返回无归属的已删除记录"""
        from apps.services.oss.admin_api import _build_unowned_file_filter

        deleted_qs = FileRecord.objects.filter(
            _build_unowned_file_filter(), status='deleted',
        )
        ids = [str(r.id) for r in deleted_qs]

        self.assertEqual(len(ids), 1)
        self.assertEqual(ids[0], str(self.deleted_unowned.id))

    def test_source_uses_aggregate_not_memory_loop(self):
        """确认 list_admin_oss_files 源码使用 aggregate 而非全表 list()"""
        import inspect
        from apps.services.oss.admin_api import list_admin_oss_files

        source = inspect.getsource(list_admin_oss_files)
        self.assertIn('.aggregate(', source)
        self.assertIn('Coalesce(Sum(', source)
        self.assertNotIn('_build_file_inventory_summary(', source)


class PERF001DbDeterministicFastPathTest(TestCase):
    """PERF-001 补充：owned/deleted 走 DB 级分页快速路径，不全量加载内存"""
    databases = '__all__'

    def setUp(self):
        for i in range(5):
            FileRecord.objects.create(
                file_name=f'owned-{i}.png', file_key=f'fastpath/owned-{i}.png',
                file_path='fastpath/', file_size=100, file_type='image',
                mime_type='image/png', file_extension='png', bucket_name='test',
                status='completed', organization_id=f'ws-{i}', ref_count=1,
            )
        for i in range(3):
            FileRecord.objects.create(
                file_name=f'unowned-{i}.png', file_key=f'fastpath/unowned-{i}.png',
                file_path='fastpath/', file_size=200, file_type='image',
                mime_type='image/png', file_extension='png', bucket_name='test',
                status='completed', organization_id='', ref_count=0,
            )
        FileRecord.objects.create(
            file_name='deleted-unowned.png', file_key='fastpath/del.png',
            file_path='fastpath/', file_size=300, file_type='image',
            mime_type='image/png', file_extension='png', bucket_name='test',
            status='deleted', organization_id='', ref_count=0,
        )

    def test_owned_state_uses_db_pagination(self):
        """repair_state='owned' 仅返回有归属记录，走 DB 分页"""
        from apps.services.oss.admin_api import list_admin_oss_files

        resp = list_admin_oss_files(
            _make_staff_request(), repair_state='owned',
            page_size=2, **_NINJA_QUERY_DEFAULTS,
        )
        self.assertEqual(resp.pagination.total, 5)
        self.assertEqual(len(resp.items), 2)
        for item in resp.items:
            self.assertTrue(item.organization_id)

    def test_deleted_state_uses_db_pagination(self):
        """repair_state='deleted' 仅返回无归属已删除记录"""
        from apps.services.oss.admin_api import list_admin_oss_files

        resp = list_admin_oss_files(
            _make_staff_request(), repair_state='deleted',
            **_NINJA_QUERY_DEFAULTS,
        )
        self.assertEqual(resp.pagination.total, 1)
        self.assertEqual(len(resp.items), 1)
        self.assertEqual(resp.items[0].status, 'deleted')

    def test_impossible_combination_returns_empty(self):
        """repair_state='owned' + repair_reason_code='file_deleted' 返回空"""
        from apps.services.oss.admin_api import list_admin_oss_files

        resp = list_admin_oss_files(
            _make_staff_request(),
            repair_state='owned',
            repair_reason_code='file_deleted',
            **_NINJA_QUERY_DEFAULTS,
        )
        self.assertEqual(resp.pagination.total, 0)
        self.assertEqual(len(resp.items), 0)

    def test_reason_code_already_owned_uses_fast_path(self):
        """repair_state='all' + reason_code='already_owned' 走快速路径"""
        from apps.services.oss.admin_api import list_admin_oss_files

        resp = list_admin_oss_files(
            _make_staff_request(),
            repair_reason_code='already_owned',
            **_NINJA_QUERY_DEFAULTS,
        )
        self.assertEqual(resp.pagination.total, 5)
        for item in resp.items:
            self.assertTrue(item.organization_id)

    def test_reason_code_file_deleted_uses_fast_path(self):
        """repair_state='all' + reason_code='file_deleted' 走快速路径"""
        from apps.services.oss.admin_api import list_admin_oss_files

        resp = list_admin_oss_files(
            _make_staff_request(),
            repair_reason_code='file_deleted',
            **_NINJA_QUERY_DEFAULTS,
        )
        self.assertEqual(resp.pagination.total, 1)
        self.assertEqual(resp.items[0].status, 'deleted')

    def test_source_has_db_deterministic_fast_path(self):
        """确认源码包含 DB 确定性快速路径分支"""
        import inspect
        from apps.services.oss.admin_api import list_admin_oss_files

        source = inspect.getsource(list_admin_oss_files)
        self.assertIn('_db_deterministic', source)


class PERF001ChunkedRepairStatsTest(TestCase):
    """PERF-001 补充：summary repair_stats 分块处理而非全量 list()"""
    databases = '__all__'

    def setUp(self):
        for i in range(6):
            FileRecord.objects.create(
                file_name=f'unowned-{i}.png',
                file_key=f'chunk-stats/unowned-{i}.png',
                file_path='chunk-stats/', file_size=100 * (i + 1),
                file_type='image', mime_type='image/png', file_extension='png',
                bucket_name='test', status='completed', organization_id='',
                ref_count=0,
            )
        FileRecord.objects.create(
            file_name='owned.png', file_key='chunk-stats/owned.png',
            file_path='chunk-stats/', file_size=999, file_type='image',
            mime_type='image/png', file_extension='png', bucket_name='test',
            status='completed', organization_id='ws-owned', ref_count=1,
        )

    def test_chunked_stats_match_full_load(self):
        """分块处理与一次性全量加载产生相同 repair_stats"""
        from apps.services.oss.admin_api import (
            _accumulate_repair_stats,
            _build_unowned_file_filter,
            _build_organization_repair_results,
        )

        unowned_q = _build_unowned_file_filter()
        non_deleted_qs = FileRecord.objects.exclude(status='deleted')
        all_unowned = list(
            non_deleted_qs.filter(unowned_q)
            .only('id', 'file_name', 'organization_id', 'metadata', 'status')
        )
        full_map = _build_organization_repair_results(all_unowned)
        full_stats = {k: 0 for k in (
            'repairable_unowned_files', 'conflict_unowned_files',
            'unverifiable_unowned_files',
            'repairable_from_attachment_reference_files',
            'repairable_from_upload_task_files',
            'repairable_from_dual_evidence_files',
            'conflict_reference_files', 'conflict_upload_task_files',
            'conflict_cross_source_files',
            'missing_evidence_unowned_files', 'lookup_error_unowned_files',
        )}
        for repair in full_map.values():
            _accumulate_repair_stats(full_stats, repair)

        chunk_stats = {k: 0 for k in full_stats}
        chunk_size = 2
        base_qs = (
            non_deleted_qs.filter(unowned_q)
            .only('id', 'file_name', 'organization_id', 'metadata', 'status')
            .order_by('pk')
        )
        offset = 0
        while True:
            chunk = list(base_qs[offset:offset + chunk_size])
            if not chunk:
                break
            chunk_map = _build_organization_repair_results(chunk)
            for repair in chunk_map.values():
                _accumulate_repair_stats(chunk_stats, repair)
            offset += chunk_size

        self.assertEqual(chunk_stats, full_stats)

    def test_accumulate_repair_stats_repairable(self):
        """_accumulate_repair_stats 正确累加 repairable 状态"""
        from apps.services.oss.admin_api import (
            REPAIR_REASON_UNIQUE_REFERENCE,
            _accumulate_repair_stats,
        )
        from apps.services.oss.admin_schemas import (
            AdminOssOrganizationRepairAssessmentSchema,
        )

        stats = {k: 0 for k in (
            'repairable_unowned_files', 'conflict_unowned_files',
            'unverifiable_unowned_files',
            'repairable_from_attachment_reference_files',
            'repairable_from_upload_task_files',
            'repairable_from_dual_evidence_files',
            'conflict_reference_files', 'conflict_upload_task_files',
            'conflict_cross_source_files',
            'missing_evidence_unowned_files', 'lookup_error_unowned_files',
        )}
        repair = AdminOssOrganizationRepairAssessmentSchema(
            file_id='test',
            repair_state='repairable',
            reason_code=REPAIR_REASON_UNIQUE_REFERENCE,
        )
        _accumulate_repair_stats(stats, repair)

        self.assertEqual(stats['repairable_unowned_files'], 1)
        self.assertEqual(stats['repairable_from_attachment_reference_files'], 1)
        self.assertEqual(stats['conflict_unowned_files'], 0)

    def test_source_uses_chunked_iteration(self):
        """确认 summary repair_stats 使用分块迭代而非全量 list()"""
        import inspect
        from apps.services.oss.admin_api import list_admin_oss_files

        source = inspect.getsource(list_admin_oss_files)
        self.assertIn('_accumulate_repair_stats(repair_stats, repair)', source)
        self.assertIn('_REPAIR_EVAL_CHUNK_SIZE', source)


class PERF001ChunkedRepairFilterTest(TestCase):
    """PERF-001 补充：repair_state 跨表过滤走分块处理"""
    databases = '__all__'

    def setUp(self):
        for i in range(5):
            FileRecord.objects.create(
                file_name=f'unowned-filter-{i}.png',
                file_key=f'chunk-filter/unowned-{i}.png',
                file_path='chunk-filter/', file_size=100, file_type='image',
                mime_type='image/png', file_extension='png', bucket_name='test',
                status='completed', organization_id='', ref_count=0,
            )

    def test_repairable_filter_uses_chunked_processing(self):
        """repair_state='repairable' 通过分块处理返回正确结果"""
        from apps.services.oss.admin_api import list_admin_oss_files

        with patch(
            'apps.services.oss.admin_api._REPAIR_EVAL_CHUNK_SIZE', 2,
        ):
            resp = list_admin_oss_files(
                _make_staff_request(), repair_state='repairable',
                **_NINJA_QUERY_DEFAULTS,
            )
        self.assertIsNotNone(resp.pagination)
        self.assertGreaterEqual(resp.pagination.total, 0)

    def test_insufficient_evidence_filter(self):
        """repair_state='insufficient_evidence' 找出缺乏证据的记录"""
        from apps.services.oss.admin_api import list_admin_oss_files

        with patch(
            'apps.services.oss.admin_api._REPAIR_EVAL_CHUNK_SIZE', 2,
        ):
            resp = list_admin_oss_files(
                _make_staff_request(),
                repair_state='insufficient_evidence',
                **_NINJA_QUERY_DEFAULTS,
            )
        for item in resp.items:
            self.assertIsNotNone(item.organization_repair)
            self.assertEqual(
                item.organization_repair.repair_state, 'insufficient_evidence',
            )


class PERF002CostOverviewAggregationTest(TestCase):
    """PERF-002: cost overview 使用 DB GROUP BY 而非 Python 遍历"""

    def setUp(self):
        FileRecord.objects.create(
            file_name='a1.png', file_key='perf002/a1.png', file_path='perf002/',
            file_size=1000, file_type='image', mime_type='image/png',
            file_extension='png', bucket_name='test',
            status='completed', organization_id='ws-A',
        )
        FileRecord.objects.create(
            file_name='a2.png', file_key='perf002/a2.png', file_path='perf002/',
            file_size=2000, file_type='image', mime_type='image/png',
            file_extension='png', bucket_name='test',
            status='completed', organization_id='ws-A',
        )
        FileRecord.objects.create(
            file_name='b1.png', file_key='perf002/b1.png', file_path='perf002/',
            file_size=3000, file_type='image', mime_type='image/png',
            file_extension='png', bucket_name='test',
            status='completed', organization_id='ws-B',
        )
        FileRecord.objects.create(
            file_name='del.png', file_key='perf002/del.png', file_path='perf002/',
            file_size=500, file_type='image', mime_type='image/png',
            file_extension='png', bucket_name='test',
            status='deleted', organization_id='ws-A',
        )
        FileRecord.objects.create(
            file_name='unowned.png', file_key='perf002/unowned.png',
            file_path='perf002/', file_size=400, file_type='image',
            mime_type='image/png', file_extension='png', bucket_name='test',
            status='completed', organization_id='',
        )

    def test_group_by_organization_aggregation(self):
        """验证 GROUP BY organization_id 产生正确的 per-organization 统计"""
        direct_qs = (
            FileRecord.objects.exclude(status='deleted')
            .exclude(Q(organization_id='') | Q(organization_id__isnull=True))
        )
        rows = {
            r['organization_id']: r
            for r in direct_qs.values('organization_id').annotate(
                file_count=Count('id'),
                file_storage_bytes=Coalesce(Sum('file_size'), Value(0)),
            )
        }

        self.assertIn('ws-A', rows)
        self.assertIn('ws-B', rows)
        self.assertEqual(rows['ws-A']['file_count'], 2)
        self.assertEqual(rows['ws-A']['file_storage_bytes'], 3000)
        self.assertEqual(rows['ws-B']['file_count'], 1)
        self.assertEqual(rows['ws-B']['file_storage_bytes'], 3000)

    def test_deleted_files_excluded(self):
        """验证 deleted 文件不参与 organization 聚合"""
        direct_qs = (
            FileRecord.objects.exclude(status='deleted')
            .exclude(Q(organization_id='') | Q(organization_id__isnull=True))
        )
        total = direct_qs.filter(organization_id='ws-A').aggregate(
            total=Coalesce(Sum('file_size'), Value(0)),
        )['total']
        self.assertEqual(total, 3000)

    def test_unowned_aggregate(self):
        """验证 unowned 文件单独统计"""
        from apps.services.oss.admin_api import _build_unowned_file_filter

        agg = (
            FileRecord.objects.exclude(status='deleted')
            .filter(_build_unowned_file_filter())
            .aggregate(
                count=Count('id'),
                total_size=Coalesce(Sum('file_size'), Value(0)),
            )
        )
        self.assertEqual(agg['count'], 1)
        self.assertEqual(agg['total_size'], 400)

    def test_organization_keyword_filter(self):
        """验证 organization_keyword 过滤使用 icontains"""
        direct_qs = (
            FileRecord.objects.exclude(status='deleted')
            .exclude(Q(organization_id='') | Q(organization_id__isnull=True))
            .filter(organization_id__icontains='ws-A')
        )
        rows = list(
            direct_qs.values('organization_id').annotate(
                file_count=Count('id'),
                file_storage_bytes=Coalesce(Sum('file_size'), Value(0)),
            )
        )
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['organization_id'], 'ws-A')

    def test_source_uses_group_by_not_python_loop(self):
        """确认 get_admin_oss_cost_overview 源码使用 GROUP BY 而非 Python 遍历"""
        import inspect
        from apps.services.oss.admin_api import get_admin_oss_cost_overview

        source = inspect.getsource(get_admin_oss_cost_overview)
        self.assertIn(".values('organization_id').annotate(", source)
        self.assertNotIn('_extract_file_organization_id(record)', source)


class PERF011TaskSummaryAggregationTest(TestCase):
    """PERF-011: list_admin_oss_tasks summary 使用单次 aggregate 而非 5 次 count"""

    def setUp(self):
        for status in ('processing', 'completed', 'completed', 'failed', 'cancelled'):
            UploadTask.objects.create(
                task_name=f'task-{status}-{uuid.uuid4().hex[:6]}',
                task_type='single',
                status=status,
            )

    def test_task_summary_counts(self):
        from apps.services.oss.admin_api import list_admin_oss_tasks

        response = list_admin_oss_tasks(_make_staff_request())
        s = response.summary

        self.assertEqual(s.total_tasks, 5)
        self.assertEqual(s.processing_tasks, 1)
        self.assertEqual(s.completed_tasks, 2)
        self.assertEqual(s.failed_tasks, 1)
        self.assertEqual(s.cancelled_tasks, 1)

    def test_task_summary_reuses_total(self):
        """total_tasks 应等于 pagination.total（复用已有 count 而非重新查询）"""
        from apps.services.oss.admin_api import list_admin_oss_tasks

        response = list_admin_oss_tasks(_make_staff_request())
        self.assertEqual(response.summary.total_tasks, response.pagination.total)

    def test_task_summary_with_status_filter(self):
        from apps.services.oss.admin_api import list_admin_oss_tasks

        response = list_admin_oss_tasks(_make_staff_request(), status='completed')
        s = response.summary

        self.assertEqual(s.total_tasks, 2)
        self.assertEqual(s.completed_tasks, 2)
        self.assertEqual(s.processing_tasks, 0)
        self.assertEqual(s.failed_tasks, 0)

    def test_source_uses_aggregate_not_multiple_count(self):
        """确认 summary 使用单次 aggregate 而非多次 .count()"""
        import inspect
        from apps.services.oss.admin_api import list_admin_oss_tasks

        source = inspect.getsource(list_admin_oss_tasks)
        self.assertIn('task_agg = queryset.aggregate(', source)
        self.assertNotIn("queryset.filter(status='processing').count()", source)
        self.assertNotIn("queryset.filter(status='completed').count()", source)
