"""W0 — ``agent.user.*`` 命名空间协议骨架契约测试（Python 镜像）。

锁定三件事：

1. :class:`AgentUserEvent` 三个常量的短名与设计一致；
2. :func:`user_event_type` 拼出 ``agent.user.<short>`` 完整事件类型字符串，
   且**不**配套 ``user_topic`` helper（用户级事件走 ``user.{user_id}`` group，
   不绑 topic 订阅）；
3. 旧 ``AgentStreamEvent`` 上的 TITLE_UPDATED 字段已彻底移除——这是 W0 的
   核心反退化保险，防止下游 Wave 把它"加回来兼容"。

镜像 TS 侧 ``packages/agent-wire/tests/user-events.test.ts``——两端的协议
形状必须同步，否则后端发出去的 envelope 前端解不开（或反之）。
"""

from __future__ import annotations

from apps.services.common.agent_protocol import constants, namespace


class TestAgentUserEventConstants:
    def test_short_names_match_design(self) -> None:
        assert constants.AgentUserEvent.TITLE_UPDATED == "title_updated"
        assert constants.AgentUserEvent.NOTIFICATION_NEW == "notification.new"
        assert constants.AgentUserEvent.PERMISSION_CHANGED == "permission.changed"
        assert constants.AgentUserEvent.INTERACTION_REQUESTED == "interaction_requested"
        assert constants.AgentUserEvent.INTERACTION_RESOLVED == "interaction_resolved"
        assert constants.AgentUserEvent.INTERACTION_EXPIRED == "interaction_expired"
        assert constants.AgentUserEvent.SESSION_CREATED == "session_created"
        assert constants.AgentUserEvent.PROJECT_TASK_INVALIDATED == "project_task_invalidated"

    def test_class_lives_in_constants_module(self) -> None:
        # 被 publisher 真正能 import 到——constants.py 是约定的 SSOT 入口
        assert hasattr(constants, "AgentUserEvent")
        # docstring 必须存在且非空（具体措辞不锁——避免把维护性表述变成硬契约）
        assert constants.AgentUserEvent.__doc__
        assert constants.AgentUserEvent.__doc__.strip()


class TestUserEventTypeHelper:
    def test_returns_agent_user_prefixed_string(self) -> None:
        assert namespace.user_event_type("title_updated") == "agent.user.title_updated"
        assert (
            namespace.user_event_type(constants.AgentUserEvent.NOTIFICATION_NEW)
            == "agent.user.notification.new"
        )
        assert (
            namespace.user_event_type(constants.AgentUserEvent.PERMISSION_CHANGED)
            == "agent.user.permission.changed"
        )
        assert (
            namespace.user_event_type(constants.AgentUserEvent.INTERACTION_REQUESTED)
            == "agent.user.interaction_requested"
        )
        assert (
            namespace.user_event_type(constants.AgentUserEvent.INTERACTION_RESOLVED)
            == "agent.user.interaction_resolved"
        )
        assert (
            namespace.user_event_type(constants.AgentUserEvent.INTERACTION_EXPIRED)
            == "agent.user.interaction_expired"
        )
        assert (
            namespace.user_event_type(constants.AgentUserEvent.SESSION_CREATED)
            == "agent.user.session_created"
        )
        assert (
            namespace.user_event_type(constants.AgentUserEvent.PROJECT_TASK_INVALIDATED)
            == "agent.user.project_task_invalidated"
        )

    def test_user_kind_constant_exists(self) -> None:
        assert namespace.USER_KIND == "user"

    def test_no_user_topic_helper(self) -> None:
        """USER_KIND 是事件命名空间，不是 topic 名——`user_topic` 不应存在。

        如果下个 Wave 误加了 `user_topic`，本断言会立即 fail，提醒作者重读
        :data:`namespace.USER_KIND` 的注释（用户级事件走 channel layer
        group ``user.{user_id}``，由 ``publish_to_user`` 投递，不走
        topic-bound 订阅）。
        """
        assert not hasattr(namespace, "user_topic")


class TestStreamEventTitleUpdatedRemoved:
    def test_agent_stream_event_no_longer_carries_title_updated(self) -> None:
        assert not hasattr(constants.AgentStreamEvent, "TITLE_UPDATED")

    def test_relay_allowed_short_names_does_not_contain_title_updated(self) -> None:
        # title_updated 不再走 stream relay 透传白名单（W1 才会真正切到
        # publish_to_user，但协议层先把入口挪走）
        assert "title_updated" not in constants.RELAY_ALLOWED_SHORT_NAMES
