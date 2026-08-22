"""
：密码须命中大写/小写/数字/特殊字符中的至少 3 类。

策略：纯单元测试，直接调用 SSOT `validate_user_password` 与 `is_strong_password`，
不依赖 DB / Redis。用例刻意避开 Django CommonPasswordValidator 常见表。
"""

from unittest import TestCase

from django.core.exceptions import ValidationError

from apps.users.auth.utils import is_strong_password
from apps.users.auth.validators import validate_user_password

COMPLEXITY_MSG = '密码必须包含大写字母、小写字母、数字、特殊字符中的至少3种'


class ValidateUserPasswordCharClassTests(TestCase):
    def _assert_rejects_complexity(self, password: str) -> None:
        with self.assertRaises(ValidationError) as ctx:
            validate_user_password(password)
        self.assertIn(COMPLEXITY_MSG, ctx.exception.messages)

    def test_one_class_rejected(self):
        self._assert_rejects_complexity('xvqkzmpl')
        self.assertFalse(is_strong_password('xvqkzmpl'))

    def test_two_classes_letter_digit_rejected(self):
        # 仅小写+数字 / 仅大写+数字 = 2 类（真·「字母+数字」两类）
        self._assert_rejects_complexity('xvqkzmpl1')
        self._assert_rejects_complexity('XVQKZMPL1')
        self.assertFalse(is_strong_password('xvqkzmpl1'))
        self.assertFalse(is_strong_password('XVQKZMPL1'))

    def test_two_classes_mixed_case_letters_only_rejected(self):
        self._assert_rejects_complexity('Xvqkzmpl')
        self.assertFalse(is_strong_password('Xvqkzmpl'))

    def test_three_classes_mixed_case_and_digit_passes(self):
        # 大写+小写+数字 = 3 类；无特殊字符亦可（与产品 SSOT 一致）
        validate_user_password('Kp7tVrmn3x')
        self.assertTrue(is_strong_password('Kp7tVrmn3x'))

    def test_three_classes_lower_digit_special_passes(self):
        # 小写+数字+特殊 = 3 类
        validate_user_password('xvqkzm1!')
        self.assertTrue(is_strong_password('xvqkzm1!'))

    def test_four_classes_passes(self):
        validate_user_password('Kp7tVrmn3!')
        self.assertTrue(is_strong_password('Kp7tVrmn3!'))

    # ：白名单外的反引号 / 间隔号也算特殊字符
    def test_backtick_and_interpunct_count_as_special(self):
        validate_user_password('niwota0512`')
        validate_user_password('niwota0512·')
        self.assertTrue(is_strong_password('niwota0512`'))
        self.assertTrue(is_strong_password('niwota0512·'))

    # ：含汉字的散文不可作新密码
    def test_cjk_prose_rejected(self):
        with self.assertRaises(ValidationError) as ctx:
            validate_user_password('这个报错的原因是Education.')
        self.assertTrue(
            any('中日韩' in msg for msg in ctx.exception.messages),
            ctx.exception.messages,
        )
