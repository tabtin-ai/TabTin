"""JWTAuthOptional + get_authenticated_user 单测

覆盖 PRD §5 Phase 0.3 要求的 3 条 ninja 行为路径：

1. 带合法 token → request.auth = User 实例
2. 带过期 / 非法 token → request.auth = ANONYMOUS_USER_MARKER
3. 不带 token → request.auth = ANONYMOUS_USER_MARKER

外加 helper 自身的 4 个分支测试。

测试策略：直接调用 ``JWTAuthOptional()(request)`` 来模拟 ninja 的
``_run_authentication``，不需要拉起完整 HTTP stack。
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase


def _make_request(authorization: str = "") -> SimpleNamespace:
    """构造一个最简 HttpRequest 替身（仅暴露 ``headers``）。

    ninja 的 HttpBearer.__call__ 只读 ``request.headers.get(self.header)``。
    """
    headers = {}
    if authorization:
        headers["Authorization"] = authorization
    return SimpleNamespace(headers=headers)


class JWTAuthOptionalThreePathsTests(SimpleTestCase):
    """PRD §5 Phase 0.3 强制覆盖的 3 路径。"""

    def test_valid_token_returns_user(self):
        from apps.users.auth.permissions import JWTAuthOptional

        fake_user = SimpleNamespace(id="u-1", is_active=True)
        # 整体 patch authenticate：让它对任意 token 都返回 fake_user
        with patch.object(
            JWTAuthOptional, "authenticate", return_value=fake_user,
        ):
            req = _make_request("Bearer valid-token-abc")
            result = JWTAuthOptional()(req)
        self.assertIs(result, fake_user)

    def test_invalid_token_returns_marker_not_none(self):
        """合法 Bearer 头但 token 无效 → JWTAuth.authenticate 返 None →
        JWTAuthOptional.__call__ 必须返回 marker，**不能**返 None
        （否则 ninja 视为认证失败抛 401，破坏 optional 语义）。
        """
        from apps.users.auth.permissions import (
            ANONYMOUS_USER_MARKER,
            JWTAuthOptional,
        )

        with patch.object(
            JWTAuthOptional, "authenticate", return_value=None,
        ):
            req = _make_request("Bearer expired-or-bogus-token")
            result = JWTAuthOptional()(req)
        self.assertIs(result, ANONYMOUS_USER_MARKER)

    def test_no_token_returns_marker(self):
        """无 Authorization header → HttpBearer.__call__ 返 None →
        JWTAuthOptional.__call__ 必须返 marker，不能透传 None。
        """
        from apps.users.auth.permissions import (
            ANONYMOUS_USER_MARKER,
            JWTAuthOptional,
        )

        req = _make_request()
        result = JWTAuthOptional()(req)
        self.assertIs(result, ANONYMOUS_USER_MARKER)


class MarkerSemanticsTests(SimpleTestCase):
    """marker 必须是 truthy + 单例语义。"""

    def test_marker_is_truthy_so_ninja_treats_as_pass(self):
        from apps.users.auth.permissions import ANONYMOUS_USER_MARKER

        self.assertTrue(bool(ANONYMOUS_USER_MARKER))
        # ninja 用 `if result:` 判断 —— marker 必须为真才能让 ninja
        # 把它赋给 request.auth 而不是抛 AuthenticationError
        self.assertFalse(not ANONYMOUS_USER_MARKER)

    def test_marker_repr_is_diagnostic(self):
        from apps.users.auth.permissions import ANONYMOUS_USER_MARKER

        self.assertIn("ANONYMOUS_USER_MARKER", repr(ANONYMOUS_USER_MARKER))


class GetAuthenticatedUserHelperTests(SimpleTestCase):

    def test_returns_user_when_authed(self):
        from apps.services.common.public_share.auth import get_authenticated_user

        user = SimpleNamespace(id="u-1")
        req = SimpleNamespace(auth=user)
        self.assertIs(get_authenticated_user(req), user)

    def test_returns_none_when_marker(self):
        from apps.services.common.public_share.auth import get_authenticated_user
        from apps.users.auth.permissions import ANONYMOUS_USER_MARKER

        req = SimpleNamespace(auth=ANONYMOUS_USER_MARKER)
        self.assertIsNone(get_authenticated_user(req))

    def test_returns_none_when_no_auth_attr(self):
        """防御性兜底：request 没有 auth 属性也不应崩溃。"""
        from apps.services.common.public_share.auth import get_authenticated_user

        req = SimpleNamespace()
        self.assertIsNone(get_authenticated_user(req))

    def test_returns_none_when_auth_is_none(self):
        from apps.services.common.public_share.auth import get_authenticated_user

        req = SimpleNamespace(auth=None)
        self.assertIsNone(get_authenticated_user(req))
