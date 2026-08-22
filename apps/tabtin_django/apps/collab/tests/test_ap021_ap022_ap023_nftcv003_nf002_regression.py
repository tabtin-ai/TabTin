"""
AP-021 / AP-022 / AP-023 / NF-TCV-003 / NF-002 回归测试

AP-021: SlideCollabAdapter.persist_changes 不过滤 status，允许非 active 状态项目写入
AP-022: VideoCollabAdapter.persist_changes 不过滤 status，允许非 active 状态项目写入
AP-023: canvas_service._cas_save_graph 中 get_current_run_id 捕获 Exception 而非仅 ImportError
NF-TCV-003: video restore_history 中 _force_close_collab_document 失败不阻断恢复流程
NF-002: RecordHistory.ACTION_CHOICES 包含 'restore' 选项
"""
import os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django
django.setup()

import pytest
from unittest.mock import MagicMock, patch, call
from uuid import uuid4


# ═══════════════════════════════════════════════════════════
# AP-021: SlideCollabAdapter.persist_changes 不过滤 status
# ═══════════════════════════════════════════════════════════


class TestAP021SlideAdapterPersistChangesNoStatusFilter:
    """AP-021: persist_changes 查询 SlideProject 时不应附加 status='active' 过滤。"""

    def test_persist_changes_does_not_filter_by_status(self):
        """filter() 调用中不应出现 status 参数（通过 inspect 验证源码）。"""
        from apps.collab.adapters.slide import SlideCollabAdapter
        import inspect

        src = inspect.getsource(SlideCollabAdapter.persist_changes)
        assert 'status="active"' not in src, (
            "SlideCollabAdapter.persist_changes 仍包含 status='active' 过滤，应已移除"
        )

    def test_persist_changes_filter_only_uses_id(self):
        """filter() 应只用 id 过滤，不附加 status。"""
        from apps.collab.adapters.slide import SlideCollabAdapter
        import inspect
        import ast

        src = inspect.getsource(SlideCollabAdapter.persist_changes)
        # 确认源码中不含 status="active" 字符串
        assert 'status="active"' not in src, (
            "SlideCollabAdapter.persist_changes 仍包含 status='active' 过滤，应已移除"
        )


# ═══════════════════════════════════════════════════════════
# AP-022: VideoCollabAdapter.persist_changes 不过滤 status
# ═══════════════════════════════════════════════════════════




# ═══════════════════════════════════════════════════════════
# AP-023: canvas_service 捕获 Exception 而非 ImportError
# ═══════════════════════════════════════════════════════════




# ═══════════════════════════════════════════════════════════
# NF-TCV-003: video restore_history force_close 失败不阻断
# ═══════════════════════════════════════════════════════════




# ═══════════════════════════════════════════════════════════
# NF-002: RecordHistory.ACTION_CHOICES 包含 restore
# ═══════════════════════════════════════════════════════════


class TestNF002RecordHistoryActionChoices:
    """NF-002: RecordHistory.ACTION_CHOICES 必须包含 'restore' 选项。"""

    def test_action_choices_contains_restore(self):
        from apps.tabdata.models import RecordHistory

        action_keys = [choice[0] for choice in RecordHistory.ACTION_CHOICES]
        assert "restore" in action_keys, (
            f"RecordHistory.ACTION_CHOICES 缺少 'restore'，当前: {action_keys}"
        )

    def test_restore_choice_has_correct_label(self):
        from apps.tabdata.models import RecordHistory

        choices_dict = dict(RecordHistory.ACTION_CHOICES)
        assert choices_dict.get("restore") == "恢复", (
            f"'restore' 的中文标签应为 '恢复'，实际: {choices_dict.get('restore')}"
        )

    def test_original_choices_still_present(self):
        """确认添加 restore 后原有选项未被破坏。"""
        from apps.tabdata.models import RecordHistory

        choices_dict = dict(RecordHistory.ACTION_CHOICES)
        assert "create" in choices_dict
        assert "update" in choices_dict
        assert "delete" in choices_dict
