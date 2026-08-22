"""
一次性业务验证脚本：构造 {A,B} → {B} 场景，验证 P0-NEW-1 修复。

模拟用户 U 先订阅 agent.stream.threadA（属 organization A）和 agent.stream.threadB（属 organization B），
然后通过 sync_organization_membership 模拟被移出 A；
断言：
  1. organization.A 从 joined_groups 移除
  2. topic.agent.stream.threadA 从 joined_groups 移除（B 类 topic 被主动退订）
  3. subscriptions 中不包含 agent.stream.threadA
  4. topic.agent.stream.threadB 仍在 joined_groups（保留）
  5. subscriptions 中仍包含 agent.stream.threadB

Usage:
    cd apps/tabtin_django && source venv/bin/activate
    DJANGO_SETTINGS_MODULE=tabtin.settings python scripts/verify_membership_b_class_prune.py
"""
from __future__ import annotations

import asyncio
import os
import pathlib
import sys
from unittest.mock import AsyncMock, MagicMock, patch

_REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django

django.setup()

from apps.services.common.ws.handlers.auth import sync_organization_membership
from apps.services.common.ws.organization_context import OrganizationContext

_WS_A = "00000000-0000-0000-0000-00000000000a"
_WS_B = "00000000-0000-0000-0000-00000000000b"


def _make_consumer_with_real_groups():
    """构造一个 consumer，joined_groups 是真实 set，_leave_group/_join_group 会真正改动它。"""
    consumer = MagicMock()
    consumer.role = "electron"
    consumer.user_id = "verify-user"
    consumer.user = MagicMock(id="verify-user")
    consumer.authed = True
    consumer.organization_ctx = OrganizationContext(_WS_A, {_WS_A, _WS_B})
    consumer._initial_organization_hint = _WS_A
    consumer.subscriptions = {
        "agent.stream.chat-session-threadA",
        "agent.stream.chat-session-threadB",
    }
    consumer.joined_groups = {
        f"organization.{_WS_A}",
        f"organization.{_WS_B}",
        "topic.agent.stream.chat-session-threadA",
        "topic.agent.stream.chat-session-threadB",
    }
    consumer._send_envelope = AsyncMock()
    consumer._send_error = AsyncMock()
    consumer.close = AsyncMock()

    async def _fake_leave(group: str) -> None:
        consumer.joined_groups.discard(group)

    async def _fake_join(group: str) -> None:
        consumer.joined_groups.add(group)

    consumer._leave_group = AsyncMock(side_effect=_fake_leave)
    consumer._join_group = AsyncMock(side_effect=_fake_join)
    consumer._membership_lock = None
    return consumer


async def main() -> int:
    consumer = _make_consumer_with_real_groups()

    # 模拟 resolver：threadA 属 A，threadB 属 B
    fake_resolve = {
        "agent.stream.chat-session-threadA": _WS_A,
        "agent.stream.chat-session-threadB": _WS_B,
    }

    def _db_sync_passthrough(fn):
        async def _wrapper(*args, **kwargs):
            if fn.__name__ == "_resolve_b_class_organizations_sync":
                return fake_resolve
            return fn(*args, **kwargs)
        return _wrapper

    with patch(
        "apps.services.common.ws.handlers.auth._fetch_user_organization_ids",
        new_callable=AsyncMock, return_value={_WS_B},
    ), patch(
        "apps.services.common.ws.handlers.auth.database_sync_to_async",
        side_effect=_db_sync_passthrough,
    ):
        changed = await sync_organization_membership(consumer)

    print(f"changed={changed}")
    print(f"joined_groups={sorted(consumer.joined_groups)}")
    print(f"subscriptions={sorted(consumer.subscriptions)}")
    print(
        "leave_calls={}".format(
            sorted([c.args[0] for c in consumer._leave_group.call_args_list]),
        ),
    )

    # 断言
    problems: list[str] = []
    if f"organization.{_WS_A}" in consumer.joined_groups:
        problems.append(f"❌ organization.{_WS_A} 应从 joined_groups 移除")
    if "topic.agent.stream.chat-session-threadA" in consumer.joined_groups:
        problems.append("❌ P0-NEW-1 核心回归：B 类 topic agent.stream.threadA 未 leave group")
    if "agent.stream.chat-session-threadA" in consumer.subscriptions:
        problems.append("❌ subscriptions 中仍保留 agent.stream.threadA")
    if "topic.agent.stream.chat-session-threadB" not in consumer.joined_groups:
        problems.append("❌ agent.stream.threadB 误被 leave")
    if "agent.stream.chat-session-threadB" not in consumer.subscriptions:
        problems.append("❌ subscriptions 中误移除 agent.stream.threadB")
    if consumer.organization_ctx.all_ids != frozenset({_WS_B}):
        problems.append(f"❌ organization_ctx 未正确更新: got {set(consumer.organization_ctx.all_ids)}")

    if problems:
        print("\n=== FAILED ===")
        for p in problems:
            print(p)
        return 1

    print("\n=== PASS ===")
    print("✅ organization.A group left")
    print("✅ topic.agent.stream.threadA group left (B 类主动退订)")
    print("✅ topic.agent.stream.threadB group retained")
    print("✅ subscriptions: threadA removed, threadB retained")
    print(f"✅ organization_ctx.all_ids == {{_WS_B}} ({consumer.organization_ctx.all_ids})")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
