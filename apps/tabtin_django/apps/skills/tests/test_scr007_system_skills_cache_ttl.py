"""
SCR-007 回归测试 — system_skills 缓存 TTL 失效机制

覆盖场景：
1. 缓存在 TTL 内返回已有数据（不重新扫描磁盘）
2. 缓存超过 TTL 后重新扫描
3. invalidate_system_skills_cache() 立即使缓存失效
4. 多次调用 invalidate 是安全的（幂等）

运行：
    cd apps/tabtin_django
    python manage.py test apps.skills.tests.test_scr007_system_skills_cache_ttl --verbosity=2 --no-input
"""

from __future__ import annotations

from unittest.mock import patch, MagicMock

from django.test import SimpleTestCase

from apps.skills.services import registry_service as rs


class TestSCR007SystemSkillsCacheTTL(SimpleTestCase):
    """SCR-007: _system_skills_cache 在 TTL 后自动刷新。"""

    def setUp(self):
        self._orig_cache = rs._system_skills_cache
        self._orig_ts = rs._system_skills_cache_ts
        rs._system_skills_cache = None
        rs._system_skills_cache_ts = 0.0

    def tearDown(self):
        rs._system_skills_cache = self._orig_cache
        rs._system_skills_cache_ts = self._orig_ts

    @patch.object(rs, "_scan_skill_dirs", return_value=[])
    def test_cache_within_ttl_no_rescan(self, mock_scan):
        """TTL 内多次调用不重新扫描磁盘。"""
        import time as _time
        from pathlib import Path

        with patch.object(Path, "exists", return_value=True):
            result1 = rs.SkillsRegistryService.list_system_skills()
        self.assertEqual(mock_scan.call_count, 1)

        result2 = rs.SkillsRegistryService.list_system_skills()
        self.assertEqual(mock_scan.call_count, 1)

    @patch.object(rs, "_scan_skill_dirs", return_value=[])
    def test_cache_expired_triggers_rescan(self, mock_scan):
        """TTL 过期后重新扫描。"""
        from pathlib import Path

        with patch.object(Path, "exists", return_value=True):
            rs.SkillsRegistryService.list_system_skills()

        self.assertEqual(mock_scan.call_count, 1)

        rs._system_skills_cache_ts = rs._system_skills_cache_ts - rs._SYSTEM_SKILLS_CACHE_TTL - 1

        with patch.object(Path, "exists", return_value=True):
            rs.SkillsRegistryService.list_system_skills()

        self.assertEqual(mock_scan.call_count, 2)

    def test_invalidate_clears_cache(self):
        """invalidate_system_skills_cache() 使缓存失效。"""
        rs._system_skills_cache = [{"skill_id": "test"}]
        rs._system_skills_cache_ts = 99999999.0

        rs.invalidate_system_skills_cache()

        self.assertIsNone(rs._system_skills_cache)
        self.assertEqual(rs._system_skills_cache_ts, 0.0)

    def test_invalidate_idempotent(self):
        """多次调用 invalidate 不会报错。"""
        rs.invalidate_system_skills_cache()
        rs.invalidate_system_skills_cache()
        self.assertIsNone(rs._system_skills_cache)

    @patch.object(rs, "_scan_skill_dirs", return_value=[])
    def test_invalidate_forces_rescan(self, mock_scan):
        """invalidate 后下一次调用强制重新扫描。"""
        from pathlib import Path

        with patch.object(Path, "exists", return_value=True):
            rs.SkillsRegistryService.list_system_skills()

        self.assertEqual(mock_scan.call_count, 1)

        rs.invalidate_system_skills_cache()

        with patch.object(Path, "exists", return_value=True):
            rs.SkillsRegistryService.list_system_skills()

        self.assertEqual(mock_scan.call_count, 2)

    def test_deepcopy_isolation(self):
        """返回值是深拷贝，修改返回值不影响缓存。"""
        rs._system_skills_cache = [{"skill_id": "immutable", "tags": ["a"]}]
        import time as _time
        rs._system_skills_cache_ts = _time.monotonic()

        result = rs.SkillsRegistryService.list_system_skills()
        result[0]["tags"].append("MUTATED")

        cached = rs._system_skills_cache
        self.assertNotIn("MUTATED", cached[0]["tags"])
