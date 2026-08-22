"""
CR-010 / CR-012 / CR-015 回归测试：session_manager.py 并发竞态修复

CR-010: validate_session 与 invalidate_session 之间无原子保证
  → 新增 check_session_active 方法供长运行操作中途感知撤销
CR-012: validate_session 写回 last_activity 无事务隔离
  → 条件 UPDATE 附带 is_active=True，失效后不再静默写入
CR-015: is_expired() → save(is_active=False) 无锁并发重复写
  → 条件 UPDATE 替代 instance.save()，天然幂等
"""

from datetime import timedelta
from unittest.mock import patch

from django.db import OperationalError
from django.db.models.query import QuerySet
from django.test import TestCase
from django.utils import timezone

from apps.users.auth.models import User, UserSession
from apps.users.auth.session_manager import SessionManager


def _create_session_directly(user, raw_key="test_session_key_001", **overrides):
    """直接创建 UserSession 行，绕过 create_session 的清理逻辑"""
    hashed_key = SessionManager.hash_session_key(raw_key)
    defaults = dict(
        user=user,
        session_key=hashed_key,
        session_type="web",
        ip_address="127.0.0.1",
        user_agent="test-agent",
        device_info={},
        expires_at=timezone.now() + timedelta(hours=24),
        is_active=True,
    )
    defaults.update(overrides)
    return UserSession.objects.create(**defaults), raw_key


class TestCR015ExpiredSessionIdempotentDeactivation(TestCase):
    """CR-015: 多个并发请求同时发现 session 过期，deactivate 应幂等"""

    databases = {"default", "postgresql"}

    def setUp(self):
        self.user = User.objects.create_user(
            email="cr015@test.com", password="TestPass123!"
        )
        self.session, self.raw_key = _create_session_directly(
            self.user,
            raw_key="cr015_key",
            expires_at=timezone.now() - timedelta(hours=1),
        )

    def test_validate_expired_session_uses_conditional_update(self):
        """过期 session 验证应返回 None 并通过条件 UPDATE 标记失效"""
        result = SessionManager.validate_session(self.raw_key)
        self.assertIsNone(result)

        self.session.refresh_from_db()
        self.assertFalse(self.session.is_active)

    def test_validate_expired_session_idempotent(self):
        """多次对同一过期 session 调用 validate 均安全返回 None"""
        r1 = SessionManager.validate_session(self.raw_key)
        r2 = SessionManager.validate_session(self.raw_key)
        self.assertIsNone(r1)
        self.assertIsNone(r2)

        self.session.refresh_from_db()
        self.assertFalse(self.session.is_active)

    def test_expired_deactivation_does_not_affect_already_inactive(self):
        """session 已被 invalidate 后，过期检查的条件 UPDATE 匹配 0 行"""
        self.session.is_active = False
        self.session.save(update_fields=["is_active"])

        result = SessionManager.validate_session(self.raw_key)
        self.assertIsNone(result)


class TestCR012LastActivityConditionalWrite(TestCase):
    """CR-012: last_activity 更新必须附带 is_active=True 条件"""

    databases = {"default", "postgresql"}

    def setUp(self):
        self.user = User.objects.create_user(
            email="cr012@test.com", password="TestPass123!"
        )
        self.session, self.raw_key = _create_session_directly(
            self.user, raw_key="cr012_key"
        )

    def test_validate_active_session_updates_last_activity(self):
        """有效 session 验证后 last_activity 应被更新"""
        old_activity = UserSession.objects.get(pk=self.session.pk).last_activity

        result = SessionManager.validate_session(self.raw_key)
        self.assertIsNotNone(result)
        self.assertEqual(str(result.user_id), str(self.user.id))

        self.session.refresh_from_db()
        self.assertGreaterEqual(self.session.last_activity, old_activity)

    def test_last_activity_not_written_after_invalidation(self):
        """session 被 invalidate 后，validate 不应写入 last_activity"""
        old_activity = UserSession.objects.get(pk=self.session.pk).last_activity

        SessionManager.invalidate_session(self.raw_key)

        result = SessionManager.validate_session(self.raw_key)
        self.assertIsNone(result)

        self.session.refresh_from_db()
        self.assertFalse(self.session.is_active)
        self.assertEqual(self.session.last_activity, old_activity)

    def test_conditional_update_skips_inactive_session(self):
        """
        验证条件 UPDATE 语义：session 被 invalidate 后，
        对同一 PK 的 filter(is_active=True).update(last_activity=...) 返回 0。
        这是 CR-012 修复的核心机制。
        """
        old_activity = UserSession.objects.get(pk=self.session.pk).last_activity

        UserSession.objects.filter(
            pk=self.session.pk, is_active=True
        ).update(is_active=False)

        updated = UserSession.objects.filter(
            pk=self.session.pk, is_active=True
        ).update(last_activity=timezone.now())
        self.assertEqual(updated, 0)

        self.session.refresh_from_db()
        self.assertFalse(self.session.is_active)
        self.assertEqual(self.session.last_activity, old_activity)


class TestCR010CheckSessionActive(TestCase):
    """CR-010: check_session_active 供长运行操作中途检查 session 存活"""

    databases = {"default", "postgresql"}

    def setUp(self):
        self.user = User.objects.create_user(
            email="cr010@test.com", password="TestPass123!"
        )
        self.session, self.raw_key = _create_session_directly(
            self.user, raw_key="cr010_key"
        )

    def test_active_session_returns_true(self):
        """活跃且未过期的 session 应返回 True"""
        self.assertTrue(SessionManager.check_session_active(self.session.id))

    def test_invalidated_session_returns_false(self):
        """被 invalidate 的 session 应返回 False"""
        SessionManager.invalidate_session(self.raw_key)
        self.assertFalse(SessionManager.check_session_active(self.session.id))

    def test_expired_session_returns_false(self):
        """过期 session 应返回 False"""
        UserSession.objects.filter(pk=self.session.pk).update(
            expires_at=timezone.now() - timedelta(hours=1)
        )
        self.assertFalse(SessionManager.check_session_active(self.session.id))

    def test_nonexistent_session_returns_false(self):
        """不存在的 session ID 应返回 False"""
        self.assertFalse(SessionManager.check_session_active("nonexistent-id-xxx"))

    def test_check_reflects_real_time_invalidation(self):
        """
        模拟长运行操作场景：validate 通过后，session 被撤销，
        check_session_active 应能感知到。
        """
        session = SessionManager.validate_session(self.raw_key)
        self.assertIsNotNone(session)
        self.assertTrue(SessionManager.check_session_active(session.id))

        SessionManager.invalidate_session(self.raw_key)

        self.assertFalse(SessionManager.check_session_active(session.id))


class TestValidateSessionAtomicity(TestCase):
    """validate_session 事务完整性测试"""

    databases = {"default", "postgresql"}

    def setUp(self):
        self.user = User.objects.create_user(
            email="atomic@test.com", password="TestPass123!"
        )

    def test_validate_nonexistent_session_returns_none(self):
        """不存在的 session key 应返回 None"""
        self.assertIsNone(SessionManager.validate_session("totally_fake_key"))

    def test_validate_inactive_session_returns_none(self):
        """已失效的 session 应返回 None"""
        session, raw_key = _create_session_directly(
            self.user, raw_key="inactive_key", is_active=False
        )
        self.assertIsNone(SessionManager.validate_session(raw_key))

    def test_validate_returns_session_with_raw_key(self):
        """验证成功时，返回对象的 session_key 应为明文"""
        session, raw_key = _create_session_directly(self.user, raw_key="rawkey_test")
        result = SessionManager.validate_session(raw_key)
        self.assertIsNotNone(result)
        self.assertEqual(result.session_key, raw_key)


class TestValidateSessionLastActivityLockTimeout(TestCase):
    """#10906: last_activity 写锁超时不得把有效会话判成未登录。"""

    databases = {"default", "postgresql"}

    def setUp(self):
        self.user = User.objects.create_user(
            email="locktimeout@test.com", password="TestPass123!"
        )
        self.session, self.raw_key = _create_session_directly(
            self.user, raw_key="locktimeout_key"
        )

    def test_last_activity_lock_timeout_still_returns_session(self):
        UserSession.objects.filter(pk=self.session.pk).update(
            last_activity=timezone.now() - timedelta(minutes=5)
        )
        original_update = QuerySet.update

        def flaky_update(queryset, **kwargs):
            if "last_activity" in kwargs:
                raise OperationalError("canceling statement due to lock timeout")
            return original_update(queryset, **kwargs)

        with patch.object(QuerySet, "update", flaky_update):
            result = SessionManager.validate_session(self.raw_key)

        self.assertIsNotNone(result)
        self.assertEqual(result.session_key, self.raw_key)
        self.assertEqual(str(result.user_id), str(self.user.id))

    def test_recent_last_activity_skips_write(self):
        recent = timezone.now()
        UserSession.objects.filter(pk=self.session.pk).update(last_activity=recent)
        self.session.refresh_from_db()

        original_update = QuerySet.update
        touch_writes = []

        def tracking_update(queryset, **kwargs):
            if "last_activity" in kwargs:
                touch_writes.append(kwargs["last_activity"])
            return original_update(queryset, **kwargs)

        with patch.object(QuerySet, "update", tracking_update):
            result = SessionManager.validate_session(self.raw_key)

        self.assertIsNotNone(result)
        self.assertEqual(touch_writes, [])

    def test_stale_last_activity_is_refreshed(self):
        stale = timezone.now() - timedelta(minutes=5)
        UserSession.objects.filter(pk=self.session.pk).update(last_activity=stale)

        result = SessionManager.validate_session(self.raw_key)
        self.assertIsNotNone(result)

        self.session.refresh_from_db()
        self.assertGreater(self.session.last_activity, stale)
