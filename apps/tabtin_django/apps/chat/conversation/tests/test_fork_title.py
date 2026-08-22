"""fork 数字编号标题与自动重命名门槛单测（尽量不落库）。"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from apps.chat.conversation.services.fork_title import (
    allocate_fork_session_title,
    fork_title_base,
    is_fork_numbered_placeholder,
)
from apps.chat.conversation.services.title_generator import TitleGeneratorService


class TestForkTitleHelpers:
    def test_fork_title_base_strips_fork_and_numbers(self):
        assert fork_title_base("收到确认指令") == "收到确认指令"
        assert fork_title_base("收到确认指令 (fork)") == "收到确认指令"
        assert fork_title_base("收到确认指令 (fork) (fork)") == "收到确认指令"
        assert fork_title_base("收到确认指令 3") == "收到确认指令"
        assert fork_title_base("收到确认指令 2 (fork)") == "收到确认指令"

    def test_is_fork_numbered_placeholder(self):
        assert is_fork_numbered_placeholder("标题 2") is True
        assert is_fork_numbered_placeholder("标题 (fork)") is True
        assert is_fork_numbered_placeholder("普通标题") is False
        assert is_fork_numbered_placeholder("新任务") is False

    def test_allocate_locks_family_root_then_increments(self):
        root = SimpleNamespace(
            id="root-id",
            forked_from_id=None,
            title="收到确认指令",
            workspace_id="ws-1",
        )
        user = SimpleNamespace(id="u1")
        lock_qs = MagicMock()
        lock_qs.filter.return_value = lock_qs
        lock_qs.only.return_value = lock_qs
        lock_qs.first.return_value = root

        scan_qs = MagicMock()
        scan_qs.filter.return_value = scan_qs
        scan_qs.values_list.return_value = ["收到确认指令 2", "收到确认指令 5"]

        objects = MagicMock()
        objects.select_for_update.return_value = lock_qs
        objects.filter.return_value = scan_qs

        with patch(
            "apps.chat.conversation.models.ChatSession.objects",
            objects,
        ), patch(
            "apps.chat.conversation.services.fork_title.resolve_fork_family_root",
            return_value=root,
        ):
            title = allocate_fork_session_title(source_session=root, user=user)

        objects.select_for_update.assert_called_once_with()
        lock_qs.filter.assert_called_once_with(id="root-id")
        assert title == "收到确认指令 6"

    def test_allocate_first_fork_is_two(self):
        root = SimpleNamespace(
            id="root-id",
            forked_from_id=None,
            title="根对话",
            workspace_id="ws-1",
        )
        user = SimpleNamespace(id="u1")
        lock_qs = MagicMock()
        lock_qs.filter.return_value = lock_qs
        lock_qs.only.return_value = lock_qs
        lock_qs.first.return_value = root

        scan_qs = MagicMock()
        scan_qs.filter.return_value = scan_qs
        scan_qs.values_list.return_value = []

        objects = MagicMock()
        objects.select_for_update.return_value = lock_qs
        objects.filter.return_value = scan_qs

        with patch(
            "apps.chat.conversation.models.ChatSession.objects",
            objects,
        ), patch(
            "apps.chat.conversation.services.fork_title.resolve_fork_family_root",
            return_value=root,
        ):
            title = allocate_fork_session_title(source_session=root, user=user)
        assert title == "根对话 2"


class TestForkTitleAutoGenerateGate:
    def test_fork_pending_allows_auto_generate_regardless_of_title_shape(self):
        """门槛只看血缘 + pending，不靠标题 ``\\s+\\d+$``。"""
        fork = SimpleNamespace(
            forked_from_id="parent",
            title="Sprint 12",
            title_generation_status="pending",
        )
        assert TitleGeneratorService.is_fork_title_pending(fork) is True
        assert TitleGeneratorService.should_auto_generate_title(fork) is True

    def test_fork_done_blocks_auto_generate(self):
        fork = SimpleNamespace(
            forked_from_id="parent",
            title="已经 LLM 过的标题",
            title_generation_status="done",
        )
        assert TitleGeneratorService.is_fork_title_pending(fork) is False
        assert TitleGeneratorService.should_auto_generate_title(fork) is False

    def test_non_fork_pending_does_not_use_fork_gate(self):
        root = SimpleNamespace(
            forked_from_id=None,
            title="新任务",
            title_generation_status="pending",
        )
        assert TitleGeneratorService.is_fork_title_pending(root) is False
