"""``tabtin install <app_id>`` 命令实现。

v3.1 方向锚（2026-04-19）以来支持两种 install 类型，由 manifest ``install.type``
字段决定：

1. ``npm-global`` — 多数社区 CLI 的原生分发方式。tabtin 只做"便利入口"：
   ``shutil.which`` 检查已装 → 未装则**默认引导用户** ``npm install -g ...``
   （设 ``--auto-install`` 或 ``TABTIN_AUTO_NPM_INSTALL=1`` 才代跑 npm）。
   **不下载 tarball、不校验 SHA256、不代管凭据**（见方向锚 H1-H9）。
2. ``tarball`` — 前任 Wave A5/D 设计的 CDN tarball 分发。保留为兼容路径，
   未来真有 tarball 形态 App 时仍可用。逻辑与 Electron 端
   ``MarketplaceAppInstaller.installApp`` 等价：
   读 manifest → 解析 platform/arch 下载 URL → SHA256 强校验（Wave D）→
   下载 tar.gz → 解压 → chmod +x → 写 registry.json

**为什么 Python 端独立实现而非走 Electron IPC**：

- A5 必须在 Daemon 模式（无 Electron 进程）也能装 marketplace App
- 主仓 IPC ``marketplace:install-app`` 仅在 Electron 主进程内可达，CLI 进程无法直接调
- 通过 cli-server HTTP 暴露 IPC 也是一种方案，但需要 Electron 在跑；Daemon 没有 IPC server
- 最务实的做法是 **Python 端独立实现，逻辑 1:1 对齐**（同样 download / SHA256 / extract / registry）
- 未来如要保证唯一逻辑，可让 Electron 端在背后调本 Python module 或共享 Go 实现

**registry 路径差异**：

- Electron 端：``app.getPath('userData')/marketplace-apps/registry.json``
  （macOS 实际为 ``~/Library/Application Support/TabTin/marketplace-apps/registry.json``）
- Python 端默认：``~/.tabtin-marketplace-apps/registry.json``
  （Daemon 模式 + dev 期使用；测试可通过 ``--registry-dir`` 覆盖）
- 二者**不互相同步**——marketplace App 在 Electron 端装的不会自动出现在 daemon 的 registry。
  这是 H1 已知约束（PRD §5.4 N-5 device 级安装可见性靠 heartbeat 上报，不靠 registry 共享），
  Wave E DeviceAppInstallSnapshot 接入后由后端统一聚合。

参数 / 行为：

- ``app_id``：必填，要安装的 App
- ``manifest_path``：可选，覆盖默认 ``packages/apps/<app_id>/app.json`` 路径
- ``registry_dir``：可选，覆盖默认 ``~/.tabtin-marketplace-apps/`` 安装根
- ``output_json``：``True`` 输出 JSON 便于脚本消费

返回：exit code（0 成功 / 78 SHA256 缺失 / 1 其他失败）。
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

from apps.services.agent_engine.cli.tabtin_cli.cli import (
    EXIT_CONFIG_MISSING,
    EXIT_OK,
)

logger = logging.getLogger(__name__)


DEFAULT_REGISTRY_DIR = Path.home() / ".tabtin-marketplace-apps"


# ── platform / arch 映射 ───────────────────────────────────────────


def _python_platform() -> str:
    """对齐 Node.js ``process.platform`` 词表。"""
    if sys.platform == "darwin":
        return "darwin"
    if sys.platform == "win32":
        return "win32"
    if sys.platform.startswith("linux"):
        return "linux"
    return sys.platform


def _python_arch() -> str:
    """对齐 Node.js ``process.arch`` 词表。"""
    import platform as _platform_mod
    machine = _platform_mod.machine().lower()
    if machine in ("x86_64", "amd64"):
        return "x64"
    if machine in ("aarch64", "arm64"):
        return "arm64"
    if machine in ("armv7l", "armv6l"):
        return "arm"
    return machine or "unknown"


def _resolve_checksum_key(
    platform_map: Dict[str, str],
    arch_map: Dict[str, str],
    *,
    platform: Optional[str] = None,
    arch: Optional[str] = None,
) -> Optional[str]:
    """与 Electron 端 ``resolveMarketplaceChecksumKey`` 等价：
    ``<platform_map[platform]>-<arch_map[arch]>``，缺映射返回 None。
    """
    plat = platform_map.get(platform or _python_platform())
    architecture = arch_map.get(arch or _python_arch())
    if not plat or not architecture:
        return None
    return f"{plat}-{architecture}"


def _resolve_download_url(
    cli: Dict[str, Any],
    *,
    platform: Optional[str] = None,
    arch: Optional[str] = None,
) -> Optional[str]:
    """与 Electron 端 ``resolveDownloadUrl`` 等价。"""
    plat = cli.get("platformMap", {}).get(platform or _python_platform())
    architecture = cli.get("archMap", {}).get(arch or _python_arch())
    if not plat or not architecture:
        return None
    download_url = cli.get("downloadUrl", "")
    return (
        download_url
        .replace("{version}", str(cli.get("version", "")))
        .replace("{platform}", plat)
        .replace("{arch}", architecture)
    )


# ── manifest 加载 ──────────────────────────────────────────────────


def _resolve_manifest_path(app_id: str, override: Optional[str] = None) -> Path:
    if override:
        return Path(override)
    # spec.py 已经定义 _REPO_PACKAGES_APPS_DIR；复用同一公式（避免重复）。
    from apps.services.agent_engine.cli.spec import _REPO_PACKAGES_APPS_DIR
    return _REPO_PACKAGES_APPS_DIR / app_id / "app.json"


def _load_manifest(app_id: str, override: Optional[str] = None) -> Dict[str, Any]:
    path = _resolve_manifest_path(app_id, override)
    if not path.is_file():
        raise FileNotFoundError(
            f"找不到 App manifest: {path}（请确认 packages/apps/{app_id}/app.json 存在）"
        )
    with path.open("r", encoding="utf-8") as fp:
        manifest = json.load(fp)
    if not isinstance(manifest, dict):
        raise ValueError(f"manifest 顶层必须是 JSON object，got {type(manifest).__name__}")
    return manifest


# ── SHA256 校验 ────────────────────────────────────────────────────


def _sha256_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    """流式计算 sha256，避免大 binary 一次读爆内存。"""
    h = hashlib.sha256()
    with path.open("rb") as fp:
        while True:
            chunk = fp.read(chunk_size)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def _verify_binary_sha256(path: Path, expected: str) -> None:
    actual = _sha256_file(path)
    if actual.lower() != expected.lower():
        raise RuntimeError(
            f"[E_INSTALL_CHECKSUM_MISMATCH] {path.name} SHA256 不匹配: "
            f"expected={expected!r} actual={actual!r}"
        )


# ── 下载 + 解压 ────────────────────────────────────────────────────


def _download_file(url: str, dest: Path, *, timeout: float = 60.0) -> None:
    """通过 stdlib urllib 下载文件到本地。

    简化实现：不做断点续传、不做进度条 UI；适用于 Daemon / dev / CI 安装路径。
    Electron 端用 ``net.fetch`` 走 Chromium 网络栈以支持 proxy/CA 配置；
    Python 端如需 proxy 由用户通过 ``HTTPS_PROXY`` 环境变量配置（urllib 自动识别）。
    """
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "tabtin-cli/0.1"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 — 受控 URL
            if resp.status != 200:
                raise RuntimeError(
                    f"下载失败: HTTP {resp.status} {resp.reason} (url={url})"
                )
            dest.parent.mkdir(parents=True, exist_ok=True)
            with dest.open("wb") as out_fp:
                shutil.copyfileobj(resp, out_fp)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"下载失败: HTTP {exc.code} {exc.reason} (url={url})") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"下载失败: {exc.reason} (url={url})") from exc


def _extract_tarball(tarball: Path, dest_dir: Path) -> None:
    """安全解压 tar.gz 到目标目录。

    防御策略（三视角 Review P0 加固）：
    - 拒绝绝对路径条目（``name`` 以 ``/`` 开头）
    - 拒绝路径跳出条目（``..`` 在路径段中）
    - **拒绝 symlink / hardlink 成员**（防御 symlink 攻击 — 解压后让 binary
      指向 ``/etc/passwd`` 或 ``/usr/bin/sudo`` 等敏感位置）
    - 拒绝设备 / 命名管道
    - 解压前用 ``Path.resolve()`` 校验最终路径仍落在 ``dest_dir`` 内
      （防御 Path Traversal 的 realpath 阶段攻击，如 ``foo/./../../bar``
      绕过简单字符串检查）

    Python 3.12+ 通过 ``filter='data'`` 内置严格 filter（已包含上述全部防护）；
    3.11 走手动校验，与 ``data`` filter 行为对齐。
    """
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest_resolved = dest_dir.resolve()
    with tarfile.open(tarball, "r:gz") as tar:
        try:
            # Python 3.12+：data filter 已经覆盖 symlink / 绝对路径 / .. 跳出 / 不安全权限
            tar.extractall(dest_dir, filter="data")  # type: ignore[arg-type]
        except TypeError:
            # Python 3.11：手动模拟 data filter 的核心防护
            for member in tar.getmembers():
                name = member.name
                if name.startswith("/") or ".." in Path(name).parts:
                    raise RuntimeError(f"拒绝解压不安全条目: {name!r}")
                # **拒绝 symlink / hardlink 成员**：data filter 也只允许 regular file + dir。
                # symlink 解压后可能让后续 chmod / 写入 / 执行落到 dest_dir 之外。
                if member.issym() or member.islnk():
                    raise RuntimeError(
                        f"拒绝解压 symlink/hardlink 条目（防御 symlink 攻击）: {name!r}"
                    )
                if member.isdev() or member.ischr() or member.isblk() or member.isfifo():
                    raise RuntimeError(f"拒绝解压设备 / 命名管道条目: {name!r}")
                # realpath 校验：解析后的最终路径必须仍在 dest_dir 内
                target = (dest_dir / name).resolve()
                try:
                    target.relative_to(dest_resolved)
                except ValueError as exc:
                    raise RuntimeError(
                        f"拒绝解压跳出 dest_dir 的条目: {name!r} → {target}"
                    ) from exc
            tar.extractall(dest_dir)  # noqa: S202 — 已校验


# ── registry 读写 ─────────────────────────────────────────────────


def _read_registry(registry_path: Path) -> Dict[str, Any]:
    if not registry_path.is_file():
        return {}
    try:
        with registry_path.open("r", encoding="utf-8") as fp:
            data = json.load(fp)
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning(
            "[tabtin install] registry %s 不可读 (%s)，按空 registry 处理",
            registry_path, exc,
        )
        return {}
    return data if isinstance(data, dict) else {}


def _write_registry(registry_path: Path, data: Dict[str, Any]) -> None:
    """原子写 registry.json（三视角 Review P1 修复）。

    用 ``tempfile`` + ``os.replace`` 同目录原子替换：避免进程中断时留下半截 JSON
    导致下次启动 ``_read_registry`` 把"已装的 App 全丢了"误判为空 registry。
    POSIX 与 Windows 上 ``os.replace`` 均原子（要求 src/dst 同一文件系统，
    本函数将临时文件创建在 registry 同目录，保证条件成立）。
    """
    registry_path.parent.mkdir(parents=True, exist_ok=True)
    # 临时文件创建在 registry_path 同目录（确保 os.replace 原子）
    fd, tmp_name = tempfile.mkstemp(
        prefix=".registry-",
        suffix=".tmp",
        dir=str(registry_path.parent),
    )
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fp:
            json.dump(data, fp, ensure_ascii=False, indent=2)
            fp.flush()
            try:
                os.fsync(fp.fileno())  # POSIX：保证内容落盘后再 rename
            except (AttributeError, OSError):
                # Windows / 某些 FS 不支持 fsync，忽略
                pass
        os.replace(tmp_path, registry_path)
    except Exception:
        # 写失败时清掉临时文件，避免残留
        try:
            if tmp_path.exists():
                tmp_path.unlink()
        except OSError:
            pass
        raise


# ── 主流程 ─────────────────────────────────────────────────────────


def install_app(
    app_id: str,
    *,
    manifest_path: Optional[str] = None,
    registry_dir: Optional[str] = None,
    platform_override: Optional[str] = None,
    arch_override: Optional[str] = None,
    allow_unchecked_install: Optional[bool] = None,
    auto_install: bool = False,
    skip_skills: bool = False,
) -> Dict[str, Any]:
    """安装 marketplace App。返回安装结果字典；失败抛异常。

    按 manifest ``install.type`` 分发：

    - ``npm-global`` — 检查 ``cli.binary`` 是否在 PATH；未装默认抛
      ``NpmInstallGuidanceError`` 让用户自己跑 ``npm install -g``；
      ``auto_install=True`` 或 ``TABTIN_AUTO_NPM_INSTALL=1`` 时代跑 npm
    - ``tarball``（默认） — 与 Electron 端 ``MarketplaceAppInstaller.installApp``
      等价：下载 → SHA256 校验 → 解压 → 写 registry

    两种路径都返回共同字段：``{"app_id", "version", "binary_path",
    "manifest_version", "install_type", "registry_path"}``；具体 type 可能
    有附加字段（如 tarball 的 ``checksum_key`` / npm 的 ``npm_package``）。

    参数：

    - ``manifest_path`` — 可选，覆盖默认 manifest 位置
    - ``registry_dir``  — 可选，覆盖默认 ``~/.tabtin-marketplace-apps/``
    - ``platform_override``/``arch_override`` — tarball 路径测试用
    - ``allow_unchecked_install`` — tarball 路径：``None`` 取 ``TABTIN_ALLOW_UNCHECKED_INSTALL=1``
    - ``auto_install`` — npm-global 路径：True 时代跑 ``npm install -g``
    """
    manifest = _load_manifest(app_id, manifest_path)
    cli = manifest.get("cli")
    if not isinstance(cli, dict) or not cli:
        raise ValueError(
            f"App {app_id} 的 manifest 不含 cli 字段（marketplace App 必须声明 cli.binary）"
        )

    binary_name = cli.get("binary")
    if not isinstance(binary_name, str) or not binary_name:
        raise ValueError(f"App {app_id} 的 manifest.cli.binary 缺失或非 string")

    install_cfg = manifest.get("install") or {}
    install_type = install_cfg.get("type", "tarball")

    if install_type == "npm-global":
        return _install_via_npm(
            app_id=app_id,
            manifest=manifest,
            cli=cli,
            install_cfg=install_cfg,
            registry_dir=registry_dir,
            auto_install=auto_install,
            skip_skills=skip_skills,
        )
    if install_type != "tarball":
        raise ValueError(
            f"不支持的 install.type={install_type!r}"
            "（当前支持: 'npm-global' | 'tarball' | 省略=tarball）"
        )

    # ── 以下为 tarball 路径（前任 Wave A5/D 原逻辑，保留兼容） ──────
    base_dir = Path(registry_dir) if registry_dir else DEFAULT_REGISTRY_DIR
    app_dir = base_dir / app_id
    bin_dir = app_dir / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    binary_dest = bin_dir / binary_name

    download_url = _resolve_download_url(
        cli,
        platform=platform_override,
        arch=arch_override,
    )
    if not download_url:
        raise RuntimeError(
            f"[E_INSTALL_NO_BINARY] App {app_id}：当前 platform "
            f"({platform_override or _python_platform()}) / arch ({arch_override or _python_arch()}) "
            f"在 manifest 中无映射，无法下载 CLI binary"
        )

    checksum_key = _resolve_checksum_key(
        cli.get("platformMap", {}),
        cli.get("archMap", {}),
        platform=platform_override,
        arch=arch_override,
    )
    expected_checksum = (
        cli.get("checksums", {}).get(checksum_key) if checksum_key else None
    )
    if allow_unchecked_install is None:
        allow_unchecked_install = (
            os.environ.get("TABTIN_ALLOW_UNCHECKED_INSTALL") == "1"
        )

    if not expected_checksum and not allow_unchecked_install:
        raise InstallChecksumMissingError(
            app_id=app_id,
            checksum_key=checksum_key,
        )

    # 下载到临时目录，再解压到 bin/
    with tempfile.TemporaryDirectory(prefix="tabtin-install-") as tmpdir:
        tarball = Path(tmpdir) / f"{app_id}-{cli.get('version', 'unknown')}.tar.gz"
        logger.info(
            "[tabtin install] %s: 下载 %s → %s",
            app_id, download_url, tarball,
        )
        _download_file(download_url, tarball)

        logger.info(
            "[tabtin install] %s: 解压 %s → %s",
            app_id, tarball, bin_dir,
        )
        _extract_tarball(tarball, bin_dir)

    if not binary_dest.is_file():
        raise RuntimeError(
            f"[E_INSTALL_BINARY_MISSING] 解压完成但 {binary_dest} 不存在 — "
            f"manifest.cli.binary={binary_name!r} 与 tarball 内容不一致"
        )

    checksum_verified = False
    if expected_checksum:
        _verify_binary_sha256(binary_dest, expected_checksum)
        checksum_verified = True
    elif allow_unchecked_install:
        logger.warning(
            "[tabtin install] %s: SHA256 校验跳过（TABTIN_ALLOW_UNCHECKED_INSTALL=1）。"
            "生产构建必须填充 manifest.cli.checksums",
            app_id,
        )

    # chmod +x（Windows 上 chmod 无意义但 stat 也不报错）
    try:
        current_mode = binary_dest.stat().st_mode
        binary_dest.chmod(current_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    except OSError as exc:
        logger.warning(
            "[tabtin install] %s: chmod +x 失败（继续）: %s", app_id, exc
        )

    # 写 manifest 副本
    manifest_copy_path = app_dir / "manifest.json"
    with manifest_copy_path.open("w", encoding="utf-8") as fp:
        json.dump(manifest, fp, ensure_ascii=False, indent=2)

    # 更新 registry
    registry_path = base_dir / "registry.json"
    registry = _read_registry(registry_path)
    registry[app_id] = {
        "version": cli.get("version", ""),
        "installedAt": datetime.now(timezone.utc).isoformat(),
        "binaryPath": str(binary_dest),
        "manifestVersion": manifest.get("version", ""),
        "installType": "tarball",
    }
    _write_registry(registry_path, registry)

    # A5：安装完 marketplace App 后，让 compute_known_binaries 缓存失效，
    # 下次 CLI 解析就能识别新 binary（无需重启进程）。
    from apps.services.agent_engine.cli.spec import invalidate_known_binaries_cache
    invalidate_known_binaries_cache()

    return {
        "app_id": app_id,
        "version": cli.get("version", ""),
        "binary_path": str(binary_dest),
        "checksum_key": checksum_key,
        "checksum_verified": checksum_verified,
        "manifest_version": manifest.get("version", ""),
        "registry_path": str(registry_path),
        "install_type": "tarball",
    }


# ── npm-global 分支（v3.1 方向锚 · Step B） ──────────────────────


def _install_via_npm(
    *,
    app_id: str,
    manifest: Dict[str, Any],
    cli: Dict[str, Any],
    install_cfg: Dict[str, Any],
    registry_dir: Optional[str],
    auto_install: bool,
    skip_skills: bool = False,
) -> Dict[str, Any]:
    """安装"npm-global"类型 App。

    业务：TabTin 不持密 / 不代管版本 / 不强制。只给一个便利入口：
    - binary 在 PATH → 记录已装，走 registry 登记
    - 不在 PATH + 用户未授权 auto → 抛 ``NpmInstallGuidanceError``，run_install
      翻译为 exit 78（与 TABTIN_ALLOW_UNCHECKED_INSTALL 同语义 —— "需要用户额外
      配置后重试"）
    - 不在 PATH + auto 开启 → fork ``npm install -g <package>``，装完再查 PATH
    """
    npm_package = install_cfg.get("npmPackage")
    if not isinstance(npm_package, str) or not npm_package:
        raise ValueError(
            f"App {app_id} install.type=npm-global 必须声明 install.npmPackage"
        )

    binary_name = cli["binary"]

    # TABTIN_AUTO_NPM_INSTALL 支持同一个开关；CLI --auto-install flag 走参数
    env_auto = os.environ.get("TABTIN_AUTO_NPM_INSTALL") == "1"
    effective_auto = auto_install or env_auto

    found = shutil.which(binary_name)
    status: str
    if found:
        logger.info(
            "[tabtin install] %s: %s 已在 PATH (%s)，跳过 npm 安装",
            app_id, binary_name, found,
        )
        status = "already_installed"
    elif not effective_auto:
        raise NpmInstallGuidanceError(
            app_id=app_id,
            npm_package=npm_package,
            binary_name=binary_name,
        )
    else:
        logger.info(
            "[tabtin install] %s: 未检测到 %s，将自动执行 npm install -g %s",
            app_id, binary_name, npm_package,
        )
        _run_npm_install_global(npm_package)
        found = shutil.which(binary_name)
        if not found:
            raise RuntimeError(
                f"[E_INSTALL_NPM_POSTCHECK] `npm install -g {npm_package}` "
                f"执行完成但 {binary_name} 仍不在 PATH；"
                "请检查 npm 全局 bin 目录是否在 PATH 中（或 nvm 切换 shim 问题）"
            )
        status = "installed"

    # 注册到 tabtin marketplace registry（统一入口，便于 uninstall/upgrade 反查）
    base_dir = Path(registry_dir) if registry_dir else DEFAULT_REGISTRY_DIR
    base_dir.mkdir(parents=True, exist_ok=True)
    registry_path = base_dir / "registry.json"
    registry = _read_registry(registry_path)
    registry[app_id] = {
        "version": cli.get("version", ""),
        "installedAt": datetime.now(timezone.utc).isoformat(),
        "binaryPath": found or "",
        "manifestVersion": manifest.get("version", ""),
        "installType": "npm-global",
        "npmPackage": npm_package,
    }
    _write_registry(registry_path, registry)

    # 让 compute_known_binaries 缓存失效，CLI 治理层立刻识别新 binary
    from apps.services.agent_engine.cli.spec import invalidate_known_binaries_cache
    invalidate_known_binaries_cache()

    # Wave H（v3.1 方向锚 · 北极星 N-7）：装完 App 后同步注册它的 Skill
    # 失败不阻断 install，只记录在返回结果里让上层打印
    skills_report: Dict[str, Any] = {"skipped": True}
    if not skip_skills:
        from apps.services.agent_engine.cli.tabtin_cli import skill_install
        try:
            skills_report = skill_install.install_and_register_app_skills(
                app_id=app_id,
                manifest=manifest,
            )
            skills_report["skipped"] = False
        except Exception as exc:  # noqa: BLE001 — 注册失败不阻断主 install
            logger.warning(
                "[tabtin install] %s: Skill 注册环节失败（不阻断）: %s",
                app_id, exc,
            )
            skills_report = {"skipped": False, "error": str(exc)}

    return {
        "app_id": app_id,
        "version": cli.get("version", ""),
        "binary_path": found or "",
        "manifest_version": manifest.get("version", ""),
        "registry_path": str(registry_path),
        "install_type": "npm-global",
        "npm_package": npm_package,
        "status": status,
        "skills": skills_report,
    }


def _run_npm_install_global(npm_package: str, *, timeout: float = 180.0) -> None:
    """fork ``npm install -g <package>`` 并等待完成。stdout/stderr 透传给用户。"""
    if shutil.which("npm") is None:
        raise RuntimeError(
            "[E_INSTALL_NPM_MISSING] 系统未安装 npm，无法自动 npm 安装。"
            "请先装 Node.js / npm（或关闭 --auto-install 改手动执行）"
        )
    proc = subprocess.run(
        ["npm", "install", "-g", npm_package],
        stdin=subprocess.DEVNULL,
        timeout=timeout,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"[E_INSTALL_NPM_FAILED] `npm install -g {npm_package}` 退出码 "
            f"{proc.returncode}；请手动排查（可能需要 sudo / nvm 切换）"
        )


# ── 异常 ────────────────────────────────────────────────────────────


class InstallChecksumMissingError(RuntimeError):
    """SHA256 缺失但未豁免（Wave D 拒装信号，仅 tarball 分支）。

    专门的异常类便于 ``run_install`` 翻译成 ``EXIT_CONFIG_MISSING`` (78) 退出码 +
    友好提示文案（PRD §6.5 / D 启动包等价）。
    """

    def __init__(self, *, app_id: str, checksum_key: Optional[str]) -> None:
        self.app_id = app_id
        self.checksum_key = checksum_key
        super().__init__(
            f"[E_INSTALL_CHECKSUM_MISSING] 拒绝安装 {app_id!r}：manifest.cli.checksums "
            f"缺少 {checksum_key or '当前 platform'} 的 SHA256。"
            "如需 dev/CI 跳过：``TABTIN_ALLOW_UNCHECKED_INSTALL=1 tabtin install "
            f"{app_id}``"
        )


class NpmInstallGuidanceError(RuntimeError):
    """npm-global 类型 App 未装且用户未授权 auto-install（v3.1 · Step B）。

    不是真正的"安装失败"——是"需要用户自己决定是否 npm 安装"的引导信号。
    run_install 翻译为 ``EXIT_CONFIG_MISSING`` (78)，与 checksum-missing 同语义
    ("需要用户额外配置")。
    """

    def __init__(
        self,
        *,
        app_id: str,
        npm_package: str,
        binary_name: str,
    ) -> None:
        self.app_id = app_id
        self.npm_package = npm_package
        self.binary_name = binary_name
        super().__init__(
            f"[E_INSTALL_NPM_GUIDANCE] App {app_id!r} 需要 {binary_name} 但系统 PATH "
            f"未找到。请手动执行：\n"
            f"    npm install -g {npm_package}\n"
            "装完再次运行 `tabtin install {app_id}` 完成登记，"
            f"或加 `--auto-install` 让 tabtin 代跑（需 npm 可用且 PATH 已配置）。"
        )


# ── CLI 入口 ──────────────────────────────────────────────────────


def run_install(
    *,
    app_id: str,
    manifest_path: Optional[str] = None,
    registry_dir: Optional[str] = None,
    output_json: bool = False,
    auto_install: bool = False,
) -> int:
    """``tabtin install <app_id>`` 入口。返回 exit code。"""
    try:
        result = install_app(
            app_id,
            manifest_path=manifest_path,
            registry_dir=registry_dir,
            auto_install=auto_install,
        )
    except InstallChecksumMissingError as exc:
        if output_json:
            _print_json_error(exc, code="E_INSTALL_CHECKSUM_MISSING")
        else:
            print(str(exc), file=sys.stderr)
        return EXIT_CONFIG_MISSING
    except NpmInstallGuidanceError as exc:
        if output_json:
            _print_json_error(exc, code="E_INSTALL_NPM_GUIDANCE")
        else:
            print(str(exc), file=sys.stderr)
        return EXIT_CONFIG_MISSING
    except FileNotFoundError as exc:
        if output_json:
            _print_json_error(exc, code="E_MANIFEST_NOT_FOUND")
        else:
            print(f"[E_MANIFEST_NOT_FOUND] {exc}", file=sys.stderr)
        return 1
    except (RuntimeError, ValueError) as exc:
        if output_json:
            _print_json_error(exc, code="E_INSTALL_FAILED")
        else:
            print(f"[E_INSTALL_FAILED] {exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001 — 顶层兜底
        if output_json:
            _print_json_error(exc, code="E_INSTALL_UNEXPECTED")
        else:
            print(f"[E_INSTALL_UNEXPECTED] {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    if output_json:
        json.dump(
            {"success": True, **result},
            sys.stdout, ensure_ascii=False, indent=2,
        )
        sys.stdout.write("\n")
    else:
        # 分两类打印——npm-global 没有 checksum 概念
        install_type = result.get("install_type", "tarball")
        status_note = ""
        if install_type == "npm-global":
            status_note = {
                "already_installed": "（已装，tabtin 仅做登记）",
                "installed": "（tabtin 代跑 npm install 完成）",
            }.get(result.get("status", ""), "")
            print(
                f"[tabtin install] {result['app_id']} v{result['version']} "
                f"{status_note}"
            )
            print(f"  binary      : {result['binary_path']}")
            print(f"  npm package : {result['npm_package']}")
            print(f"  manifest    : v{result['manifest_version']}")
            print(f"  registry    : {result['registry_path']}")

            # Wave H：Skill 注册摘要
            skills = result.get("skills") or {}
            if skills.get("error"):
                print(f"  skills      : ⚠ 登记失败 — {skills['error']}")
            elif skills.get("install_error"):
                # ``skillsInstall`` fork 失败（例如 npx skills add 网络挂了）。
                # 此时既没装也没登记，必须显式告知用户而不是默默打印
                # "登记 0 个 skill"，否则用户会误以为 fix 没生效。
                print(f"  skills      : ⚠ skillsInstall 失败 — {skills['install_error']}")
                print(
                    f"                可手动跑 `{skills.get('install_command', '')}` 后"
                    f"再 `tabtin install {result['app_id']}` 重试"
                )
            elif skills.get("skipped"):
                pass  # 明确跳过，不打印
            elif skills.get("skip_reason"):
                print(f"  skills      : 跳过（{skills['skip_reason']}）")
            else:
                ok = skills.get("registered_success", 0)
                fail = skills.get("registered_fail", 0)
                if skills.get("installed"):
                    print(f"  skills      : ✓ 已装 + 登记 {ok} 个 skill"
                          + (f"（{fail} 失败）" if fail else ""))
                else:
                    print(f"  skills      : 登记 {ok} 个 skill"
                          + (f"（{fail} 失败）" if fail else ""))
        else:
            print(f"[tabtin install] {result['app_id']} v{result['version']} 安装成功")
            print(f"  binary  : {result['binary_path']}")
            print(f"  manifest: v{result['manifest_version']}")
            print(
                f"  checksum: {result.get('checksum_key') or 'n/a'} "
                f"({'verified' if result.get('checksum_verified') else 'skipped (--unchecked)'})"
            )
            print(f"  registry: {result['registry_path']}")
    return EXIT_OK


def _print_json_error(exc: BaseException, *, code: str) -> None:
    payload = {
        "success": False,
        "error": {
            "code": code,
            "type": type(exc).__name__,
            "message": str(exc),
        },
    }
    json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


__all__ = [
    "DEFAULT_REGISTRY_DIR",
    "InstallChecksumMissingError",
    "install_app",
    "run_install",
]
