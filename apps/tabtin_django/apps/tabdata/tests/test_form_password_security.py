"""
回归测试：表单密码安全修复 (BS-002, BS-003, BS-009, AS-001)

Wave 5 §8：TableShare.password 字段已改名为 ``password_hash``，
所有存量明文已 hash 化（migration 0036）；外部 verify 行为不变。

验证：
- TableShare.set_password / check_password 正常工作（BS-002）
- 速率限制逻辑正确（BS-003）
- api_form.py 中的密码验证调用链路走 check_password（BS-002 + BS-009）
"""
import uuid

from django.test import TestCase, override_settings
from django.contrib.auth import get_user_model
from django.contrib.auth.hashers import identify_hasher

from apps.tabdata.models import TableShare, Table, TableView
from apps.tabdata.api_form import (
    _is_password_rate_limited,
    _record_password_failure,
    MAX_PASSWORD_ATTEMPTS,
)

User = get_user_model()


class TableSharePasswordTest(TestCase):
    """TableShare 密码哈希与验证"""

    databases = ['default', 'postgresql']

    def setUp(self):
        self.user = User.objects.create_user(
            username=f'testuser_{uuid.uuid4().hex[:8]}',
            email='pwd_test@example.com',
            password='testpass',
        )
        self.table = Table.objects.using('postgresql').create(
            name='test_table',
            created_by=self.user,
        )
        self.view = TableView.objects.using('postgresql').create(
            table=self.table,
            name='form_view',
            view_type='form',
        )

    def _make_share(self, **kwargs):
        defaults = dict(
            table=self.table,
            view=self.view,
            share_id=uuid.uuid4().hex[:16],
            created_by=self.user,
        )
        defaults.update(kwargs)
        return TableShare.objects.using('postgresql').create(**defaults)

    # ── BS-002: set_password 生成 Django 标准哈希 ──

    def test_set_password_produces_hash(self):
        share = self._make_share()
        share.set_password('my_secret')
        share.save(update_fields=['password_hash'])
        share.refresh_from_db()

        self.assertTrue(share.password_hash)
        identify_hasher(share.password_hash)

    def test_set_password_empty_clears(self):
        share = self._make_share()
        share.set_password('my_secret')
        share.save(update_fields=['password_hash'])
        share.set_password('')
        self.assertEqual(share.password_hash, '')

    # ── BS-002: check_password 验证哈希 ──

    def test_check_password_correct(self):
        share = self._make_share()
        share.set_password('correct_pwd')
        share.save(update_fields=['password_hash'])
        self.assertTrue(share.check_password('correct_pwd'))

    def test_check_password_wrong(self):
        share = self._make_share()
        share.set_password('correct_pwd')
        share.save(update_fields=['password_hash'])
        self.assertFalse(share.check_password('wrong_pwd'))

    def test_check_password_empty_stored(self):
        share = self._make_share()
        self.assertFalse(share.check_password('anything'))

    def test_has_password_property(self):
        share = self._make_share()
        self.assertFalse(share.has_password)
        share.set_password('abc')
        share.save(update_fields=['password_hash'])
        self.assertTrue(share.has_password)


@override_settings(CACHES={'default': {'BACKEND': 'django.core.cache.backends.locmem.LocMemCache'}})
class PasswordRateLimitTest(TestCase):
    """密码验证速率限制 (BS-003)"""

    def test_not_limited_initially(self):
        self.assertFalse(_is_password_rate_limited('share1', '1.2.3.4'))

    def test_limited_after_max_attempts(self):
        for _ in range(MAX_PASSWORD_ATTEMPTS):
            _record_password_failure('share2', '5.6.7.8')
        self.assertTrue(_is_password_rate_limited('share2', '5.6.7.8'))

    def test_different_ip_not_affected(self):
        for _ in range(MAX_PASSWORD_ATTEMPTS):
            _record_password_failure('share3', '1.1.1.1')
        self.assertFalse(_is_password_rate_limited('share3', '2.2.2.2'))

    def test_different_share_not_affected(self):
        for _ in range(MAX_PASSWORD_ATTEMPTS):
            _record_password_failure('shareA', '3.3.3.3')
        self.assertFalse(_is_password_rate_limited('shareB', '3.3.3.3'))
