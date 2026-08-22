"""A3 验证 — _init_files 脱离 manifest JSONField。

核心断言:
1. 新发布(走新代码路径)写入 PackageVersion.init_files 字段,
   manifest **不**含 _init_files。
2. finalize 后 init_files 字段被清空,manifest 保持纯净。
3. 数据迁移 0003 能把老格式 ``manifest._init_files`` 迁到 ``init_files`` 字段,
   迁移完成后 manifest 不再含 _init_files。
4. finalize 端点能兼容残留老数据(manifest 中仍有 _init_files 但
   init_files 字段为空)的情况(双路径都跑通)。

运行方式::

    cd apps/tabtin_django && source venv/bin/activate
    python manage.py test \\
        apps.services.package_registry.tests.test_init_files_storage \\
        --settings=tabtin.settings_package_registry_test --verbosity=2
"""

from __future__ import annotations

import importlib
import uuid
from unittest.mock import patch

from django.test import TestCase

from apps.services.package_registry import services
from apps.services.package_registry.models import (
    Package,
    PackageVersion,
)
from apps.services.package_registry.tests.conftest import (
    apply_all_mocks,
    compute_bundle,
    uid as _uid,
)


# ---------------------------------------------------------------------------
# 1. 新代码路径 — manifest 不再被污染
# ---------------------------------------------------------------------------

class InitFilesIsolatedFromManifestTest(TestCase):
    """新发布走 init_version → finalize_version,manifest 始终不含 _init_files。"""

    databases = {"default", "postgresql"}

    def setUp(self):
        apply_all_mocks(self)
        self.user_id = _uid()
        self.wt_id = _uid()
        self.pkg = services.create_package(
            namespace="a3-iso", name="probe",
            organization_id=self.wt_id, created_by=self.user_id,
        )

    def test_init_version_writes_to_init_files_field(self):
        """init_version 应把 files 写入 init_files,不写入 manifest。"""
        files = [{"path": "main.py", "sha256": "a" * 64, "size": 100}]
        manifest = {"type": "skill", "name": "iso-test"}

        result = services.init_version(
            package=self.pkg,
            files=files,
            manifest=manifest,
            version_label="v1",
            user_id=self.user_id,
        )
        v = PackageVersion.objects.get(id=result["version_id"])

        # init_files 独立字段持有 files
        self.assertEqual(len(v.init_files), 1)
        self.assertEqual(v.init_files[0]["path"], "main.py")
        self.assertEqual(v.init_files[0]["sha256"], "a" * 64)

        # manifest 不应被污染
        self.assertNotIn("_init_files", v.manifest)
        # 用户 manifest 数据完整保留
        self.assertEqual(v.manifest.get("type"), "skill")
        self.assertEqual(v.manifest.get("name"), "iso-test")

    def test_finalize_clears_init_files_and_keeps_manifest(self):
        """finalize 之后 init_files 字段被清空,manifest 保持用户数据。"""
        files = [{"path": "main.py", "sha256": "a" * 64, "size": 100}]
        manifest = {"type": "skill", "vendor": "demo-app"}

        init = services.init_version(
            package=self.pkg, files=files, manifest=manifest,
            version_label=None, user_id=self.user_id,
        )
        v = PackageVersion.objects.get(id=init["version_id"])
        bundle = compute_bundle([("main.py", "a" * 64)])
        services.finalize_version(
            package=self.pkg, version=v,
            bundle_sha256=bundle,
            init_files=files,
            user_id=self.user_id,
        )
        v.refresh_from_db()

        self.assertEqual(v.status, PackageVersion.Status.PUBLISHED)
        self.assertEqual(v.init_files, [])
        self.assertNotIn("_init_files", v.manifest)
        self.assertEqual(v.manifest.get("type"), "skill")
        self.assertEqual(v.manifest.get("vendor"), "demo-app")

    def test_init_files_independent_of_manifest_size(self):
        """大量 files(100 个)进 init_files,不污染 manifest 体积。"""
        files = [
            {"path": f"f{i}.py", "sha256": f"{i:064x}", "size": 10}
            for i in range(100)
        ]
        manifest = {"name": "many"}

        init = services.init_version(
            package=self.pkg, files=files, manifest=manifest,
            version_label=None, user_id=self.user_id,
        )
        v = PackageVersion.objects.get(id=init["version_id"])

        self.assertEqual(len(v.init_files), 100)
        self.assertEqual(set(v.manifest.keys()), {"name"})


# ---------------------------------------------------------------------------
# 2. 数据迁移 0003 行为验证
# ---------------------------------------------------------------------------

class InitFilesMigrationFunctionTest(TestCase):
    """直接调用 migration 0003 的迁移函数,验证它把老数据搬到新字段。"""

    databases = {"default", "postgresql"}

    def setUp(self):
        # 用 silence 模式 mock OSS / EventBus / 权限,避免迁移 setup 误触
        apply_all_mocks(self)
        self.user_id = _uid()
        self.wt_id = _uid()
        self.pkg = services.create_package(
            namespace="a3-mig", name="legacy",
            organization_id=self.wt_id, created_by=self.user_id,
        )

    def _legacy_row(self, files: list[dict], extra_manifest: dict | None = None):
        """模拟 0003 之前的数据形态:_init_files 在 manifest 中,init_files 字段为空。"""
        manifest = dict(extra_manifest or {})
        manifest["_init_files"] = list(files)
        v = PackageVersion.objects.create(
            package=self.pkg,
            status=PackageVersion.Status.UPLOADING,
            manifest=manifest,
            init_files=[],  # 空 — 模拟老数据
            created_by=self.user_id,
        )
        return v

    def _run_forward(self):
        """以 schema_editor 风格调用 0003 的 _move_init_files。"""
        from django.apps import apps as django_apps
        from django.db import connections

        mig = importlib.import_module(
            "apps.services.package_registry.migrations."
            "0003_packageversion_init_files"
        )
        # 在测试上下文中 apps 直接给 django.apps,using 通过 connection 拿
        class _FakeSchemaEditor:
            connection = connections["postgresql"]
        mig._move_init_files(django_apps, _FakeSchemaEditor())

    def test_legacy_data_migrated_to_new_field(self):
        files = [
            {"path": "old.py", "sha256": "a" * 64, "size": 99},
            {"path": "old2.py", "sha256": "b" * 64, "size": 33},
        ]
        v = self._legacy_row(files, extra_manifest={"type": "skill"})

        self._run_forward()
        v.refresh_from_db()

        self.assertEqual(len(v.init_files), 2)
        self.assertEqual(
            {f["path"] for f in v.init_files},
            {"old.py", "old2.py"},
        )
        self.assertNotIn("_init_files", v.manifest)
        # 用户业务数据保留
        self.assertEqual(v.manifest.get("type"), "skill")

    def test_migration_idempotent_on_already_clean_rows(self):
        """已经走新代码发布的行(没有 manifest._init_files)迁移函数应静默跳过。"""
        files = [{"path": "n.py", "sha256": "c" * 64, "size": 1}]
        v = PackageVersion.objects.create(
            package=self.pkg,
            status=PackageVersion.Status.UPLOADING,
            manifest={"name": "new"},
            init_files=files,
            created_by=self.user_id,
        )

        self._run_forward()
        v.refresh_from_db()

        # 数据保持不变
        self.assertEqual(v.init_files, files)
        self.assertEqual(v.manifest, {"name": "new"})

    def test_migration_strips_init_files_from_manifest_even_when_empty(self):
        """老数据 _init_files 是 [] 也要被剥掉(避免迁移后 manifest 仍带这个 key)。"""
        v = self._legacy_row([], extra_manifest={"vendor": "x"})

        self._run_forward()
        v.refresh_from_db()

        self.assertEqual(v.init_files, [])
        self.assertNotIn("_init_files", v.manifest)
        self.assertEqual(v.manifest.get("vendor"), "x")


# ---------------------------------------------------------------------------
# 3. finalize 端点同时兼容新老两条数据路径(双 fallback)
# ---------------------------------------------------------------------------

class FinalizeReadsInitFilesFallbackTest(TestCase):
    """api.finalize_version 读取 init_files 时,优先新字段,残留老数据可读。

    场景:运行 0003 迁移之前,某行已经处于 UPLOADING(manifest 带 _init_files,
    init_files 字段为 []),客户端在迁移 *之后* 才来 finalize — 此时新代码必须
    能从 manifest 兜底读出。
    """

    databases = {"default", "postgresql"}

    def setUp(self):
        apply_all_mocks(self)
        self.user_id = _uid()
        self.wt_id = _uid()
        self.pkg = services.create_package(
            namespace="a3-fb", name="fallback",
            organization_id=self.wt_id, created_by=self.user_id,
        )

    def test_legacy_uploading_can_still_finalize(self):
        files = [{"path": "leg.py", "sha256": "a" * 64, "size": 50}]
        # 模拟未迁移的老 UPLOADING 行
        v = PackageVersion.objects.create(
            package=self.pkg,
            status=PackageVersion.Status.UPLOADING,
            manifest={"type": "skill", "_init_files": files},
            init_files=[],  # 老数据为空
            created_by=self.user_id,
        )

        # 模拟 api 层读取逻辑(参考 api.py 中 finalize_version 端点)
        init_files_data = (
            list(v.init_files)
            if v.init_files
            else v.manifest.get("_init_files")
        )
        self.assertEqual(init_files_data, files)

        bundle = compute_bundle([("leg.py", "a" * 64)])
        services.finalize_version(
            package=self.pkg, version=v,
            bundle_sha256=bundle, init_files=init_files_data,
            user_id=self.user_id,
        )
        v.refresh_from_db()

        self.assertEqual(v.status, PackageVersion.Status.PUBLISHED)
        self.assertNotIn("_init_files", v.manifest)
        self.assertEqual(v.init_files, [])
        self.assertEqual(v.manifest.get("type"), "skill")


# ---------------------------------------------------------------------------
# 4. Schema source check:防止后人重新把 _init_files 塞回 manifest
# ---------------------------------------------------------------------------

class ModelHasInitFilesFieldTest(TestCase):
    """直接对 PackageVersion 字段集合做静态断言。"""

    def test_packageversion_has_init_files_field(self):
        names = {f.name for f in PackageVersion._meta.get_fields()}
        self.assertIn("init_files", names, "A3 要求 PackageVersion 有 init_files 独立字段")

    def test_packageversion_init_files_default_is_list(self):
        from django.db import models

        f = PackageVersion._meta.get_field("init_files")
        self.assertIsInstance(f, models.JSONField)
        # default 应该是 list(可变默认值是用 callable 注册,这里取 default 检查类型)
        self.assertEqual(f.default, list)


# ---------------------------------------------------------------------------
# 5. fork_package 不传染 manifest._init_files 残留(BLOCKER 防退化)
# ---------------------------------------------------------------------------

class ForkStripsLegacyInitFilesFromManifestTest(TestCase):
    """fork_package 必须清洗 source.manifest._init_files,避免跨 namespace 传染。

    场景:某个 source PackageVersion 因 0003 异常或蓝绿部署窗口期产生了
    "manifest 残留 _init_files"的脏行。fork 操作如果原样复制 manifest,
    会把 legacy 数据带进新 namespace,违反 A3 字段隔离承诺。
    """

    databases = {"default", "postgresql"}

    def setUp(self):
        apply_all_mocks(self)
        self.user_id = _uid()
        self.wt_id = _uid()
        self.target_wt_id = _uid()
        self.src_pkg = services.create_package(
            namespace="a3-fork-src", name="origin",
            organization_id=self.wt_id, created_by=self.user_id,
        )

    def test_fork_strips_legacy_init_files_from_manifest(self):
        """构造 source 含残留 _init_files 的 published 版本,fork 后新版本必须纯净。"""
        legacy_files = [{"path": "legacy.py", "sha256": "a" * 64, "size": 10}]

        # 直接构造一个"被污染"的已发布 source 版本(模拟 migration 异常残留 / 老进程写入)
        src_v = PackageVersion.objects.create(
            package=self.src_pkg,
            status=PackageVersion.Status.PUBLISHED,
            version_seq=1,
            version_label="1.0",
            bundle_sha256="b" * 64,
            file_count=1,
            total_size=10,
            manifest={
                "type": "skill",
                "vendor": "demo-app",
                "_init_files": legacy_files,  # ← 污染:本不该出现在 published 行
            },
            init_files=[],
            created_by=self.user_id,
        )
        self.src_pkg.latest_version_seq = 1
        self.src_pkg.save(update_fields=["latest_version_seq"])

        # 执行 fork
        result = services.fork_package(
            source_package=self.src_pkg,
            target_namespace="a3-fork-dst",
            target_name="forked",
            target_organization_id=self.target_wt_id,
            user_id=self.user_id,
        )

        # 取 fork 出的新 version
        new_pkg = Package.objects.get(id=result["new_package_id"])
        new_v = PackageVersion.objects.get(package=new_pkg, version_seq=1)

        # 关键断言:fork 必须剥离 _init_files
        self.assertNotIn(
            "_init_files", new_v.manifest,
            "fork 必须清洗 manifest._init_files,否则会跨 namespace 传染 legacy 数据",
        )
        # 用户业务字段保留
        self.assertEqual(new_v.manifest.get("type"), "skill")
        self.assertEqual(new_v.manifest.get("vendor"), "demo-app")
        # init_files 字段必须显式为空 list(fork 出的新版本视为已 published 状态)
        self.assertEqual(new_v.init_files, [])
        # source 自身不被改动(fork 是 copy,不动 source)
        src_v.refresh_from_db()
        self.assertIn("_init_files", src_v.manifest)
