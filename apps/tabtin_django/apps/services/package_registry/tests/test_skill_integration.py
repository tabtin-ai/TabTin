"""#7, #9, #14 改造测试：content_type 统一、organization 校验对齐、agents_json fallback。"""

from __future__ import annotations

import uuid
from unittest.mock import MagicMock, patch

from django.test import TestCase

from apps.services.package_registry.utils import guess_content_type


# ---------------------------------------------------------------------------
# #14  guess_content_type 统一映射
# ---------------------------------------------------------------------------


class GuessContentTypeTest(TestCase):
    """utils.guess_content_type 是唯一映射入口。"""

    def test_python(self):
        self.assertEqual(guess_content_type("main.py"), "text/x-python")

    def test_markdown(self):
        self.assertEqual(guess_content_type("README.md"), "text/markdown")

    def test_json(self):
        self.assertEqual(guess_content_type("package.json"), "application/json")

    def test_yaml_variants(self):
        self.assertEqual(guess_content_type("config.yaml"), "text/yaml")
        self.assertEqual(guess_content_type("config.yml"), "text/yaml")

    def test_javascript(self):
        self.assertEqual(guess_content_type("index.js"), "application/javascript")

    def test_typescript(self):
        self.assertEqual(guess_content_type("index.ts"), "application/typescript")

    def test_html(self):
        self.assertEqual(guess_content_type("page.html"), "text/html")

    def test_css(self):
        self.assertEqual(guess_content_type("style.css"), "text/css")

    def test_toml(self):
        self.assertEqual(guess_content_type("pyproject.toml"), "application/toml")

    def test_shell(self):
        self.assertEqual(guess_content_type("run.sh"), "application/x-sh")

    def test_csv(self):
        self.assertEqual(guess_content_type("data.csv"), "text/csv")

    def test_txt(self):
        self.assertEqual(guess_content_type("notes.txt"), "text/plain")

    def test_unknown_extension(self):
        self.assertEqual(guess_content_type("binary.wasm"), "application/octet-stream")

    def test_no_extension(self):
        self.assertEqual(guess_content_type("Makefile"), "application/octet-stream")

    def test_case_insensitive(self):
        self.assertEqual(guess_content_type("README.MD"), "text/markdown")

    def test_nested_path(self):
        self.assertEqual(guess_content_type("src/lib/utils.py"), "text/x-python")


class ClientDelegatesGuessContentType(TestCase):
    """client._guess_content_type 委托给 utils.guess_content_type。"""

    def test_client_uses_utils(self):
        from apps.services.package_registry.client import _guess_content_type
        self.assertEqual(_guess_content_type("test.sh"), "application/x-sh")
        self.assertEqual(_guess_content_type("test.csv"), "text/csv")
        self.assertEqual(_guess_content_type("test.toml"), "application/toml")


class PublishServiceDelegatesGuessContentType(TestCase):
    """publish_service._guess_content_type 委托给 utils.guess_content_type。"""

    def test_publish_service_uses_utils(self):
        from apps.skills.services.publish_service import _guess_content_type
        self.assertEqual(_guess_content_type("test.sh"), "application/x-sh")
        self.assertEqual(_guess_content_type("test.csv"), "text/csv")
        self.assertEqual(_guess_content_type("test.toml"), "application/toml")


# ---------------------------------------------------------------------------
# #7  organization 校验逻辑统一
# ---------------------------------------------------------------------------


class OrganizationValidationUnifiedTest(TestCase):
    """publish_service._check_organization_membership 委托给 services.check_package_write_access。"""

    def test_no_organization_skips_check(self):
        from apps.skills.services.publish_service import _check_organization_membership
        _check_organization_membership(uuid.uuid4(), None)

    def test_no_user_raises(self):
        from apps.skills.services.publish_service import (
            _check_organization_membership,
            SkillPermissionError,
        )
        with self.assertRaises(SkillPermissionError):
            _check_organization_membership(None, uuid.uuid4())

    @patch("apps.services.package_registry.services.check_package_write_access")
    def test_delegates_to_check_package_write_access(self, mock_check):
        from apps.skills.services.publish_service import _check_organization_membership
        uid = uuid.uuid4()
        wt = uuid.uuid4()
        _check_organization_membership(uid, wt)
        mock_check.assert_called_once_with(
            user_id=str(uid),
            organization_id=str(wt),
            min_role="editor",
        )

    @patch(
        "apps.services.package_registry.services.check_package_write_access",
        side_effect=PermissionError("denied"),
    )
    def test_permission_error_wrapped(self, mock_check):
        from apps.skills.services.publish_service import (
            _check_organization_membership,
            SkillPermissionError,
        )
        with self.assertRaises(SkillPermissionError):
            _check_organization_membership(uuid.uuid4(), uuid.uuid4())

    def test_role_hierarchy_consistency(self):
        """services._ROLES_GTE 的 editor 层级应包含 owner/admin/editor。"""
        from apps.services.package_registry.services import _ROLES_GTE
        editor_roles = set(_ROLES_GTE["editor"])
        self.assertEqual(editor_roles, {"owner", "admin", "editor"})


# ---------------------------------------------------------------------------
# #9  agents_json PR manifest fallback
# ---------------------------------------------------------------------------


class GetAgentsJsonFromPrTest(TestCase):
    """_get_agents_json_from_pr 从 PackageVersion.manifest 读取 agents_json。"""
    databases = {"default", "postgresql"}

    def test_returns_none_when_no_package(self):
        from apps.skills.api import _get_agents_json_from_pr
        result = _get_agents_json_from_pr(uuid.uuid4())
        self.assertIsNone(result)

    @patch("apps.services.package_registry.models.Package.objects")
    def test_returns_agents_json_from_manifest(self, mock_pkg_objects):
        from apps.skills.api import _get_agents_json_from_pr

        mock_version = MagicMock()
        mock_version.manifest = {"agents_json": [{"name": "bot1", "persona": "helper"}]}

        mock_pkg = MagicMock()
        mock_pkg.latest_version_seq = 1

        mock_pkg_objects.filter.return_value.first.return_value = mock_pkg

        with patch("apps.services.package_registry.models.PackageVersion.objects") as mock_pv:
            mock_pv.filter.return_value.first.return_value = mock_version
            result = _get_agents_json_from_pr(uuid.uuid4())

        self.assertEqual(result, [{"name": "bot1", "persona": "helper"}])

    @patch("apps.services.package_registry.models.Package.objects")
    def test_returns_agents_key_fallback(self, mock_pkg_objects):
        """manifest 中 key 为 'agents' 而非 'agents_json' 时也能读取。"""
        from apps.skills.api import _get_agents_json_from_pr

        mock_version = MagicMock()
        mock_version.manifest = {"agents": [{"name": "bot2"}]}

        mock_pkg = MagicMock()
        mock_pkg.latest_version_seq = 2

        mock_pkg_objects.filter.return_value.first.return_value = mock_pkg

        with patch("apps.services.package_registry.models.PackageVersion.objects") as mock_pv:
            mock_pv.filter.return_value.first.return_value = mock_version
            result = _get_agents_json_from_pr(uuid.uuid4())

        self.assertEqual(result, [{"name": "bot2"}])

    @patch("apps.services.package_registry.models.Package.objects")
    def test_returns_none_when_manifest_empty(self, mock_pkg_objects):
        from apps.skills.api import _get_agents_json_from_pr

        mock_version = MagicMock()
        mock_version.manifest = {}

        mock_pkg = MagicMock()
        mock_pkg.latest_version_seq = 1

        mock_pkg_objects.filter.return_value.first.return_value = mock_pkg

        with patch("apps.services.package_registry.models.PackageVersion.objects") as mock_pv:
            mock_pv.filter.return_value.first.return_value = mock_version
            result = _get_agents_json_from_pr(uuid.uuid4())

        self.assertIsNone(result)

    @patch("apps.services.package_registry.models.Package.objects")
    def test_returns_none_when_agents_empty_list(self, mock_pkg_objects):
        from apps.skills.api import _get_agents_json_from_pr

        mock_version = MagicMock()
        mock_version.manifest = {"agents_json": []}

        mock_pkg = MagicMock()
        mock_pkg.latest_version_seq = 1

        mock_pkg_objects.filter.return_value.first.return_value = mock_pkg

        with patch("apps.services.package_registry.models.PackageVersion.objects") as mock_pv:
            mock_pv.filter.return_value.first.return_value = mock_version
            result = _get_agents_json_from_pr(uuid.uuid4())

        self.assertIsNone(result)

    @patch(
        "apps.services.package_registry.models.Package.objects",
        **{"filter.return_value.first.side_effect": Exception("db down")},
    )
    def test_returns_none_on_exception(self, mock_pkg_objects):
        from apps.skills.api import _get_agents_json_from_pr
        result = _get_agents_json_from_pr(uuid.uuid4())
        self.assertIsNone(result)
