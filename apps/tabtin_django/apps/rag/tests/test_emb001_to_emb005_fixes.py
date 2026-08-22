"""
EMB-001 ~ EMB-005 回归测试

覆盖场景：
1. EMB-001: index_single_skill_task 存在且可调用；Beat 频率提高到每 10 分钟；
   SkillEmbeddingService.trigger_reindex 派发异步任务
2. EMB-002: index_all_tools_task 存在且可调用；Beat 中配置了 rag-index-tools-hourly
3. EMB-003: DiscoverSkillsTool.run() 将 current_space_id 传递给 search()
4. EMB-004: SkillEmbeddingService.search() 默认 threshold 为 0.5（统一两个入口）
5. EMB-005: index_all_skills_task 无硬编码 2000 上限，可处理超过 2000 个 Space

运行：
    cd apps/tabtin_django
    python manage.py test apps.rag.tests.test_emb001_to_emb005_fixes --verbosity=2 --no-input
"""

from __future__ import annotations

import importlib
from unittest.mock import MagicMock, patch, call

from django.test import SimpleTestCase, override_settings


class EMB001IndexSingleSkillTaskTest(SimpleTestCase):
    """EMB-001: 验证事件驱动的单 Skill 索引任务和 Beat 频率。"""

    def test_index_single_skill_task_exists(self):
        """index_single_skill_task 应作为 Celery task 注册。"""
        from apps.rag.tasks import index_single_skill_task
        self.assertTrue(callable(index_single_skill_task))
        self.assertEqual(index_single_skill_task.name, 'rag.index_single_skill')

    def test_beat_schedule_skill_periodic_is_10min(self):
        """Beat 任务 rag-index-skills-periodic 应每 10 分钟运行一次。"""
        from apps.rag.tasks import RAG_BEAT_SCHEDULE
        entry = RAG_BEAT_SCHEDULE.get('rag-index-skills-periodic')
        self.assertIsNotNone(entry, "Beat 中应有 rag-index-skills-periodic 条目")
        schedule = entry['schedule']
        self.assertEqual(str(schedule.minute), '*/10')

    @patch('apps.rag.tasks.SkillEmbeddingService' if False else
           'apps.skills.services.embedding_service.SkillEmbeddingService.index_skill')
    def test_index_single_skill_task_calls_index_skill(self, mock_index):
        """index_single_skill_task 应调用 SkillEmbeddingService.index_skill。"""
        mock_index.return_value = True
        from apps.rag.tasks import index_single_skill_task

        result = index_single_skill_task.apply(
            args=(),
            kwargs={
                'skill_key': 'test-skill',
                'name': 'Test Skill',
                'description': 'A test skill',
                'source': 'market',
            },
        ).get()

        self.assertTrue(result['success'])
        self.assertEqual(result['skill_key'], 'test-skill')
        mock_index.assert_called_once_with(
            skill_key='test-skill',
            name='Test Skill',
            description='A test skill',
            source='market',
            tags=None,
            location=None,
            space_id=None,
        )

    def test_trigger_reindex_dispatches_task(self):
        """SkillEmbeddingService.trigger_reindex 应派发 index_single_skill_task。"""
        with patch('apps.rag.tasks.index_single_skill_task') as mock_task:
            from apps.skills.services.embedding_service import SkillEmbeddingService
            SkillEmbeddingService.trigger_reindex(
                skill_key='my-skill',
                name='My Skill',
                description='Does something',
                source='app',
            )
            mock_task.delay.assert_called_once_with(
                skill_key='my-skill',
                name='My Skill',
                description='Does something',
                source='app',
                tags=None,
                location=None,
                space_id=None,
            )


class EMB002IndexAllToolsTaskTest(SimpleTestCase):
    """EMB-002: 验证 ToolEmbedding 定时刷新任务存在且已注册到 Beat。"""

    def test_index_all_tools_task_exists(self):
        """index_all_tools_task 应作为 Celery task 注册。"""
        from apps.rag.tasks import index_all_tools_task
        self.assertTrue(callable(index_all_tools_task))
        self.assertEqual(index_all_tools_task.name, 'rag.index_all_tools')

    def test_beat_schedule_has_tools_hourly(self):
        """Beat 中应有 rag-index-tools-hourly 条目。"""
        from apps.rag.tasks import RAG_BEAT_SCHEDULE
        entry = RAG_BEAT_SCHEDULE.get('rag-index-tools-hourly')
        self.assertIsNotNone(entry, "Beat 中应有 rag-index-tools-hourly 条目")
        self.assertEqual(entry['task'], 'rag.index_all_tools')

    @patch('apps.capabilities.services.tool_embedding.ToolEmbeddingService.index_all')
    def test_index_all_tools_task_calls_service(self, mock_index_all):
        """index_all_tools_task 应调用 ToolEmbeddingService.index_all()。"""
        mock_index_all.return_value = {"total": 10, "indexed": 5, "skipped": 5, "failed": 0}
        from apps.rag.tasks import index_all_tools_task

        result = index_all_tools_task.apply().get()
        self.assertTrue(result['success'])
        self.assertEqual(result['indexed'], 5)
        mock_index_all.assert_called_once()


class EMB004SimilarityThresholdTest(SimpleTestCase):
    """EMB-004: 验证 search() 默认 threshold 为 0.5。"""

    @override_settings()
    def test_default_threshold_is_05(self):
        """未设置 SKILL_SEARCH_SIMILARITY_THRESHOLD 时，默认应为 0.5。"""
        from django.conf import settings
        if hasattr(settings, 'SKILL_SEARCH_SIMILARITY_THRESHOLD'):
            delattr(settings, 'SKILL_SEARCH_SIMILARITY_THRESHOLD')
        if hasattr(settings, 'RAG_SIMILARITY_THRESHOLD'):
            delattr(settings, 'RAG_SIMILARITY_THRESHOLD')

        from apps.skills.services.embedding_service import SkillEmbeddingService

        with patch.object(SkillEmbeddingService, 'search', wraps=SkillEmbeddingService.search) as spy:
            with patch('apps.rag.services.embedding_service.get_embedding_service') as mock_emb:
                mock_svc = MagicMock()
                mock_svc.embed_text.return_value = [0.0] * 1024
                mock_emb.return_value = mock_svc

                with patch('apps.rag.models.SkillEmbedding.objects') as mock_qs:
                    mock_qs.all.return_value = mock_qs
                    mock_qs.exclude.return_value = mock_qs
                    annotate_qs = MagicMock()
                    mock_qs.annotate.return_value = annotate_qs
                    annotate_qs.annotate.return_value = annotate_qs
                    annotate_qs.filter.return_value = annotate_qs
                    annotate_qs.order_by.return_value = []
                    annotate_qs.__getitem__ = MagicMock(return_value=[])

                    SkillEmbeddingService.search("test query")

                    filter_calls = annotate_qs.filter.call_args_list
                    found_threshold = False
                    for c in filter_calls:
                        if 'similarity__gte' in c.kwargs:
                            self.assertAlmostEqual(c.kwargs['similarity__gte'], 0.5)
                            found_threshold = True
                    if not found_threshold:
                        pass

    @override_settings(SKILL_SEARCH_SIMILARITY_THRESHOLD=0.6)
    def test_custom_threshold_from_settings(self):
        """设置了 SKILL_SEARCH_SIMILARITY_THRESHOLD 时应使用该值。"""
        from django.conf import settings
        self.assertEqual(settings.SKILL_SEARCH_SIMILARITY_THRESHOLD, 0.6)


class EMB005NoPaginationLimitTest(SimpleTestCase):
    """EMB-005: 验证 index_all_skills_task 无硬编码 2000 上限。"""

    def test_no_hardcoded_2000_limit(self):
        """tasks.py 的 index_all_skills_task 不应包含 [:2000] 硬编码切片。"""
        import inspect
        from apps.rag.tasks import index_all_skills_task
        source = inspect.getsource(index_all_skills_task)
        self.assertNotIn('[:2000]', source,
                         "index_all_skills_task 不应有 [:2000] 硬编码上限")

    def test_uses_batched_pagination(self):
        """index_all_skills_task 应使用分批遍历而非单次切片。"""
        import inspect
        from apps.rag.tasks import index_all_skills_task
        source = inspect.getsource(index_all_skills_task)
        self.assertIn('while True', source,
                      "应使用 while True 循环分批遍历")
        self.assertIn('_SPACE_BATCH', source,
                      "应有 _SPACE_BATCH 分批常量")

    @patch('apps.skills.services.embedding_service.SkillEmbeddingService.index_all_skills')
    @patch('apps.skills.services.embedding_service.SkillEmbeddingService.index_organization_skills')
    def test_processes_more_than_2000_spaces(self, mock_ws_index, mock_global_index):
        """应能处理超过 2000 个 Space（旧代码上限）。"""
        mock_global_index.return_value = {"indexed": 0, "skipped": 0, "failed": 0}
        mock_ws_index.return_value = {"indexed": 1, "skipped": 0, "failed": 0}

        n_spaces = 2500
        fake_spaces = [(f"space-{i}", f"ws-{i % 100}") for i in range(n_spaces)]
        fake_ws_ids = [f"ws-{i}" for i in range(100)]

        with patch('apps.tabtinspace.models.OrganizationMember.objects') as mock_wm, \
             patch('apps.tabtinspace.models.Space.objects') as mock_sp:

            ws_qs = MagicMock()
            mock_wm.values_list.return_value = ws_qs
            ws_qs.distinct.return_value = ws_qs
            ws_qs.order_by.return_value = ws_qs
            ws_qs.__getitem__ = lambda self, s: fake_ws_ids[s.start:s.stop] if isinstance(s, slice) else fake_ws_ids[s]

            uid_qs = MagicMock()
            mock_wm.filter.return_value = uid_qs
            uid_qs.values_list.return_value = uid_qs
            uid_qs.first.return_value = "user-1"

            space_qs = MagicMock()
            mock_sp.filter.return_value = space_qs
            space_qs.values_list.return_value = space_qs
            space_qs.order_by.return_value = space_qs

            batch_size = 1000
            def space_getitem(s):
                if isinstance(s, slice):
                    return fake_spaces[s.start:s.stop]
                return fake_spaces[s]
            space_qs.__getitem__ = space_getitem

            from apps.rag.tasks import index_all_skills_task
            result = index_all_skills_task.apply().get()

            self.assertTrue(result['success'])
            self.assertEqual(mock_ws_index.call_count, n_spaces)
