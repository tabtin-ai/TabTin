"""设置 IA Phase 3 §8.6 分层规则 forward 投递单测（dispatcher / forward_runner 注入）。

覆盖：
- ``PromptForwardService.resolve_layered_rules_for_forward``：**owner 身份取法**
  （per-owner via ``Organization.owner_id``，照 userPortrait 现状、**非当前说话人**）+
  跨库读 personal_rules（owner ``UserProfile``）+ 空白归一 + 读失败不阻塞。
- ``forward_prompt`` payload：personal_rules **非空才写**（向后兼容）。

（2026-06：原团队基线层 team_rules（``Organization.agent_rules``）已下线——团队不再对
Agent 设统一 prompt 基线，岗位差异化交给 skill 系统。分层规则降为个人 + Agent 两层。）

dispatcher / forward_runner 两条路径都通过 ``resolve_layered_rules_for_forward``
取值后透传 ``forward_prompt``——本文件锁定 helper 取值正确 + payload 写入语义。

跑法：
    python -m pytest apps/services/agent_engine/tests/test_layered_rules_forward.py -v
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.services.agent_engine.services.prompt_forward_service import (
    PromptForwardService,
)


def _fake_space(*, owner_id="owner-uid"):
    organization = SimpleNamespace(owner_id=owner_id)
    return SimpleNamespace(organization=organization)


def _patch_profile(personal_value):
    """patch ``UserProfile.objects.filter(...).values_list(...).first()`` 链。

    返回 (patch_ctx, objects_mock)；objects_mock 用于断言 filter 入参（owner 身份）。
    """
    objects = MagicMock()
    objects.filter.return_value.values_list.return_value.first.return_value = personal_value
    fake_model = SimpleNamespace(objects=objects)
    return patch("apps.users.auth.models.UserProfile", fake_model), objects


class ResolveLayeredRulesTests(SimpleTestCase):
    def test_reads_personal_per_owner(self):
        """个人取 owner UserProfile.personal_rules（per-owner，非当前说话人）。"""
        space = _fake_space(owner_id="owner-123")
        ctx, objects = _patch_profile("请用中文")
        with ctx:
            out = PromptForwardService.resolve_layered_rules_for_forward(space)
        self.assertEqual(out["personal_rules"], "请用中文")
        # 团队基线层已下线：返回里不再有 team_rules key。
        self.assertNotIn("team_rules", out)
        # owner 身份取法（关键）：用 Organization.owner_id 查 UserProfile —— per-owner，
        # 不是当前说话人（与 userPortrait 现状对齐）。
        objects.filter.assert_called_once_with(user_id="owner-123")

    def test_none_when_owner_has_no_personal(self):
        space = _fake_space(owner_id="owner-123")
        ctx, _ = _patch_profile(None)
        with ctx:
            out = PromptForwardService.resolve_layered_rules_for_forward(space)
        self.assertIsNone(out["personal_rules"])

    def test_blank_personal_normalized_to_none(self):
        space = _fake_space(owner_id="owner-123")
        ctx, _ = _patch_profile("  \n ")
        with ctx:
            out = PromptForwardService.resolve_layered_rules_for_forward(space)
        self.assertIsNone(out["personal_rules"])

    def test_no_organization_returns_none(self):
        space = SimpleNamespace(organization=None)
        out = PromptForwardService.resolve_layered_rules_for_forward(space)
        self.assertIsNone(out["personal_rules"])

    def test_no_owner_id_skips_personal(self):
        space = _fake_space(owner_id=None)
        out = PromptForwardService.resolve_layered_rules_for_forward(space)
        self.assertIsNone(out["personal_rules"])

    def test_profile_read_failure_non_fatal(self):
        """owner profile 读失败（跨库异常）→ personal None，不抛。"""
        space = _fake_space(owner_id="owner-123")
        broken = SimpleNamespace(objects=MagicMock())
        broken.objects.filter.side_effect = RuntimeError("db down")
        with patch("apps.users.auth.models.UserProfile", broken):
            out = PromptForwardService.resolve_layered_rules_for_forward(space)
        self.assertIsNone(out["personal_rules"])


class ForwardPayloadLayeredRulesTests(SimpleTestCase):
    """forward_prompt payload：personal_rules 非空才写（照 custom_rules 范式）。"""

    thread_id = "chat-session-layered-rules"

    def _capture_envelope(self, **forward_kwargs):
        fake_space = SimpleNamespace(
            organization_id="ws-1",
            agent_config={"workspace_root": "/home/user"},
        )
        fake_device = SimpleNamespace(
            device_type="daemon", status="online", fingerprint="fp-daemon-layered",
        )
        with patch(
            "apps.services.agent_engine.services.prompt_forward_service.is_daemon_ws_connected",
            return_value=True,
        ), patch(
            "apps.services.agent_engine.services.prompt_forward_service.is_device_ws_connected",
            return_value=False,
        ), patch(
            "apps.services.agent_engine.services.prompt_forward_service.publish_ws_event_reliable",
        ) as mock_reliable, patch(
            "apps.tabtinspace.services.execution_binding.resolve_control_device",
            return_value=fake_device,
        ):
            mock_reliable.return_value = None
            svc = PromptForwardService()
            result = svc.forward_prompt(
                thread_id=self.thread_id,
                space=fake_space,
                prompt="hello",
                attachments=[],
                agent_backend_config={"type": "local"},
                runtime_mode="local",
                **forward_kwargs,
            )
            self.assertEqual(result["published"], 1)
            mock_reliable.assert_called_once()
            return mock_reliable.call_args[0][1]["payload"]

    def test_personal_rules_nonempty_in_payload(self):
        payload = self._capture_envelope(personal_rules="请用中文")
        self.assertEqual(payload["personal_rules"], "请用中文")

    def test_personal_rules_empty_not_in_payload(self):
        for bad in (None, "", "  ", "\r\n"):
            payload = self._capture_envelope(personal_rules=bad)
            self.assertNotIn("personal_rules", payload)

    def test_not_passing_layered_rules_backward_compatible(self):
        payload = self._capture_envelope()
        self.assertNotIn("personal_rules", payload)
