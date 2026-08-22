from __future__ import annotations

from django.test import SimpleTestCase
from unittest.mock import patch

from apps.channel_gateway.schemas import ChannelInboundMessage
from apps.channel_gateway.services.policy_service import ChannelPolicyService


class ChannelPolicyServiceTests(SimpleTestCase):
    def setUp(self):
        self.service = ChannelPolicyService()

    def test_extract_policy_prefers_policy_namespace(self):
        config = {
            "dm_policy": "open",
            "group_policy": "open",
            "require_mention": True,
            "groups": {"legacy_group": {"require_mention": False}},
            "policy": {
                "dm_policy": "allowlist",
                "group_policy": "allowlist",
                "require_mention": False,
                "groups": {
                    "group_1": {"requireMention": True},
                    "group_2": False,
                },
                "command_gate_enabled": True,
                "command_prefixes": ["/", "!"],
            },
        }

        policy = self.service.extract_policy_config(config)

        self.assertEqual(policy["dm_policy"], "allowlist")
        self.assertEqual(policy["group_policy"], "allowlist")
        self.assertFalse(policy["require_mention"])
        self.assertEqual(
            policy["group_require_mention"],
            {
                "group_1": True,
                "group_2": False,
            },
        )
        self.assertTrue(policy["command_gate_enabled"])
        self.assertEqual(policy["command_prefixes"], ["/", "!"])

    def test_extract_policy_with_non_dict_config_uses_defaults(self):
        policy = self.service.extract_policy_config(config=None)
        self.assertEqual(policy["dm_policy"], self.service.dm_policy)
        self.assertEqual(policy["group_policy"], self.service.group_policy)
        self.assertTrue(policy["require_mention"])
        self.assertEqual(policy["group_require_mention"], {})
        self.assertFalse(policy["command_gate_enabled"])
        self.assertEqual(policy["command_prefixes"], ["/"])

    def test_apply_policy_patch_updates_policy_and_legacy_keys(self):
        source_config = {
            "api_key": "token",
            "policy": {
                "dm_policy": "open",
                "group_policy": "allowlist",
                "require_mention": True,
                "groups": {"*": {"require_mention": True}},
            },
        }

        updated = self.service.apply_policy_patch(
            source_config,
            dm_policy="pairing",
            require_mention=False,
            group_require_mention={"group_A": True},
            command_gate_enabled=True,
            command_prefixes=["/", "!"],
        )

        self.assertEqual(updated["policy"]["dm_policy"], "pairing")
        self.assertEqual(updated["policy"]["group_policy"], "allowlist")
        self.assertFalse(updated["policy"]["require_mention"])
        self.assertEqual(updated["policy"]["groups"], {"group_A": {"require_mention": True}})
        self.assertEqual(updated["dm_policy"], "pairing")
        self.assertEqual(updated["group_policy"], "allowlist")
        self.assertFalse(updated["require_mention"])
        self.assertEqual(updated["groups"], {"group_A": {"require_mention": True}})
        self.assertTrue(updated["policy"]["command_gate_enabled"])
        self.assertEqual(updated["policy"]["command_prefixes"], ["/", "!"])
        self.assertTrue(updated["command_gate_enabled"])
        self.assertEqual(updated["command_prefixes"], ["/", "!"])
        self.assertTrue(updated["command_only"])

    def test_apply_policy_patch_supports_clear_group_overrides(self):
        source_config = {
            "policy": {
                "dm_policy": "pairing",
                "group_policy": "allowlist",
                "require_mention": True,
                "groups": {"group_A": {"require_mention": False}},
            }
        }

        updated = self.service.apply_policy_patch(
            source_config,
            clear_group_overrides=True,
        )

        self.assertEqual(updated["policy"]["groups"], {})
        self.assertEqual(updated["groups"], {})

    def test_evaluate_group_command_gate_blocks_non_command(self):
        inbound = ChannelInboundMessage(
            schema_version=1,
            type="channel.inbound",
            channel="telegram",
            account_id="default",
            organization_id="ws_1",
            peer_kind="group",
            peer_id="group_1",
            sender_id="user_1",
            message_id="msg_1",
            text="hello",
            timestamp=1,
            metadata={"mentioned": True},
        )
        policy = {
            "dm_policy": "pairing",
            "group_policy": "open",
            "require_mention": False,
            "group_require_mention": {},
            "command_gate_enabled": True,
            "command_prefixes": ["/"],
        }

        with patch.object(self.service, "resolve_policy", return_value=policy):
            decision = self.service.evaluate(inbound, binding=None)

        self.assertFalse(decision.allowed)
        self.assertEqual(decision.reason, "group_command_required")

    def test_evaluate_group_command_gate_allows_command_message(self):
        inbound = ChannelInboundMessage(
            schema_version=1,
            type="channel.inbound",
            channel="telegram",
            account_id="default",
            organization_id="ws_1",
            peer_kind="group",
            peer_id="group_1",
            sender_id="user_1",
            message_id="msg_2",
            text="/help",
            timestamp=1,
            metadata={"mentioned": True},
        )
        policy = {
            "dm_policy": "pairing",
            "group_policy": "open",
            "require_mention": False,
            "group_require_mention": {},
            "command_gate_enabled": True,
            "command_prefixes": ["/"],
        }

        with patch.object(self.service, "resolve_policy", return_value=policy):
            decision = self.service.evaluate(inbound, binding=None)

        self.assertTrue(decision.allowed)

    # ── DS-020 回归测试 ──

    def _dm_inbound(self, **overrides):
        defaults = dict(
            schema_version=1,
            type="channel.inbound",
            channel="feishu",
            account_id="default",
            organization_id="ws_1",
            peer_kind="dm",
            peer_id="peer_1",
            sender_id="user_ext",
            message_id="msg_dm",
            text="hello",
            timestamp=1,
            metadata={},
        )
        defaults.update(overrides)
        return ChannelInboundMessage(**defaults)

    def test_ds020_dm_open_still_blocks_if_allowlist_blocked(self):
        """DS-020: dm_policy=open 时显式 block 条目仍应拒绝。"""
        inbound = self._dm_inbound()
        policy = {
            "dm_policy": "open",
            "group_policy": "allowlist",
            "require_mention": True,
            "group_require_mention": {},
            "command_gate_enabled": False,
            "command_prefixes": ["/"],
        }

        with (
            patch.object(self.service, "resolve_policy", return_value=policy),
            patch.object(self.service, "_allowlist_hit", return_value=False),
        ):
            decision = self.service.evaluate(inbound, binding=None)

        self.assertFalse(decision.allowed)
        self.assertEqual(decision.reason, "allowlist_blocked")

    def test_ds020_dm_open_allows_when_not_blocked(self):
        """DS-020: dm_policy=open 且无 block 条目时允许通过。"""
        inbound = self._dm_inbound()
        policy = {
            "dm_policy": "open",
            "group_policy": "allowlist",
            "require_mention": True,
            "group_require_mention": {},
            "command_gate_enabled": False,
            "command_prefixes": ["/"],
        }

        with (
            patch.object(self.service, "resolve_policy", return_value=policy),
            patch.object(self.service, "_allowlist_hit", return_value=None),
        ):
            decision = self.service.evaluate(inbound, binding=None)

        self.assertTrue(decision.allowed)
        self.assertEqual(decision.reason, "dm_open")

    def test_ds020_dm_pairing_still_checks_allowlist_allow(self):
        """pairing 模式下 allowlist allow 条目仍然放行。"""
        inbound = self._dm_inbound()
        policy = {
            "dm_policy": "pairing",
            "group_policy": "allowlist",
            "require_mention": True,
            "group_require_mention": {},
            "command_gate_enabled": False,
            "command_prefixes": ["/"],
        }

        with (
            patch.object(self.service, "resolve_policy", return_value=policy),
            patch.object(self.service, "_allowlist_hit", return_value=True),
        ):
            decision = self.service.evaluate(inbound, binding=None)

        self.assertTrue(decision.allowed)
        self.assertEqual(decision.reason, "allowlist")
