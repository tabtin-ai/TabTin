from copy import deepcopy
from importlib import import_module
from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase

from apps.integrations_feishu.feature import (
    FEISHU_IMPORT_FEATURE_KEY,
    feishu_import_enabled_for_organization,
)
from apps.platform_config.services import PlatformRuntimeConfigService
from apps.services.common.runtime_build import ClientBuild


class FeishuImportFeatureTests(SimpleTestCase):
    def test_delegates_to_the_shared_organization_feature_rollout(self):
        client = ClientBuild(client_type="electron", client_version="1.0.0")
        with patch.object(
            PlatformRuntimeConfigService,
            "evaluate_feature",
            return_value=SimpleNamespace(enabled=True),
        ) as evaluate:
            enabled = feishu_import_enabled_for_organization(
                user_id="user-1",
                organization_id="org-1",
                client=client,
            )

        self.assertTrue(enabled)
        evaluate.assert_called_once_with(
            FEISHU_IMPORT_FEATURE_KEY,
            client=client,
            user_id="user-1",
            organization_id="org-1",
        )

    def test_missing_organization_fails_closed(self):
        with patch.object(PlatformRuntimeConfigService, "evaluate_feature") as evaluate:
            enabled = feishu_import_enabled_for_organization(
                user_id="user-1",
                organization_id="",
            )

        self.assertFalse(enabled)
        evaluate.assert_not_called()

    def test_seeded_rollout_can_enable_an_allowlisted_organization(self):
        migration = import_module(
            "apps.platform_config.migrations.0004_seed_feishu_import_feature"
        )
        config = deepcopy(migration.DEFAULT_FEISHU_IMPORT_FEATURE)
        config["rollout"]["allow_organization_ids"] = ["org-allowed"]

        with patch.object(
            PlatformRuntimeConfigService,
            "_get_feature_item",
            return_value=SimpleNamespace(is_active=True, value=config),
        ):
            allowed = feishu_import_enabled_for_organization(
                user_id="user-1",
                organization_id="org-allowed",
            )
            blocked = feishu_import_enabled_for_organization(
                user_id="user-1",
                organization_id="org-blocked",
            )

        self.assertTrue(allowed)
        self.assertFalse(blocked)
