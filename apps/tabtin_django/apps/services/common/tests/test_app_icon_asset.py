import json
import tempfile
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

from apps.services.common.app_registry import (
    _load_app_definition_from_manifest,
    get_app,
)
from apps.tabtinspace.services.app_catalog_service import (
    OrganizationAppCatalogService,
)


class AppIconAssetManifestTest(TestCase):
    def test_builtin_app_exposes_package_owned_icon_asset(self):
        app = get_app("tabdoc")

        self.assertIsNotNone(app)
        self.assertEqual(
            app.icon_asset,
            {
                "default": "assets/icon.svg",
                "presentation": "selfContained",
            },
        )

    def test_icon_asset_supports_aliases_and_usage_variants(self):
        tabdata = get_app("tabdata")
        folder = get_app("tabfolder")

        self.assertEqual(tabdata.icon_asset["aliases"], ["table"])
        self.assertEqual(folder.icon_asset["variants"], {"tab": "assets/tab.svg"})

    def test_unsafe_or_missing_asset_path_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            package_dir = Path(directory)
            manifest_path = package_dir / "app.json"
            manifest_path.write_text(
                json.dumps({
                    "id": "unsafe-app",
                    "name": "Unsafe App",
                    "icon": "box",
                    "uiHints": {
                        "iconAsset": {
                            "default": "../outside.svg",
                            "presentation": "selfContained",
                        },
                    },
                }),
                encoding="utf-8",
            )

            app = _load_app_definition_from_manifest(manifest_path)

        self.assertIsNotNone(app)
        self.assertIsNone(app.icon_asset)

    @patch.object(
        OrganizationAppCatalogService,
        "_is_organization_admin",
        return_value=False,
    )
    @patch.object(
        OrganizationAppCatalogService,
        "get_installed_app_ids",
        return_value={"tabdoc"},
    )
    @patch(
        "apps.tabtinspace.services.app_catalog_service.list_apps",
        return_value=(get_app("tabdoc"),),
    )
    def test_app_catalog_passes_icon_asset_contract_to_clients(
        self,
        _list_apps,
        _installed_ids,
        _is_admin,
    ):
        catalog = OrganizationAppCatalogService.list_catalog(
            "organization-id",
            user=object(),
        )

        self.assertEqual(
            catalog["apps"][0]["icon_asset"],
            {
                "default": "assets/icon.svg",
                "presentation": "selfContained",
            },
        )
