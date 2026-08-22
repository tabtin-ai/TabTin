"""
R1-00 / R1-15 回归测试：动态 organization membership 同步。

使用 ``django.test.SimpleTestCase`` + ``unittest.IsolatedAsyncioTestCase`` 两条体系，
确保 **Django 原生 test runner** 也能抓到（前一版用 ``@pytest.mark.asyncio``
被 Django runner 跳过，修复 R1-16）。

核心验证：
  1. `_extract_topic_organization_id` A 类 topic 解析
  2. `_prune_organization_subscriptions` 混合 A 类 + B 类退订
  3. `sync_organization_membership` 全链路：leave group / prune subs / join group /
     原子替换 ctx / LRU clear / 推送 organization.membership_changed
  4. B 类 topic（agent.stream.{thread}、table.events.{table} 等）必须被主动退订，
     因为 publish_ws_event 发到 topic.{topic} group，leave organization 不足以切断流
"""
from __future__ import annotations

import os
import sys
import unittest
import uuid
from collections import OrderedDict
from unittest.mock import AsyncMock, MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402

if not getattr(django.apps, "apps_ready", False):
    django.setup()

from django.test import SimpleTestCase  # noqa: E402

from apps.services.common.ws.handlers.auth import (  # noqa: E402
    _OrganizationMembershipFetchError,
    _extract_topic_organization_id,
    _prune_organization_subscriptions,
    _select_new_primary,
    sync_organization_membership,
)
from apps.services.common.ws.organization_context import OrganizationContext  # noqa: E402


_WS_A = str(uuid.UUID("00000000-0000-0000-0000-000000000001"))
_WS_B = str(uuid.UUID("00000000-0000-0000-0000-000000000002"))
_WS_C = str(uuid.UUID("00000000-0000-0000-0000-000000000003"))


def _make_consumer(*, role: str = "electron", organization_ids=None,
                   subscriptions=None, initial_hint=None,
                   primary_id=None):
    """构造 MagicMock consumer，organization_ctx / subscriptions 都为真实值。"""
    organization_ids = set(organization_ids or set())
    if primary_id is None:
        primary_id = next(iter(organization_ids), None)
    consumer = MagicMock()
    consumer.role = role
    consumer.user_id = "user-sync-test"
    consumer.user = MagicMock(id="user-sync-test")
    consumer.authed = True
    consumer.organization_ctx = OrganizationContext(primary_id, organization_ids)
    consumer._initial_organization_hint = initial_hint
    consumer.subscriptions = set(subscriptions or set())
    consumer._send_envelope = AsyncMock()
    consumer._send_error = AsyncMock()
    consumer.close = AsyncMock()
    consumer._join_group = AsyncMock()
    consumer._leave_group = AsyncMock()
    consumer._membership_lock = None
    return consumer


# -----------------------------------------------------------------------------
# _extract_topic_organization_id 单元测试 —— 继承 SimpleTestCase
# -----------------------------------------------------------------------------


class ExtractTopicOrganizationIdTests(SimpleTestCase):
    def test_tracker_events(self):
        self.assertEqual(_extract_topic_organization_id(f"tracker.events.{_WS_A}"), _WS_A)

    def test_extension_events(self):
        self.assertEqual(_extract_topic_organization_id(f"extension.events.{_WS_A}"), _WS_A)

    def test_billing_events(self):
        self.assertEqual(_extract_topic_organization_id(f"billing.events.{_WS_A}"), _WS_A)

    def test_context_sync_organization(self):
        self.assertEqual(
            _extract_topic_organization_id(f"context.sync.organization.{_WS_A}"), _WS_A,
        )

    def test_device_capabilities_refresh(self):
        self.assertEqual(
            _extract_topic_organization_id(f"device.capabilities.refresh.{_WS_A}"), _WS_A,
        )

    def test_context_sync_space_returns_none(self):
        self.assertIsNone(_extract_topic_organization_id("context.sync.space-uuid-xxx"))

    def test_agent_stream_b_class_returns_none(self):
        self.assertIsNone(_extract_topic_organization_id("agent.stream.chat-session-xxx"))

    def test_table_events_b_class_returns_none(self):
        self.assertIsNone(_extract_topic_organization_id("table.events.some-uuid"))

    def test_short_topic_returns_none(self):
        self.assertIsNone(_extract_topic_organization_id("ping"))
        self.assertIsNone(_extract_topic_organization_id("extension.events"))


# -----------------------------------------------------------------------------
# _select_new_primary 单元测试
# -----------------------------------------------------------------------------


class SelectNewPrimaryTests(SimpleTestCase):
    def test_preserves_old_primary_when_still_member(self):
        self.assertEqual(
            _select_new_primary(_WS_A, {_WS_A, _WS_C}, None),
            _WS_A,
        )

    def test_falls_back_to_preferred_hint(self):
        self.assertEqual(
            _select_new_primary(_WS_B, {_WS_A, _WS_C}, _WS_C),
            _WS_C,
        )

    def test_returns_none_when_no_candidate(self):
        """旧 primary 被移除 + 无 hint → 返回 None（让前端显式选择）。"""
        self.assertIsNone(_select_new_primary(_WS_B, {_WS_A, _WS_C}, None))

    def test_hint_not_member_returns_none(self):
        """hint 不在 new_all 里时也返回 None，不强塞无权限的 organization。"""
        self.assertIsNone(_select_new_primary(_WS_B, {_WS_A}, _WS_C))


# -----------------------------------------------------------------------------
# _prune_organization_subscriptions 单元测试（混合 A + B 类）
#
# 这里用 IsolatedAsyncioTestCase，因为 _prune 现在是 async（用了
# database_sync_to_async 包装 B 类批量查询）
# -----------------------------------------------------------------------------


class PruneOrganizationSubscriptionsTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_class_only(self):
        """仅 A 类 subscriptions（topic 字符串内嵌 organization_id）。"""
        subs = {
            f"extension.events.{_WS_A}",
            f"extension.events.{_WS_B}",
            f"tracker.events.{_WS_B}",
            f"billing.events.{_WS_A}",
            "notifications.user-sync-test",
        }
        consumer = _make_consumer(organization_ids={_WS_A, _WS_B}, subscriptions=subs)
        # 未走 B 类 DB 查询路径，返回空 dict
        with patch(
            "apps.services.common.ws.handlers.auth.database_sync_to_async",
            side_effect=lambda fn: AsyncMock(side_effect=lambda *a, **kw: fn(*a, **kw)),
        ), patch(
            "apps.services.common.ws.handlers.auth._resolve_b_class_organizations_sync",
            return_value={"notifications.user-sync-test": None},
        ):
            removed = await _prune_organization_subscriptions(consumer, {_WS_B})
        self.assertEqual(
            set(removed),
            {f"extension.events.{_WS_B}", f"tracker.events.{_WS_B}"},
        )
        self.assertNotIn(f"extension.events.{_WS_B}", consumer.subscriptions)
        self.assertIn(f"extension.events.{_WS_A}", consumer.subscriptions)
        self.assertIn(f"billing.events.{_WS_A}", consumer.subscriptions)
        self.assertIn("notifications.user-sync-test", consumer.subscriptions)

    async def test_b_class_topic_of_removed_organization_is_pruned(self):
        """P0-NEW-1 核心：B 类 topic（资源级）属于 removed organization 必须被退订。"""
        subs = {
            "agent.stream.chat-session-on-wsB",
            "agent.stream.chat-session-on-wsA",
            "table.events.table-in-wsB",
        }
        consumer = _make_consumer(organization_ids={_WS_A, _WS_B}, subscriptions=subs)
        # 模拟 resolver：chat-session-on-wsB / table-in-wsB 属于 _WS_B；chat-session-on-wsA 属于 _WS_A
        fake_results = {
            "agent.stream.chat-session-on-wsB": _WS_B,
            "agent.stream.chat-session-on-wsA": _WS_A,
            "table.events.table-in-wsB": _WS_B,
        }
        with patch(
            "apps.services.common.ws.handlers.auth.database_sync_to_async",
            side_effect=lambda fn: AsyncMock(side_effect=lambda *a, **kw: fake_results if fn.__name__ == "_resolve_b_class_organizations_sync" else fn(*a, **kw)),
        ):
            removed = await _prune_organization_subscriptions(consumer, {_WS_B})
        # _WS_B 资源的 B 类 topic 必须被退订
        self.assertIn("agent.stream.chat-session-on-wsB", removed)
        self.assertIn("table.events.table-in-wsB", removed)
        # _WS_A 资源的 B 类 topic 必须保留
        self.assertIn("agent.stream.chat-session-on-wsA", consumer.subscriptions)
        self.assertNotIn("agent.stream.chat-session-on-wsB", consumer.subscriptions)
        self.assertNotIn("table.events.table-in-wsB", consumer.subscriptions)

    async def test_b_class_with_none_resolution_preserved(self):
        """resolver 返回 None 的 topic（如 notifications.{uid}、phone.* 等用户/设备级）保留。"""
        subs = {
            "notifications.user-sync-test",
            "phone.call.fp-xyz",
            "agent.stream.chat-session-removed",
        }
        consumer = _make_consumer(organization_ids={_WS_A}, subscriptions=subs)
        fake_results = {
            "notifications.user-sync-test": None,
            "phone.call.fp-xyz": None,
            "agent.stream.chat-session-removed": _WS_B,
        }
        with patch(
            "apps.services.common.ws.handlers.auth.database_sync_to_async",
            side_effect=lambda fn: AsyncMock(side_effect=lambda *a, **kw: fake_results if fn.__name__ == "_resolve_b_class_organizations_sync" else fn(*a, **kw)),
        ):
            removed = await _prune_organization_subscriptions(consumer, {_WS_B})
        self.assertEqual(removed, ["agent.stream.chat-session-removed"])
        self.assertIn("notifications.user-sync-test", consumer.subscriptions)
        self.assertIn("phone.call.fp-xyz", consumer.subscriptions)


# -----------------------------------------------------------------------------
# sync_organization_membership 端到端
# -----------------------------------------------------------------------------


class SyncOrganizationMembershipTests(unittest.IsolatedAsyncioTestCase):

    def _mk_db_sync_passthrough(self, fake_fn=None, fake_resolve=None):
        """返回一个 side_effect 让 database_sync_to_async 原路径穿透，
        同时替换 _resolve_b_class_organizations_sync / _fetch_user_organization_ids 行为。"""
        def _side_effect(fn):
            name = getattr(fn, "__name__", "")
            if name == "_resolve_b_class_organizations_sync" and fake_resolve is not None:
                return AsyncMock(side_effect=lambda *a, **kw: fake_resolve)
            if fake_fn is not None and name == "_fetch_user_organization_ids_sync":
                return AsyncMock(side_effect=lambda *a, **kw: fake_fn)
            return AsyncMock(side_effect=lambda *a, **kw: fn(*a, **kw))
        return _side_effect

    async def test_add_and_remove_also_prunes_b_class(self):
        """{A,B} → {A,C}：leave organization.B + 退订 B 的 A 类 + **退订 B 的 B 类 resource topic**。

        这是 P0-NEW-1 修复的核心断言：此前错误地认为 B 类可以靠 leave organization
        group 自然切断，实测 publish_ws_event 走 topic.{topic} group，
        所以 B 类必须主动 leave。
        """
        consumer = _make_consumer(
            organization_ids={_WS_A, _WS_B},
            primary_id=_WS_A,
            subscriptions={
                f"extension.events.{_WS_A}",
                f"extension.events.{_WS_B}",
                "agent.stream.chat-session-threadA",  # 属 _WS_A，应保留
                "agent.stream.chat-session-threadB",  # 属 _WS_B，应退订
            },
        )
        fake_resolve = {
            "agent.stream.chat-session-threadA": _WS_A,
            "agent.stream.chat-session-threadB": _WS_B,
        }
        with patch(
            "apps.services.common.ws.handlers.auth._fetch_user_organization_ids",
            new_callable=AsyncMock, return_value={_WS_A, _WS_C},
        ), patch(
            "apps.services.common.ws.handlers.auth.database_sync_to_async",
            side_effect=self._mk_db_sync_passthrough(fake_resolve=fake_resolve),
        ):
            changed = await sync_organization_membership(consumer)

        self.assertTrue(changed)
        leave_calls = [c.args[0] for c in consumer._leave_group.call_args_list]
        join_calls = [c.args[0] for c in consumer._join_group.call_args_list]
        # organization 级 leave
        self.assertIn(f"organization.{_WS_B}", leave_calls)
        # organization 级 join
        self.assertIn(f"organization.{_WS_C}", join_calls)
        # A 类 topic group leave
        self.assertIn(f"topic.extension.events.{_WS_B}", leave_calls)
        # B 类 topic group leave —— **P0-NEW-1 核心**
        self.assertIn("topic.agent.stream.chat-session-threadB", leave_calls)
        # A 的 B 类 topic 必须保留
        self.assertNotIn("topic.agent.stream.chat-session-threadA", leave_calls)
        self.assertIn("agent.stream.chat-session-threadA", consumer.subscriptions)
        self.assertNotIn("agent.stream.chat-session-threadB", consumer.subscriptions)
        # ctx 原子更新
        self.assertEqual(consumer.organization_ctx.all_ids, frozenset({_WS_A, _WS_C}))
        # primary 保留（A 仍在）
        self.assertEqual(consumer.organization_ctx.primary_id, _WS_A)
        # membership_changed 事件含 pruned_topics
        env = consumer._send_envelope.call_args[0][0]
        self.assertEqual(env["type"], "organization.membership_changed")
        self.assertIn("agent.stream.chat-session-threadB", env["payload"]["pruned_topics"])
        self.assertIn(f"extension.events.{_WS_B}", env["payload"]["pruned_topics"])

    async def test_removed_from_all_closes_connection(self):
        consumer = _make_consumer(
            organization_ids={_WS_A, _WS_B},
            subscriptions={f"extension.events.{_WS_A}", f"extension.events.{_WS_B}"},
        )
        with patch(
            "apps.services.common.ws.handlers.auth._fetch_user_organization_ids",
            new_callable=AsyncMock, return_value=set(),
        ), patch(
            "apps.services.common.ws.handlers.auth.database_sync_to_async",
            side_effect=self._mk_db_sync_passthrough(fake_resolve={}),
        ):
            changed = await sync_organization_membership(consumer)

        self.assertTrue(changed)
        self.assertFalse(consumer.authed)
        self.assertIsNone(consumer.organization_ctx.primary_id)
        self.assertEqual(consumer.organization_ctx.all_ids, frozenset())
        consumer.close.assert_called_once_with(code=4003)
        env = consumer._send_envelope.call_args[0][0]
        self.assertEqual(env["payload"]["reason"], "removed_from_all_organizations")

    async def test_no_change_is_noop(self):
        consumer = _make_consumer(
            organization_ids={_WS_A},
            subscriptions={f"extension.events.{_WS_A}"},
        )
        with patch(
            "apps.services.common.ws.handlers.auth._fetch_user_organization_ids",
            new_callable=AsyncMock, return_value={_WS_A},
        ):
            changed = await sync_organization_membership(consumer)

        self.assertFalse(changed)
        consumer._join_group.assert_not_called()
        consumer._leave_group.assert_not_called()
        consumer._send_envelope.assert_not_called()

    async def test_daemon_role_skipped(self):
        consumer = _make_consumer(role="daemon", organization_ids={_WS_A})
        with patch(
            "apps.services.common.ws.handlers.auth._fetch_user_organization_ids",
            new_callable=AsyncMock, return_value={_WS_A, _WS_B},
        ) as fetch:
            changed = await sync_organization_membership(consumer)
        self.assertFalse(changed)
        fetch.assert_not_called()

    async def test_channel_role_skipped(self):
        consumer = _make_consumer(role="channel", organization_ids={_WS_A})
        with patch(
            "apps.services.common.ws.handlers.auth._fetch_user_organization_ids",
            new_callable=AsyncMock, return_value={_WS_A, _WS_B},
        ) as fetch:
            changed = await sync_organization_membership(consumer)
        self.assertFalse(changed)
        fetch.assert_not_called()

    async def test_db_error_preserves_ctx(self):
        consumer = _make_consumer(organization_ids={_WS_A, _WS_B})
        with patch(
            "apps.services.common.ws.handlers.auth._fetch_user_organization_ids",
            new_callable=AsyncMock, side_effect=_OrganizationMembershipFetchError("db down"),
        ):
            changed = await sync_organization_membership(consumer)
        self.assertFalse(changed)
        self.assertEqual(consumer.organization_ctx.all_ids, frozenset({_WS_A, _WS_B}))
        consumer._leave_group.assert_not_called()
        consumer._join_group.assert_not_called()
        consumer._send_envelope.assert_not_called()

    async def test_primary_uses_initial_hint_when_old_removed(self):
        """旧 primary 被移除 + initial hint 命中 → 用 hint 而非 min(new_all)。"""
        consumer = _make_consumer(
            organization_ids={_WS_B}, primary_id=_WS_B, initial_hint=_WS_C,
        )
        with patch(
            "apps.services.common.ws.handlers.auth._fetch_user_organization_ids",
            new_callable=AsyncMock, return_value={_WS_A, _WS_C},
        ), patch(
            "apps.services.common.ws.handlers.auth.database_sync_to_async",
            side_effect=self._mk_db_sync_passthrough(fake_resolve={}),
        ):
            await sync_organization_membership(consumer)
        # 若走 min()，primary 会是 _WS_A；这里期望走 hint → _WS_C
        self.assertEqual(consumer.organization_ctx.primary_id, _WS_C)

    async def test_primary_none_when_no_hint_and_old_removed(self):
        consumer = _make_consumer(
            organization_ids={_WS_B}, primary_id=_WS_B, initial_hint=None,
        )
        with patch(
            "apps.services.common.ws.handlers.auth._fetch_user_organization_ids",
            new_callable=AsyncMock, return_value={_WS_A, _WS_C},
        ), patch(
            "apps.services.common.ws.handlers.auth.database_sync_to_async",
            side_effect=self._mk_db_sync_passthrough(fake_resolve={}),
        ):
            await sync_organization_membership(consumer)
        self.assertIsNone(consumer.organization_ctx.primary_id)

    async def test_lru_caches_are_cleared(self):
        """thread/resource LRU 在 membership 变化后必须清空，避免 stale 判断。"""
        consumer = _make_consumer(organization_ids={_WS_A, _WS_B})
        consumer._thread_organization_cache = OrderedDict()
        consumer._thread_organization_cache["stale-thread"] = (_WS_B, 9999999999.0)
        consumer._resource_organization_cache = OrderedDict()
        consumer._resource_organization_cache["stale-topic"] = (_WS_B, 9999999999.0)

        with patch(
            "apps.services.common.ws.handlers.auth._fetch_user_organization_ids",
            new_callable=AsyncMock, return_value={_WS_A, _WS_C},
        ), patch(
            "apps.services.common.ws.handlers.auth.database_sync_to_async",
            side_effect=self._mk_db_sync_passthrough(fake_resolve={}),
        ):
            await sync_organization_membership(consumer)

        self.assertEqual(len(consumer._thread_organization_cache), 0)
        self.assertEqual(len(consumer._resource_organization_cache), 0)
