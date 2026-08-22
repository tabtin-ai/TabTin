"""
 回归测试：密码禁止包含任何空白字符。

策略：纯单元测试，直接调用 SSOT 校验器 `validate_user_password`
与强度工具 `is_strong_password`，不依赖 DB / Redis / Django Server。
（pytest-django 在 pytest_configure 阶段已 setup Django，模块顶层
 `get_user_model()` 与 Django 内置 `validate_password` 可正常工作。）
"""

from unittest import TestCase

from django.core.exceptions import ValidationError

from apps.users.auth.utils import is_strong_password
from apps.users.auth.validators import validate_user_password


class ValidateUserPasswordWhitespaceTests(TestCase):
    """反向用例：含空白的密码应被拒绝。"""

    def _assert_rejects_whitespace(self, password):
        with self.assertRaises(ValidationError) as ctx:
            validate_user_password(password)
        messages = ctx.exception.messages
        self.assertIn('密码不能包含空格', messages)

    def test_leading_space_rejected(self):
        self._assert_rejects_whitespace(' Abc12345')

    def test_trailing_space_rejected(self):
        self._assert_rejects_whitespace('Abc12345 ')

    def test_middle_space_rejected(self):
        self._assert_rejects_whitespace('Abc 12345')

    def test_all_spaces_rejected(self):
        self._assert_rejects_whitespace('        ')

    def test_tab_rejected(self):
        self._assert_rejects_whitespace('Abc1234\t5')

    def test_newline_rejected(self):
        self._assert_rejects_whitespace('Abc1234\n5')


class ValidateUserPasswordPositiveTests(TestCase):
    """正向用例：不含空白的合规密码应通过。"""

    def test_strong_password_without_whitespace_passes(self):
        # 大写 + 小写 + 数字 + 特殊字符，满足复杂度且无空白
        validate_user_password('Abcd1234!')

    def test_three_classes_without_whitespace_passes(self):
        # 大写 + 小写 + 数字三类、无空白、且非 Django 常见密码表命中
        validate_user_password('Kp7tVrmn3x')


class IsStrongPasswordWhitespaceTests(TestCase):
    """强度工具应与禁空白口径一致。"""

    def test_whitespace_password_not_strong(self):
        self.assertFalse(is_strong_password('Abcd 1234'))

    def test_clean_password_is_strong(self):
        self.assertTrue(is_strong_password('Abcd1234!'))
