"""ACL 缓存失效 signal handler 单测（Wave 2）。"""

from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

import apps.fts.tests.conftest  # noqa: F401


class HelperResolveTests(unittest.TestCase):
    def test_resolve_organization_id_from_space_none(self):
        from apps.fts.signals import _resolve_organization_id_from_space
        self.assertIsNone(_resolve_organization_id_from_space(None))

    def test_resolve_organization_id_returns_str(self):
        from apps.fts.signals import _resolve_organization_id_from_space
        with patch("apps.services.billing.organization_resolver.resolve_organization_id_from_space", return_value="wt-9"):
            self.assertEqual(_resolve_organization_id_from_space("sp-1"), "wt-9")


class MembershipChangeTests(unittest.TestCase):
    def test_user_membership_invalidates_user_acl(self):
        from apps.fts.signals import on_space_membership_changed
        instance = MagicMock(space_id="sp-1", user_id="u-1", agent_id=None)
        with patch("apps.fts.signals._resolve_organization_id_from_membership", return_value="wt-1"), \
             patch("apps.fts.signals._safe_invalidate_user") as m_inv:
            on_space_membership_changed(MagicMock(), instance)
        m_inv.assert_any_call("u-1", "wt-1")

    def test_agent_membership_invalidates_owning_user(self):
        from apps.fts.signals import on_space_membership_changed
        instance = MagicMock(space_id="sp-1", user_id=None, agent_id="ag-1")
        with patch("apps.fts.signals._resolve_organization_id_from_membership", return_value="wt-1"), \
             patch("apps.fts.signals._safe_invalidate_user") as m_inv, \
             patch("apps.tabtinspace.models.Agent.objects") as m_agent:
            m_agent.using.return_value.filter.return_value.values.return_value.first.return_value = {
                "user_id": "u-99",
            }
            on_space_membership_changed(MagicMock(), instance)
        m_inv.assert_called_with("u-99", "wt-1")

    def test_no_organization_short_circuits(self):
        from apps.fts.signals import on_space_membership_changed
        instance = MagicMock(space_id="sp-1", user_id="u-1", agent_id=None)
        with patch("apps.fts.signals._resolve_organization_id_from_membership", return_value=None), \
             patch("apps.fts.signals._safe_invalidate_user") as m_inv:
            on_space_membership_changed(MagicMock(), instance)
        m_inv.assert_not_called()


class MembershipFastResolveTests(unittest.TestCase):
    """新增：验证 _resolve_organization_id_from_membership 优先用 instance.workspace。"""

    def test_uses_instance_workspace_when_present(self):
        from apps.fts.signals import _resolve_organization_id_from_membership
        # 模拟 SpaceMembership.workspace 已被 select_related 加载
        instance = MagicMock(workspace_id="sp-1")
        instance.workspace = MagicMock(organization_id="wt-fast")
        with patch("apps.fts.signals._resolve_organization_id_from_space") as m_pg:
            wt = _resolve_organization_id_from_membership(instance)
        self.assertEqual(wt, "wt-fast")
        m_pg.assert_not_called()

    def test_falls_back_to_pg_when_no_workspace(self):
        from apps.fts.signals import _resolve_organization_id_from_membership
        instance = MagicMock(workspace_id="sp-1")
        instance.workspace = None
        with patch("apps.fts.signals._resolve_organization_id_from_space",
                   return_value="wt-from-pg") as m_pg:
            wt = _resolve_organization_id_from_membership(instance)
        self.assertEqual(wt, "wt-from-pg")
        m_pg.assert_called_once_with("sp-1")


class AgentChangeAclInvalidationTests(unittest.TestCase):
    """Wave 2 Review 修复（技术 HIGH 1）：Agent 变更失效 ACL 缓存。"""

    def test_agent_save_invalidates_owner_user_acl(self):
        from apps.fts.signals import on_agent_saved
        instance = MagicMock(id="ag-1", user_id="u-1", organization_id="wt-1")
        with patch("apps.fts.signals.is_engine_enabled", return_value=True), \
             patch("apps.fts.signals._safe_write_outbox"), \
             patch("apps.fts.signals._schedule_flush"), \
             patch("apps.fts.signals._safe_invalidate_user") as m_inv, \
             patch("apps.fts.signals.sync_service.should_index_agent", return_value=True):
            on_agent_saved(MagicMock(), instance, created=False)
        m_inv.assert_called_once_with("u-1", "wt-1")

    def test_agent_delete_invalidates_owner_user_acl(self):
        from apps.fts.signals import on_agent_deleted
        instance = MagicMock(id="ag-1", user_id="u-1", organization_id="wt-1")
        with patch("apps.fts.signals.is_engine_enabled", return_value=True), \
             patch("apps.fts.signals._safe_write_outbox"), \
             patch("apps.fts.signals._schedule_flush"), \
             patch("apps.fts.signals._safe_invalidate_user") as m_inv:
            on_agent_deleted(MagicMock(), instance)
        m_inv.assert_called_once_with("u-1", "wt-1")

    def test_agent_no_user_no_invalidate(self):
        from apps.fts.signals import on_agent_saved
        instance = MagicMock(id="ag-1", user_id=None, organization_id="wt-1")
        with patch("apps.fts.signals.is_engine_enabled", return_value=True), \
             patch("apps.fts.signals._safe_write_outbox"), \
             patch("apps.fts.signals._schedule_flush"), \
             patch("apps.fts.signals._safe_invalidate_user") as m_inv, \
             patch("apps.fts.signals.sync_service.should_index_agent", return_value=True):
            on_agent_saved(MagicMock(), instance, created=False)
        m_inv.assert_not_called()


class SafeInvalidateTests(unittest.TestCase):
    def test_invalidate_user_calls_through(self):
        from apps.fts.signals import _safe_invalidate_user
        with patch("apps.fts.services.acl_service.invalidate_user_acl") as m:
            _safe_invalidate_user("u1", "wt1")
        m.assert_called_once_with("u1", "wt1")

    def test_invalidate_user_swallow_exception(self):
        from apps.fts.signals import _safe_invalidate_user
        with patch("apps.fts.services.acl_service.invalidate_user_acl",
                   side_effect=RuntimeError("boom")):
            _safe_invalidate_user("u1", "wt1")  # 不抛

    def test_invalidate_empty_skips(self):
        from apps.fts.signals import _safe_invalidate_user
        with patch("apps.fts.services.acl_service.invalidate_user_acl") as m:
            _safe_invalidate_user(None, "wt1")
            _safe_invalidate_user("u1", None)
        m.assert_not_called()


class SignalsRegistrationTests(unittest.TestCase):
    """ACL 失效 signals 登记完整。"""

    def test_signals_attached_to_membership(self):
        from django.db.models.signals import post_save, post_delete
        # Django dispatch_uid 存在 receivers 元组的第一元素 (lookup_key)
        # lookup_key 形如 (id(receiver), id(sender_class)) 时无 uid，
        # 用 dispatch_uid 时为 (uid_str, id(sender_class))
        all_save_uids = {r[0][0] for r in post_save.receivers if isinstance(r[0][0], str)}
        all_del_uids = {r[0][0] for r in post_delete.receivers if isinstance(r[0][0], str)}
        self.assertIn("fts_acl_membership_saved", all_save_uids)
        self.assertIn("fts_acl_membership_deleted", all_del_uids)


if __name__ == "__main__":
    unittest.main()
