"""进宝 Echo Bot 单元测试。

设计取舍说明：
- 真实链路 E2E 验证（创建 DM / 真发消息 / 等回声 / 断 echo content）由
  独立 manage.py shell 脚本完成（见工作报告 Step 4），那里能跑完整 PG +
  Celery + Django signals 链路。
- 这里的 pytest 测试只覆盖 jinbao 模块**自己的边界逻辑**，避免依赖
  ConversationService / MessageService / SpaceLifecycle 等周边重型链路
  （主 settings 路径下的 SQLite 测试库装不下 services_billing 等 app 的
  MySQL/PG only DDL；为 jinbao 单独做 isolated settings 性价比太低）。
- 所有需要 DB 的逻辑都用 unittest.mock.patch 替身，专注断言：
  * `JINBAO_USER_ID` 是合法 UUID（P0-2 回归保护）
  * `jinbao.echo_message` Celery task 已被 autodiscover（P0-1 回归保护）
  * signal handler `_on_message_created` 正确分流 DM / 群聊 / 自己 / 对端
  * task 实现 `echo_message` 的防递归 / 非 TEXT 跳过 / 长度截断 / 前缀拼接

测试模式下 settings 强制 ENABLE_JINBAO_BOT=False（见 settings.py 注释），
但 receiver 装饰器在 module import 时已把 handler connect 到 dispatcher，
所以 dispatch 测试也能跑。
"""
from __future__ import annotations

import unittest
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from celery import current_app

from apps.services.jinbao.constants import (
    ECHO_PREFIX,
    ECHO_THINK_SECONDS,
    JINBAO_USER_ID,
)


class JinbaoConstantsTests(unittest.TestCase):
    """常量与 Celery 注册校验（不需要 DB）。"""

    def test_jinbao_user_id_is_valid_uuid(self):
        """P0-2：JINBAO_USER_ID 必须是合法 UUID 形状。

        仓内多处会 `uuid.UUID(user_id)` 校验（middleware、agent_engine、oss、
        rag 等）。原 `'jb01'` 后缀非 hex，会抛 ValueError；纯 hex `0ba001`
        是 review 后修正点。
        """
        parsed = uuid.UUID(JINBAO_USER_ID)
        self.assertEqual(str(parsed), JINBAO_USER_ID)

    def test_celery_task_is_registered(self):
        """P0-1：Celery autodiscover 必须能找到 `jinbao.echo_message`。

        `tabtin/celery.py` 调 `app.autodiscover_tasks()` 默认 related_name='tasks'，
        只 import 每个 INSTALLED_APP 下的 `tasks.py`。
        如果 jinbao 用 `echo_task.py` 命名，worker 拿不到这个 task → 整条 echo
        链路静默失败。
        """
        self.assertIn('jinbao.echo_message', current_app.tasks)

    def test_echo_think_seconds_is_positive(self):
        """ECHO_THINK_SECONDS 必须 > 0，用于模拟「真人回复」延迟。"""
        self.assertGreater(ECHO_THINK_SECONDS, 0)


class JinbaoSignalDispatchTests(unittest.TestCase):
    """`signals._on_message_created` 的分流逻辑（patch 掉 enqueue 副作用）。"""

    def _fake_msg(self, sender_id: str, msg_id: int = 12345):
        return SimpleNamespace(id=msg_id, sender_id=sender_id, content='x')

    def _fake_dm_conv(self, conv_id='conv-1', conv_type=None):
        from apps.tabchat.constants import ConversationType
        return SimpleNamespace(
            id=conv_id,
            type=ConversationType.DM if conv_type is None else conv_type,
        )

    def _fake_group_conv(self, conv_id='conv-2'):
        from apps.tabchat.constants import ConversationType
        return SimpleNamespace(id=conv_id, type=ConversationType.GROUP)

    def test_skips_non_dm_conversation(self):
        from apps.services.jinbao import signals as jinbao_signals

        with patch('apps.services.jinbao.tasks.echo_message.apply_async') as mock_apply:
            jinbao_signals._on_message_created(
                sender=None,
                message=self._fake_msg('user-real'),
                conversation=self._fake_group_conv(),
            )
            self.assertFalse(mock_apply.called, '群聊不应触发 echo task')

    def test_skips_jinbao_own_message(self):
        from apps.services.jinbao import signals as jinbao_signals

        with patch('apps.services.jinbao.tasks.echo_message.apply_async') as mock_apply:
            jinbao_signals._on_message_created(
                sender=None,
                message=self._fake_msg(JINBAO_USER_ID),
                conversation=self._fake_dm_conv(),
            )
            self.assertFalse(mock_apply.called, '进宝自己消息不应触发回声（防递归）')

    def test_skips_dm_without_jinbao(self):
        from apps.services.jinbao import signals as jinbao_signals

        # ConversationMember 查询返回 [] —— 对端不是进宝
        mock_qs = MagicMock()
        mock_qs.filter.return_value.exclude.return_value.values_list.return_value = []
        with patch(
            'apps.services.jinbao.signals.ConversationMember.objects', mock_qs,
        ), patch(
            'apps.services.jinbao.tasks.echo_message.apply_async',
        ) as mock_apply:
            jinbao_signals._on_message_created(
                sender=None,
                message=self._fake_msg('user-real'),
                conversation=self._fake_dm_conv(),
            )
            self.assertFalse(mock_apply.called, '不含进宝的 DM 不应触发回声')

    def test_dispatches_when_dm_with_jinbao(self):
        from apps.services.jinbao import signals as jinbao_signals

        # ConversationMember 查询返回 [JINBAO_USER_ID]
        mock_qs = MagicMock()
        mock_qs.filter.return_value.exclude.return_value.values_list.return_value = [
            JINBAO_USER_ID,
        ]
        with patch(
            'apps.services.jinbao.signals.ConversationMember.objects', mock_qs,
        ), patch(
            'apps.services.jinbao.tasks.echo_message.apply_async',
        ) as mock_apply:
            jinbao_signals._on_message_created(
                sender=None,
                message=self._fake_msg('user-real', msg_id=42),
                conversation=self._fake_dm_conv(),
            )
            self.assertTrue(mock_apply.called)
            self.assertEqual(
                mock_apply.call_args.kwargs.get('args') or mock_apply.call_args.args[0],
                [42],
            )

    def test_dispatch_swallows_handler_exceptions(self):
        """signal handler 异常不应反推影响发送主路径。"""
        from apps.services.jinbao import signals as jinbao_signals

        # 让 ConversationMember.objects.filter 抛异常模拟 DB 故障
        mock_qs = MagicMock()
        mock_qs.filter.side_effect = RuntimeError('simulated DB failure')

        with patch(
            'apps.services.jinbao.signals.ConversationMember.objects', mock_qs,
        ):
            try:
                jinbao_signals._on_message_created(
                    sender=None,
                    message=self._fake_msg('user-real'),
                    conversation=self._fake_dm_conv(),
                )
            except Exception:
                self.fail('handler 必须吞掉异常，不能抛出')


class JinbaoEchoTaskTests(unittest.TestCase):
    """`tasks.echo_message` 任务的内部分支（防递归 / 非 TEXT / trim / prefix）。

    所有 ORM / sleep 都被 mock。
    """

    def _fake_message(self, **overrides):
        from apps.tabchat.constants import MessageType
        defaults = {
            'id': 1001,
            'conversation_id': 'conv-x',
            'sender_id': 'user-real',
            'content': 'hello, jinbao!',
            'message_type': MessageType.TEXT,
        }
        defaults.update(overrides)
        return SimpleNamespace(**defaults)

    def _patches(self, message):
        """常用 patch 集合：Message.get / sleep / send_message。"""
        return [
            patch(
                'apps.services.jinbao.tasks.Message.objects.get',
                return_value=message,
            ),
            patch('apps.services.jinbao.tasks.time.sleep'),
            patch(
                'apps.services.jinbao.tasks.MessageService.send_message',
            ),
        ]

    def test_echoes_text_message_with_prefix(self):
        from apps.services.jinbao.tasks import echo_message

        msg = self._fake_message(content='hi')
        patches = self._patches(msg)
        with patches[0], patches[1], patches[2] as mock_send:
            echo_message.apply(args=[msg.id]).get()
            mock_send.assert_called_once()
            kwargs = mock_send.call_args.kwargs
            self.assertEqual(kwargs['content'], f'{ECHO_PREFIX}hi')
            self.assertEqual(kwargs['sender_id'], JINBAO_USER_ID)
            self.assertEqual(kwargs['conversation_id'], 'conv-x')

    def test_skips_jinbao_self_message_in_task(self):
        """task 内部的二次防递归（双重保险）。"""
        from apps.services.jinbao.tasks import echo_message

        msg = self._fake_message(sender_id=JINBAO_USER_ID)
        patches = self._patches(msg)
        with patches[0], patches[1], patches[2] as mock_send:
            echo_message.apply(args=[msg.id]).get()
            self.assertFalse(mock_send.called, '进宝消息不应再触发 send_message')

    def test_skips_non_text_message(self):
        from apps.services.jinbao.tasks import echo_message
        from apps.tabchat.constants import MessageType

        msg = self._fake_message(message_type=MessageType.IMAGE)
        patches = self._patches(msg)
        with patches[0], patches[1], patches[2] as mock_send:
            echo_message.apply(args=[msg.id]).get()
            self.assertFalse(mock_send.called, '图片/文件类不应回声')

    def test_trims_oversized_content(self):
        """P1-1：原文 + 🔁 前缀 > MAX_CONTENT_LENGTH 必须截断。"""
        from apps.services.jinbao.tasks import echo_message
        from apps.tabchat.services.message_service import MAX_CONTENT_LENGTH

        long = 'A' * (MAX_CONTENT_LENGTH + 100)
        msg = self._fake_message(content=long)
        patches = self._patches(msg)
        with patches[0], patches[1], patches[2] as mock_send:
            echo_message.apply(args=[msg.id]).get()
            content = mock_send.call_args.kwargs['content']
            self.assertEqual(len(content), MAX_CONTENT_LENGTH)
            self.assertTrue(content.startswith(ECHO_PREFIX))

    def test_waits_before_echo(self):
        """回声任务保留短暂延迟。"""
        from apps.services.jinbao.tasks import echo_message

        msg = self._fake_message()
        with patch(
            'apps.services.jinbao.tasks.Message.objects.get', return_value=msg,
        ), patch('apps.services.jinbao.tasks.time.sleep') as mock_sleep, patch(
            'apps.services.jinbao.tasks.MessageService.send_message',
        ):
            echo_message.apply(args=[msg.id]).get()

        self.assertTrue(mock_sleep.called)
        self.assertEqual(mock_sleep.call_args.args[0], ECHO_THINK_SECONDS)

    def test_silently_returns_when_message_missing(self):
        """原消息已删除：task 直接 return，不抛、不重试。"""
        from apps.services.jinbao.tasks import echo_message
        from apps.tabchat.models import Message

        with patch(
            'apps.services.jinbao.tasks.Message.objects.get',
            side_effect=Message.DoesNotExist,
        ), patch(
            'apps.services.jinbao.tasks.MessageService.send_message',
        ) as mock_send:
            echo_message.apply(args=[99999]).get()
            self.assertFalse(mock_send.called)


if __name__ == '__main__':
    unittest.main(verbosity=2)
