"""COM-12 回归测试：成员删除信号异步化验证。"""
import os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

import inspect  # noqa: E402
import pytest  # noqa: E402


class TestCOM12SignalAsync:
    """COM-12: decrease_organization_member_count 信号不再包含重操作。"""

    def test_signal_handler_does_not_contain_centrifugo(self):
        """信号处理器不应直接调用 Centrifugo。"""
        from apps.tabtinspace.signals import decrease_organization_member_count
        source = inspect.getsource(decrease_organization_member_count)
        assert "get_centrifugo_service" not in source
        assert "centrifugo.publish" not in source

    def test_signal_handler_dispatches_async_task(self):
        """信号处理器应调度 async_deactivate_member_resources 任务。"""
        from apps.tabtinspace.signals import decrease_organization_member_count
        source = inspect.getsource(decrease_organization_member_count)
        assert "async_deactivate_member_resources" in source
        assert "on_commit" in source

    def test_signal_handler_does_not_query_conversation(self):
        """信号处理器不应直接查询 Conversation 表。"""
        from apps.tabtinspace.signals import decrease_organization_member_count
        source = inspect.getsource(decrease_organization_member_count)
        assert "ConversationMember" not in source

    def test_async_task_exists(self):
        """async_deactivate_member_resources 任务已定义。"""
        from apps.tabtinspace.tasks import async_deactivate_member_resources
        assert async_deactivate_member_resources.name == "tabtinspace.async_deactivate_member_resources"

    def test_async_task_handles_agent_deactivation(self):
        """异步任务包含 Agent 失活逻辑。"""
        from apps.tabtinspace.tasks import async_deactivate_member_resources
        source = inspect.getsource(async_deactivate_member_resources)
        assert "Agent.objects.filter" in source
        assert "is_active=False" in source

    def test_async_task_handles_conversation_cleanup(self):
        """异步任务包含 Conversation 清理逻辑。"""
        from apps.tabtinspace.tasks import async_deactivate_member_resources
        source = inspect.getsource(async_deactivate_member_resources)
        assert "ConversationMember" in source

    def test_async_task_has_time_limits(self):
        """异步任务应设置 time_limit 和 soft_time_limit。"""
        from apps.tabtinspace.tasks import async_deactivate_member_resources
        assert async_deactivate_member_resources.time_limit is not None
        assert async_deactivate_member_resources.soft_time_limit is not None
