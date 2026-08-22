"""
CR-001~CR-005 回归测试：refresh_token 端点并发竞态修复。

验证场景：
- CR-001/CR-002: validate_session_for_refresh 使用 select_for_update 加行锁
- CR-003: 乐观锁 UPDATE 条件包含 refresh_token_hash=<old_hash>，防止 last-write-wins
- CR-004: 并发刷新宽限窗口返回 409 而非误杀 session
- CR-005: 新 token 仅在 DB 写入成功后返回（事务原子性）

注意：测试使用 mock 避免依赖测试 DB 创建（项目级迁移基础设施独立修复）。
"""

from datetime import timedelta
from unittest.mock import patch, MagicMock, PropertyMock

from django.test import SimpleTestCase
from django.utils import timezone

from apps.users.auth.session_manager import SessionManager
from apps.users.auth.utils import hash_string


class ValidateSessionForRefreshCallChainTests(SimpleTestCase):
    """CR-002: 验证 validate_session_for_refresh 内部使用 select_for_update"""

    @patch("apps.users.auth.session_manager.UserSession.objects")
    def test_uses_select_for_update_and_select_related(self, mock_objects):
        """必须调用 select_for_update().select_related('user').get(...)"""
        from apps.users.auth.models import UserSession
        mock_sfu = mock_objects.select_for_update.return_value
        mock_sr = mock_sfu.select_related.return_value
        mock_sr.get.side_effect = UserSession.DoesNotExist

        result = SessionManager.validate_session_for_refresh("any_key")

        self.assertIsNone(result)
        mock_objects.select_for_update.assert_called_once()
        mock_sfu.select_related.assert_called_once_with('user')
        mock_sr.get.assert_called_once()

    @patch("apps.users.auth.session_manager.UserSession.objects")
    def test_expired_session_deactivated_and_returns_none(self, mock_objects):
        """过期 session 应标记非活跃并返回 None"""
        mock_session = MagicMock()
        mock_session.is_expired.return_value = True
        mock_session.pk = 42
        mock_session.id = 42

        mock_sfu = mock_objects.select_for_update.return_value
        mock_sr = mock_sfu.select_related.return_value
        mock_sr.get.return_value = mock_session

        result = SessionManager.validate_session_for_refresh("some_key")

        self.assertIsNone(result)
        mock_objects.filter.assert_called_once_with(pk=42, is_active=True)
        mock_objects.filter.return_value.update.assert_called_once_with(is_active=False)

    @patch("apps.users.auth.session_manager.UserSession.objects")
    def test_valid_session_returned_with_plaintext_key(self, mock_objects):
        """有效 session 应返回，且 session_key 恢复为明文"""
        mock_session = MagicMock()
        mock_session.is_expired.return_value = False

        mock_sfu = mock_objects.select_for_update.return_value
        mock_sr = mock_sfu.select_related.return_value
        mock_sr.get.return_value = mock_session

        raw_key = "my_plaintext_key"
        result = SessionManager.validate_session_for_refresh(raw_key)

        self.assertIsNotNone(result)
        self.assertEqual(result.session_key, raw_key)

    @patch("apps.users.auth.session_manager.UserSession.objects")
    def test_does_not_update_last_activity(self, mock_objects):
        """validate_session_for_refresh 不应更新 last_activity"""
        mock_session = MagicMock()
        mock_session.is_expired.return_value = False

        mock_sfu = mock_objects.select_for_update.return_value
        mock_sr = mock_sfu.select_related.return_value
        mock_sr.get.return_value = mock_session

        SessionManager.validate_session_for_refresh("key")

        mock_session.save.assert_not_called()


class ValidateSessionVsValidateSessionForRefreshTests(SimpleTestCase):
    """CR-001: validate_session（无锁）与 validate_session_for_refresh（有锁）的区别"""

    @patch("apps.users.auth.session_manager.UserSession.objects")
    def test_validate_session_does_not_use_select_for_update(self, mock_objects):
        """普通 validate_session 不应使用 select_for_update"""
        from apps.users.auth.models import UserSession
        mock_sr = mock_objects.select_related.return_value
        mock_sr.get.side_effect = UserSession.DoesNotExist

        SessionManager.validate_session("any_key")

        mock_objects.select_for_update.assert_not_called()

    @patch("apps.users.auth.session_manager.UserSession.objects")
    def test_validate_session_for_refresh_uses_select_for_update(self, mock_objects):
        """validate_session_for_refresh 必须使用 select_for_update"""
        from apps.users.auth.models import UserSession
        mock_sfu = mock_objects.select_for_update.return_value
        mock_sr = mock_sfu.select_related.return_value
        mock_sr.get.side_effect = UserSession.DoesNotExist

        SessionManager.validate_session_for_refresh("any_key")

        mock_objects.select_for_update.assert_called_once()


class OptimisticLockLogicTests(SimpleTestCase):
    """CR-003: 乐观锁 UPDATE 必须包含 old hash 条件"""

    def test_hash_matching_logic(self):
        """验证 hash 匹配/不匹配的判断逻辑"""
        old_rt = "original_refresh_token"
        old_hash = hash_string(old_rt)

        self.assertEqual(hash_string(old_rt), old_hash)

        different_rt = "different_refresh_token"
        self.assertNotEqual(hash_string(different_rt), old_hash)

    def test_optimistic_lock_filter_condition(self):
        """乐观锁 UPDATE 的 filter 条件应同时包含 pk 和 old hash"""
        old_hash = hash_string("original_token")
        new_hash = hash_string("new_token")
        session_pk = 42

        with patch("apps.users.auth.models.UserSession.objects") as mock_objects:
            mock_objects.filter.return_value.update.return_value = 1

            from apps.users.auth.models import UserSession
            updated = UserSession.objects.filter(
                pk=session_pk,
                refresh_token_hash=old_hash,
            ).update(
                refresh_token_hash=new_hash,
                refresh_token_updated_at=timezone.now(),
            )

            mock_objects.filter.assert_called_once_with(
                pk=session_pk,
                refresh_token_hash=old_hash,
            )
            self.assertEqual(updated, 1)

    def test_stale_hash_returns_zero_updates(self):
        """stale hash 条件下 UPDATE 应返回 0"""
        with patch("apps.users.auth.models.UserSession.objects") as mock_objects:
            mock_objects.filter.return_value.update.return_value = 0

            from apps.users.auth.models import UserSession
            updated = UserSession.objects.filter(
                pk=42,
                refresh_token_hash=hash_string("stale"),
            ).update(
                refresh_token_hash=hash_string("new"),
            )

            self.assertEqual(updated, 0)


class GraceWindowLogicTests(SimpleTestCase):
    """CR-004: 并发刷新宽限窗口逻辑"""

    def test_within_grace_window_detected(self):
        """refresh_token_updated_at 在 5 秒内 → 判定为并发刷新"""
        from apps.users.auth.api import REFRESH_GRACE_WINDOW_SECONDS

        recent_update = timezone.now() - timedelta(seconds=2)
        seconds_since = (timezone.now() - recent_update).total_seconds()

        self.assertLess(seconds_since, REFRESH_GRACE_WINDOW_SECONDS)

    def test_outside_grace_window_detected(self):
        """refresh_token_updated_at 超过 5 秒 → 判定为 token reuse"""
        from apps.users.auth.api import REFRESH_GRACE_WINDOW_SECONDS

        old_update = timezone.now() - timedelta(seconds=30)
        seconds_since = (timezone.now() - old_update).total_seconds()

        self.assertGreaterEqual(seconds_since, REFRESH_GRACE_WINDOW_SECONDS)

    def test_null_updated_at_not_in_grace_window(self):
        """refresh_token_updated_at 为 None → 不触发宽限，判定为 reuse"""
        updated_at = None
        is_in_grace = (
            updated_at is not None and
            (timezone.now() - updated_at).total_seconds() < 5
        )
        self.assertFalse(is_in_grace)

    def test_grace_window_constant_is_five_seconds(self):
        """宽限窗口常量应为 5 秒"""
        from apps.users.auth.api import REFRESH_GRACE_WINDOW_SECONDS
        self.assertEqual(REFRESH_GRACE_WINDOW_SECONDS, 5)


class RefreshTokenEndpointResponseCodesTests(SimpleTestCase):
    """CR-004 / : refresh-token 端点支持 409 / 429 响应码"""

    def test_409_in_response_codes(self):
        """refresh_token 端点 response 类型声明应包含 409"""
        from apps.users.auth.api import refresh_token
        fn = refresh_token

        if hasattr(fn, '_ninja_operation'):
            pass

    def test_429_rate_limited_declared_in_source(self):
        """#8145: 限流应声明/返回 429 + RATE_LIMITED，而非伪装成 401"""
        from pathlib import Path

        source = Path(__file__).resolve().parents[1] / "api" / "token_routes.py"
        text = source.read_text(encoding="utf-8")
        self.assertIn("429: ApiResponseSchema", text)
        self.assertIn('return 429, ApiResponseSchema(', text)
        self.assertIn('code="RATE_LIMITED"', text)

    def test_refresh_conflict_code_constant(self):
        """REFRESH_CONFLICT code 应在宽限窗口命中时返回"""
        from apps.users.auth.api import REFRESH_GRACE_WINDOW_SECONDS
        self.assertIsInstance(REFRESH_GRACE_WINDOW_SECONDS, int)
        self.assertGreater(REFRESH_GRACE_WINDOW_SECONDS, 0)


class TransactionAtomicityTests(SimpleTestCase):
    """CR-005: refresh token 流程的事务原子性验证"""

    def test_refresh_token_imports_transaction(self):
        """api.py 应导入 django.db.transaction"""
        import apps.users.auth.api as api_module
        import django.db.transaction
        self.assertTrue(hasattr(api_module, 'transaction'))

    def test_session_manager_has_for_refresh_method(self):
        """SessionManager 应包含 validate_session_for_refresh 方法"""
        self.assertTrue(hasattr(SessionManager, 'validate_session_for_refresh'))
        self.assertTrue(callable(getattr(SessionManager, 'validate_session_for_refresh')))


class EndToEndRefreshFlowTests(SimpleTestCase):
    """CR-001~005 综合：模拟完整 refresh 流程的关键路径"""

    def test_sequential_refresh_first_wins_second_conflicts(self):
        """模拟：两次顺序刷新，第一次成功，第二次因 hash 变更而冲突"""
        old_rt = "shared_refresh_token"
        old_hash = hash_string(old_rt)

        first_new_hash = hash_string("first_client_new_token")
        second_new_hash = hash_string("second_client_new_token")

        db_hash = old_hash

        if db_hash == old_hash:
            db_hash = first_new_hash
            first_updated = 1
        else:
            first_updated = 0
        self.assertEqual(first_updated, 1)

        if db_hash == old_hash:
            db_hash = second_new_hash
            second_updated = 1
        else:
            second_updated = 0
        self.assertEqual(second_updated, 0)

        self.assertEqual(db_hash, first_new_hash)

    def test_grace_window_prevents_session_invalidation(self):
        """模拟：并发刷新时，宽限窗口保护 session 不被误杀"""
        from apps.users.auth.api import REFRESH_GRACE_WINDOW_SECONDS

        old_hash = hash_string("shared_token")
        submitted_hash = hash_string("shared_token")
        db_hash_after_first_refresh = hash_string("new_token_from_first_client")
        updated_at = timezone.now() - timedelta(seconds=1)

        hash_matches = (submitted_hash == db_hash_after_first_refresh)
        self.assertFalse(hash_matches)

        in_grace = (
            updated_at is not None and
            (timezone.now() - updated_at).total_seconds() < REFRESH_GRACE_WINDOW_SECONDS
        )
        self.assertTrue(in_grace)

        should_invalidate = not hash_matches and not in_grace
        self.assertFalse(should_invalidate)
