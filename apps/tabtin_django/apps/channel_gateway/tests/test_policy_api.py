from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase, TestCase
from pydantic import ValidationError

from apps.channel_gateway.api import get_policy, update_policy
from apps.channel_gateway.api_schemas import ChannelPolicyUpdateRequest
from apps.channel_gateway.models import ChannelAccount


def _request():
    return SimpleNamespace(auth=SimpleNamespace(id="user_1"))


class ChannelPolicyApiSchemaTests(SimpleTestCase):
    def test_schema_requires_at_least_one_policy_field(self):
        with self.assertRaises(ValidationError):
            ChannelPolicyUpdateRequest(
                organization_id="ws_1",
                channel="telegram",
                account_id="default",
            )

    def test_schema_rejects_invalid_dm_policy(self):
        with self.assertRaises(ValidationError):
            ChannelPolicyUpdateRequest(
                organization_id="ws_1",
                channel="telegram",
                dm_policy="invalid",
            )

    def test_schema_rejects_empty_command_prefixes(self):
        with self.assertRaises(ValidationError):
            ChannelPolicyUpdateRequest(
                organization_id="ws_1",
                channel="telegram",
                command_prefixes=["", "   "],
            )


class ChannelPolicyApiTests(TestCase):
    def setUp(self):
        self.account = ChannelAccount.objects.create(
            channel="telegram",
            account_id="default",
            organization_id="ws_1",
            enabled=True,
            config={
                "policy": {
                    "dm_policy": "allowlist",
                    "group_policy": "allowlist",
                    "require_mention": True,
                    "groups": {"group_old": {"require_mention": False}},
                    "command_gate_enabled": False,
                    "command_prefixes": ["/"],
                }
            },
        )

    @patch("apps.channel_gateway.api._ensure_organization_permission")
    def test_get_policy_returns_normalized_config(self, _permission):
        result = get_policy(
            _request(),
            organization_id="ws_1",
            channel="telegram",
            account_id="default",
        )

        self.assertTrue(result["success"])
        data = result["data"]
        self.assertEqual(data["dm_policy"], "allowlist")
        self.assertEqual(data["group_policy"], "allowlist")
        self.assertTrue(data["require_mention"])
        self.assertEqual(data["group_require_mention"], {"group_old": False})
        self.assertFalse(data["command_gate_enabled"])
        self.assertEqual(data["command_prefixes"], ["/"])

    @patch("apps.channel_gateway.api._ensure_organization_permission")
    def test_update_policy_persists_patch(self, _permission):
        data = ChannelPolicyUpdateRequest(
            organization_id="ws_1",
            channel="telegram",
            dm_policy="pairing",
            group_policy="open",
            require_mention=False,
            group_require_mention={"group_new": True, "*": False},
            command_gate_enabled=True,
            command_prefixes=["/", "!"],
        )

        result = update_policy(_request(), data)
        self.account.refresh_from_db()

        self.assertTrue(result["success"])
        rd = result["data"]
        self.assertEqual(rd["dm_policy"], "pairing")
        self.assertEqual(rd["group_policy"], "open")
        self.assertFalse(rd["require_mention"])
        self.assertEqual(rd["group_require_mention"], {"group_new": True, "*": False})
        self.assertTrue(rd["command_gate_enabled"])
        self.assertEqual(rd["command_prefixes"], ["/", "!"])
        self.assertEqual(self.account.config["policy"]["dm_policy"], "pairing")
        self.assertEqual(self.account.config["policy"]["group_policy"], "open")
        self.assertFalse(self.account.config["policy"]["require_mention"])
        self.assertEqual(
            self.account.config["policy"]["groups"],
            {"group_new": {"require_mention": True}, "*": {"require_mention": False}},
        )
        self.assertEqual(self.account.config["dm_policy"], "pairing")
        self.assertEqual(self.account.config["group_policy"], "open")
        self.assertFalse(self.account.config["require_mention"])
        self.assertTrue(self.account.config["policy"]["command_gate_enabled"])
        self.assertEqual(self.account.config["policy"]["command_prefixes"], ["/", "!"])
        self.assertTrue(self.account.config["command_gate_enabled"])
        self.assertEqual(self.account.config["command_prefixes"], ["/", "!"])

    @patch("apps.channel_gateway.api._ensure_organization_permission")
    def test_get_policy_returns_404_when_account_missing(self, _permission):
        result = get_policy(
            _request(),
            organization_id="ws_1",
            channel="discord",
            account_id="default",
        )
        status_code, body = result
        self.assertEqual(status_code, 404)
        self.assertFalse(body["success"])
        self.assertEqual(body["code"], "NOT_FOUND")
