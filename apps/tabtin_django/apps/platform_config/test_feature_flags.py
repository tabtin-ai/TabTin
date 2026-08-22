from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase, override_settings

from apps.platform_config.services import PlatformRuntimeConfigService
from apps.services.common.runtime_build import ClientBuild


class FeatureFlagTests(SimpleTestCase):
    def _evaluate(self, value=None, *, is_active=True, **context):
        item = SimpleNamespace(is_active=is_active, value={} if value is None else value)
        with patch.object(PlatformRuntimeConfigService, "_get_feature_item", return_value=item):
            return PlatformRuntimeConfigService.evaluate_feature(
                "example",
                client=ClientBuild(client_type="electron", client_version="1.0.0"),
                **context,
            )

    def test_only_explicitly_enabled_active_flags_are_open(self):
        with patch.object(PlatformRuntimeConfigService, "_get_feature_item", return_value=None):
            self.assertFalse(
                PlatformRuntimeConfigService.evaluate_feature(
                    "missing",
                    client=ClientBuild(client_type="electron", client_version="1.0.0"),
                ).enabled
            )

        self.assertFalse(self._evaluate(is_active=False).enabled)
        self.assertFalse(self._evaluate({}).enabled)
        self.assertFalse(self._evaluate({"enabled": False}).enabled)
        self.assertTrue(self._evaluate({"enabled": True}).enabled)

    @override_settings(TABTIN_SERVER_VERSION="1.0.1-beta.1", TABTIN_GIT_SHA="abc1234")
    def test_applies_versions_allowlists_and_stable_organization_rollout(self):
        blocked = self._evaluate(
            {"enabled": True, "min_client_versions": {"electron": "2.0.0"}},
            organization_id="org-1",
        )
        self.assertEqual(blocked.reason, "client_version_too_low")

        unknown_client = self._evaluate(
            {"enabled": True, "min_client_versions": {"ios": "1.0.0"}},
            organization_id="org-1",
        )
        self.assertEqual(unknown_client.reason, "client_version_too_low")

        allowed = self._evaluate(
            {"enabled": True, "rollout": {"allow_organization_ids": ["org-1"], "percentage": 0}},
            organization_id="org-1",
        )
        self.assertTrue(allowed.enabled)

        rule = {"enabled": True, "rollout": {"percentage": 50, "percentage_unit": "organization"}}
        first = self._evaluate(rule, organization_id="org-2")
        second = self._evaluate(rule, organization_id="org-2")
        self.assertEqual(first, second)

    def test_organization_rollout_without_trusted_organization_is_closed(self):
        decision = self._evaluate(
            {"enabled": True, "rollout": {"percentage": 100, "percentage_unit": "organization"}},
            user_id="user-1",
        )
        self.assertEqual(decision.reason, "not_in_rollout")

    def test_organization_allowlist_is_scoped_to_current_organization(self):
        allowed = self._evaluate(
            {"enabled": True, "rollout": {"allow_organization_ids": ["mufan"], "percentage": 0}},
            organization_id="mufan",
        )
        blocked = self._evaluate(
            {"enabled": True, "rollout": {"allow_organization_ids": ["mufan"], "percentage": 0}},
            organization_id="other",
        )
        self.assertTrue(allowed.enabled)
        self.assertFalse(blocked.enabled)

    def test_server_enforcement_skips_client_version_but_keeps_organization_rollout(self):
        item = SimpleNamespace(
            is_active=True,
            value={
                "enabled": True,
                "min_client_versions": {"electron": "99.0.0"},
                "rollout": {"allow_organization_ids": ["mufan"], "percentage": 0},
            },
        )
        with patch.object(PlatformRuntimeConfigService, "_get_feature_item", return_value=item):
            allowed = PlatformRuntimeConfigService.evaluate_feature(
                "daemon_control", client=None, organization_id="mufan",
            )
            blocked = PlatformRuntimeConfigService.evaluate_feature(
                "daemon_control", client=None, organization_id="other",
            )
        self.assertTrue(allowed.enabled)
        self.assertFalse(blocked.enabled)
