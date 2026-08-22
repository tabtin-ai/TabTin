"""Package Registry 测试共享 fixtures 和 helpers。"""

from __future__ import annotations

import hashlib
import uuid
from unittest.mock import MagicMock, patch


def uid() -> str:
    return str(uuid.uuid4())


def compute_bundle(files: list[tuple[str, str]]) -> str:
    sorted_entries = sorted(files, key=lambda x: x[0])
    h = hashlib.sha256()
    for path, sha256 in sorted_entries:
        h.update(f"{path}:{sha256}".encode())
    return h.hexdigest()


MOCK_OSS_PATCHES = [
    patch(
        "apps.services.package_registry.services._find_existing_file_records_batch",
        return_value={},
    ),
    patch(
        "apps.services.package_registry.services._generate_presigned_put_url",
        return_value="https://oss.example.com/presigned-put",
    ),
    patch(
        "apps.services.package_registry.services._generate_presigned_get_url",
        return_value="https://oss.example.com/presigned-get",
    ),
    patch(
        "apps.services.package_registry.services._register_file_record",
        side_effect=lambda **kw: MagicMock(id=uuid.uuid4()),
    ),
]


def _make_fake_oss():
    """W4-修1:服务端 finalize_managed_skill_upsert 会调 get_oss_service() 读 SKILL.md。
    测试默认 mock 一个返回 success=False 的 OSS,跳过自动 upsert (除非测试自己显式提供内容)。
    """
    fake = MagicMock()
    fake.download_file.return_value = {
        "success": False,
        "message": "OSS mocked in test - no content",
    }
    return fake


def apply_oss_mocks(test_instance):
    for p in MOCK_OSS_PATCHES:
        m = p.start()
        test_instance.addCleanup(p.stop)
    # W4-修1:阻挡服务端 _read_skill_md_content 真实连阿里云
    p_oss = patch(
        "apps.services.oss.services.factory.get_oss_service",
        return_value=_make_fake_oss(),
    )
    p_oss.start()
    test_instance.addCleanup(p_oss.stop)


def apply_eventbus_mock(test_instance):
    p = patch("apps.services.package_registry.services.emit_on_commit")
    m = p.start()
    test_instance.addCleanup(p.stop)
    return m


def apply_permission_mock(test_instance):
    """Mock check_package_write_access to always pass (for tests that don't test permissions)."""
    p = patch("apps.services.package_registry.services.check_package_write_access")
    m = p.start()
    test_instance.addCleanup(p.stop)
    return m


def apply_using_db_mock(test_instance):
    p = patch("apps.services.package_registry.services._USING_DB", "postgresql")
    p.start()
    test_instance.addCleanup(p.stop)


def apply_all_mocks(test_instance):
    """一次应用全部标准 mock（OSS + EventBus + Permission + DB）。"""
    apply_oss_mocks(test_instance)
    apply_eventbus_mock(test_instance)
    apply_permission_mock(test_instance)
    apply_using_db_mock(test_instance)


def create_published_package(user_id: str, namespace: str, name: str, organization_id: str):
    """创建一个已发布的包（含 1 个版本 1 个文件）。"""
    from apps.services.package_registry import services
    from apps.services.package_registry.models import PackageVersion

    pkg = services.create_package(
        namespace=namespace, name=name,
        organization_id=organization_id, created_by=user_id,
    )
    sha = "a" * 64
    init = services.init_version(
        package=pkg,
        files=[{"path": "main.py", "sha256": sha, "size": 100}],
        manifest={"type": "skill"},
        version_label="1.0",
        user_id=user_id,
    )
    v = PackageVersion.objects.get(id=init["version_id"])
    bundle = compute_bundle([("main.py", sha)])
    services.finalize_version(
        package=pkg, version=v,
        bundle_sha256=bundle,
        init_files=[{"path": "main.py", "sha256": sha, "size": 100}],
        user_id=user_id,
    )
    return pkg
