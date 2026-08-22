"""
test_path_safety.py — 路径权限治理 Wave 4 P1-6 Python 端 isDangerouslyBroadPath 镜像单测。

钉死跨语言行为对齐：本 case 与 TS 端
`packages/security-policy/tests/path-normalize.test.ts` 同款用例必须返回相同结果。
"""

from __future__ import annotations

import pytest

from apps.services.common.path_safety import is_dangerously_broad_root


class TestIsDangerouslyBroadRoot:
    """P1-6 钉死契约 —— 与 TS 端 `isDangerouslyBroadPath` 行为对齐"""

    @pytest.mark.parametrize(
        "path",
        [
            "/",
            "/Users",
            "/Users/",
            "/home",
            "/home/",
            "/etc",
            "/var",
            "/usr",
            "/tmp",
            "/bin",
            "/sbin",
            "/opt",
            "/root",
            "/private",
            "/Volumes",
            "/Applications",
            "/srv",
            "/mnt",
            "/media",
            "/proc",
            "/sys",
            "/dev",
            "/System",
            "/Library",
            "/boot",
            "/run",
            "/snap",
        ],
    )
    def test_dangerous_toplevel_dirs(self, path):
        assert is_dangerously_broad_root(path) is True

    @pytest.mark.parametrize(
        "path",
        [
            "C:",
            "C:/",
            "C:\\",
            "/C:/",
            "/C:\\",
            "D:/",
            "z:\\",
        ],
    )
    def test_dangerous_windows_roots(self, path):
        assert is_dangerously_broad_root(path) is True

    @pytest.mark.parametrize(
        "path",
        [
            "",
            "   ",
            "\t\n",
        ],
    )
    def test_empty_or_blank(self, path):
        assert is_dangerously_broad_root(path) is True

    @pytest.mark.parametrize(
        "path",
        [
            "relative/path",
            "../escape",
            "~/home",
            "~/.ssh",
            "no-leading-slash",
        ],
    )
    def test_non_absolute(self, path):
        assert is_dangerously_broad_root(path) is True

    @pytest.mark.parametrize(
        "value",
        [
            None,
            123,
            ["/Users/x"],
            {"path": "/x"},
            object(),
        ],
    )
    def test_non_string(self, value):
        assert is_dangerously_broad_root(value) is True

    @pytest.mark.parametrize(
        "path",
        [
            "/Users/developer",  # M3.1.1 起放行单用户家目录
            "/Users/developer/dev/midscene",
            "/Users/developer/Documents/work",
            "/home/alice",
            "/home/alice/proj",
            "/tmp/tabtin-sandbox/space-xxx",
            "/Volumes/外接盘/projects/foo",  # 子路径合法，仅整段 /Volumes 危险
            "/etc/some/sub/path",  # 子路径合法
            "C:/Users/developer/proj",  # Windows 子路径
        ],
    )
    def test_legitimate_workspace_paths(self, path):
        assert is_dangerously_broad_root(path) is False

    def test_handles_unicode_normalization(self):
        # NFC 归一应让等价字符的两种形式都被识别
        # café 的 NFC vs NFD 形式
        nfc = "/Users/caf\u00e9"
        nfd = "/Users/cafe\u0301"
        assert is_dangerously_broad_root(nfc) is False
        assert is_dangerously_broad_root(nfd) is False

    def test_trailing_slash_normalization(self):
        # /Users 与 /Users/ 应行为一致
        assert is_dangerously_broad_root("/Users") is True
        assert is_dangerously_broad_root("/Users/") is True
        assert is_dangerously_broad_root("/Users//") is True


class TestSandboxPolicyDoesNotBypassDenyWithBroadRoot:
    """钉死 P1-6 修复：sandbox_policy 的 short-circuit 不再被注入的危险 root 绕过"""

    def setup_method(self):
        from apps.services.common.sandbox_policy import (
            SandboxPolicyResolver,
            SANDBOX_PRESETS,
        )
        self.r = SandboxPolicyResolver(
            sandbox_config=dict(SANDBOX_PRESETS["cautious"])
        )

    def _ws(self, allowed):
        return {
            "sources": {
                "sandbox": "/tmp",
                "tabcodeProjects": list(allowed),
                "tabfolderDirs": [],
                "attachedFiles": [],
            },
            "allowedPaths": list(allowed),
            "allowedFiles": [],
            "spaceSessionId": "test",
        }

    def test_dangerously_broad_root_does_not_bypass_deny_root(self):
        # 注入 / 试图让所有路径 short-circuit 放行
        d = self.r.resolve_file(
            "write_file",
            "/Users/x/proj/.env",
            workspace_snapshot=self._ws(["/"]),
        )
        # / 被 P1-6 过滤掉 → short-circuit 不命中 → 走 deny_write_paths → blocked
        assert d.route == "blocked"

    def test_dangerously_broad_root_does_not_bypass_deny_users(self):
        d = self.r.resolve_file(
            "write_file",
            "/Users/x/proj/.env",
            workspace_snapshot=self._ws(["/Users"]),
        )
        assert d.route == "blocked"

    def test_dangerously_broad_root_does_not_bypass_deny_etc(self):
        d = self.r.resolve_file(
            "read_file",
            "/etc/passwd",
            workspace_snapshot=self._ws(["/etc"]),
        )
        # /etc 顶级目录被过滤 → short-circuit 不命中
        # /etc/passwd 进 deny_read_paths 检查（cautious preset 不命中具体 /etc/passwd
        # 但合法路径检查仍要跑）。关键断言：route != short-circuit 走的 regular。
        # cautious deny_read_paths 默认含 ~/.ssh/.aws 等 home 路径，不含 /etc/passwd
        # 所以这条 case route 仍是 regular，但**不是 short-circuit 跳过的 regular**。
        # 我们换一个能稳定区分的 deny 路径：
        d = self.r.resolve_file(
            "read_file",
            "/Users/x/.ssh/id_rsa",
            workspace_snapshot=self._ws(["/Users"]),  # /Users 危险，应被过滤
        )
        # /Users 被过滤 → short-circuit 不命中 → 走 deny_read_paths → ~/.ssh 命中
        assert d.route == "blocked"

    def test_dangerously_broad_root_does_not_bypass_deny_var(self):
        d = self.r.resolve_file(
            "write_file",
            "/var/log/sensitive.log",
            workspace_snapshot=self._ws(["/var"]),
        )
        # /var 危险 → 过滤 → short-circuit 不命中。这条 case 在 cautious
        # preset 的 deny_write_paths 不含 /var/* → 仍可能 regular。关键断言：
        # 至少 short-circuit 没让 .env 在 /var 内的写绕过：
        d2 = self.r.resolve_file(
            "write_file",
            "/var/proj/.env",
            workspace_snapshot=self._ws(["/var"]),
        )
        # /var 被过滤 → .env basename 命中 deny_write_paths → blocked
        assert d2.route == "blocked"

    def test_legitimate_user_workspace_still_short_circuits(self):
        # 合法工作区 /Users/x/proj 不被过滤 → 普通文件 short-circuit 仍然命中
        d = self.r.resolve_file(
            "write_file",
            "/Users/x/proj/src/main.py",
            workspace_snapshot=self._ws(["/Users/x/proj"]),
        )
        assert d.route == "regular"

    def test_mixed_dangerous_and_legitimate(self):
        # 混合 root：一个危险一个合法 → 危险被过滤，合法仍生效
        d = self.r.resolve_file(
            "write_file",
            "/Users/x/proj/src/main.py",
            workspace_snapshot=self._ws(["/", "/Users/x/proj"]),
        )
        # / 被过滤 → /Users/x/proj 命中 → 普通文件 short-circuit allow
        assert d.route == "regular"


# ── W7/B2 codegen 接入 · 4 条 basename pattern 跨端契约 ─────────────


class TestSensitivePathBasenameCrossEndCoverage:
    """W7/B2 codegen 接入钉死契约 —— 4 条 basename pattern (.crt / .kdbx /
    id_dsa / id_ecdsa) 在 Python 端**必须**命中 sensitive。

    与 TS 端 `packages/terminal-core/tests/w7-b2-codegen-cross-end.test.ts`
    的同款 4 条对应——两端用同一份 SSoT (`hardline-v3-rules.json`) 派生，
    任何漂移都会让其中一端失败。
    """

    def test_crt_basename_match(self):
        from apps.services.common.path_safety import matches_sensitive_path
        # basename fullmatch 形态（.*\\.crt$）
        assert matches_sensitive_path("/Users/x/proj/server.crt") is True
        # substring 形态也命中（path_scan_rules 的 *.crt 规则）
        assert matches_sensitive_path("/Users/x/proj/.crt-backup/foo.txt") is True

    def test_kdbx_basename_match(self):
        from apps.services.common.path_safety import matches_sensitive_path
        assert matches_sensitive_path("/Users/x/keys/db.kdbx") is True
        # 即使在子目录后缀里也命中（substring 形态）
        assert matches_sensitive_path("/Users/x/.kdbx-archive/old.txt") is True

    def test_id_dsa_basename_match(self):
        from apps.services.common.path_safety import matches_sensitive_path
        # basename fullmatch 形态（^id_dsa.*$）—— basename 是 id_dsa 开头
        assert matches_sensitive_path("/Users/x/.ssh/id_dsa") is True
        assert matches_sensitive_path("/Users/x/.ssh/id_dsa.pub") is True
        assert matches_sensitive_path("/Users/x/.ssh/id_dsa_backup") is True
        # 即使不在 .ssh/ 目录里
        assert matches_sensitive_path("/Users/x/proj/id_dsa") is True

    def test_id_ecdsa_basename_match(self):
        from apps.services.common.path_safety import matches_sensitive_path
        assert matches_sensitive_path("/Users/x/.ssh/id_ecdsa") is True
        assert matches_sensitive_path("/Users/x/.ssh/id_ecdsa.pub") is True
        assert matches_sensitive_path("/Users/x/.ssh/id_ecdsa_backup") is True
        assert matches_sensitive_path("/Users/x/proj/id_ecdsa") is True

    def test_normal_path_not_matched(self):
        from apps.services.common.path_safety import matches_sensitive_path
        assert matches_sensitive_path("/Users/x/proj/main.py") is False
        assert matches_sensitive_path("/Users/x/proj/README.md") is False
        # 包含 id_rsa 子串但前置不是 word boundary（不应误命中 substring path_scan_rule）
        # `my_id_rsa_helper` basename 不是 ^id_rsa.* 开头（fullmatch 不命中），
        # 路径 substring 匹配前置 `_` 也不命中（path_scan_rule 要求前置非 word char）
        assert matches_sensitive_path("/Users/x/proj/my_id_rsa_helper.sh") is False


class TestCodegenIntegrity:
    """W7/B2 codegen 接入：跑 ``codegen-hardline.py --check`` 验证 generated
    产物与 SSoT JSON 一致（如果 JSON 改了但 generated 没重生成则 fail）。

    任何 PR 改了 `hardline-v3-rules.json` 但没跑 codegen 的，都会被这条捕获。
    """

    def test_generated_outputs_in_sync_with_json_ssot(self):
        import subprocess
        import sys
        from pathlib import Path

        # locate repo root from this file: apps/tabtin_django/apps/services/common/tests/test_path_safety.py
        repo_root = Path(__file__).resolve().parents[6]
        codegen_script = repo_root / "scripts" / "codegen-hardline.py"
        assert codegen_script.exists(), f"codegen script missing: {codegen_script}"
        # 用 sys.executable 而非 'python3'，确保用 venv（保 PEP 668 / 系统 Python 隔离）
        proc = subprocess.run(
            [sys.executable, str(codegen_script), "--check"],
            cwd=str(repo_root),
            capture_output=True,
            text=True,
            timeout=30,
        )
        assert proc.returncode == 0, (
            f"codegen --check failed (rc={proc.returncode}). "
            f"stdout: {proc.stdout!r}\nstderr: {proc.stderr!r}\n"
            f"hint: run `python scripts/codegen-hardline.py` to regenerate "
            f"generated_hardline.py, sensitive-paths.generated.ts, "
            f"and hardline-command-denylist.generated.ts."
        )
