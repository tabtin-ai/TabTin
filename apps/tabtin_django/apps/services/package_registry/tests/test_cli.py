"""``tabtin pkg`` CLI 命令单元测试。

采用 mock 模式（与 test_a5_install.py 一致），不需要真实 OSS / 网络。
覆盖 5 个子命令的正常路径和错误路径。
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from unittest.mock import patch

from django.test import TestCase

from apps.services.agent_engine.cli.tabtin_cli.pkg import (
    _infer_from_directory,
    _parse_fork_ref,
    _parse_pkg_ref,
    run_pkg,
)
from apps.services.package_registry.tests.conftest import (
    apply_all_mocks,
    create_published_package,
    uid as _uid,
)


def _make_args(**kw):
    """构造一个类似 argparse.Namespace 的对象。"""
    ns = argparse.Namespace()
    for k, v in kw.items():
        setattr(ns, k, v)
    if not hasattr(ns, "json"):
        ns.json = False
    return ns


# ---------------------------------------------------------------------------
# 解析工具函数
# ---------------------------------------------------------------------------

class ParsePkgRefTest(TestCase):

    def test_parse_namespace_name(self):
        r = _parse_pkg_ref("demo-app/some-skill")
        self.assertEqual(r["namespace"], "demo-app")
        self.assertEqual(r["name"], "some-skill")
        self.assertIsNone(r["version"])

    def test_parse_with_version(self):
        r = _parse_pkg_ref("demo-app/some-skill@2")
        self.assertEqual(r["namespace"], "demo-app")
        self.assertEqual(r["name"], "some-skill")
        self.assertEqual(r["version"], 2)

    def test_parse_invalid(self):
        for bad in ["demo-app", "Demo-App/skill", "demo-app/Skill", "demo-app/skill@abc", ""]:
            with self.assertRaises(ValueError, msg=f"Should reject: {bad!r}"):
                _parse_pkg_ref(bad)


class ParseForkRefTest(TestCase):

    def test_parse_success(self):
        r = _parse_fork_ref("acme/my-pkg")
        self.assertEqual(r["namespace"], "acme")
        self.assertEqual(r["name"], "my-pkg")

    def test_parse_invalid(self):
        with self.assertRaises(ValueError):
            _parse_fork_ref("single")


class InferFromDirectoryTest(TestCase):

    def test_infer_from_skills_path(self):
        r = _infer_from_directory("/repo/packages/apps/demo-app/skills/code-review")
        self.assertEqual(r["namespace"], "demo-app")
        self.assertEqual(r["name"], "code-review")

    def test_infer_fallback(self):
        r = _infer_from_directory("/home/user/my-packages/my-skill")
        self.assertEqual(r["namespace"], "my-packages")
        self.assertEqual(r["name"], "my-skill")


# ---------------------------------------------------------------------------
# CLI publish
# ---------------------------------------------------------------------------

class CliPublishTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        apply_all_mocks(self)
        self.user_id = _uid()
        self.wt_id = _uid()

    def test_publish_success(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "SKILL.md").write_text("# Skill")
            (Path(tmp) / "main.py").write_text("print(1)")

            with patch(
                "apps.services.agent_engine.cli.tabtin_cli.pkg._get_user_context",
                return_value={"user_id": self.user_id, "organization_id": self.wt_id},
            ), patch(
                "apps.services.package_registry.client.PackageRegistryClient._upload_file",
            ):
                args = _make_args(
                    pkg_command="publish",
                    directory=tmp,
                    namespace="cli-ns",
                    name="cli-pkg",
                    organization_id=self.wt_id,
                    version_label=None,
                )
                rc = run_pkg(args)
            self.assertEqual(rc, 0)

    def test_publish_nonexistent_dir(self):
        with patch(
            "apps.services.agent_engine.cli.tabtin_cli.pkg._get_user_context",
            return_value={"user_id": self.user_id, "organization_id": self.wt_id},
        ):
            args = _make_args(
                pkg_command="publish", directory="/nonexistent/dir",
                namespace="x", name="y", organization_id=self.wt_id,
                version_label=None,
            )
            rc = run_pkg(args)
        self.assertEqual(rc, 1)


# ---------------------------------------------------------------------------
# CLI install
# ---------------------------------------------------------------------------

class CliInstallTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        apply_all_mocks(self)
        self.user_id = _uid()
        self.wt_id = _uid()
        create_published_package(self.user_id, "cli-inst", "pkg", self.wt_id)

    def test_install_success(self):
        import tempfile
        with tempfile.TemporaryDirectory() as target:
            with patch(
                "apps.services.agent_engine.cli.tabtin_cli.pkg._get_user_context",
                return_value={"user_id": self.user_id, "organization_id": self.wt_id},
            ), patch(
                "apps.services.package_registry.client.PackageRegistryClient._download_file",
                side_effect=lambda url, dest: dest.write_bytes(b"content"),
            ), patch(
                "apps.services.package_registry.client._sha256_file",
                return_value="a" * 64,
            ):
                args = _make_args(
                    pkg_command="install",
                    package_ref="cli-inst/pkg",
                    target_dir=target,
                )
                rc = run_pkg(args)
            self.assertEqual(rc, 0)

    def test_install_not_found(self):
        with patch(
            "apps.services.agent_engine.cli.tabtin_cli.pkg._get_user_context",
            return_value={"user_id": self.user_id, "organization_id": self.wt_id},
        ):
            args = _make_args(
                pkg_command="install",
                package_ref="no/such-pkg",
                target_dir=None,
            )
            rc = run_pkg(args)
        self.assertEqual(rc, 1)

    def test_install_invalid_ref(self):
        with patch(
            "apps.services.agent_engine.cli.tabtin_cli.pkg._get_user_context",
            return_value={"user_id": self.user_id, "organization_id": self.wt_id},
        ):
            args = _make_args(
                pkg_command="install", package_ref="invalidref",
                target_dir=None,
            )
            rc = run_pkg(args)
        self.assertEqual(rc, 1)


# ---------------------------------------------------------------------------
# CLI list
# ---------------------------------------------------------------------------

class CliListTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        apply_all_mocks(self)
        self.user_id = _uid()
        self.wt_id = _uid()
        create_published_package(self.user_id, "cli-list", "pkg", self.wt_id)

    def test_list_success(self):
        with patch(
            "apps.services.agent_engine.cli.tabtin_cli.pkg._get_user_context",
            return_value={"user_id": self.user_id, "organization_id": self.wt_id},
        ):
            args = _make_args(pkg_command="list", package_ref="cli-list/pkg")
            rc = run_pkg(args)
        self.assertEqual(rc, 0)

    def test_list_json(self, capsys=None):
        with patch(
            "apps.services.agent_engine.cli.tabtin_cli.pkg._get_user_context",
            return_value={"user_id": self.user_id, "organization_id": self.wt_id},
        ):
            args = _make_args(pkg_command="list", package_ref="cli-list/pkg")
            args.json = True
            rc = run_pkg(args)
        self.assertEqual(rc, 0)


# ---------------------------------------------------------------------------
# CLI yank
# ---------------------------------------------------------------------------

class CliYankTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        apply_all_mocks(self)
        self.user_id = _uid()
        self.wt_id = _uid()
        create_published_package(self.user_id, "cli-yank", "pkg", self.wt_id)

    def test_yank_success(self):
        with patch(
            "apps.services.agent_engine.cli.tabtin_cli.pkg._get_user_context",
            return_value={"user_id": self.user_id, "organization_id": self.wt_id},
        ):
            args = _make_args(
                pkg_command="yank", package_ref="cli-yank/pkg@1",
                reason="broken",
            )
            rc = run_pkg(args)
        self.assertEqual(rc, 0)

    def test_yank_missing_version(self):
        with patch(
            "apps.services.agent_engine.cli.tabtin_cli.pkg._get_user_context",
            return_value={"user_id": self.user_id, "organization_id": self.wt_id},
        ):
            args = _make_args(
                pkg_command="yank", package_ref="cli-yank/pkg",
                reason="test",
            )
            rc = run_pkg(args)
        self.assertEqual(rc, 1)


# ---------------------------------------------------------------------------
# CLI fork
# ---------------------------------------------------------------------------

class CliForkTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        apply_all_mocks(self)
        self.user_id = _uid()
        self.wt_id = _uid()
        create_published_package(self.user_id, "cli-fork-src", "pkg", self.wt_id)

    def test_fork_success(self):
        with patch(
            "apps.services.agent_engine.cli.tabtin_cli.pkg._get_user_context",
            return_value={"user_id": self.user_id, "organization_id": self.wt_id},
        ):
            args = _make_args(
                pkg_command="fork",
                source_ref="cli-fork-src/pkg",
                to="cli-fork-dst/pkg-copy",
                organization_id=self.wt_id,
            )
            rc = run_pkg(args)
        self.assertEqual(rc, 0)

    def test_fork_source_not_found(self):
        with patch(
            "apps.services.agent_engine.cli.tabtin_cli.pkg._get_user_context",
            return_value={"user_id": self.user_id, "organization_id": self.wt_id},
        ):
            args = _make_args(
                pkg_command="fork",
                source_ref="no/pkg",
                to="dst/copy",
                organization_id=self.wt_id,
            )
            rc = run_pkg(args)
        self.assertEqual(rc, 1)
