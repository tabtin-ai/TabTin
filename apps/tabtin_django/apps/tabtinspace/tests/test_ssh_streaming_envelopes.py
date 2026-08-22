"""
R6-CROSS-1（Wave 7）反向回归：SSHExecutionService.execute_streaming 的
``_push`` 闭包通过 ``build_envelope`` 推送 stdout/stderr 到 ws.stream 的链路测试。

修复前：build_envelope kwargs 调用抛 TypeError → 被外层 ``except Exception``
误捕到 "SSH 连接失败" 分支 → 又调 ``_push("stderr", f"SSH Error: {exc}",
done=True)`` 再次抛 TypeError → 整个 streaming 命令崩溃，前端拿不到任何输出。

本测试通过 fake paramiko channel + patch ``publish_ws_event`` 反向断言：
  - 一条命令的 stdout chunk → publish_ws_event 至少 2 次（chunk + done）
  - 每次 envelope.type 正确（``ssh.stream.ssh_output``）
  - envelope.payload 字段对得上（server_name / stream / data / done）
  - SSH 异常路径仍然能 _push("stderr", ...)（修复前会因 TypeError 崩溃）

实现细节：``publish_ws_event`` 在 ssh_execution_service 内部是函数级 import，
mock 必须打到源 ``apps.services.common.ws.bus.publish_ws_event``，
不能打到 ssh_execution_service 模块顶层（顶层根本没这个 attribute）。
"""
from __future__ import annotations

import os
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402

if not getattr(django.apps, "apps_ready", False):
    django.setup()

from django.test import SimpleTestCase  # noqa: E402

from apps.services.common.agent_protocol.namespace import (  # noqa: E402
    stream_event_type,
    stream_topic,
)


class _FakeChannel:
    """模拟 paramiko Channel：可控制 recv_ready / chunk 序列 / exit_status_ready 时序。"""

    def __init__(self, stdout_chunks=None, stderr_chunks=None, exit_code=0):
        self._stdout = list(stdout_chunks or [])
        self._stderr = list(stderr_chunks or [])
        self._exit_code = exit_code
        self._exit_emitted = False

    def settimeout(self, _t):
        return None

    def exec_command(self, _cmd):
        return None

    def recv_ready(self):
        return bool(self._stdout)

    def recv(self, _n):
        return self._stdout.pop(0) if self._stdout else b""

    def recv_stderr_ready(self):
        return bool(self._stderr)

    def recv_stderr(self, _n):
        return self._stderr.pop(0) if self._stderr else b""

    def exit_status_ready(self):
        # 当 stdout / stderr 已耗尽，宣布 exit
        if not self._stdout and not self._stderr:
            self._exit_emitted = True
            return True
        return False

    def recv_exit_status(self):
        return self._exit_code

    def close(self):
        return None


class _FakeTransport:
    def __init__(self, channel):
        self._channel = channel

    def open_session(self):
        return self._channel


class _FakeSshClient:
    def __init__(self, channel):
        self._transport = _FakeTransport(channel)

    def get_transport(self):
        return self._transport


def _make_server():
    """构造最小 server fixture：SimpleNamespace + save() no-op。"""
    server = SimpleNamespace(
        id="srv-1", name="prod-1", host="10.0.0.1", port=22,
        last_connected_at=None,
    )
    # execute_streaming 成功路径会调 server.save(update_fields=[...])
    server.save = lambda **_kw: None
    return server


class TestSshStreamingEnvelopes(SimpleTestCase):
    """``_push`` 闭包通过 build_envelope 推送 envelope 的回归。"""

    def test_stdout_chunk_publishes_envelope_with_correct_type(self):
        """stdout chunk → envelope.type=stream_event_type('ssh_output'), payload.stream='stdout'。"""
        from apps.tabtinspace.services.ssh_execution_service import SSHExecutionService

        svc = SSHExecutionService()
        svc._get_server = MagicMock(return_value=_make_server())  # type: ignore[attr-defined]
        svc._evict_client = MagicMock()  # type: ignore[attr-defined]

        channel = _FakeChannel(stdout_chunks=[b"hello\n"])
        client = _FakeSshClient(channel)
        svc._get_cached_client = MagicMock(return_value=client)  # type: ignore[attr-defined]

        with patch(
            "apps.services.common.ws.bus.publish_ws_event",
        ) as mock_pub:
            result = svc.execute_streaming(
                server_id="srv-1",  # type: ignore[arg-type]
                command="echo hello",
                thread_id="th-ssh-1",
                user=None,
            )

        # 至少 2 次：1 个 stdout chunk + 1 个 done sentinel
        self.assertGreaterEqual(mock_pub.call_count, 2)

        envelope_types = [
            call.args[1]["type"] for call in mock_pub.call_args_list
        ]
        expected_type = stream_event_type("ssh_output")
        self.assertTrue(
            all(t == expected_type for t in envelope_types),
            f"所有 envelope.type 应为 {expected_type}, got: {envelope_types}",
        )

        topics = {call.args[0] for call in mock_pub.call_args_list}
        self.assertEqual(topics, {stream_topic("th-ssh-1")})

        # 第一条是 stdout chunk
        first_payload = mock_pub.call_args_list[0].args[1]["payload"]
        self.assertEqual(first_payload["stream"], "stdout")
        self.assertIn("hello", first_payload["data"])
        self.assertFalse(first_payload["done"])
        self.assertEqual(first_payload["server_name"], "prod-1")

        # 最后一条 done=True
        last_payload = mock_pub.call_args_list[-1].args[1]["payload"]
        self.assertTrue(last_payload["done"])

        self.assertEqual(result.exit_code, 0)
        self.assertEqual(result.stdout, "hello\n")

    def test_stderr_chunk_publishes_envelope_with_stderr_stream(self):
        """stderr chunk → envelope.payload.stream='stderr'。"""
        from apps.tabtinspace.services.ssh_execution_service import SSHExecutionService

        svc = SSHExecutionService()
        svc._get_server = MagicMock(return_value=_make_server())  # type: ignore[attr-defined]
        svc._evict_client = MagicMock()  # type: ignore[attr-defined]

        channel = _FakeChannel(stderr_chunks=[b"oops\n"], exit_code=1)
        client = _FakeSshClient(channel)
        svc._get_cached_client = MagicMock(return_value=client)  # type: ignore[attr-defined]

        with patch(
            "apps.services.common.ws.bus.publish_ws_event",
        ) as mock_pub:
            result = svc.execute_streaming(
                server_id="srv-2",  # type: ignore[arg-type]
                command="false",
                thread_id="th-ssh-err",
                user=None,
            )

        stderr_chunks = [
            call.args[1]["payload"] for call in mock_pub.call_args_list
            if call.args[1]["payload"].get("stream") == "stderr"
            and not call.args[1]["payload"].get("done")
        ]
        self.assertGreaterEqual(len(stderr_chunks), 1)
        self.assertIn("oops", stderr_chunks[0]["data"])

        self.assertEqual(result.stderr, "oops\n")
        self.assertEqual(result.exit_code, 1)

    def test_ssh_exception_path_still_pushes_error_envelope(self):
        """get_cached_client 抛 paramiko 错误 → 走 except 分支 _push("stderr", "SSH Error: ..."),
        修复前：build_envelope kwargs 抛 TypeError 让 _push 崩溃；修复后：done envelope 必须发出。
        """
        from apps.tabtinspace.services.ssh_execution_service import SSHExecutionService

        svc = SSHExecutionService()
        svc._get_server = MagicMock(return_value=_make_server())  # type: ignore[attr-defined]
        svc._evict_client = MagicMock()  # type: ignore[attr-defined]
        svc._get_cached_client = MagicMock(  # type: ignore[attr-defined]
            side_effect=RuntimeError("SSH connection refused"),
        )

        with patch(
            "apps.services.common.ws.bus.publish_ws_event",
        ) as mock_pub:
            result = svc.execute_streaming(
                server_id="srv-3",  # type: ignore[arg-type]
                command="ls",
                thread_id="th-ssh-fail",
                user=None,
            )

        mock_pub.assert_called_once()
        payload = mock_pub.call_args.args[1]["payload"]
        self.assertEqual(payload["stream"], "stderr")
        self.assertTrue(payload["done"])
        self.assertIn("SSH Error", payload["data"])
        self.assertIn("connection refused", payload["data"])

        self.assertEqual(result.error, "SSH connection refused")

    def test_envelope_construction_typeerror_routes_to_isolated_branch(self):
        """R6-CROSS-1（W7 收口）：主 try 内 ``build_envelope`` 抛 TypeError →
        外层 except 必须走"envelope 构造类"独立分支：

        1. SSHResult.error 显式标注 ``WS envelope construction error``
           （不再误归类为 ``SSH Error``，避免运维/用户被误导排查 SSH 链路）
        2. 不再调 ``_push("stderr", ...)``——_push 自身就调 build_envelope，
           会再次抛 TypeError 形成死循环（修复前真实事故链路）
        3. ``_evict_client`` 仍被调（连接清理保持原有 best-effort 行为）

        模拟手法：patch ``protocol.build_envelope`` 抛 TypeError，模拟 kwargs
        误用 / protocol 常量名变更等代码层 bug。execute_streaming 内对
        publish_ws_event 的调用必须**在 build_envelope 抛之前完全不发生**
        （envelope = build_envelope(...) 这一行就抛了），所以 mock_pub.call_count
        必须 = 0；间接也证明"_push 不会被再次进入死循环"。
        """
        from apps.tabtinspace.services.ssh_execution_service import SSHExecutionService

        svc = SSHExecutionService()
        svc._get_server = MagicMock(return_value=_make_server())  # type: ignore[attr-defined]
        svc._evict_client = MagicMock()  # type: ignore[attr-defined]

        channel = _FakeChannel(stdout_chunks=[b"hello\n"])
        client = _FakeSshClient(channel)
        svc._get_cached_client = MagicMock(return_value=client)  # type: ignore[attr-defined]

        with patch(
            "apps.services.common.ws.protocol.build_envelope",
            side_effect=TypeError(
                "got some positional-only arguments passed as keyword arguments"
            ),
        ), patch(
            "apps.services.common.ws.bus.publish_ws_event",
        ) as mock_pub:
            result = svc.execute_streaming(
                server_id="srv-typeerr",  # type: ignore[arg-type]
                command="echo hello",
                thread_id="th-typeerr",
                user=None,
            )

        # 关键反向断言 1：publish_ws_event 不应被调（_push 内 envelope 构造抛
        # TypeError → 立即进入新 except 分支，永远不到 publish_ws_event 那一行）
        # 同时反向钉死 "_push 不会被再次进入死循环"
        self.assertEqual(mock_pub.call_count, 0)

        # 关键反向断言 2：error 必须明确标注 envelope 构造类
        self.assertIsNotNone(result.error)
        assert result.error is not None  # 让 mypy 满意
        self.assertIn("envelope construction error", result.error)

        # 关键反向断言 3：_evict_client 必须被调（连接清理）
        svc._evict_client.assert_called_once_with("srv-typeerr")

        # 关键反向断言 4：exit_code 应保持默认 -1（命令未执行成功）
        self.assertEqual(result.exit_code, -1)

    def test_envelope_carries_event_id_and_thread_id(self):
        """envelope 顶层带 event_id（每条 chunk 唯一）+ thread_id（关联会话）。"""
        from apps.tabtinspace.services.ssh_execution_service import SSHExecutionService

        svc = SSHExecutionService()
        svc._get_server = MagicMock(return_value=_make_server())  # type: ignore[attr-defined]
        svc._evict_client = MagicMock()  # type: ignore[attr-defined]

        channel = _FakeChannel(stdout_chunks=[b"a\n", b"b\n"])
        client = _FakeSshClient(channel)
        svc._get_cached_client = MagicMock(return_value=client)  # type: ignore[attr-defined]

        with patch(
            "apps.services.common.ws.bus.publish_ws_event",
        ) as mock_pub:
            svc.execute_streaming(
                server_id="srv-eid",  # type: ignore[arg-type]
                command="echo a; echo b",
                thread_id="th-eid-1",
                user=None,
            )

        for call in mock_pub.call_args_list:
            envelope = call.args[1]
            self.assertIn("event_id", envelope)
            self.assertTrue(envelope["event_id"].startswith("evt_"))
            self.assertEqual(envelope["thread_id"], "th-eid-1")

        # event_id 应当唯一，避免 buffer dedup 把多条 chunk 当成同一事件
        event_ids = [c.args[1]["event_id"] for c in mock_pub.call_args_list]
        self.assertEqual(len(event_ids), len(set(event_ids)))


if __name__ == "__main__":
    unittest.main()
