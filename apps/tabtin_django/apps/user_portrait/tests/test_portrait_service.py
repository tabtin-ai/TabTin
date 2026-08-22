"""
M2 单测 · UserPortraitService（/#4118 画像 per-Agent 化）

覆盖：
  - get_or_create_portrait: 首次创建 + 重复获取 + 不同 Organization / Agent 独立
  - get_portrait: 不存在返回 None
  - add_hint: 正常 + 空字符串拒 + 超长拒 + 队列容量按时间最旧丢弃
  - clear_pending_hints: 清空成功
  - mark_distill_pending: 首次 + 已 pending 时抛 DISTILL_IN_PROGRESS
  - commit_distill_result: content_md 更新 + version+1 + last_distilled_at + Snapshot 归档
  - commit_distill_result: 蒸馏成功后 pending_hints 清空
  - mark_distill_failed: 错误信息保存 + 旧 content_md 完整保留
  - 跨用户隔离: 用户 A 的 portrait 不影响用户 B
  - 【关键】跨 Organization 隔离: 同一用户在 Organization A / Organization B 的画像完全独立
  - 【关键 /#4118】跨 Agent 隔离: 同一 (user, organization) 下不同 Agent 画像完全独立
  - 【关键 /#4118】缺失 / 非法 agent_id → INVALID_AGENT_ID（fail-closed）
  - 【关键】级联清理: delete_portraits_for_organization / delete_portrait_for_member /
    delete_portraits_for_agent
  - organization_id 非法格式校验
"""

from __future__ import annotations

import uuid

from django.apps import apps as django_apps
from django.test import TestCase

from apps.user_portrait.constants import USER_PORTRAIT_DB
from apps.user_portrait.models import UserPortrait, UserPortraitSnapshot
from apps.user_portrait.services.portrait_service import UserPortraitService
from apps.user_portrait.error_codes import ErrorCode, ServiceError
from apps.users.auth.models import User


def _fake_tabtinspace_loaded() -> bool:
    """检测是否装载了 fake tabtinspace（仅集成 settings 下成立）。"""
    return django_apps.is_installed("apps.user_portrait.tests._fake_tabtinspace")


class UserPortraitServiceTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.alice = User.objects.create_user(
            email="alice@portrait.test",
            password="StrongPass123!",
        )
        self.bob = User.objects.create_user(
            email="bob@portrait.test",
            password="StrongPass123!",
        )
        # v0.2：每个测试用例都需要明确 organization_id
        self.organization_a = str(uuid.uuid4())
        self.organization_b = str(uuid.uuid4())
        # /#4118：画像按 Agent 完全隔离——每个用例需要明确 agent_id
        self.agent_a = str(uuid.uuid4())
        self.agent_b = str(uuid.uuid4())
        self.svc_alice = UserPortraitService(user=self.alice)
        self.svc_bob = UserPortraitService(user=self.bob)
        # membership 校验在 tabtinspace 装载时会真查 Organization/OrganizationMember。
        # fake_tabtinspace（集成 settings）与真实 tabtinspace（默认 PG 测试）都要预建。
        if _fake_tabtinspace_loaded():
            self._provision_fake_organizations()
        else:
            self._provision_real_organizations()

    def _provision_fake_organizations(self):
        from apps.user_portrait.tests._fake_tabtinspace.models import (
            Organization,
            OrganizationMember,
        )

        for wid in (self.organization_a, self.organization_b):
            Organization.objects.create(
                id=wid,
                name=f"WT-{wid[:8]}",
                owner_id=self.alice.id,
            )
            OrganizationMember.objects.create(
                organization_id=wid,
                user_id=self.bob.id,
                role="editor",
            )

    def _provision_real_organizations(self):
        from apps.tabtinspace.models import Organization, OrganizationMember

        for wid in (self.organization_a, self.organization_b):
            Organization.objects.create(
                id=wid,
                name=f"WT-{str(wid)[:8]}",
                owner=self.alice,
            )
            OrganizationMember.objects.create(
                organization_id=wid,
                user_id=self.bob.id,
                role="editor",
            )

    # ── get_or_create_portrait ───────────────────────────

    def test_get_or_create_portrait_first_time_creates_empty(self):
        portrait = self.svc_alice.get_or_create_portrait(self.organization_a, self.agent_a)
        self.assertIsNotNone(portrait)
        self.assertEqual(portrait.content_md, "")
        self.assertEqual(portrait.version, 0)
        self.assertEqual(str(portrait.organization_id), self.organization_a)
        self.assertEqual(str(portrait.agent_id), self.agent_a)
        self.assertEqual(
            portrait.last_distill_status,
            UserPortrait.DistillStatus.IDLE,
        )
        self.assertEqual(portrait.pending_hints, [])

    def test_get_or_create_portrait_idempotent(self):
        p1 = self.svc_alice.get_or_create_portrait(self.organization_a, self.agent_a)
        p2 = self.svc_alice.get_or_create_portrait(self.organization_a, self.agent_a)
        self.assertEqual(p1.id, p2.id)

    def test_get_portrait_returns_none_when_not_exists(self):
        # bob 还没创建过
        self.assertIsNone(self.svc_bob.get_portrait(self.organization_a, self.agent_a))

    def test_invalid_organization_id_rejected(self):
        with self.assertRaises(ServiceError) as ctx:
            self.svc_alice.get_or_create_portrait("not-a-uuid", self.agent_a)
        self.assertEqual(ctx.exception.code, ErrorCode.INVALID_ORGANIZATION_ID)

    def test_missing_agent_id_rejected(self):
        """#4090/#4118：缺失 agent_id → INVALID_AGENT_ID（fail-closed，不落无主画像）。"""
        with self.assertRaises(ServiceError) as ctx:
            self.svc_alice.get_or_create_portrait(self.organization_a, "")
        self.assertEqual(ctx.exception.code, ErrorCode.INVALID_AGENT_ID)

    def test_invalid_agent_id_rejected(self):
        with self.assertRaises(ServiceError) as ctx:
            self.svc_alice.get_or_create_portrait(self.organization_a, "not-a-uuid")
        self.assertEqual(ctx.exception.code, ErrorCode.INVALID_AGENT_ID)

    # ── add_hint ─────────────────────────────────────────

    def test_add_hint_normal(self):
        portrait = self.svc_alice.add_hint(
            self.organization_a, self.agent_a, text="我已经把狗送人了"
        )
        self.assertEqual(len(portrait.pending_hints), 1)
        self.assertEqual(portrait.pending_hints[0]["text"], "我已经把狗送人了")
        self.assertIn("submitted_at", portrait.pending_hints[0])

    def test_add_hint_empty_rejected(self):
        with self.assertRaises(ServiceError) as ctx:
            self.svc_alice.add_hint(self.organization_a, self.agent_a, text="   ")
        self.assertEqual(ctx.exception.code, ErrorCode.INVALID_HINT)

    def test_add_hint_too_long_rejected(self):
        with self.assertRaises(ServiceError) as ctx:
            self.svc_alice.add_hint(self.organization_a, self.agent_a, text="a" * 3000)
        self.assertEqual(ctx.exception.code, ErrorCode.INVALID_HINT)

    def test_add_hint_capacity_drops_oldest(self):
        from apps.user_portrait.constants import MAX_PENDING_HINTS

        for i in range(MAX_PENDING_HINTS + 5):
            self.svc_alice.add_hint(self.organization_a, self.agent_a, text=f"hint #{i}")
        portrait = self.svc_alice.get_portrait(self.organization_a, self.agent_a)
        self.assertEqual(len(portrait.pending_hints), MAX_PENDING_HINTS)
        last = portrait.pending_hints[-1]
        self.assertEqual(last["text"], f"hint #{MAX_PENDING_HINTS + 4}")

    def test_clear_pending_hints(self):
        self.svc_alice.add_hint(self.organization_a, self.agent_a, text="a")
        self.svc_alice.add_hint(self.organization_a, self.agent_a, text="b")
        portrait = self.svc_alice.clear_pending_hints(self.organization_a, self.agent_a)
        self.assertEqual(portrait.pending_hints, [])

    # ── 蒸馏状态机 ───────────────────────────────────────

    def test_mark_distill_pending_first_time(self):
        portrait = self.svc_alice.mark_distill_pending(self.organization_a, self.agent_a)
        self.assertEqual(
            portrait.last_distill_status,
            UserPortrait.DistillStatus.PENDING,
        )

    def test_mark_distill_pending_when_already_pending_raises(self):
        self.svc_alice.mark_distill_pending(self.organization_a, self.agent_a)
        with self.assertRaises(ServiceError) as ctx:
            self.svc_alice.mark_distill_pending(self.organization_a, self.agent_a)
        self.assertEqual(ctx.exception.code, ErrorCode.DISTILL_IN_PROGRESS)

    def test_commit_distill_result_creates_snapshot_and_increments_version(self):
        # 先有个旧版本（含 hint）
        self.svc_alice.add_hint(self.organization_a, self.agent_a, text="some hint")
        old_portrait = self.svc_alice.get_or_create_portrait(self.organization_a, self.agent_a)
        old_portrait.content_md = "## old content"
        old_portrait.version = 1
        old_portrait.save(using=USER_PORTRAIT_DB)

        new_md = "## 工作背景\n新的画像内容\n"
        result = self.svc_alice.commit_distill_result(
            organization_id=self.organization_a,
            agent_id=self.agent_a,
            new_content_md=new_md,
            trigger_reason="manual",
            input_summary={"memo_count": 5, "hint_count": 1},
        )

        # 主体更新
        self.assertEqual(result.content_md, new_md)
        self.assertEqual(result.version, 2)
        self.assertIsNotNone(result.last_distilled_at)
        self.assertEqual(
            result.last_distill_status,
            UserPortrait.DistillStatus.IDLE,
        )
        self.assertEqual(result.pending_hints, [])

        # 旧版本归档为 Snapshot
        snapshots = list(
            UserPortraitSnapshot.objects.using(USER_PORTRAIT_DB).filter(
                portrait_id=result.id,
            )
        )
        self.assertEqual(len(snapshots), 1)
        self.assertEqual(snapshots[0].content_md, "## old content")
        self.assertEqual(snapshots[0].version_at_snapshot, 1)
        self.assertEqual(snapshots[0].trigger_reason, "manual")

    def test_mark_distill_failed_preserves_old_content(self):
        portrait = self.svc_alice.get_or_create_portrait(self.organization_a, self.agent_a)
        portrait.content_md = "## 旧内容"
        portrait.version = 3
        portrait.save(using=USER_PORTRAIT_DB)
        self.svc_alice.add_hint(self.organization_a, self.agent_a, text="hint that should survive")

        result = self.svc_alice.mark_distill_failed(
            self.organization_a, self.agent_a, error="模型超时"
        )

        self.assertEqual(result.content_md, "## 旧内容")
        self.assertEqual(result.version, 3)
        self.assertEqual(
            result.last_distill_status,
            UserPortrait.DistillStatus.FAILED,
        )
        self.assertEqual(result.last_distill_error, "模型超时")
        # 失败必须保留 hint
        self.assertEqual(len(result.pending_hints), 1)

    def test_mark_distill_failed_error_message_truncated(self):
        long_err = "x" * 5000
        result = self.svc_alice.mark_distill_failed(
            self.organization_a, self.agent_a, error=long_err
        )
        self.assertLessEqual(len(result.last_distill_error), 2000)

    # ── 跨用户隔离（v0.1 已有，v0.2 仍然成立） ──────

    def test_users_isolated(self):
        self.svc_alice.add_hint(self.organization_a, self.agent_a, text="alice's hint")
        # bob 的 portrait 不受影响
        bob_portrait = self.svc_bob.get_or_create_portrait(self.organization_a, self.agent_a)
        self.assertEqual(bob_portrait.pending_hints, [])

        alice_portrait = self.svc_alice.get_portrait(self.organization_a, self.agent_a)
        self.assertEqual(len(alice_portrait.pending_hints), 1)
        self.assertNotEqual(alice_portrait.id, bob_portrait.id)

    # ── 【v0.2 关键】跨 Organization 隔离 ─────────────────

    def test_cross_organization_portraits_are_independent(self):
        """关键安全测试：同一用户在不同 Organization 的画像完全独立。"""
        # alice 在 organization_a 创建画像 + 加 hint
        self.svc_alice.add_hint(self.organization_a, self.agent_a, text="hint for organization A")
        alice_a = self.svc_alice.get_portrait(self.organization_a, self.agent_a)

        # alice 在 organization_b 创建画像 + 加不同 hint
        self.svc_alice.add_hint(self.organization_b, self.agent_a, text="hint for organization B")
        alice_b = self.svc_alice.get_portrait(self.organization_b, self.agent_a)

        # 两份画像完全独立
        self.assertNotEqual(alice_a.id, alice_b.id)
        self.assertEqual(alice_a.pending_hints[0]["text"], "hint for organization A")
        self.assertEqual(alice_b.pending_hints[0]["text"], "hint for organization B")

    def test_cross_organization_distill_isolated(self):
        """关键安全测试：在 organization_a 蒸馏不影响 organization_b 的画像。"""
        self.svc_alice.commit_distill_result(
            organization_id=self.organization_a,
            agent_id=self.agent_a,
            new_content_md="## 工作背景\n这是 Organization A 的内容",
            trigger_reason="manual",
        )
        # organization_b 的画像还是空的
        portrait_b = self.svc_alice.get_or_create_portrait(self.organization_b, self.agent_a)
        self.assertEqual(portrait_b.content_md, "")
        self.assertEqual(portrait_b.version, 0)

        # organization_a 的画像已更新
        portrait_a = self.svc_alice.get_portrait(self.organization_a, self.agent_a)
        self.assertIn("Organization A", portrait_a.content_md)
        self.assertEqual(portrait_a.version, 1)

    def test_cross_organization_distill_status_isolated(self):
        """关键：organization_a 的状态机变化不影响 organization_b。"""
        self.svc_alice.mark_distill_pending(self.organization_a, self.agent_a)
        # organization_b 还是 idle
        portrait_b = self.svc_alice.get_or_create_portrait(self.organization_b, self.agent_a)
        self.assertEqual(
            portrait_b.last_distill_status,
            UserPortrait.DistillStatus.IDLE,
        )
        # organization_b 仍可正常 mark pending（不被 a 的 pending 阻塞）
        self.svc_alice.mark_distill_pending(self.organization_b, self.agent_a)

    # ── 【#4090/#4118 关键】跨 Agent 隔离 ───────────────────

    def test_cross_agent_portraits_are_independent(self):
        """#4090/#4118：同一 (user, organization) 下不同 Agent 的画像完全独立、互不串台。"""
        self.svc_alice.add_hint(self.organization_a, self.agent_a, text="hint for agent A")
        alice_a = self.svc_alice.get_portrait(self.organization_a, self.agent_a)

        self.svc_alice.add_hint(self.organization_a, self.agent_b, text="hint for agent B")
        alice_b = self.svc_alice.get_portrait(self.organization_a, self.agent_b)

        self.assertNotEqual(alice_a.id, alice_b.id)
        self.assertEqual(alice_a.pending_hints[0]["text"], "hint for agent A")
        self.assertEqual(alice_b.pending_hints[0]["text"], "hint for agent B")

    def test_cross_agent_distill_isolated(self):
        """#4090/#4118：Agent A 蒸馏出的画像绝不写进 Agent B 的画像。"""
        self.svc_alice.commit_distill_result(
            organization_id=self.organization_a,
            agent_id=self.agent_a,
            new_content_md="## 工作背景\nAgent A 视角的用户画像",
            trigger_reason="manual",
        )
        # Agent B 画像仍为空
        portrait_b = self.svc_alice.get_or_create_portrait(self.organization_a, self.agent_b)
        self.assertEqual(portrait_b.content_md, "")
        self.assertEqual(portrait_b.version, 0)
        # Agent A 画像已更新
        portrait_a = self.svc_alice.get_portrait(self.organization_a, self.agent_a)
        self.assertIn("Agent A", portrait_a.content_md)

    def test_cross_agent_distill_status_isolated(self):
        """#4090/#4118：Agent A 蒸馏中（pending）不阻塞 Agent B 蒸馏。"""
        self.svc_alice.mark_distill_pending(self.organization_a, self.agent_a)
        # Agent B 仍可正常 mark pending（不被 A 的 pending 阻塞）
        portrait_b = self.svc_alice.mark_distill_pending(self.organization_a, self.agent_b)
        self.assertEqual(
            portrait_b.last_distill_status, UserPortrait.DistillStatus.PENDING
        )

    # ── 【v0.2 关键】级联清理 ───────────────────────

    def test_delete_portraits_for_organization_clears_all_users(self):
        """决策 N3：Organization 删除时清理所有成员的画像（跨 Agent）。"""
        self.svc_alice.add_hint(self.organization_a, self.agent_a, text="alice in A")
        self.svc_bob.add_hint(self.organization_a, self.agent_a, text="bob in A")
        self.svc_alice.add_hint(self.organization_b, self.agent_a, text="alice in B")  # 不应被影响

        count = UserPortraitService.delete_portraits_for_organization(self.organization_a)
        self.assertEqual(count, 2)  # alice + bob 在 organization_a 的画像被清

        # organization_a 的画像都没了
        self.assertIsNone(self.svc_alice.get_portrait(self.organization_a, self.agent_a))
        self.assertIsNone(self.svc_bob.get_portrait(self.organization_a, self.agent_a))
        # organization_b 的画像不受影响
        self.assertIsNotNone(self.svc_alice.get_portrait(self.organization_b, self.agent_a))

    def test_delete_portrait_for_member_only_affects_that_pair(self):
        """决策 N4：成员退出 Organization 时只清理该成员在该 Organization 的画像（跨 Agent）。"""
        self.svc_alice.add_hint(self.organization_a, self.agent_a, text="alice in A")
        self.svc_alice.add_hint(self.organization_b, self.agent_a, text="alice in B")  # 不应被影响
        self.svc_bob.add_hint(self.organization_a, self.agent_a, text="bob in A")  # 不应被影响

        deleted = UserPortraitService.delete_portrait_for_member(
            user_id=str(self.alice.id),
            organization_id=self.organization_a,
        )
        self.assertTrue(deleted)

        self.assertIsNone(self.svc_alice.get_portrait(self.organization_a, self.agent_a))
        # alice 在 organization_b 不受影响
        self.assertIsNotNone(self.svc_alice.get_portrait(self.organization_b, self.agent_a))
        # bob 在 organization_a 不受影响
        self.assertIsNotNone(self.svc_bob.get_portrait(self.organization_a, self.agent_a))

    def test_delete_portrait_for_member_clears_all_agents(self):
        """#4090/#4118：成员退出清理其名下**全部** per-Agent 画像（不漏掉任何 Agent）。"""
        self.svc_alice.add_hint(self.organization_a, self.agent_a, text="alice A/agent-a")
        self.svc_alice.add_hint(self.organization_a, self.agent_b, text="alice A/agent-b")

        deleted = UserPortraitService.delete_portrait_for_member(
            user_id=str(self.alice.id),
            organization_id=self.organization_a,
        )
        self.assertTrue(deleted)
        self.assertIsNone(self.svc_alice.get_portrait(self.organization_a, self.agent_a))
        self.assertIsNone(self.svc_alice.get_portrait(self.organization_a, self.agent_b))

    def test_delete_portraits_for_agent_only_affects_that_agent(self):
        """#4090/#4118：Agent 删除清理该 Agent 全部画像（所有 subject），不动其它 Agent。"""
        self.svc_alice.add_hint(self.organization_a, self.agent_a, text="alice/agent-a")
        self.svc_bob.add_hint(self.organization_a, self.agent_a, text="bob/agent-a")
        self.svc_alice.add_hint(self.organization_a, self.agent_b, text="alice/agent-b")

        count = UserPortraitService.delete_portraits_for_agent(self.agent_a)
        self.assertEqual(count, 2)  # alice + bob 在 agent_a 的画像被清

        self.assertIsNone(self.svc_alice.get_portrait(self.organization_a, self.agent_a))
        self.assertIsNone(self.svc_bob.get_portrait(self.organization_a, self.agent_a))
        # agent_b 的画像不受影响
        self.assertIsNotNone(self.svc_alice.get_portrait(self.organization_a, self.agent_b))

    def test_delete_portrait_for_member_returns_false_when_no_portrait(self):
        """从未蒸馏过的成员退出，不应该报错。"""
        deleted = UserPortraitService.delete_portrait_for_member(
            user_id=str(self.bob.id),
            organization_id=str(uuid.uuid4()),
        )
        self.assertFalse(deleted)
