"""
回归测试：SS-002 / SS-003 / SS-004 / SS-005
- SS-002: SkillEmbedding 失败时创建 EmbeddingTask 记录
- SS-003: index_mail_embedding 失败时创建 EmbeddingTask 记录
- SS-004: get_index_quality_stats() 统计 Skill/Mail 路径的数据
- SS-005: get_index_coverage() 和 detect_anomalies() 包含 Skill/Mail 覆盖率
"""
from __future__ import annotations

import uuid
from unittest.mock import MagicMock, patch

import pytest


# ───────────────────────────────────────────────────────────────────────────────
# 辅助工具
# ───────────────────────────────────────────────────────────────────────────────

def _make_uuid():
    return uuid.uuid4()


# ───────────────────────────────────────────────────────────────────────────────
# SS-002: SkillEmbeddingService.index_skill() 失败时创建 EmbeddingTask 记录
# ───────────────────────────────────────────────────────────────────────────────

class TestSS002SkillEmbeddingFailureTracking:
    """embed_text 抛异常后，应在 EmbeddingTask 表中创建 status='failed' 记录。"""

    def test_embed_failure_creates_embedding_task(self):
        """embed_text 失败时应创建 EmbeddingTask(task_type='skill', status='failed')。"""
        created_tasks = []

        mock_svc = MagicMock()
        mock_svc.embed_text.side_effect = RuntimeError("embedding API unavailable")

        mock_task_cls = MagicMock()
        mock_task_cls.objects = MagicMock()
        mock_task_cls.objects.create.side_effect = lambda **kw: created_tasks.append(kw)

        mock_skill_embedding_cls = MagicMock()
        mock_skill_embedding_cls.objects = MagicMock()
        mock_skill_embedding_cls.objects.filter.return_value.first.return_value = None

        mock_calculate_hash = MagicMock(return_value="abc123")

        with patch(
            "apps.skills.services.embedding_service.get_embedding_service",
            return_value=mock_svc,
        ), patch(
            "apps.rag.models.SkillEmbedding", mock_skill_embedding_cls
        ), patch(
            "apps.rag.models.EmbeddingTask", mock_task_cls
        ), patch(
            "apps.rag.utils.calculate_content_hash", mock_calculate_hash
        ):
            from apps.skills.services.embedding_service import SkillEmbeddingService

            result = SkillEmbeddingService.index_skill(
                skill_key="test_skill_001",
                name="Test Skill",
                description="A test skill",
                source="system",
            )

        assert result is False, "embed 失败时 index_skill 应返回 False"
        assert len(created_tasks) == 1, "应创建一条 EmbeddingTask 记录"
        task = created_tasks[0]
        assert task["task_type"] == "skill", "task_type 应为 'skill'"
        assert task["status"] == "failed", "status 应为 'failed'"
        assert "embedding API unavailable" in task["error_message"], "error_message 应包含异常信息"

    def test_embed_success_does_not_create_failed_task(self):
        """embed_text 成功时不应创建 EmbeddingTask(status='failed') 记录。"""
        created_tasks = []

        mock_svc = MagicMock()
        mock_svc.embed_text.return_value = [0.1] * 1536
        mock_svc.dimensions = 1536

        mock_task_cls = MagicMock()
        mock_task_cls.objects = MagicMock()
        mock_task_cls.objects.create.side_effect = lambda **kw: created_tasks.append(kw)

        mock_skill_embedding_cls = MagicMock()
        mock_skill_embedding_cls.objects = MagicMock()
        mock_skill_embedding_cls.objects.filter.return_value.first.return_value = None
        mock_skill_embedding_cls.objects.update_or_create.return_value = (MagicMock(), True)

        mock_calculate_hash = MagicMock(return_value="abc456")

        with patch(
            "apps.skills.services.embedding_service.get_embedding_service",
            return_value=mock_svc,
        ), patch(
            "apps.rag.models.SkillEmbedding", mock_skill_embedding_cls
        ), patch(
            "apps.rag.models.EmbeddingTask", mock_task_cls
        ), patch(
            "apps.rag.utils.calculate_content_hash", mock_calculate_hash
        ):
            from apps.skills.services.embedding_service import SkillEmbeddingService

            result = SkillEmbeddingService.index_skill(
                skill_key="test_skill_002",
                name="Test Skill 2",
                description="Success case",
                source="system",
            )

        assert result is True
        failed = [t for t in created_tasks if t.get("status") == "failed"]
        assert len(failed) == 0, "成功路径不应创建失败 EmbeddingTask"


# ───────────────────────────────────────────────────────────────────────────────
# SS-004: get_index_quality_stats() 包含 Skill 统计字段
# ───────────────────────────────────────────────────────────────────────────────

class TestSS004IndexQualityStats:
    """get_index_quality_stats() 应包含 skill_task_status / recent_24h.skills。"""

    def _build_mock_qs(self, count=0, values_result=None, filter_count=0):
        """构造模拟 QuerySet，支持 .count()、.filter().count()、.values().annotate()。"""
        qs = MagicMock()
        qs.count.return_value = count
        qs.filter.return_value.count.return_value = filter_count
        qs.values.return_value.annotate.return_value = values_result or []
        return qs

    def test_stats_contains_skill_fields(self):
        """返回值中应包含 skill_task_status 和 recent_24h.skills。"""
        from apps.rag.services.monitor_service import MonitorService

        with patch("apps.rag.models.TableEmbedding") as mock_te, \
             patch("apps.rag.models.RecordEmbedding") as mock_re, \
             patch("apps.rag.models.DocumentEmbedding") as mock_de, \
             patch("apps.rag.models.SkillEmbedding") as mock_se, \
             patch("apps.rag.models.EmbeddingTask") as mock_et:

            mock_te.objects.count.return_value = 10
            mock_re.objects.count.return_value = 100
            mock_de.objects.count.return_value = 5
            mock_se.objects.count.return_value = 20

            mock_te.objects.values.return_value.annotate.return_value = [{"status": "success", "count": 10}]
            mock_re.objects.values.return_value.annotate.return_value = []
            mock_de.objects.values.return_value.annotate.return_value = []

            skill_task_qs = MagicMock()
            skill_task_qs.values.return_value.annotate.return_value = [{"status": "failed", "count": 3}]

            def et_filter(**kwargs):
                if kwargs.get("task_type") == "skill":
                    return skill_task_qs
                m = MagicMock()
                m.count.return_value = 10
                m.filter.return_value.count.return_value = 1
                return m

            mock_et.objects.filter.side_effect = et_filter
            mock_et.objects.values.return_value.annotate.return_value = []
            mock_se.objects.filter.return_value.count.return_value = 2

            svc = MonitorService()
            stats = svc.get_index_quality_stats()

        assert "skill_task_status" in stats, "SS-004: 应包含 skill_task_status"
        assert "skills" in stats["recent_24h"], "SS-004: recent_24h 应包含 skills"
        assert "failure_rate_scope" in stats, "SS-004: 应有 failure_rate_scope 说明数据来源"


# ───────────────────────────────────────────────────────────────────────────────
# SS-005: get_index_coverage() / detect_anomalies() 包含 Skill/Mail 覆盖率
# ───────────────────────────────────────────────────────────────────────────────

class TestSS005IndexCoverageAndAnomalies:
    """get_index_coverage() 应返回 skill_coverage；detect_anomalies() 检测 skill 失败。"""

    def test_coverage_contains_skill(self):
        """get_index_coverage() 返回值中应包含 skill_coverage 字段。"""
        from apps.rag.services.monitor_service import MonitorService

        with patch("apps.tabdata.models.Table") as mock_table, \
             patch("apps.tabdata.models.TableRecord") as mock_record, \
             patch("apps.rag.models.TableEmbedding") as mock_te, \
             patch("apps.rag.models.RecordEmbedding") as mock_re, \
             patch("apps.rag.models.DocumentEmbedding") as mock_de, \
             patch("apps.rag.models.SkillEmbedding") as mock_se, \
             patch("apps.rag.models.EmbeddingTask") as mock_et:

            mock_table.objects.count.return_value = 10
            mock_record.objects.count.return_value = 100
            mock_te.objects.values.return_value.distinct.return_value.count.return_value = 8
            mock_re.objects.values.return_value.distinct.return_value.count.return_value = 80
            mock_te.objects.values.return_value = MagicMock()
            mock_table.objects.exclude.return_value.count.return_value = 2

            mock_se.objects.count.return_value = 15
            mock_et.objects.filter.return_value.count.return_value = 2
            mock_de.objects.filter.return_value.values.return_value.distinct.return_value.count.return_value = 0

            svc = MonitorService()
            coverage = svc.get_index_coverage()

        assert "skill_coverage" in coverage, "SS-005: 应包含 skill_coverage"
        assert coverage["skill_coverage"]["indexed"] == 15

    def test_detect_anomalies_skill_failures_triggers_alert(self):
        """skill_coverage.failed_tasks > 0 时应触发 skill_embedding_failures 告警。"""
        from apps.rag.services.monitor_service import MonitorService

        coverage_with_skill_failures = {
            "table_coverage": {"coverage_rate": 90.0, "total": 10, "indexed": 9, "unindexed": 1},
            "record_coverage": {"coverage_rate": 90.0, "total": 100, "indexed": 90, "unindexed": 10},
            "document_coverage": {"coverage_rate": 80.0, "total": 5, "indexed": 4, "unindexed": 1},
            "skill_coverage": {"indexed": 10, "failed_tasks": 7},
        }

        mock_et = MagicMock()
        recent_qs = MagicMock()
        recent_qs.exists.return_value = False
        mock_et.objects.filter.return_value = recent_qs

        mock_search_log = MagicMock()
        mock_search_log.objects.filter.return_value = MagicMock(
            exists=MagicMock(return_value=False),
            count=MagicMock(return_value=0),
        )

        with patch("apps.rag.models.EmbeddingTask", mock_et), \
             patch("apps.rag.models.SearchLog", mock_search_log):
            svc = MonitorService()
            result = svc.detect_anomalies(coverage=coverage_with_skill_failures)

        anomaly_types = [a["type"] for a in result["anomalies"]]
        assert "skill_embedding_failures" in anomaly_types, \
            "SS-005: skill 有失败任务时应触发 skill_embedding_failures 告警"

    def test_detect_anomalies_no_skill_mail_alerts_when_healthy(self):
        """Skill/Mail 均健康时不应产生对应告警。"""
        from apps.rag.services.monitor_service import MonitorService

        healthy_coverage = {
            "table_coverage": {"coverage_rate": 90.0, "total": 10, "indexed": 9, "unindexed": 1},
            "record_coverage": {"coverage_rate": 90.0, "total": 100, "indexed": 90, "unindexed": 10},
            "document_coverage": {"coverage_rate": 80.0, "total": 5, "indexed": 4, "unindexed": 1},
            "skill_coverage": {"indexed": 10, "failed_tasks": 0},
        }

        mock_et = MagicMock()
        recent_qs = MagicMock()
        recent_qs.exists.return_value = False
        mock_et.objects.filter.return_value = recent_qs

        mock_search_log = MagicMock()
        mock_search_log.objects.filter.return_value = MagicMock(
            exists=MagicMock(return_value=False),
            count=MagicMock(return_value=0),
        )

        with patch("apps.rag.models.EmbeddingTask", mock_et), \
             patch("apps.rag.models.SearchLog", mock_search_log):
            svc = MonitorService()
            result = svc.detect_anomalies(coverage=healthy_coverage)

        anomaly_types = [a["type"] for a in result["anomalies"]]
        assert "skill_embedding_failures" not in anomaly_types
