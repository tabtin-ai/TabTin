"""lookup_package 服务函数 + API 端点测试。"""

from __future__ import annotations

import uuid
from unittest.mock import patch

from django.test import TestCase

from apps.services.package_registry import services
from apps.services.package_registry.models import Package


def _uid() -> str:
    return str(uuid.uuid4())


class LookupPackageServiceTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        p = patch("apps.services.package_registry.services.emit_on_commit")
        p.start()
        self.addCleanup(p.stop)
        p2 = patch("apps.services.package_registry.services._USING_DB", "postgresql")
        p2.start()
        self.addCleanup(p2.stop)
        p3 = patch("apps.services.package_registry.services.check_package_write_access")
        p3.start()
        self.addCleanup(p3.stop)

    def test_lookup_success(self):
        services.create_package(
            namespace="lookup-ns", name="lookup-pkg",
            organization_id=_uid(), created_by=_uid(),
        )
        pkg = services.lookup_package(namespace="lookup-ns", name="lookup-pkg")
        self.assertEqual(pkg.namespace, "lookup-ns")
        self.assertEqual(pkg.name, "lookup-pkg")

    def test_lookup_not_found(self):
        with self.assertRaises(LookupError) as ctx:
            services.lookup_package(namespace="no", name="pkg")
        self.assertIn("PACKAGE_NOT_FOUND", str(ctx.exception))

    def test_lookup_partial_match_not_found(self):
        """namespace 匹配但 name 不匹配 → 找不到。"""
        services.create_package(
            namespace="partial-ns", name="real-pkg",
            organization_id=_uid(), created_by=_uid(),
        )
        with self.assertRaises(LookupError):
            services.lookup_package(namespace="partial-ns", name="other-pkg")


class ComputeBundleSha256PublicTest(TestCase):
    """验证 compute_bundle_sha256 被公开且与 _compute_bundle_sha256 行为一致。"""

    def test_public_equals_private(self):
        files = [("b.py", "b" * 64), ("a.py", "a" * 64)]
        result = services.compute_bundle_sha256(files)
        self.assertEqual(len(result), 64)
        result2 = services._compute_bundle_sha256(files)
        self.assertEqual(result, result2)

    def test_order_independent(self):
        files_a = [("x.py", "x" * 64), ("a.py", "a" * 64)]
        files_b = [("a.py", "a" * 64), ("x.py", "x" * 64)]
        self.assertEqual(
            services.compute_bundle_sha256(files_a),
            services.compute_bundle_sha256(files_b),
        )
