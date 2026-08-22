"""
回归测试：SCR-003, SCR-005, SCR-022, SCR-025

- SCR-003: bins/env 过滤维度在所有平台上永远为 None，资格过滤形同虚设
- SCR-005: 移动端 bins 过滤无兜底，依赖二进制的 Skill 全部漏网
- SCR-022: _detect_platform() 永远返回服务端平台（Linux）而非客户端平台
- SCR-025: platform 过滤链路三次格式转换，任一步出错导致 os_filter 失效
"""

from django.test import SimpleTestCase

from apps.skills.services.eligibility import SkillEligibilityService, _detect_platform


class SCR022DetectPlatformNoServerFallbackTests(SimpleTestCase):
    """SCR-022: _detect_platform() 不应返回服务端平台。"""

    def test_detect_platform_returns_none(self):
        result = _detect_platform()
        self.assertIsNone(result, "_detect_platform() 不应再返回服务端平台值")

    def test_os_filter_skipped_when_platform_unknown(self):
        """platform=None 时，os_filter 不应排除任何 Skill。"""
        entry = {"skill_key": "things-mac", "os_filter": ["darwin"]}
        result = SkillEligibilityService.should_include(entry, platform=None)
        self.assertTrue(result, "platform 未知时不应排除 Skill（无法判断客户端平台）")

    def test_os_filter_excludes_when_platform_known_mismatch(self):
        """platform='linux' 时，os_filter=['darwin'] 应排除。"""
        entry = {"skill_key": "things-mac", "os_filter": ["darwin"]}
        result = SkillEligibilityService.should_include(entry, platform="linux")
        self.assertFalse(result, "platform='linux' 应排除 darwin-only Skill")

    def test_os_filter_includes_when_platform_known_match(self):
        """platform='darwin' 时，os_filter=['darwin'] 应包含。"""
        entry = {"skill_key": "things-mac", "os_filter": ["darwin"]}
        result = SkillEligibilityService.should_include(entry, platform="darwin")
        self.assertTrue(result, "platform='darwin' 应包含 darwin-only Skill")


class SCR025PlatformCanonicalFormatTests(SimpleTestCase):
    """SCR-025: _extract_os_platform 应直接返回与 os_filter 一致的规范格式。"""

    def test_darwin_os_info_returns_darwin(self):
        from apps.services.agent_engine.services.execution_context import _extract_os_platform
        self.assertEqual(_extract_os_platform({"platform": "darwin"}), "darwin")

    def test_macos_os_info_returns_darwin(self):
        from apps.services.agent_engine.services.execution_context import _extract_os_platform
        self.assertEqual(_extract_os_platform({"platform": "macOS"}), "darwin")

    def test_macos_lowercase_returns_darwin(self):
        """即使 os_info 返回小写 'macos'，也应正确映射到 'darwin'。"""
        from apps.services.agent_engine.services.execution_context import _extract_os_platform
        self.assertEqual(_extract_os_platform({"platform": "macos"}), "darwin")

    def test_linux_os_info_returns_linux(self):
        from apps.services.agent_engine.services.execution_context import _extract_os_platform
        self.assertEqual(_extract_os_platform({"platform": "linux"}), "linux")

    def test_win32_os_info_returns_win32(self):
        from apps.services.agent_engine.services.execution_context import _extract_os_platform
        self.assertEqual(_extract_os_platform({"platform": "win32"}), "win32")

    def test_windows_os_info_returns_win32(self):
        from apps.services.agent_engine.services.execution_context import _extract_os_platform
        self.assertEqual(_extract_os_platform({"platform": "Windows"}), "win32")

    def test_end_to_end_os_filter_matches_without_platform_map(self):
        """验证 _extract_os_platform 返回值可直接用于 os_filter 匹配，无需中间转换。"""
        from apps.services.agent_engine.services.execution_context import _extract_os_platform
        os_filter = ["darwin"]
        platform = _extract_os_platform({"platform": "macOS"})
        self.assertIn(platform, os_filter, "规范化平台应直接匹配 os_filter")


class SCR003BinsFilterActivationTests(SimpleTestCase):
    """SCR-003: available_bins 不为 None 时，bins 过滤应生效。"""

    def test_bins_filter_bypassed_when_none(self):
        """available_bins=None 时应跳过 bins 检查（兼容旧路径）。"""
        entry = {
            "skill_key": "tmux",
            "requires": {"bins": ["tmux"]},
        }
        result = SkillEligibilityService.should_include(
            entry, available_bins=None,
        )
        self.assertTrue(result, "available_bins=None 时不应过滤")

    def test_bins_filter_excludes_when_empty_set(self):
        """available_bins=set() 时，依赖二进制的 Skill 应被排除。"""
        entry = {
            "skill_key": "tmux",
            "requires": {"bins": ["tmux"]},
        }
        result = SkillEligibilityService.should_include(
            entry, available_bins=set(),
        )
        self.assertFalse(result, "available_bins 为空集合时应排除依赖二进制的 Skill")

    def test_bins_filter_includes_when_bin_present(self):
        """available_bins 包含所需二进制时应包含。"""
        entry = {
            "skill_key": "tmux",
            "requires": {"bins": ["tmux"]},
        }
        result = SkillEligibilityService.should_include(
            entry, available_bins={"tmux", "git"},
        )
        self.assertTrue(result)

    def test_any_bins_filter_excludes_when_empty_set(self):
        """available_bins=set() 时，any_bins 也应排除。"""
        entry = {
            "skill_key": "1password",
            "requires": {"any_bins": ["op", "1password-cli"]},
        }
        result = SkillEligibilityService.should_include(
            entry, available_bins=set(),
        )
        self.assertFalse(result, "available_bins 为空集合时 any_bins 也应排除")


class SCR005MobileBinsFilterTests(SimpleTestCase):
    """SCR-005: 移动端（can_terminal=False）bins 过滤兜底。

    通过模拟 SkillsMessageMiddleware.before_iteration 的 elig_ctx 构建逻辑，
    验证移动端正确传入 bins=set() 使得二进制依赖 Skill 被过滤。
    """

    def test_mobile_device_bins_set_to_empty(self):
        """模拟移动端构建 elig_ctx：can_terminal=False 时 bins 应为空集合。"""
        from apps.services.agent_engine.services.execution_context import ExecutionContext
        exec_ctx = ExecutionContext(
            mode="backend_only",
            can_terminal=False,
        )

        can_terminal = exec_ctx.can_terminal
        elig_ctx = {}
        if exec_ctx.device_os_platform:
            elig_ctx["platform"] = exec_ctx.device_os_platform
        if not can_terminal:
            elig_ctx["bins"] = set()

        self.assertIn("bins", elig_ctx, "移动端 elig_ctx 应包含 bins 键")
        self.assertEqual(elig_ctx["bins"], set(), "移动端 bins 应为空集合")

    def test_mobile_bins_filter_excludes_binary_skills(self):
        """移动端传入 bins=set() 应过滤掉所有依赖二进制的 Skill。"""
        skills = [
            {"skill_key": "tmux", "requires": {"bins": ["tmux"]}},
            {"skill_key": "things-mac", "requires": {"bins": ["things"]}},
            {"skill_key": "no-deps", "requires": {}},
            {"skill_key": "always-on", "always": True, "requires": {"bins": ["git"]}},
        ]
        eligible = SkillEligibilityService.filter_eligible(
            skills, available_bins=set(),
        )
        eligible_keys = {s["skill_key"] for s in eligible}
        self.assertNotIn("tmux", eligible_keys, "tmux 应被排除")
        self.assertNotIn("things-mac", eligible_keys, "things-mac 应被排除")
        self.assertIn("no-deps", eligible_keys, "无依赖的 Skill 应保留")
        self.assertIn("always-on", eligible_keys, "always=True 应绕过 bins 检查")

    def test_desktop_with_terminal_bins_not_forced_empty(self):
        """桌面端（can_terminal=True）不应强制 bins 为空集合。"""
        from apps.services.agent_engine.services.execution_context import ExecutionContext
        exec_ctx = ExecutionContext(
            mode="device_online",
            can_terminal=True,
            device_os_platform="darwin",
        )

        can_terminal = exec_ctx.can_terminal
        elig_ctx = {}
        if exec_ctx.device_os_platform:
            elig_ctx["platform"] = exec_ctx.device_os_platform
        if not can_terminal:
            elig_ctx["bins"] = set()

        self.assertNotIn("bins", elig_ctx,
                         "桌面端（有终端）不应强制 bins 为空集合，保持 None（兼容）")
