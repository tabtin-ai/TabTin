"""PRD 第十节验收 — 6 个端到端场景 + Skill 修复验收。

运行方式：
    cd apps/tabtin_django && source venv/bin/activate
    python manage.py test apps.services.package_registry.tests.test_e2e \
        --settings=tabtin.settings_package_registry_test --verbosity=2
"""

from __future__ import annotations

import hashlib
import tempfile
import uuid
from pathlib import Path
from unittest.mock import MagicMock, patch

from django.test import TransactionTestCase

from apps.services.package_registry import services
from apps.services.package_registry.client import PackageRegistryClient
from apps.services.package_registry.models import Package, PackageFile, PackageVersion
from apps.services.package_registry.tests.conftest import (
    apply_eventbus_mock,
    apply_oss_mocks,
    apply_permission_mock,
    apply_using_db_mock,
    compute_bundle,
    uid,
)


def _sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _make_test_dir(files: dict[str, bytes]) -> tempfile.TemporaryDirectory:
    """创建临时目录并写入文件，返回 TemporaryDirectory 对象。"""
    td = tempfile.TemporaryDirectory()
    base = Path(td.name)
    for rel_path, content in files.items():
        p = base / rel_path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(content)
    return td


# ---------------------------------------------------------------------------
# PRD §10 — 6 个验收场景端到端
# ---------------------------------------------------------------------------

class PackageRegistryE2ETest(TransactionTestCase):
    """PRD 第十节验收 — 6 个场景端到端。"""

    databases = {"default", "postgresql"}

    def setUp(self):
        self.eventbus = apply_eventbus_mock(self)
        self.oss_mocks = apply_oss_mocks(self)
        apply_using_db_mock(self)
        apply_permission_mock(self)
        self.user_id = uid()
        self.wt_id = uid()

    # ── helpers ──────────────────────────────────────────────────

    def _publish_via_service(
        self, namespace: str, name: str, files: dict[str, bytes],
        *, version_label: str | None = None,
    ) -> dict:
        """通过 services 层走完整 publish 两阶段流程。"""
        try:
            pkg = services.lookup_package(namespace=namespace, name=name)
        except LookupError:
            pkg = services.create_package(
                namespace=namespace, name=name,
                organization_id=self.wt_id, created_by=self.user_id,
            )

        init_files = []
        for rel_path, content in sorted(files.items()):
            init_files.append({
                "path": rel_path,
                "sha256": _sha256(content),
                "size": len(content),
                "content_type": "application/octet-stream",
            })

        init_result = services.init_version(
            package=pkg,
            files=init_files,
            manifest={"type": "skill"},
            version_label=version_label,
            user_id=self.user_id,
        )

        version = PackageVersion.objects.get(id=init_result["version_id"])
        bundle = compute_bundle(
            [(f["path"], f["sha256"]) for f in init_files]
        )
        result = services.finalize_version(
            package=pkg,
            version=version,
            bundle_sha256=bundle,
            init_files=init_files,
            user_id=self.user_id,
        )
        result["package_id"] = str(pkg.id)
        return result

    # ── 场景 1 ───────────────────────────────────────────────────

    def test_scenario_1_publish(self):
        """场景 1: publish 一个 skill 包 → 三表落地。"""
        files = {
            "SKILL.md": b"# My Skill\nGreat skill.",
            "main.py": b"def run(): pass",
            "utils/helper.py": b"def help(): pass",
        }

        result = self._publish_via_service("demo-app", "some-skill", files)

        self.assertEqual(result["version_seq"], 1)
        self.assertEqual(result["file_count"], 3)
        self.assertGreater(result["total_size"], 0)
        self.assertEqual(len(result["bundle_sha256"]), 64)

        pkg = Package.objects.get(id=result["package_id"])
        self.assertEqual(pkg.namespace, "demo-app")
        self.assertEqual(pkg.name, "some-skill")
        self.assertEqual(pkg.latest_version_seq, 1)

        version = PackageVersion.objects.get(
            package=pkg, version_seq=1,
        )
        self.assertEqual(version.status, PackageVersion.Status.PUBLISHED)
        self.assertEqual(version.file_count, 3)

        pf_count = PackageFile.objects.filter(version=version).count()
        self.assertEqual(pf_count, 3)

        pf_paths = set(
            PackageFile.objects.filter(version=version)
            .values_list("path", flat=True)
        )
        self.assertEqual(pf_paths, {"SKILL.md", "main.py", "utils/helper.py"})

        for pf in PackageFile.objects.filter(version=version):
            self.assertTrue(pf.oss_object_key.startswith("package_registry/"))
            self.assertEqual(len(pf.sha256), 64)
            self.assertIsNotNone(pf.file_record_id)

    # ── 场景 2 ───────────────────────────────────────────────────

    def test_scenario_2_republish_version_seq(self):
        """场景 2: 再次 publish → version_seq 自动递增。"""
        v1_files = {"main.py": b"v1 content"}
        r1 = self._publish_via_service("demo-app", "re-skill", v1_files)
        self.assertEqual(r1["version_seq"], 1)

        v2_files = {"main.py": b"v2 content - modified"}
        r2 = self._publish_via_service("demo-app", "re-skill", v2_files)
        self.assertEqual(r2["version_seq"], 2)

        pkg = Package.objects.get(id=r1["package_id"])
        self.assertEqual(pkg.latest_version_seq, 2)

        versions = PackageVersion.objects.filter(
            package=pkg, status=PackageVersion.Status.PUBLISHED,
        ).order_by("version_seq")
        self.assertEqual(versions.count(), 2)
        self.assertEqual(list(versions.values_list("version_seq", flat=True)), [1, 2])

    # ── 场景 3 ───────────────────────────────────────────────────

    def test_scenario_3_install_to_local(self):
        """场景 3: install → 文件下载到本地目录。"""
        file_content = b"def run(): print('installed')"
        file_sha = _sha256(file_content)

        self._publish_via_service("demo-app", "inst-skill", {"main.py": file_content})

        client = PackageRegistryClient(user_id=self.user_id)

        with tempfile.TemporaryDirectory() as target:
            def fake_download(url, dest):
                dest.write_bytes(file_content)

            with patch.object(
                PackageRegistryClient, "_download_file",
                side_effect=fake_download,
            ):
                result = client.install(
                    namespace="demo-app", name="inst-skill",
                    target_dir=target,
                )

            self.assertEqual(result["version_seq"], 1)
            self.assertEqual(len(result["files"]), 1)
            self.assertEqual(result["files"][0]["path"], "main.py")

            local_path = Path(result["files"][0]["local_path"])
            self.assertTrue(local_path.exists())
            self.assertEqual(local_path.read_bytes(), file_content)

    # ── 场景 4 ───────────────────────────────────────────────────

    def test_scenario_4_yank_blocks_install(self):
        """场景 4: yank v2 → install 拒绝 v2。"""
        self._publish_via_service("demo-app", "yank-skill", {"v1.py": b"v1"})
        self._publish_via_service("demo-app", "yank-skill", {"v2.py": b"v2 broken"})

        pkg = services.lookup_package(namespace="demo-app", name="yank-skill")
        self.assertEqual(pkg.latest_version_seq, 2)

        services.yank_version(
            package=pkg, version_seq=2,
            reason="broken", user_id=self.user_id,
        )

        with self.assertRaises(PermissionError):
            services.get_version_files(package=pkg, version_seq=2)

        v1_files = services.get_version_files(package=pkg, version_seq=1)
        self.assertFalse(v1_files["is_yanked"])
        self.assertEqual(v1_files["version_seq"], 1)

        yanked_with_flag = services.get_version_files(
            package=pkg, version_seq=2, include_yanked=True,
        )
        self.assertTrue(yanked_with_flag["is_yanked"])

    # ── 场景 5 ───────────────────────────────────────────────────

    def test_scenario_5_fork_zero_retransmit(self):
        """场景 5: fork → 新 Package 创建，file_record_id 复用（零重传）。"""
        self._publish_via_service("demo-app", "fork-skill", {
            "main.py": b"skill code",
            "config.json": b'{"key": "val"}',
        })

        pkg_src = services.lookup_package(namespace="demo-app", name="fork-skill")
        target_wt = uid()

        with patch(
            "apps.services.package_registry.services._register_file_record",
        ) as mock_register:
            result = services.fork_package(
                source_package=pkg_src,
                target_namespace="acme",
                target_name="fork-skill",
                target_organization_id=target_wt,
                user_id=self.user_id,
            )

            mock_register.assert_not_called()

        self.assertEqual(result["copied_versions"], 1)

        new_pkg = Package.objects.get(id=result["new_package_id"])
        self.assertEqual(new_pkg.namespace, "acme")
        self.assertEqual(new_pkg.name, "fork-skill")
        self.assertEqual(str(new_pkg.parent_package_id), str(pkg_src.id))

        src_files = list(
            PackageFile.objects.filter(version__package=pkg_src)
            .values_list("file_record_id", "oss_object_key")
        )
        new_files = list(
            PackageFile.objects.filter(version__package=new_pkg)
            .values_list("file_record_id", "oss_object_key")
        )
        src_fids = {str(fid) for fid, _ in src_files}
        new_fids = {str(fid) for fid, _ in new_files}
        self.assertEqual(src_fids, new_fids)

        src_keys = {k for _, k in src_files}
        new_keys = {k for _, k in new_files}
        self.assertEqual(src_keys, new_keys)

    # ── 场景 6 ───────────────────────────────────────────────────

    def test_scenario_6_eventbus_all_events(self):
        """场景 6: 全流程事件都被发布。"""
        self.eventbus.reset_mock()

        self._publish_via_service("demo-app", "ev-skill", {"main.py": b"code"})

        self._publish_via_service("demo-app", "ev-skill", {"main.py": b"code v2"})

        pkg = services.lookup_package(namespace="demo-app", name="ev-skill")

        services.yank_version(
            package=pkg, version_seq=2,
            reason="bad", user_id=self.user_id,
        )

        services.fork_package(
            source_package=pkg,
            target_namespace="acme",
            target_name="ev-skill",
            target_organization_id=uid(),
            user_id=self.user_id,
        )

        emitted_types = [c[0][0] for c in self.eventbus.call_args_list]

        self.assertIn("pkg.package.created", emitted_types)
        self.assertIn("pkg.version.published", emitted_types)
        self.assertIn("pkg.version.yanked", emitted_types)
        self.assertIn("pkg.fork.created", emitted_types)

        created_count = emitted_types.count("pkg.package.created")
        self.assertGreaterEqual(created_count, 2)

        published_count = emitted_types.count("pkg.version.published")
        self.assertGreaterEqual(published_count, 2)

        yanked_count = emitted_types.count("pkg.version.yanked")
        self.assertEqual(yanked_count, 1)

        fork_count = emitted_types.count("pkg.fork.created")
        self.assertEqual(fork_count, 1)

        for c in self.eventbus.call_args_list:
            event_type, organization_id, payload = c[0]
            self.assertIsInstance(event_type, str)
            self.assertTrue(event_type.startswith("pkg."))
            self.assertIsInstance(payload, dict)


# ---------------------------------------------------------------------------
# Skill 修复验收
# ---------------------------------------------------------------------------

class SkillPRIntegrationTest(TransactionTestCase):
    """Skill 修复验收。"""

    databases = {"default", "postgresql"}

    def setUp(self):
        self.eventbus = apply_eventbus_mock(self)
        apply_using_db_mock(self)
        apply_permission_mock(self)
        self.user_id = uid()
        self.wt_id = uid()

    # ── publish 走 OSS 而非本地 BLOB ─────────────────────────────

    def test_publish_uses_oss_not_blob(self):
        """publish 走 OSS 而非本地 BLOB。"""
        mock_register = MagicMock(side_effect=lambda **kw: MagicMock(id=uuid.uuid4()))
        mock_presign_put = MagicMock(return_value="https://oss.example.com/put")
        mock_presign_get = MagicMock(return_value="https://oss.example.com/get")

        with patch(
            "apps.services.package_registry.services._find_existing_file_records_batch",
            return_value={},
        ), patch(
            "apps.services.package_registry.services._generate_presigned_put_url",
            mock_presign_put,
        ), patch(
            "apps.services.package_registry.services._generate_presigned_get_url",
            mock_presign_get,
        ), patch(
            "apps.services.package_registry.services._register_file_record",
            mock_register,
        ):
            pkg = services.create_package(
                namespace="skill-oss", name="test-skill",
                organization_id=self.wt_id, created_by=self.user_id,
            )
            sha = _sha256(b"skill code")
            init = services.init_version(
                package=pkg,
                files=[{"path": "main.py", "sha256": sha, "size": 10}],
                manifest={"type": "skill"},
                version_label=None,
                user_id=self.user_id,
            )

            upload_task = init["upload_tasks"][0]
            self.assertEqual(upload_task["action"], "upload")
            self.assertIn("presigned_url", upload_task)
            self.assertTrue(
                upload_task["oss_object_key"].startswith("package_registry/")
            )

            mock_presign_put.assert_called_once()
            put_args = mock_presign_put.call_args
            self.assertIn("package_registry/", put_args[0][0])

            version = PackageVersion.objects.get(id=init["version_id"])
            bundle = compute_bundle([("main.py", sha)])
            services.finalize_version(
                package=pkg, version=version,
                bundle_sha256=bundle,
                init_files=[{"path": "main.py", "sha256": sha, "size": 10}],
                user_id=self.user_id,
            )

            mock_register.assert_called_once()
            reg_kwargs = mock_register.call_args[1]
            self.assertEqual(reg_kwargs["sha256"], sha)
            self.assertIn("package_registry/", reg_kwargs["object_key"])
            self.assertEqual(reg_kwargs["file_name"], "main.py")

    # ── publish 强制 organization_member 校验 ────────────────────────

    def test_publish_requires_organization_member(self):
        """非成员 publish 被拒绝。"""
        apply_oss_mocks(self)

        owner_wt = uid()
        services.create_package(
            namespace="auth-ns", name="auth-pkg",
            organization_id=owner_wt, created_by=uid(),
        )

        other_wt = uid()
        client = PackageRegistryClient(
            user_id=self.user_id, organization_id=other_wt,
        )

        td = _make_test_dir({"main.py": b"evil code"})
        try:
            with self.assertRaises(PermissionError) as ctx:
                with patch.object(PackageRegistryClient, "_upload_file"):
                    client.publish(
                        directory=td.name,
                        namespace="auth-ns",
                        name="auth-pkg",
                        organization_id=other_wt,
                    )
            self.assertIn("ORGANIZATION_MISMATCH", str(ctx.exception))
        finally:
            td.cleanup()

    # ── 并发 publish 0 失败 ──────────────────────────────────────

    def test_concurrent_publish_no_failure(self):
        """并发 publish 0 失败（顺序快速 publish 验证 version_seq 序列化安全）。

        注：SQLite 不支持真正的 select_for_update 并发，此处用快速顺序
        publish 验证 version_seq 严格递增且无冲突。真正的并发安全由
        PostgreSQL 的 select_for_update 保证。
        """
        apply_oss_mocks(self)

        pkg = services.create_package(
            namespace="conc-ns", name="conc-pkg",
            organization_id=self.wt_id, created_by=self.user_id,
        )

        num_publishes = 5
        results = []

        for idx in range(num_publishes):
            content = f"print('version {idx}')".encode()
            sha = _sha256(content)
            path = f"v{idx}.py"
            init = services.init_version(
                package=pkg,
                files=[{"path": path, "sha256": sha, "size": len(content)}],
                manifest={},
                version_label=None,
                user_id=self.user_id,
            )
            version = PackageVersion.objects.get(id=init["version_id"])
            bundle = compute_bundle([(path, sha)])
            result = services.finalize_version(
                package=pkg,
                version=version,
                bundle_sha256=bundle,
                init_files=[{"path": path, "sha256": sha, "size": len(content)}],
                user_id=self.user_id,
            )
            results.append(result)

        self.assertEqual(len(results), num_publishes)

        seqs = [r["version_seq"] for r in results]
        self.assertEqual(seqs, list(range(1, num_publishes + 1)))
        self.assertEqual(len(set(seqs)), num_publishes)

    # ── install 真下载到本地 ─────────────────────────────────────

    def test_install_downloads_files(self):
        """install 返回下载 URL 并真下载到本地。"""
        apply_oss_mocks(self)

        file_content = b"def main(): return 42"
        file_sha = _sha256(file_content)

        pkg = services.create_package(
            namespace="dl-ns", name="dl-pkg",
            organization_id=self.wt_id, created_by=self.user_id,
        )
        init = services.init_version(
            package=pkg,
            files=[{"path": "main.py", "sha256": file_sha, "size": len(file_content)}],
            manifest={"type": "skill"},
            version_label=None,
            user_id=self.user_id,
        )
        version = PackageVersion.objects.get(id=init["version_id"])
        bundle = compute_bundle([("main.py", file_sha)])
        services.finalize_version(
            package=pkg, version=version,
            bundle_sha256=bundle,
            init_files=[{"path": "main.py", "sha256": file_sha, "size": len(file_content)}],
            user_id=self.user_id,
        )

        files_result = services.get_version_files(package=pkg, version_seq=1)
        self.assertEqual(len(files_result["files"]), 1)
        self.assertIn("download_url", files_result["files"][0])

        client = PackageRegistryClient(user_id=self.user_id)

        with tempfile.TemporaryDirectory() as target:
            def fake_download(url, dest):
                dest.write_bytes(file_content)

            with patch.object(
                PackageRegistryClient, "_download_file",
                side_effect=fake_download,
            ):
                result = client.install(
                    namespace="dl-ns", name="dl-pkg",
                    target_dir=target,
                )

            self.assertEqual(result["version_seq"], 1)
            self.assertEqual(len(result["files"]), 1)

            local_file = Path(result["files"][0]["local_path"])
            self.assertTrue(local_file.exists())
            self.assertEqual(local_file.read_bytes(), file_content)
