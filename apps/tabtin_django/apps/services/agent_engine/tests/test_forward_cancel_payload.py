"""
#3406：``forward_cancel`` 按 thread 取消的 wire payload 契约测试。

锁定行为：
  - 带 task_id：payload = {"task_id": ...}（历史行为不变）；
  - 无 task_id：payload 不带 task_id 字段（设备端 PromptCancelPayloadSchema
    已改 optional，按 envelope 顶层 thread_id 命中当前 run）；
  - envelope 顶层 thread_id 恒写入（设备端按 thread 命中的前提）。
"""
from __future__ import annotations

import os
import sys

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402

django.setup()

from unittest.mock import MagicMock, patch  # noqa: E402

from django.test import SimpleTestCase  # noqa: E402

from apps.services.agent_engine.services.prompt_forward_service import (  # noqa: E402
    PromptForwardService,
)

_THREAD_ID = "chat-session-16ab3a0e-0575-48b4-8e41-e44a7e1beb13"
_TASK_ID = "prompt_abc123def456"


class ForwardCancelPayloadTests(SimpleTestCase):

    def _capture_envelope(self, task_id, **kwargs):
        service = PromptForwardService()
        space = MagicMock()
        space.id = "workspace-1"
        space.organization_id = "organization-1"
        with patch.object(service, "_publish_exclusive", return_value=1) as publish:
            published = service.forward_cancel(
                thread_id=_THREAD_ID,
                task_id=task_id,
                space=space,
                **kwargs,
            )
        self.assertEqual(published, 1)
        publish.assert_called_once()
        # _publish_exclusive(thread_id, space, envelope, agent_id=...)
        return publish.call_args.args[2]

    def test_with_task_id_payload_carries_task_id(self):
        envelope = self._capture_envelope(_TASK_ID)
        self.assertEqual(envelope["payload"], {"task_id": _TASK_ID})
        self.assertEqual(envelope["thread_id"], _THREAD_ID)

    def test_without_task_id_payload_omits_field(self):
        envelope = self._capture_envelope(None)
        self.assertNotIn("task_id", envelope["payload"])
        # 设备端按 envelope 顶层 thread_id 命中——该字段是按 thread 取消的前提。
        self.assertEqual(envelope["thread_id"], _THREAD_ID)

    def test_empty_string_task_id_treated_as_absent(self):
        envelope = self._capture_envelope("")
        self.assertNotIn("task_id", envelope["payload"])

    def test_unanswered_withdraw_context_is_forwarded_to_runtime_host(self):
        envelope = self._capture_envelope(
            None,
            withdraw_unanswered=True,
            client_message_id="client-1",
            target_content="发错了",
            session_id="session-1",
        )
        self.assertEqual(envelope["payload"], {
            "withdraw_unanswered": True,
            "client_message_id": "client-1",
            "session_id": "session-1",
            "target_content": "发错了",
            "space_id": "workspace-1",
            "organization_id": "organization-1",
        })
