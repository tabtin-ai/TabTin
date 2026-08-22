"""Namespace helpers for orchestration runtime (agent-only)."""

from __future__ import annotations

from typing import Iterable, Sequence

PRIMARY_NAMESPACE = "agent"

STREAM_KIND = "stream"
ACTION_KIND = "action"
RUN_KIND = "run"
# SESSION_KIND: 与 ChatSession 生命周期绑定的 topic（session 打开/激活时订阅,
# 离开时退订），独立于单轮 stream slot 的 cleanup。
# 适用场景：LLM 增强摘要、异步后台任务结果、跨轮次的系统通知等
# —— 事件产生时 agent.stream.{thread_id} 可能已被 unsubscribe。
SESSION_KIND = "session"
# USER_KIND: 用户级广播**事件命名空间**（不是 topic 名！）。
#
# 完整事件类型形如 ``agent.user.title_updated``——由 :func:`user_event_type`
# 拼接生成，仅用作 envelope 的 ``message_type`` 字段值。
#
# **重要区别**：本 namespace 没有对应的 ``user_topic()`` helper——用户级事件
# 不走 topic-bound 订阅，而是通过 channel layer group ``user.{user_id}``
# 投递（publisher 调用 ``apps.services.common.ws.bus.publish_to_user``，
# 客户端 auth.ok 后已自动 join 该 group）。这与 STREAM/SESSION/ACTION
# 三类不同——后者每类都有 ``*_topic()`` 函数生成对应 topic 名。
USER_KIND = "user"

STREAM_CAPABILITY = f"{PRIMARY_NAMESPACE}.{STREAM_KIND}"
ACTION_CAPABILITY = f"{PRIMARY_NAMESPACE}.{ACTION_KIND}"
# session capability 与 stream 共享同一订阅能力位（后端 gateway 现有
# agent.stream capability 即授权订阅 agent.session.* 主题，无需前端额外授权，
# 保持客户端订阅成本最低；详见 syncSubscriptions 的 capability 校验）。
SESSION_CAPABILITY = STREAM_CAPABILITY

ACTION_PREFIX = f"{PRIMARY_NAMESPACE}.{ACTION_KIND}."
ACTION_DEVICE_PREFIX = f"{PRIMARY_NAMESPACE}.{ACTION_KIND}.device."


def namespaced_topic(kind: str, target_id: str) -> str:
    return f"{PRIMARY_NAMESPACE}.{kind}.{target_id}"


def stream_topic(thread_id: str) -> str:
    return namespaced_topic(STREAM_KIND, thread_id)


def action_topic(thread_id: str) -> str:
    return namespaced_topic(ACTION_KIND, thread_id)


def session_topic(session_id: str) -> str:
    """Session-level topic，生命周期跟随 ChatSession 激活/离开。"""
    return namespaced_topic(SESSION_KIND, session_id)


def device_action_topic(device_fingerprint: str) -> str:
    """设备级 action topic — Daemon 通过此 topic 接收 action 请求。"""
    return f"{PRIMARY_NAMESPACE}.{ACTION_KIND}.device.{device_fingerprint}"


def namespaced_event_type(kind: str, event_name: str) -> str:
    return f"{PRIMARY_NAMESPACE}.{kind}.{event_name}"


def stream_event_type(event_name: str) -> str:
    return namespaced_event_type(STREAM_KIND, event_name)


def action_event_type(event_name: str) -> str:
    return namespaced_event_type(ACTION_KIND, event_name)


def run_event_type(event_name: str) -> str:
    return namespaced_event_type(RUN_KIND, event_name)


def session_event_type(event_name: str) -> str:
    return namespaced_event_type(SESSION_KIND, event_name)


def user_event_type(event_name: str) -> str:
    """组装 ``agent.user.<event_name>`` 完整事件类型字符串。

    与 stream/session/action 系列对称的命名 helper——但**仅用于生成 envelope
    的 message_type**，没有配套的 ``user_topic()``：用户级事件通过
    channel layer group ``user.{user_id}`` 投递（``publish_to_user``），
    并不走 topic-bound 订阅。详见 :data:`USER_KIND` 注释。
    """
    return namespaced_event_type(USER_KIND, event_name)


def normalize_capabilities(capabilities: Iterable[str]) -> set[str]:
    return {str(item).strip() for item in capabilities if isinstance(item, str) and str(item).strip()}


def has_stream_capability(capabilities: Iterable[str]) -> bool:
    return STREAM_CAPABILITY in set(capabilities)


def has_action_capability(capabilities: Iterable[str]) -> bool:
    return ACTION_CAPABILITY in set(capabilities)


def redis_key(parts: Sequence[str]) -> str:
    return ":".join([PRIMARY_NAMESPACE, *parts])
