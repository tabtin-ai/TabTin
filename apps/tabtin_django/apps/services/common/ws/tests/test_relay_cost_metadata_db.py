"""
relay_message_writer 计费 metadata 落库归属 / 幂等（DB）测试。

需要真 MySQL：本地 sqlite 测试库跑不动 services_billing 的 MySQL-only DDL
（`ALTER TABLE ... CONVERT TO CHARACTER SET utf8mb4`），已登记 conftest
`_REQUIRES_PG_NATIVE`，本地默认 deselect、CI 真库跑。纯函数部分见
`test_relay_cost_metadata.py`（本地 + CI 都跑）。

覆盖 `_attach_cost_metadata_from_done`：
  - 按 trace_id 把计费 metadata 合并进该 run **最后一条** assistant 消息
    （防一个 turn 多条消息重复计 credits）；
  - 合并而非覆盖（保留 reassembler 既有账务字段）；
  - 不影响 usage_json（per-call 上下文规模走独立字段）；
  - relay 重试幂等；trace 无匹配消息时 no-op；跨 run 不串味。
"""
from __future__ import annotations

import os
import sys
import uuid

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402

django.setup()

from datetime import timedelta  # noqa: E402

from django.contrib.auth import get_user_model  # noqa: E402
from django.test import TestCase  # noqa: E402
from django.utils import timezone  # noqa: E402

from apps.chat.conversation.models import ChatMessage, ChatSession  # noqa: E402
from apps.services.common.ws.handlers.relay_message_writer import (  # noqa: E402
    SyncWriteResult,
    _accumulate_session_tokens_from_done,
    _attach_cost_metadata_from_done,
)

User = get_user_model()


class AttachCostMetadataTests(TestCase):
    """DB：把计费 metadata 归到本 run 最后一条 assistant 消息。"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from django.db.models.signals import post_save
        from apps.tabtinspace.signals import create_default_organization
        post_save.disconnect(create_default_organization, sender=User)

    @classmethod
    def tearDownClass(cls):
        from django.db.models.signals import post_save
        from apps.tabtinspace.signals import create_default_organization
        post_save.connect(create_default_organization, sender=User)
        super().tearDownClass()

    def setUp(self):
        self.user = User.objects.create_user(
            username="cost_meta_user",
            email="cost_meta@example.com",
            password="testpass123",
        )
        self.session = ChatSession.objects.create(
            user=self.user,
            organization_id="test-organization",
            title="cost metadata test",
        )
        self.trace = uuid.uuid4()

    def _reassembler_meta(self) -> dict:
        return {
            "_persisted_via": "reassembler",
            "client_event_id": str(uuid.uuid4()),
            "source": "agent_stream_6_piece",
        }

    def _mk_assistant(self, *, text: str, created_offset_s: int, trace: uuid.UUID | None = None):
        msg = ChatMessage.objects.create(
            session=self.session,
            role="assistant",
            text_summary=text,
            trace_id=trace if trace is not None else self.trace,
            metadata=self._reassembler_meta(),
        )
        # auto_now_add 无法在 create 时指定——用 update 强制确定性时间序
        ChatMessage.objects.filter(id=msg.id).update(
            created_at=timezone.now() + timedelta(seconds=created_offset_s)
        )
        return msg

    def _done(self, usage: dict, trace: uuid.UUID | None = None) -> dict:
        return {
            "type": "agent.stream.done",
            "payload": {
                "trace_id": str(trace if trace is not None else self.trace),
                "usage": usage,
            },
        }

    def test_attaches_credits_to_latest_assistant_only(self):
        first = self._mk_assistant(text="[工具调用]", created_offset_s=0)
        last = self._mk_assistant(text="两个子 agent 均已完成", created_offset_s=2)

        _attach_cost_metadata_from_done(
            str(self.session.id),
            [self._done({
                "cost_usd": 29.3589,
                "charge_status": "success",
                "input_tokens": 78570,
                "output_tokens": 266,
            })],
            SyncWriteResult(),
        )

        last.refresh_from_db()
        first.refresh_from_db()
        # 最后一条 assistant 拿到 credits + token 总计
        self.assertEqual(last.metadata.get("credits_consumed"), 29.3589)
        self.assertEqual(last.metadata.get("input_tokens"), 78570)
        # 既有 reassembler 账务字段保留（合并而非覆盖）
        self.assertEqual(last.metadata.get("source"), "agent_stream_6_piece")
        # 第一条（tool_use）不带 credits——防一个 turn 重复计费
        self.assertNotIn("credits_consumed", first.metadata)

    def test_does_not_clobber_usage_json_context_path(self):
        # 落库的 usage_json（per-call 上下文）不被计费 metadata 影响
        last = self._mk_assistant(text="总结", created_offset_s=1)
        ChatMessage.objects.filter(id=last.id).update(
            usage_json={"input_tokens": 30517, "output_tokens": 63}
        )
        _attach_cost_metadata_from_done(
            str(self.session.id),
            [self._done({"cost_usd": 5.0, "input_tokens": 78570})],
            SyncWriteResult(),
        )
        last.refresh_from_db()
        self.assertEqual(last.usage_json.get("input_tokens"), 30517)  # 上下文不变
        self.assertEqual(last.metadata.get("credits_consumed"), 5.0)  # 计费已落

    def test_backfills_usage_json_from_last_star_when_missing(self):
        # （ 复发）：最后一条 assistant 缺 usage_json（message_delta 未带 usage），DONE 的
        # per-call last_* 应回填 usage_json，避免前端环回退到 turn 累加 input_tokens 虚高
        last = self._mk_assistant(text="最终回复", created_offset_s=1)
        self.assertIsNone(last.usage_json)

        _attach_cost_metadata_from_done(
            str(self.session.id),
            [self._done({
                "cost_usd": 8.0,
                "input_tokens": 358562,            # turn 累加（多工具调用，虚高）
                "last_input_tokens": 55000,        # per-call（最后一次真实输入）
                "last_cache_read_input_tokens": 30720,
            })],
            SyncWriteResult(),
        )

        last.refresh_from_db()
        # usage_json 用 per-call last_* 回填（不是 turn 累加的 358562）
        self.assertEqual(last.usage_json.get("input_tokens"), 55000)
        self.assertEqual(last.usage_json.get("cache_read_input_tokens"), 30720)
        # metadata 仍写 turn 累加计费总计（不含 last_*，契约不变）
        self.assertEqual(last.metadata.get("input_tokens"), 358562)
        self.assertNotIn("last_input_tokens", last.metadata)

    def test_backfills_usage_json_for_full_cache_hit(self):
        last = self._mk_assistant(text="最终回复", created_offset_s=1)
        self.assertIsNone(last.usage_json)

        _attach_cost_metadata_from_done(
            str(self.session.id),
            [self._done({
                "input_tokens": 0,
                "cache_read_input_tokens": 1500,
                "last_input_tokens": 0,
                "last_cache_read_input_tokens": 1500,
                "last_cache_creation_input_tokens": 0,
            })],
            SyncWriteResult(),
        )

        last.refresh_from_db()
        self.assertEqual(last.usage_json.get("input_tokens"), 0)
        self.assertEqual(last.usage_json.get("cache_read_input_tokens"), 1500)
        self.assertEqual(last.usage_json.get("cache_creation_input_tokens"), 0)

    def test_does_not_overwrite_existing_per_call_usage_json(self):
        # reassembler 已落 per-call usage_json 时，DONE 的 last_* 不得覆盖（保留权威源）
        last = self._mk_assistant(text="最终回复", created_offset_s=1)
        ChatMessage.objects.filter(id=last.id).update(
            usage_json={"input_tokens": 27439, "output_tokens": 120}
        )
        _attach_cost_metadata_from_done(
            str(self.session.id),
            [self._done({
                "input_tokens": 358562,
                "last_input_tokens": 55000,
            })],
            SyncWriteResult(),
        )
        last.refresh_from_db()
        self.assertEqual(last.usage_json.get("input_tokens"), 27439)  # 保留 reassembler 真值

    def test_idempotent_on_relay_retry(self):
        last = self._mk_assistant(text="总结", created_offset_s=1)
        done = self._done({"cost_usd": 12.5, "input_tokens": 100})
        _attach_cost_metadata_from_done(str(self.session.id), [done], SyncWriteResult())
        _attach_cost_metadata_from_done(str(self.session.id), [done], SyncWriteResult())
        last.refresh_from_db()
        # 重复写同值，不累加、不报错
        self.assertEqual(last.metadata.get("credits_consumed"), 12.5)

    def test_no_matching_assistant_is_noop(self):
        # DONE 的 trace 没有对应 assistant 消息 → 不报错、不落任何东西
        orphan_trace = uuid.uuid4()
        _attach_cost_metadata_from_done(
            str(self.session.id),
            [self._done({"cost_usd": 1.0}, trace=orphan_trace)],
            SyncWriteResult(),
        )
        self.assertFalse(
            ChatMessage.objects.filter(
                session=self.session, trace_id=orphan_trace
            ).exists()
        )

    def test_other_run_not_contaminated(self):
        # 两个 turn（不同 trace）：各自的 cost 只落到各自 run 的最后一条 assistant
        run_a = self._mk_assistant(text="run A 回复", created_offset_s=0, trace=self.trace)
        other_trace = uuid.uuid4()
        run_b = self._mk_assistant(text="run B 回复", created_offset_s=2, trace=other_trace)

        _attach_cost_metadata_from_done(
            str(self.session.id),
            [self._done({"cost_usd": 3.0}, trace=other_trace)],
            SyncWriteResult(),
        )
        run_a.refresh_from_db()
        run_b.refresh_from_db()
        self.assertNotIn("credits_consumed", run_a.metadata)
        self.assertEqual(run_b.metadata.get("credits_consumed"), 3.0)


class AccumulateSessionTokensCacheTests(TestCase):
    """DONE.usage 累加到 ChatSession——input 为非 cache，cache 单列累加。"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from django.db.models.signals import post_save
        from apps.tabtinspace.signals import create_default_organization
        post_save.disconnect(create_default_organization, sender=User)

    @classmethod
    def tearDownClass(cls):
        from django.db.models.signals import post_save
        from apps.tabtinspace.signals import create_default_organization
        post_save.connect(create_default_organization, sender=User)
        super().tearDownClass()

    def setUp(self):
        from django.core.cache import cache
        cache.clear()
        self.user = User.objects.create_user(
            username="sess_cache_user", email="sess_cache@example.com", password="testpass123",
        )
        self.session = ChatSession.objects.create(
            user=self.user, organization_id="test-organization", title="cache accumulate test",
        )

    def _done(self, usage: dict, trace: uuid.UUID) -> dict:
        return {"type": "agent.stream.done", "payload": {"trace_id": str(trace), "usage": usage}}

    def test_cache_accumulates_separately_from_input(self):
        # Kimi 高 cache：input(非cache)=8638 单列进 input_tokens；cache_read=14336 单列
        _accumulate_session_tokens_from_done(
            str(self.session.id),
            [self._done({
                "input_tokens": 8638,
                "cache_read_input_tokens": 14336,
                "output_tokens": 226,
            }, trace=uuid.uuid4())],
            SyncWriteResult(),
        )
        self.session.refresh_from_db()
        self.assertEqual(self.session.input_tokens, 8638)          # 非 cache，不混 cache
        self.assertEqual(self.session.cache_read_input_tokens, 14336)  # 单列
        self.assertEqual(self.session.output_tokens, 226)
        self.assertEqual(self.session.total_tokens, 8638 + 226)    # total 不含 cache

    def test_cache_creation_counted(self):
        _accumulate_session_tokens_from_done(
            str(self.session.id),
            [self._done({
                "input_tokens": 500,
                "cache_creation_input_tokens": 2000,
                "output_tokens": 100,
            }, trace=uuid.uuid4())],
            SyncWriteResult(),
        )
        self.session.refresh_from_db()
        self.assertEqual(self.session.input_tokens, 500)
        self.assertEqual(self.session.cache_creation_input_tokens, 2000)
        self.assertEqual(self.session.total_tokens, 600)

    def test_cache_only_done_still_accumulates(self):
        # 极端：某轮只有 cache（input/output 皆 0）也要落 cache，不被早退跳过
        _accumulate_session_tokens_from_done(
            str(self.session.id),
            [self._done({"cache_read_input_tokens": 4096}, trace=uuid.uuid4())],
            SyncWriteResult(),
        )
        self.session.refresh_from_db()
        self.assertEqual(self.session.cache_read_input_tokens, 4096)

    def test_multi_turn_accumulates(self):
        for _ in range(2):
            _accumulate_session_tokens_from_done(
                str(self.session.id),
                [self._done({
                    "input_tokens": 1000, "cache_read_input_tokens": 5000, "output_tokens": 50,
                }, trace=uuid.uuid4())],
                SyncWriteResult(),
            )
        self.session.refresh_from_db()
        self.assertEqual(self.session.input_tokens, 2000)
        self.assertEqual(self.session.cache_read_input_tokens, 10000)
        self.assertEqual(self.session.output_tokens, 100)
