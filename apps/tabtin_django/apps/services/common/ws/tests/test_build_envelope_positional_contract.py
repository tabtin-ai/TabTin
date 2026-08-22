"""
R6-CROSS-1（Wave 7）反向回归：build_envelope positional-only 契约测试。

背景：
  ``protocol.build_envelope`` 前 3 个参数（``message_type`` / ``request_id``
  / ``payload``）通过 PEP 570 ``/`` 标记为 positional-only。生产环境曾发现
  5 处调用方误用 kwargs 语法（``message_type=...``），TypeError 被外层
  ``except Exception`` 吞到 ``logger.debug``，导致：
    - 外部 Agent 事件转发到 goal.events 失败
    - Daemon 离线通知失败
    - Checkpoint dispatch 失败
    - notification step 失败
    - SSH streaming 输出整条命令崩溃

本测试钉死契约：
  - kwargs 调用必须抛 TypeError（让违规调用方在测试期就被发现，而非生产期 silent 吞）
  - positional 调用成功且返回 envelope dict 字段完整
  - device_id / role / event_id / thread_id 等可选字段保持 keyword-only 支持
"""
from __future__ import annotations

import os
import sys
import unittest

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402

if not getattr(django.apps, "apps_ready", False):
    django.setup()

from django.test import SimpleTestCase  # noqa: E402

from apps.services.common.ws.protocol import (  # noqa: E402
    PROTOCOL_VERSION,
    SERVER_DEVICE_ID,
    SERVER_ROLE,
    build_envelope,
    new_event_id,
)


class TestBuildEnvelopePositionalContract(SimpleTestCase):
    """钉死前 3 个参数 positional-only，避免 R6-CROSS-1 类 silent broken 复发。"""

    def test_positional_call_succeeds(self):
        """positional 调用成功且 envelope 字段完整。"""
        env = build_envelope("agent.test", "req-1", {"key": "value"})

        self.assertEqual(env["v"], PROTOCOL_VERSION)
        self.assertEqual(env["type"], "agent.test")
        self.assertEqual(env["request_id"], "req-1")
        self.assertEqual(env["payload"], {"key": "value"})
        self.assertEqual(env["device_id"], SERVER_DEVICE_ID)
        self.assertEqual(env["role"], SERVER_ROLE)
        self.assertIn("ts", env)

    def test_kwargs_message_type_raises_type_error(self):
        """``build_envelope(message_type=..., ...)`` 必须抛 TypeError。"""
        with self.assertRaises(TypeError) as ctx:
            build_envelope(
                message_type="agent.test",  # type: ignore[misc]
                request_id="req-1",  # type: ignore[misc]
                payload={"k": "v"},  # type: ignore[misc]
            )
        msg = str(ctx.exception)
        # CPython 3.8+ 标准 positional-only 错误消息格式
        self.assertIn("positional-only", msg.lower())

    def test_kwargs_request_id_only_raises_type_error(self):
        """仅把 request_id 当 kwarg 也违规（前 3 个参数都不能当 kwarg）。"""
        with self.assertRaises(TypeError):
            # 前 2 个 positional + 第 3 个 kwarg —— 第 3 个仍被 / 标记
            build_envelope(
                "agent.test", "req-1",
                payload={"k": "v"},  # type: ignore[misc]
            )

    def test_optional_fields_remain_keyword_only(self):
        """``device_id`` / ``role`` / ``event_id`` / ``thread_id`` 仍可 keyword 传入。"""
        env = build_envelope(
            "agent.test", "req-1", {},
            device_id="fp-electron-1",
            role="electron",
            event_id="evt_xyz",
            thread_id="th-1",
            organization_id="wt-1",
        )
        self.assertEqual(env["device_id"], "fp-electron-1")
        self.assertEqual(env["role"], "electron")
        self.assertEqual(env["event_id"], "evt_xyz")
        self.assertEqual(env["thread_id"], "th-1")
        self.assertEqual(env["organization_id"], "wt-1")

    def test_optional_fields_omitted_not_in_envelope(self):
        """未传的可选字段不应出现在 envelope dict（避免 None 污染）。"""
        env = build_envelope("agent.test", "req-1", {})
        for optional in (
            "event_id", "reply_to", "thread_id", "trace_id",
            "organization_id", "session_id", "table_id", "instance_id",
        ):
            self.assertNotIn(optional, env, f"optional field {optional} 应被略过")

    def test_positional_call_with_event_id_kwarg(self):
        """生产典型用法：3 个 positional + event_id keyword。"""
        env = build_envelope(
            "ssh.stream.ssh_output",
            "req-ssh",
            {"stream": "stdout", "data": "hello\n"},
            event_id=new_event_id(),
            thread_id="th-ssh-1",
        )
        self.assertEqual(env["type"], "ssh.stream.ssh_output")
        self.assertTrue(env["event_id"].startswith("evt_"))
        self.assertEqual(env["thread_id"], "th-ssh-1")


if __name__ == "__main__":
    unittest.main()
