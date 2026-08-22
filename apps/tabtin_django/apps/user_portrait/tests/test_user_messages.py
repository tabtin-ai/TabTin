"""
v0.2 USER 画像 · 用户文案映射 (user_messages.py) 契约测试

  - 任何 ErrorCode 都必须有对应的中文人话（不能漏映射）
  - 任何蒸馏失败子类都必须有对应的中文人话
  - 所有用户文案不得包含内部术语（LLM / scene / organization_id 等）
  - 所有用户文案保持"短"——便于在 banner / toast / FailedBanner 直接展示

新增 ErrorCode 但忘了加映射的同学，会在 CI 上被这组测试 catch 住。
"""

from __future__ import annotations

from django.test import SimpleTestCase

from apps.user_portrait.error_codes import ErrorCode
from apps.user_portrait.user_messages import (
    INVALID_HINT_TOO_LONG_MESSAGE_TEMPLATE,
    DistillFailureKind,
    humanize_api_error,
    humanize_distill_failure,
    known_api_error_codes,
    known_distill_failure_kinds,
)


# ── 核心：所有 USER 画像可能抛出的 ErrorCode 都必须有人话 ──
#
# 列表来自代码里 raise ServiceError(ErrorCode.X, ...) 的所有用法。
# 每加一个新 raise 点就要把新 code 加到这里——这不是负担，是契约。
USER_FACING_CODES = (
    ErrorCode.UNAUTHORIZED,
    ErrorCode.PERMISSION_DENIED,
    ErrorCode.INVALID_HINT,
    ErrorCode.INVALID_ORGANIZATION_ID,
    ErrorCode.DISTILL_IN_PROGRESS,
    ErrorCode.DISTILL_FAILED,
)

# 所有蒸馏失败子类（distill_service 实际产生的 kind 集合）
USER_FACING_DISTILL_KINDS = (
    DistillFailureKind.EMPTY_OUTPUT,
    DistillFailureKind.INCOMPLETE_OUTPUT,
    DistillFailureKind.MODEL_UNAVAILABLE,
    DistillFailureKind.LLM_CALL_FAILED,
    DistillFailureKind.UNEXPECTED,
)


# 任何用户文案都不应该出现的内部术语（敏感字串）
FORBIDDEN_TERMS_IN_USER_MESSAGE = (
    "LLM",
    "scene",
    "organization_id",
    "user_id",
    "portrait_id",
    "raw_detail",
    "Hint text",     # 旧英文文案残留
    "Invalid",       # 同上
    "ServiceError",  # 内部异常类名
)

MAX_USER_MESSAGE_CHARS = 50  # 留点余量给"超长"模板格式化后的长度


class HumanizeApiErrorContractTests(SimpleTestCase):
    """API 错误码必须 100% 覆盖映射，且文案符合产品规范。"""

    def test_every_user_facing_code_has_message(self):
        for code in USER_FACING_CODES:
            with self.subTest(code=code):
                msg = humanize_api_error(code)
                self.assertTrue(
                    msg and msg.strip(),
                    f"ErrorCode {code} 缺人话映射，请在 user_messages._API_ERROR_MESSAGES 补",
                )

    def test_every_user_facing_code_in_known_list(self):
        """known_api_error_codes() 必须包含所有当前 USER 画像可能抛的 code。"""
        known = set(known_api_error_codes())
        for code in USER_FACING_CODES:
            with self.subTest(code=code):
                self.assertIn(
                    code, known,
                    f"ErrorCode {code} 不在 known_api_error_codes() — 漏注册了",
                )

    def test_no_forbidden_internal_terms(self):
        """所有用户向 API 错误文案不得包含内部术语。"""
        for code in USER_FACING_CODES:
            msg = humanize_api_error(code)
            for term in FORBIDDEN_TERMS_IN_USER_MESSAGE:
                with self.subTest(code=code, term=term):
                    self.assertNotIn(
                        term, msg,
                        f"{code} 的人话含禁用术语 {term!r}，应替换为中文表达",
                    )

    def test_messages_are_short(self):
        for code in USER_FACING_CODES:
            with self.subTest(code=code):
                msg = humanize_api_error(code)
                self.assertLessEqual(
                    len(msg), MAX_USER_MESSAGE_CHARS,
                    f"{code} 文案太长（{len(msg)} 字），banner/toast 可能被截断",
                )

    def test_unknown_code_returns_fallback(self):
        msg = humanize_api_error("SOME_UNKNOWN_CODE_NEVER_DEFINED")
        self.assertTrue(msg and "失败" in msg, "未知 code 必须返回兜底人话")

    def test_unknown_code_with_explicit_fallback(self):
        msg = humanize_api_error("SOME_UNKNOWN_CODE", fallback="自定义兜底")
        self.assertEqual(msg, "自定义兜底")


class HumanizeDistillFailureContractTests(SimpleTestCase):
    """蒸馏失败子类必须 100% 覆盖映射，且文案符合产品规范。"""

    def test_every_kind_has_message(self):
        for kind in USER_FACING_DISTILL_KINDS:
            with self.subTest(kind=kind):
                msg = humanize_distill_failure(kind)
                self.assertTrue(msg and msg.strip())

    def test_every_kind_in_known_list(self):
        known = set(known_distill_failure_kinds())
        for kind in USER_FACING_DISTILL_KINDS:
            with self.subTest(kind=kind):
                self.assertIn(kind, known)

    def test_no_forbidden_internal_terms(self):
        for kind in USER_FACING_DISTILL_KINDS:
            msg = humanize_distill_failure(kind)
            for term in FORBIDDEN_TERMS_IN_USER_MESSAGE:
                with self.subTest(kind=kind, term=term):
                    self.assertNotIn(term, msg)

    def test_all_distill_failures_keep_old_portrait_promise(self):
        """所有蒸馏失败子类都要透出"旧画像还在"或"重试"指引——降低用户焦虑。"""
        for kind in USER_FACING_DISTILL_KINDS:
            with self.subTest(kind=kind):
                msg = humanize_distill_failure(kind)
                # 任一关键词出现即可：旧画像保留 / 仍在 / 可重试
                has_safety_signal = any(
                    sig in msg for sig in ("保留旧画像", "旧画像仍在", "重试", "联系")
                )
                self.assertTrue(
                    has_safety_signal,
                    f"{kind} 的文案 '{msg}' 缺安抚词（应包含'保留'/'重试'/'联系'之一）",
                )

    def test_unknown_kind_returns_unexpected_fallback(self):
        msg = humanize_distill_failure("some_unknown_kind")
        self.assertIn("出了点问题", msg)


class InvalidHintTooLongTemplateTests(SimpleTestCase):
    """超长 hint 用专门的人话模板（区别于"空"的默认 INVALID_HINT 文案）。"""

    def test_template_format_with_limit(self):
        msg = INVALID_HINT_TOO_LONG_MESSAGE_TEMPLATE.format(limit=2000)
        self.assertIn("2000", msg)
        self.assertIn("精简", msg)
        self.assertNotIn("Hint", msg)
