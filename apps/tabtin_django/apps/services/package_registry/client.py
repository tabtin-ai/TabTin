"""Package Registry 客户端 SDK — 面向 CLI / 脚本的高级操作封装。

运行在 Django 环境中，直接调用 services.py 的函数（不走 HTTP API）。
文件上传通过 OSS 服务直接上传。
"""

from __future__ import annotations

import hashlib
import logging
import os
import shutil
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_IGNORED_DIRS = frozenset({
    "__pycache__", ".git", "node_modules", ".tox", ".mypy_cache",
    ".pytest_cache", ".eggs", "dist", "build",
})

_IGNORED_FILES = frozenset({
    ".DS_Store", "Thumbs.db", ".gitkeep",
})

_IGNORED_SUFFIXES = frozenset({
    ".pyc", ".pyo", ".egg-info", ".so", ".dylib",
})

_SENSITIVE_PATTERNS = frozenset({
    ".env", ".env.local", ".env.production", ".env.development",
    "credentials.json", ".npmrc", ".yarnrc",
})

_SENSITIVE_EXTENSIONS = frozenset({
    ".pem", ".key", ".p12", ".pfx", ".jks",
    ".secret", ".secrets",
})


def _should_ignore(name: str, *, is_dir: bool = False) -> bool:
    if is_dir:
        return name in _IGNORED_DIRS
    if name in _IGNORED_FILES or name in _SENSITIVE_PATTERNS:
        return True
    ext = Path(name).suffix.lower()
    if ext in _IGNORED_SUFFIXES or ext in _SENSITIVE_EXTENSIONS:
        return True
    if name.startswith(".env"):
        return True
    return False


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fp:
        for chunk in iter(lambda: fp.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _scan_directory(directory: str) -> list[dict[str, Any]]:
    """扫描目录下所有文件，返回 [{path, sha256, size, content_type, abs_path}]。"""
    base = Path(directory).resolve()
    if not base.is_dir():
        raise FileNotFoundError(f"目录不存在: {directory}")

    files = []
    for root, dirs, filenames in os.walk(base):
        dirs[:] = [d for d in dirs if not _should_ignore(d, is_dir=True)]
        for fname in filenames:
            if _should_ignore(fname):
                continue
            abs_path = Path(root) / fname
            rel_path = str(abs_path.relative_to(base))
            sha = _sha256_file(abs_path)
            files.append({
                "path": rel_path,
                "sha256": sha,
                "size": abs_path.stat().st_size,
                "content_type": _guess_content_type(fname),
                "abs_path": str(abs_path),
            })
    return files


def _guess_content_type(filename: str) -> str:
    from apps.services.package_registry.utils import guess_content_type
    return guess_content_type(filename)


def _read_manifest_from_dir(directory: str) -> dict[str, Any]:
    """从目录读取 manifest 信息（SKILL.md frontmatter 或 manifest.json）。"""
    import json
    base = Path(directory).resolve()

    manifest_json = base / "manifest.json"
    if manifest_json.is_file():
        with manifest_json.open("r", encoding="utf-8") as fp:
            return json.load(fp)

    skill_md = base / "SKILL.md"
    if skill_md.is_file():
        return {"type": "skill", "source": "SKILL.md"}

    return {}


def _validate_file_path(rel_path: str, dest_root: Path) -> Path:
    """防御路径穿越：校验 rel_path 解析后仍在 dest_root 内。"""
    rel = Path(rel_path)
    if rel.is_absolute() or ".." in rel.parts:
        raise ValueError(f"拒绝不安全的文件路径: {rel_path!r}")
    resolved = (dest_root / rel).resolve()
    if not resolved.is_relative_to(dest_root.resolve()):
        raise ValueError(f"路径穿越检测: {rel_path!r} → {resolved}")
    return resolved


class PackageRegistryClient:
    """面向 CLI / 脚本的 Package Registry 高级操作。"""

    def __init__(self, *, user_id: str, organization_id: str | None = None):
        self.user_id = user_id
        self.organization_id = organization_id

    def publish(
        self,
        directory: str,
        namespace: str,
        name: str,
        organization_id: str | None = None,
        version_label: str | None = None,
    ) -> dict[str, Any]:
        """从目录发布一个包。

        1. 扫描 directory 下所有文件
        2. 计算每个文件的 sha256
        3. 调用 create_package（如不存在）
        4. 调用 init_version
        5. 上传需要上传的文件
        6. 调用 finalize_version
        """
        from apps.services.package_registry import services

        wt_id = organization_id or self.organization_id
        if not wt_id:
            raise ValueError("organization_id is required for publish")

        scanned = _scan_directory(directory)
        if not scanned:
            raise ValueError(f"目录为空或没有可发布的文件: {directory}")

        manifest = _read_manifest_from_dir(directory)

        try:
            pkg = services.lookup_package(namespace=namespace, name=name)
            if str(pkg.organization_id) != wt_id:
                raise PermissionError(
                    f"ORGANIZATION_MISMATCH: 包 {namespace}/{name} 属于 organization "
                    f"{pkg.organization_id}，当前 organization 为 {wt_id}"
                )
        except LookupError:
            pkg = services.create_package(
                namespace=namespace,
                name=name,
                organization_id=wt_id,
                created_by=self.user_id,
                metadata=manifest.get("metadata", {}),
            )

        init_files = [
            {"path": f["path"], "sha256": f["sha256"],
             "size": f["size"], "content_type": f["content_type"]}
            for f in scanned
        ]
        init_result = services.init_version(
            package=pkg,
            files=init_files,
            manifest=manifest,
            version_label=version_label,
            user_id=self.user_id,
        )

        abs_map = {f["path"]: f["abs_path"] for f in scanned}
        try:
            for task in init_result["upload_tasks"]:
                if task["action"] == "upload":
                    self._upload_file(
                        abs_map[task["path"]],
                        task["oss_object_key"],
                    )
        except Exception:
            logger.warning(
                "[PackageRegistryClient] publish 上传中断，orphan version_id=%s (UPLOADING)",
                init_result.get("version_id"),
            )
            raise

        version = self._get_version(init_result["version_id"])
        bundle = services.compute_bundle_sha256(
            [(f["path"], f["sha256"]) for f in scanned]
        )
        result = services.finalize_version(
            package=pkg,
            version=version,
            bundle_sha256=bundle,
            init_files=init_files,
            user_id=self.user_id,
        )
        result["package_id"] = str(pkg.id)
        result["namespace"] = namespace
        result["name"] = name
        return result

    def install(
        self,
        namespace: str,
        name: str,
        version_seq: int | None = None,
        target_dir: str | None = None,
    ) -> dict[str, Any]:
        """安装一个包到本地目录（原子性：先下载到临时目录，成功后 rename）。

        1. 查找 Package
        2. 获取版本文件列表（yanked 版本自动回退到最新可用版本）
        3. 下载所有文件到临时目录，校验 SHA256
        4. 全部成功后 rename 临时目录到目标目录
        5. 任何失败都清理临时目录，目标目录不受影响
        """
        from apps.services.package_registry import services

        pkg = services.lookup_package(namespace=namespace, name=name)

        seq = version_seq
        if seq is None:
            seq = self._resolve_latest_available_version(pkg)

        try:
            files_result = services.get_version_files(
                package=pkg, version_seq=seq,
            )
        except PermissionError:
            if version_seq is not None:
                raise
            seq = self._resolve_latest_available_version(pkg, exclude_seq=seq)
            files_result = services.get_version_files(
                package=pkg, version_seq=seq,
            )

        dest = Path(target_dir) if target_dir else (
            Path.home() / ".tabtin" / "packages" / namespace / name
        )
        dest_resolved = dest.resolve()

        tmp_dir = dest_resolved.parent / (dest_resolved.name + ".tmp_install")
        try:
            if tmp_dir.exists():
                shutil.rmtree(tmp_dir)
            tmp_dir.mkdir(parents=True, exist_ok=True)

            downloaded = []
            for f in files_result["files"]:
                file_dest = _validate_file_path(f["path"], tmp_dir)
                file_dest.parent.mkdir(parents=True, exist_ok=True)
                self._download_file(f["download_url"], file_dest)
                actual_sha = _sha256_file(file_dest)
                if actual_sha != f["sha256"]:
                    raise RuntimeError(
                        f"SHA256 校验失败: {f['path']} "
                        f"expected={f['sha256'][:16]}... actual={actual_sha[:16]}..."
                    )
                downloaded.append({
                    "path": f["path"],
                    "sha256": f["sha256"],
                })
        except Exception:
            shutil.rmtree(tmp_dir, ignore_errors=True)
            raise

        # 原子替换：先删旧目录，再 rename 临时目录
        try:
            if dest_resolved.exists():
                shutil.rmtree(dest_resolved)
            dest_resolved.parent.mkdir(parents=True, exist_ok=True)
            os.rename(str(tmp_dir), str(dest_resolved))
        except Exception:
            shutil.rmtree(tmp_dir, ignore_errors=True)
            raise

        files_with_local = [
            {
                "path": d["path"],
                "local_path": str(dest_resolved / d["path"]),
                "sha256": d["sha256"],
            }
            for d in downloaded
        ]

        return {
            "namespace": namespace,
            "name": name,
            "version_seq": files_result["version_seq"],
            "version_label": files_result["version_label"],
            "target_dir": str(dest),
            "files": files_with_local,
        }

    def list_versions(self, namespace: str, name: str) -> list[dict[str, Any]]:
        """列出包的所有版本。"""
        from apps.services.package_registry import services

        pkg = services.lookup_package(namespace=namespace, name=name)
        result = services.list_versions(package=pkg)
        return result["items"]

    def yank(
        self, namespace: str, name: str, version_seq: int, reason: str,
    ) -> dict[str, Any]:
        """下架某个版本。"""
        from apps.services.package_registry import services

        pkg = services.lookup_package(namespace=namespace, name=name)
        return services.yank_version(
            package=pkg,
            version_seq=version_seq,
            reason=reason,
            user_id=self.user_id,
        )

    def revert(
        self,
        namespace: str,
        name: str,
        target_version_seq: int,
    ) -> dict[str, Any]:
        """把包回滚到指定旧版本(等价于 git revert,创建新版本指向旧内容)。"""
        from apps.services.package_registry import services

        pkg = services.lookup_package(namespace=namespace, name=name)
        return services.revert_to_version(
            package=pkg,
            target_version_seq=target_version_seq,
            user_id=self.user_id,
        )

    def fork(
        self,
        source_ns: str,
        source_name: str,
        target_ns: str,
        target_name: str,
        target_organization_id: str | None = None,
        fork_at_version_seq: int | None = None,
    ) -> dict[str, Any]:
        """fork 一个包。"""
        from apps.services.package_registry import services

        src = services.lookup_package(namespace=source_ns, name=source_name)
        wt_id = target_organization_id or self.organization_id
        if not wt_id:
            raise ValueError("target_organization_id is required for fork")
        return services.fork_package(
            source_package=src,
            target_namespace=target_ns,
            target_name=target_name,
            target_organization_id=wt_id,
            fork_at_version_seq=fork_at_version_seq,
            user_id=self.user_id,
        )

    # ── internal helpers ─────────────────────────────────────────

    @staticmethod
    def _resolve_latest_available_version(
        pkg, *, exclude_seq: int | None = None,
    ) -> int:
        """找到最新的非 yanked 版本。"""
        from apps.services.package_registry.models import PackageVersion

        qs = (
            PackageVersion.objects
            .filter(
                package=pkg,
                status=PackageVersion.Status.PUBLISHED,
                is_yanked=False,
            )
            .order_by("-version_seq")
        )
        if exclude_seq is not None:
            qs = qs.exclude(version_seq=exclude_seq)
        latest = qs.first()
        if not latest:
            raise LookupError(
                f"包 {pkg.namespace}/{pkg.name} 没有可用的（非下架）版本"
            )
        return latest.version_seq

    @staticmethod
    def _get_version(version_id: str):
        from apps.services.package_registry.models import PackageVersion
        return PackageVersion.objects.get(id=version_id)

    @staticmethod
    def _upload_file(local_path: str, oss_object_key: str) -> None:
        """通过 OSS 服务直接上传文件。"""
        from apps.services.oss.services.factory import get_oss_service
        oss = get_oss_service()
        oss.upload_file_from_path(local_path, oss_object_key)

    @staticmethod
    def _download_file(url: str, dest: Path, *, max_retries: int = 3) -> None:
        """从 presigned URL 下载文件到本地，带指数退避重试。"""
        _RETRYABLE = (urllib.error.URLError, ConnectionError, TimeoutError)
        last_exc: Exception | None = None
        for attempt in range(max_retries):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "tabtin-pkg/0.1"})
                with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310
                    with dest.open("wb") as fp:
                        while True:
                            chunk = resp.read(1024 * 1024)
                            if not chunk:
                                break
                            fp.write(chunk)
                return
            except _RETRYABLE as exc:
                last_exc = exc
                if attempt < max_retries - 1:
                    wait = 2 ** attempt  # 1s, 2s, 4s
                    logger.warning(
                        "[PackageRegistryClient] download retry %d/%d for %s (%s), wait %.0fs",
                        attempt + 1, max_retries, url[:80], exc, wait,
                    )
                    time.sleep(wait)
        raise last_exc  # type: ignore[misc]
