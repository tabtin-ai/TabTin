"""relay_message_writer silent drop 告警守门测试。

== 业务背景 ==

2026-05-23 dogfood 复盘发现：daemon `EnvelopeEmitter.emitDetachedMiniMessage`
默认 messageId 形态 `msg_inline_<uuid>` 整个字符串非 UUID4，下游
`relay_message_writer.py` 主路径 `_write_chat_messages_from_reassembler`
的 `uuid.UUID(message_id)` 强校验失败 → silently skip → **所有 widget /
search_results / cli_output mini-message 自 W1a（2026-05-18）以来一直在丢库**。

这个事故能持续 5 天没人察觉的核心放大器是 silent drop 路径只用 `logger.warning`
被淹在普通日志流，没有运维侧主动告警。

== 本测试守护契约 ==

钉死 6 处守门式 skip 路径必须主动告警：

  - 主路径 `_write_chat_messages_from_reassembler`：
    1. 缺 trace_id 推算 cid → `relay.silent_drop.missing_trace_id`
    2. 非法 client_event_id → `relay.silent_drop.invalid_client_event_id`
    3. 非法 message_id      → `relay.silent_drop.invalid_message_id`（已知 P0）

  - lifecycle 兜底路径 `_write_chat_messages_from_reassembler_lifecycle_fallback`：
    4. 缺 trace_id          → `relay.silent_drop.missing_trace_id.lifecycle_fallback`
    5. 非法 client_event_id → `relay.silent_drop.invalid_client_event_id.lifecycle_fallback`
    6. 非法 message_id      → `relay.silent_drop.invalid_message_id.lifecycle_fallback`

  - 老路径 `_write_chat_messages`（assistant final）：
    7. 缺 client_event_id   → `relay.silent_drop.missing_client_event_id.legacy`
    8. 非法 client_event_id → `relay.silent_drop.invalid_client_event_id.legacy`

每条 alert 必须双管齐下：
  (a) 命名 logger `relay_message_writer.silent_drop_alert` 输出 ERROR level
  (b) sentry_sdk.capture_message 调用（即便 sentry_sdk 未安装也不能崩）

未来如果有人改回 `logger.warning` 或忘了 sentry 调用，本测试立刻 fail。
"""
from __future__ import annotations

import logging
import sys
import uuid as uuid_mod
from contextlib import contextmanager

import pytest

from apps.services.common.ws.handlers import relay_message_writer as writer


@contextmanager
def fake_sentry_sdk():
    """Mock sentry_sdk 模块——本测试运行时 sentry_sdk 可能没装/没初始化，
    用 fake module 让 _emit_silent_drop_alert 的 sentry 路径可观测。

    与 test_app_registry_check.py:_test_warning_aggregation_to_sentry 同款手法。

    关键设计：push_scope 在 **yield 之前** 就把 scope_state append 进
    `captured_scopes`（而不是 with 退出时 append）—— 这样 capture_message
    在 with 块内执行时通过 `captured_scopes[-1]` 拿到的就是当前 active scope，
    set_tag / set_extra 的引用语义保证后续 mutate 可见。原写法在 with 退出时
    才 append，capture_message 早于 append 执行 → 拿不到 scope。
    """
    captured_messages: list[tuple[str, str, dict]] = []  # (level, message, scope_state)
    captured_scopes: list[dict] = []

    @contextmanager
    def fake_push_scope():
        scope_state: dict = {"tags": {}, "extras": {}}
        scope = type(
            "FakeScope",
            (),
            {
                "set_tag": lambda self, k, v: scope_state["tags"].update({k: v}),
                "set_extra": lambda self, k, v: scope_state["extras"].update({k: v}),
            },
        )()
        # 先 append 引用，让 capture_message 在 with 内能拿到正在被 mutate 的 scope
        captured_scopes.append(scope_state)
        yield scope

    def fake_capture_message(message: str, level: str = "info", **kwargs) -> None:
        # 取最近一次 push_scope 的 state 作为 extras 关联
        scope_state = captured_scopes[-1] if captured_scopes else {}
        # 浅拷贝当前 state 快照（避免后续 push_scope 复用 list 时被覆盖）
        captured_messages.append((
            level,
            message,
            {"tags": dict(scope_state.get("tags", {})), "extras": dict(scope_state.get("extras", {}))},
        ))

    fake_module = type(
        "FakeSentryModule",
        (),
        {
            "push_scope": staticmethod(fake_push_scope),
            "capture_message": staticmethod(fake_capture_message),
        },
    )

    original_sentry = sys.modules.get("sentry_sdk")
    sys.modules["sentry_sdk"] = fake_module  # type: ignore[assignment]
    try:
        yield captured_messages
    finally:
        if original_sentry is None:
            sys.modules.pop("sentry_sdk", None)
        else:
            sys.modules["sentry_sdk"] = original_sentry


# ─── 单元测试：_emit_silent_drop_alert helper ─────────────────────────────


def test_emit_silent_drop_alert_logs_error_with_metric_and_tags(caplog):
    """命名 logger `relay_message_writer.silent_drop_alert` 必须在 ERROR level
    输出，且 extra 字段里携带 metric + tags 让 ELK / Sentry alert rule 能聚合。
    """
    with caplog.at_level(logging.ERROR, logger="relay_message_writer.silent_drop_alert"):
        writer._emit_silent_drop_alert(
            metric="relay.silent_drop.invalid_message_id",
            reason="message_id 不是合法 UUID4",
            message_id="msg_inline_88ffdd88-9dae-45e9-a2b1-ac94cf88305c",
            session_id="session-test-1",
            role="assistant",
            message_kind="tool_artifact",
            run_id="run-test-1",
        )

    silent_drop_records = [
        r for r in caplog.records
        if r.name == "relay_message_writer.silent_drop_alert"
    ]
    assert len(silent_drop_records) == 1, (
        "必须命名 logger 输出（ELK / Sentry 按 logger name grouping）"
    )
    record = silent_drop_records[0]
    assert record.levelno == logging.ERROR, (
        f"必须 ERROR level 让 alert rule 命中（不是 WARNING——"
        f"原 silent drop 用 WARNING 被淹在普通日志流是 dogfood 事故根因放大器）。"
        f"实际 level: {record.levelname}"
    )
    # extra 字段的 metric / tags 必须可被结构化日志采集器读取
    assert getattr(record, "metric", None) == "relay.silent_drop.invalid_message_id"
    tags = getattr(record, "tags", {})
    assert tags.get("reason") == "message_id 不是合法 UUID4"
    assert tags.get("message_id") == "msg_inline_88ffdd88-9dae-45e9-a2b1-ac94cf88305c"
    assert tags.get("session_id") == "session-test-1"
    assert tags.get("role") == "assistant"
    assert tags.get("message_kind") == "tool_artifact"
    assert tags.get("run_id") == "run-test-1"


def test_emit_silent_drop_alert_calls_sentry_capture_message():
    """sentry_sdk.capture_message 必须被调用，且 push_scope 内 set_tag /
    set_extra 携带 metric / message_id / session_id 等聚合维度。
    """
    with fake_sentry_sdk() as captured:
        writer._emit_silent_drop_alert(
            metric="relay.silent_drop.invalid_message_id",
            reason="UUID parse failed",
            message_id="msg_inline_xxx",
            session_id="session-test-2",
            role="assistant",
            message_kind="tool_artifact",
        )
    assert len(captured) == 1, "Sentry capture_message 必须被调用一次"
    level, message, scope = captured[0]
    assert level == "error"
    assert "relay.silent_drop.invalid_message_id" in message
    assert "UUID parse failed" in message
    # tag 维度必须含 metric + message_kind + role（运维 dashboard 按这些维度切片）
    tags = scope.get("tags", {})
    assert tags.get("relay.silent_drop.metric") == "relay.silent_drop.invalid_message_id"
    assert tags.get("relay.silent_drop.message_kind") == "tool_artifact"
    assert tags.get("relay.silent_drop.role") == "assistant"
    extras = scope.get("extras", {})
    assert extras.get("message_id") == "msg_inline_xxx"
    assert extras.get("session_id") == "session-test-2"


def test_emit_silent_drop_alert_swallows_sentry_failures(caplog):
    """sentry_sdk 未安装 / 失败 → 不能反过来阻断业务路径（caller 已在 skip 路径上）。"""

    def boom_capture_message(*args, **kwargs):
        raise RuntimeError("Sentry server unreachable")

    fake_module = type(
        "FakeSentryModule",
        (),
        {
            "push_scope": staticmethod(__import__("contextlib").nullcontext),
            "capture_message": staticmethod(boom_capture_message),
        },
    )
    original = sys.modules.get("sentry_sdk")
    sys.modules["sentry_sdk"] = fake_module  # type: ignore[assignment]
    try:
        # 不应该抛
        with caplog.at_level(logging.ERROR, logger="relay_message_writer.silent_drop_alert"):
            writer._emit_silent_drop_alert(
                metric="relay.silent_drop.invalid_message_id",
                reason="test",
                message_id="m",
            )
        # 命名 logger 仍然兜底输出（Sentry 失败时 ELK 仍能告警）
        records = [
            r for r in caplog.records
            if r.name == "relay_message_writer.silent_drop_alert"
        ]
        assert len(records) == 1
    finally:
        if original is None:
            sys.modules.pop("sentry_sdk", None)
        else:
            sys.modules["sentry_sdk"] = original


def test_emit_silent_drop_alert_swallows_logger_failures():
    """命名 logger 自身故障 → 不能反过来阻断业务路径。"""

    class BoomHandler(logging.Handler):
        def emit(self, record):
            raise RuntimeError("Logger handler crashed")

    boom = BoomHandler(level=logging.ERROR)
    alert_logger = logging.getLogger("relay_message_writer.silent_drop_alert")
    alert_logger.addHandler(boom)
    try:
        # 不应该抛
        writer._emit_silent_drop_alert(
            metric="relay.silent_drop.invalid_message_id",
            reason="test",
            message_id="m",
        )
    finally:
        alert_logger.removeHandler(boom)


# ─── 端到端集成：dogfood bug 场景模拟 ─────────────────────────────────────


def _event(event_type: str, **payload_extras) -> dict:
    payload = {
        "protocol_version": "v2",
        "min_compatible_version": "v2",
        "_seq": payload_extras.pop("_seq", 0),
        "trace_id": payload_extras.pop("trace_id", str(uuid_mod.uuid4())),
        "thread_id": payload_extras.pop("thread_id", "thread-1"),
        **payload_extras,
    }
    return {"type": event_type, "payload": payload}

