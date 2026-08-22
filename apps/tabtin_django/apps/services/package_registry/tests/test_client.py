"""Package Registry Client SDK 单元测试。

覆盖范围：
  - publish 完整流程（扫描 → create → init → upload → finalize）
  - publish 已存在包（跳过 create）
  - publish organization 归属校验
  - install 完整流程（lookup → get_files → download → sha256 verify）
  - install 原子性（临时目录 + rename，失败无残留）
  - install 路径穿越防御
  - install yanked 版本自动回退
  - download 重试（指数退避）
  - list_versions
  - yank
  - fork（含 fork_at_version_seq）
  - 敏感文件过滤
  - 错误场景（空目录、包不存在、无版本）
"""

from __future__ import annotations

import hashlib
import urllib.error
from pathlib import Path
from unittest.mock import patch, call

from django.test import TestCase

from apps.services.package_registry import services
from apps.services.package_registry.client import (
    PackageRegistryClient,
    _scan_directory,
    _sha256_file,
    _validate_file_path,
)
from apps.services.package_registry.tests.conftest import (
    apply_all_mocks,
    create_published_package,
    uid,
)


# ---------------------------------------------------------------------------
# scan_directory
# ---------------------------------------------------------------------------

class ScanDirectoryTest(TestCase):

    def test_scan_finds_files(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            (p / "hello.py").write_text("print('hello')")
            (p / "sub").mkdir()
            (p / "sub" / "data.json").write_text("{}")

            files = _scan_directory(tmp)
            paths = {f["path"] for f in files}
            self.assertEqual(paths, {"hello.py", "sub/data.json"})
            for f in files:
                self.assertIn("sha256", f)
                self.assertIn("size", f)
                self.assertGreater(f["size"], 0)

    def test_scan_ignores_pycache(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            (p / "main.py").write_text("x = 1")
            (p / "__pycache__").mkdir()
            (p / "__pycache__" / "main.cpython-311.pyc").write_bytes(b"compiled")

            files = _scan_directory(tmp)
            paths = {f["path"] for f in files}
            self.assertEqual(paths, {"main.py"})

    def test_scan_ignores_sensitive_files(self):
        """P0 安全修复：.env / .pem / .key 等敏感文件不应被扫描。"""
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            (p / "main.py").write_text("x = 1")
            (p / ".env").write_text("SECRET=abc")
            (p / ".env.local").write_text("LOCAL_SECRET=xyz")
            (p / "server.pem").write_bytes(b"cert")
            (p / "private.key").write_bytes(b"key")
            (p / "credentials.json").write_text("{}")

            files = _scan_directory(tmp)
            paths = {f["path"] for f in files}
            self.assertEqual(paths, {"main.py"})

    def test_scan_empty_dir_returns_empty_list(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            files = _scan_directory(tmp)
            self.assertEqual(files, [])

    def test_scan_nonexistent_dir_raises(self):
        with self.assertRaises(FileNotFoundError):
            _scan_directory("/nonexistent/path/xxx")


# ---------------------------------------------------------------------------
# sha256_file
# ---------------------------------------------------------------------------

class Sha256FileTest(TestCase):

    def test_sha256_matches(self):
        import tempfile
        with tempfile.NamedTemporaryFile(delete=False, suffix=".txt") as f:
            f.write(b"hello world")
            path = Path(f.name)
        try:
            expected = hashlib.sha256(b"hello world").hexdigest()
            self.assertEqual(_sha256_file(path), expected)
        finally:
            path.unlink()


# ---------------------------------------------------------------------------
# validate_file_path (path traversal defense)
# ---------------------------------------------------------------------------

class ValidateFilePathTest(TestCase):

    def test_valid_path(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp)
            result = _validate_file_path("sub/file.py", dest)
            self.assertTrue(str(result).startswith(str(dest.resolve())))

    def test_rejects_absolute_path(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError, msg="拒绝不安全"):
                _validate_file_path("/etc/passwd", Path(tmp))

    def test_rejects_dotdot_traversal(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError, msg="拒绝不安全"):
                _validate_file_path("../../etc/passwd", Path(tmp))


# ---------------------------------------------------------------------------
# publish
# ---------------------------------------------------------------------------

class PublishTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        apply_all_mocks(self)
        self.user_id = uid()
        self.wt_id = uid()
        self.client = PackageRegistryClient(
            user_id=self.user_id, organization_id=self.wt_id,
        )

    def test_publish_new_package(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "SKILL.md").write_text("# My Skill\n")
            (Path(tmp) / "main.py").write_text("print('hello')")

            with patch.object(PackageRegistryClient, "_upload_file"):
                result = self.client.publish(
                    directory=tmp,
                    namespace="test-ns",
                    name="test-skill",
                    organization_id=self.wt_id,
                )

            self.assertEqual(result["version_seq"], 1)
            self.assertEqual(result["namespace"], "test-ns")
            self.assertEqual(result["name"], "test-skill")
            self.assertEqual(result["file_count"], 2)

    def test_publish_existing_package_increments_version(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "v1.py").write_text("v1")

            with patch.object(PackageRegistryClient, "_upload_file"):
                r1 = self.client.publish(
                    directory=tmp, namespace="inc-ns", name="inc-pkg",
                    organization_id=self.wt_id,
                )

            (Path(tmp) / "v2.py").write_text("v2")
            with patch.object(PackageRegistryClient, "_upload_file"):
                r2 = self.client.publish(
                    directory=tmp, namespace="inc-ns", name="inc-pkg",
                    organization_id=self.wt_id,
                )

            self.assertEqual(r1["version_seq"], 1)
            self.assertEqual(r2["version_seq"], 2)

    def test_publish_organization_mismatch_raises(self):
        """P1 安全修复：publish 时归属 organization 不匹配应拒绝。"""
        import tempfile
        other_wt = uid()
        services.create_package(
            namespace="wt-test", name="pkg",
            organization_id=other_wt, created_by=self.user_id,
        )
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "x.py").write_text("x")
            with self.assertRaises(PermissionError, msg="ORGANIZATION_MISMATCH"):
                self.client.publish(
                    directory=tmp, namespace="wt-test", name="pkg",
                    organization_id=self.wt_id,
                )

    def test_publish_empty_dir_raises(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError, msg="目录为空"):
                self.client.publish(
                    directory=tmp, namespace="e", name="empty",
                    organization_id=self.wt_id,
                )

    def test_publish_no_organization_raises(self):
        client = PackageRegistryClient(user_id=self.user_id)
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "x.py").write_text("x")
            with self.assertRaises(ValueError, msg="organization_id"):
                client.publish(directory=tmp, namespace="n", name="p")


# ---------------------------------------------------------------------------
# install
# ---------------------------------------------------------------------------

class InstallTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        apply_all_mocks(self)
        self.user_id = uid()
        self.wt_id = uid()
        create_published_package(self.user_id, "inst-ns", "inst-pkg", self.wt_id)
        self.client = PackageRegistryClient(user_id=self.user_id)

    def test_install_downloads_and_verifies_sha256(self):
        """install 后文件在目标目录（非临时目录），SHA256 校验通过。"""
        import tempfile
        content = b"print('hello')"

        with tempfile.TemporaryDirectory() as target:
            def fake_download(url, dest, **kw):
                dest.write_bytes(content)

            with patch.object(
                PackageRegistryClient, "_download_file", side_effect=fake_download,
            ), patch(
                "apps.services.package_registry.client._sha256_file",
                return_value="a" * 64,
            ):
                result = self.client.install(
                    namespace="inst-ns", name="inst-pkg",
                    target_dir=target,
                )

            self.assertEqual(result["version_seq"], 1)
            self.assertEqual(len(result["files"]), 1)
            # 文件落在目标目录，不在临时目录
            tmp_dir = Path(target).resolve().parent / (Path(target).resolve().name + ".tmp_install")
            self.assertFalse(tmp_dir.exists())

    def test_install_failure_no_residual_files(self):
        """install 下载失败时，目标目录不会出现残留文件。"""
        import tempfile

        with tempfile.TemporaryDirectory() as parent:
            target = str(Path(parent) / "pkg_target")

            call_count = 0

            def failing_download(url, dest, **kw):
                nonlocal call_count
                call_count += 1
                raise ConnectionError("network down")

            with patch.object(
                PackageRegistryClient, "_download_file", side_effect=failing_download,
            ), patch(
                "apps.services.package_registry.client._sha256_file",
                return_value="a" * 64,
            ):
                with self.assertRaises(ConnectionError):
                    self.client.install(
                        namespace="inst-ns", name="inst-pkg",
                        target_dir=target,
                    )

            # 目标目录和临时目录都不应存在
            self.assertFalse(Path(target).exists())
            tmp_dir = Path(target).resolve().parent / (Path(target).resolve().name + ".tmp_install")
            self.assertFalse(tmp_dir.exists())

    def test_install_sha256_mismatch_cleans_tmp(self):
        """SHA256 校验失败时，临时目录被清理，目标目录无残留。"""
        import tempfile

        with tempfile.TemporaryDirectory() as parent:
            target = str(Path(parent) / "sha_target")

            def fake_download(url, dest, **kw):
                dest.write_bytes(b"corrupted data")

            with patch.object(
                PackageRegistryClient, "_download_file", side_effect=fake_download,
            ), patch(
                "apps.services.package_registry.client._sha256_file",
                return_value="f" * 64,
            ):
                with self.assertRaises(RuntimeError, msg="SHA256"):
                    self.client.install(
                        namespace="inst-ns", name="inst-pkg",
                        target_dir=target,
                    )

            self.assertFalse(Path(target).exists())
            tmp_dir = Path(target).resolve().parent / (Path(target).resolve().name + ".tmp_install")
            self.assertFalse(tmp_dir.exists())

    def test_install_package_not_found(self):
        with self.assertRaises(LookupError):
            self.client.install(namespace="no-such", name="pkg")

    def test_install_no_versions(self):
        services.create_package(
            namespace="empty-ns", name="empty-pkg",
            organization_id=self.wt_id, created_by=self.user_id,
        )
        with self.assertRaises(LookupError, msg="没有可用"):
            self.client.install(namespace="empty-ns", name="empty-pkg")


# ---------------------------------------------------------------------------
# install yanked version fallback
# ---------------------------------------------------------------------------

class InstallYankedFallbackTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        apply_all_mocks(self)
        self.user_id = uid()
        self.wt_id = uid()
        self.pkg = create_published_package(self.user_id, "yk-fb", "pkg", self.wt_id)
        sha2 = "b" * 64
        init2 = services.init_version(
            package=self.pkg,
            files=[{"path": "v2.py", "sha256": sha2, "size": 200}],
            manifest={}, version_label="2.0", user_id=self.user_id,
        )
        from apps.services.package_registry.models import PackageVersion
        from apps.services.package_registry.tests.conftest import compute_bundle
        v2 = PackageVersion.objects.get(id=init2["version_id"])
        bundle2 = compute_bundle([("v2.py", sha2)])
        services.finalize_version(
            package=self.pkg, version=v2,
            bundle_sha256=bundle2,
            init_files=[{"path": "v2.py", "sha256": sha2, "size": 200}],
            user_id=self.user_id,
        )
        services.yank_version(
            package=self.pkg, version_seq=2,
            reason="broken", user_id=self.user_id,
        )
        self.client = PackageRegistryClient(user_id=self.user_id)

    def test_install_auto_fallback_to_non_yanked(self):
        """P0 修复：yank v2 后，install 不指定版本应自动回退到 v1。"""
        import tempfile
        with tempfile.TemporaryDirectory() as target:
            with patch.object(
                PackageRegistryClient, "_download_file",
                side_effect=lambda url, dest, **kw: dest.write_bytes(b"content"),
            ), patch(
                "apps.services.package_registry.client._sha256_file",
                return_value="a" * 64,
            ):
                result = self.client.install(
                    namespace="yk-fb", name="pkg", target_dir=target,
                )
            self.assertEqual(result["version_seq"], 1)


# ---------------------------------------------------------------------------
# list_versions
# ---------------------------------------------------------------------------

class ListVersionsTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        apply_all_mocks(self)
        self.user_id = uid()
        self.wt_id = uid()
        create_published_package(self.user_id, "lv-ns", "lv-pkg", self.wt_id)
        self.client = PackageRegistryClient(user_id=self.user_id)

    def test_list_returns_versions(self):
        versions = self.client.list_versions("lv-ns", "lv-pkg")
        self.assertEqual(len(versions), 1)
        self.assertEqual(versions[0]["version_seq"], 1)

    def test_list_not_found(self):
        with self.assertRaises(LookupError):
            self.client.list_versions("no", "pkg")


# ---------------------------------------------------------------------------
# yank
# ---------------------------------------------------------------------------

class YankTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        apply_all_mocks(self)
        self.user_id = uid()
        self.wt_id = uid()
        create_published_package(self.user_id, "yk-ns", "yk-pkg", self.wt_id)
        self.client = PackageRegistryClient(user_id=self.user_id)

    def test_yank_success(self):
        result = self.client.yank("yk-ns", "yk-pkg", version_seq=1, reason="broken")
        self.assertIn("yanked_at", result)

    def test_yank_not_found(self):
        with self.assertRaises(LookupError):
            self.client.yank("yk-ns", "yk-pkg", version_seq=999, reason="nope")


# ---------------------------------------------------------------------------
# fork
# ---------------------------------------------------------------------------

class ForkTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        apply_all_mocks(self)
        self.user_id = uid()
        self.wt_id = uid()
        create_published_package(self.user_id, "fk-src", "fk-pkg", self.wt_id)
        self.client = PackageRegistryClient(
            user_id=self.user_id, organization_id=self.wt_id,
        )

    def test_fork_success(self):
        result = self.client.fork(
            source_ns="fk-src", source_name="fk-pkg",
            target_ns="fk-dst", target_name="fk-copy",
        )
        self.assertIn("new_package_id", result)
        self.assertEqual(result["copied_versions"], 1)

    def test_fork_with_version_seq(self):
        """P1 修复：fork 支持 fork_at_version_seq 参数。"""
        result = self.client.fork(
            source_ns="fk-src", source_name="fk-pkg",
            target_ns="fk-dst2", target_name="fk-partial",
            fork_at_version_seq=1,
        )
        self.assertEqual(result["copied_versions"], 1)

    def test_fork_source_not_found(self):
        with self.assertRaises(LookupError):
            self.client.fork(
                source_ns="no", source_name="pkg",
                target_ns="dst", target_name="x",
            )

    def test_fork_no_organization_raises(self):
        client = PackageRegistryClient(user_id=self.user_id)
        with self.assertRaises(ValueError, msg="organization_id"):
            client.fork(
                source_ns="fk-src", source_name="fk-pkg",
                target_ns="fk-dst3", target_name="fk-copy3",
            )


# ---------------------------------------------------------------------------
# download retry
# ---------------------------------------------------------------------------

class DownloadRetryTest(TestCase):
    """_download_file 指数退避重试机制测试。"""

    def test_retry_success_on_second_attempt(self):
        """首次 URLError，第二次成功 → 最终成功。"""
        import tempfile
        attempts = []

        original_urlopen = None

        def fake_urlopen(req, **kw):
            attempts.append(1)
            if len(attempts) == 1:
                raise urllib.error.URLError("transient")
            # 返回一个简单的 response-like 对象
            import io

            class FakeResp:
                def read(self, n):
                    if not hasattr(self, '_done'):
                        self._done = True
                        return b"file content"
                    return b""
                def __enter__(self): return self
                def __exit__(self, *a): pass

            return FakeResp()

        with tempfile.NamedTemporaryFile(delete=False, suffix=".txt") as f:
            dest = Path(f.name)
        try:
            with patch("urllib.request.urlopen", side_effect=fake_urlopen), \
                 patch("time.sleep"):
                PackageRegistryClient._download_file("http://example.com/f", dest)
            self.assertEqual(len(attempts), 2)
            self.assertEqual(dest.read_bytes(), b"file content")
        finally:
            dest.unlink(missing_ok=True)

    def test_retry_all_fail_raises_original(self):
        """3 次全失败 → 抛出最后的 URLError。"""
        import tempfile
        attempts = []

        def always_fail(req, **kw):
            attempts.append(1)
            raise urllib.error.URLError("persistent failure")

        with tempfile.NamedTemporaryFile(delete=False, suffix=".txt") as f:
            dest = Path(f.name)
        try:
            with patch("urllib.request.urlopen", side_effect=always_fail), \
                 patch("time.sleep"):
                with self.assertRaises(urllib.error.URLError):
                    PackageRegistryClient._download_file("http://example.com/f", dest)
            self.assertEqual(len(attempts), 3)
        finally:
            dest.unlink(missing_ok=True)

    def test_retry_connection_error(self):
        """ConnectionError 也触发重试。"""
        import tempfile
        attempts = []

        def fail_then_ok(req, **kw):
            attempts.append(1)
            if len(attempts) <= 2:
                raise ConnectionError("reset")
            import io

            class FakeResp:
                def read(self, n):
                    if not hasattr(self, '_done'):
                        self._done = True
                        return b"ok"
                    return b""
                def __enter__(self): return self
                def __exit__(self, *a): pass

            return FakeResp()

        with tempfile.NamedTemporaryFile(delete=False, suffix=".txt") as f:
            dest = Path(f.name)
        try:
            with patch("urllib.request.urlopen", side_effect=fail_then_ok), \
                 patch("time.sleep"):
                PackageRegistryClient._download_file("http://example.com/f", dest)
            self.assertEqual(len(attempts), 3)
        finally:
            dest.unlink(missing_ok=True)

    def test_non_retryable_error_raises_immediately(self):
        """ValueError 等非网络异常不重试，直接抛出。"""
        import tempfile

        def raise_value_error(req, **kw):
            raise ValueError("bad url")

        with tempfile.NamedTemporaryFile(delete=False, suffix=".txt") as f:
            dest = Path(f.name)
        try:
            with patch("urllib.request.urlopen", side_effect=raise_value_error), \
                 patch("time.sleep"):
                with self.assertRaises(ValueError):
                    PackageRegistryClient._download_file("http://example.com/f", dest)
        finally:
            dest.unlink(missing_ok=True)

    def test_retry_exponential_backoff_intervals(self):
        """验证指数退避间隔：1s, 2s。"""
        import tempfile
        sleep_calls = []

        def always_fail(req, **kw):
            raise urllib.error.URLError("fail")

        def track_sleep(seconds):
            sleep_calls.append(seconds)

        with tempfile.NamedTemporaryFile(delete=False, suffix=".txt") as f:
            dest = Path(f.name)
        try:
            with patch("urllib.request.urlopen", side_effect=always_fail), \
                 patch("time.sleep", side_effect=track_sleep):
                with self.assertRaises(urllib.error.URLError):
                    PackageRegistryClient._download_file("http://example.com/f", dest)
            # 3 attempts: sleep after 1st (1s) and 2nd (2s), no sleep after 3rd
            self.assertEqual(sleep_calls, [1, 2])
        finally:
            dest.unlink(missing_ok=True)
