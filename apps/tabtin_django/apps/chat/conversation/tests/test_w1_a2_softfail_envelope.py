"""contract Wave 1 / A2 — fail-soft 路径强制 ``err_response('SOFT_FAIL', ...)`` 形状契约测试。

历史背景（dogfood 4eb4a2f2 复盘 + contract 主战场 §一·1.2）：

后端"假装成功的兜底数据"是 contract 项目要根除的反模式 —— 譬如旧
``generate_title`` view 里 force=False 且会话已有标题时会返
``GenerateTitleResponse(success=False, title=session.title, message=...)``
包成 ``{ok:true, data:{success:false, ...}}``，前端拿到 envelope ok:true
**误以为成功**，把 ``data.title``（其实就是当前的 "新对话"）写进 cache，
让用户永远看到 "新对话"。

Wave 1 A2 改造后，所有 fail-soft 路径必须返：

  ``{ok: false, error: {code: 'SOFT_FAIL', message: ..., detail: {fallback: {...}, reason: ...}}}``

前端默认 throw / skip ok:false，不会再被 fallback 数据误导；如果调用方
**主动**想消费兜底数据（譬如想保留占位文案）才显式读
``error.detail.fallback``。

本测试覆盖 W1 A2 改造仍在用的路径：

* ``compact_session`` session 不存在路径（NOT_FOUND envelope，与 SOFT_FAIL 区分）
* ``test_ssh_connection`` SSH 连接失败路径
* ``admin_update_app_authorization`` setting 不存在路径

**变更（用户级事件治理 W1）**：原 ``generate_title`` view 三个 fail-soft 分支
（``force_required`` / ``no_messages`` / ``llm_unavailable``）随 fire-and-forget
改造下线 —— 新 view 不再同步 await LLM、不返回 ``title``，所以
"返 stale title 假装成功" 这条反模式根上消失了。fire-and-forget 路径的契约
覆盖见 ``test_generate_title_view_fire_and_forget.py``。

测试策略（同 ``test_title_async_late_persist.py``）：本仓库 ``chat.conversation``
模块的 MySQL ``CONVERT TO CHARACTER SET`` migration 跟 SQLite 测试库不兼容，
跑不了 ``TestCase`` + 真 DB；本文件用 ``SimpleTestCase`` + ``unittest.mock``
直接调 view 函数，只验证 envelope **结构契约**，不验证业务真值。
"""
from __future__ import annotations

import asyncio
import os
import sys
from unittest.mock import MagicMock, patch

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")
if not django.apps.apps.ready:
    django.setup()

from django.test import SimpleTestCase  # noqa: E402

from apps.chat.conversation.api import session as session_api  # noqa: E402
from apps.chat.conversation.services.compaction_service import (  # noqa: E402
    SessionCompactionNotFoundError,
)


def _run_async(coro):
    """同步 helper：在 SimpleTestCase 里跑 async view。"""
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _build_mock_request(*, request_id: str | None = None):
    """构造一个 ``getattr(request, 'request_id', None)`` 行为正确的 mock request。

    ``err_response(request=request)`` 内部用 ``getattr(request, "request_id", None)``
    自动 resolve trace_id；裸 ``MagicMock`` 会让所有 attr lookup 返回新的
    MagicMock instance（而非 None），导致 envelope ``trace_id`` 字段进了一个
    无法 JSON 序列化的 MagicMock。手工把 ``request_id`` set 成显式值（默认
    ``None``，模拟"中间件没注入 trace_id"场景）。
    """
    request = MagicMock()
    request.auth = MagicMock(id="u-1")
    request.headers = {}
    request.META = {}
    request.request_id = request_id
    return request


def _assert_softfail_envelope(test, response, *, expected_reason: str, expected_fallback_keys: set):
    """通用断言：response 必须是 envelope ``ok:false`` + ``error.code='SOFT_FAIL'``
    + ``error.detail.fallback`` 含指定 key + ``error.detail.reason`` 等于期望值。

    这就是 W1 A2 fail-soft 契约 —— 任何 fail-soft 改造路径都应通过本断言。

    **Wave 2 W2-ε 收紧**（W1 §五登记的 [P2]）：早期版本用过
    ``response.get("success") or response.get("ok")`` / ``response.get("error") or {}``
    这种"or 兼容"写法以"过渡期同时容忍新老形态"，但 A2 改造已经把所有 fail-soft
    路径改成 envelope，本测试**就是为了守住 envelope 契约的回归敏感度**——
    任何 fail-soft 路径退化回老 ``{success: false}`` / 漏返 ``error`` / 漏返
    ``detail.reason`` 都必须立即让本测试 fail，不该被"or 默认空字典"吞掉。
    所以下方所有 ``response[key]`` / ``error[key]`` 一律用方括号下标，缺字段
    即抛 KeyError，断言失败 trace 第一时间指出真正缺哪个字段。
    """
    test.assertIsInstance(response, dict, "fail-soft 路径应直接返 envelope dict（非 tuple）")
    test.assertIs(response["ok"], False, f"ok 必须显式为 False（不允许字段缺失或非布尔值）：{response}")
    test.assertIn("error", response, f"ok:false envelope 必须含顶层 error 字段：{response}")
    error = response["error"]
    test.assertIsInstance(error, dict, f"error 必须是 dict：{error}")
    test.assertEqual(error["code"], "SOFT_FAIL", f"error.code 必须是 SOFT_FAIL: {error}")
    test.assertIn("message", error, f"error 必须含 message: {error}")
    test.assertIn("detail", error, f"SOFT_FAIL envelope 必须含 error.detail: {error}")
    detail = error["detail"]
    test.assertIsInstance(detail, dict, f"detail 必须是 dict：{detail}")
    test.assertIn("fallback", detail, "SOFT_FAIL 必须带 detail.fallback 供调用方选择性消费")
    fallback = detail["fallback"]
    test.assertIsInstance(fallback, dict)
    test.assertTrue(
        expected_fallback_keys.issubset(fallback.keys()),
        f"fallback 缺少 key: {expected_fallback_keys - set(fallback.keys())}",
    )
    test.assertEqual(detail["reason"], expected_reason, f"detail.reason 必须等于 {expected_reason}: {detail}")


class TestCompactSessionNotFound(SimpleTestCase):
    """``compact_session`` view session 不存在路径契约 —— NOT_FOUND envelope。

    跟 generate_title 的 SOFT_FAIL 区分：session 不存在是**真错误**，不该
    走 SOFT_FAIL 兜底（用户行为本身就是错的，不是后台异步 best-effort）；
    返 NOT_FOUND 让前端正确显示"会话不存在"而非"压缩失败可重试"。
    """

    def test_returns_not_found_envelope_when_session_missing(self):
        request = _build_mock_request()

        from apps.chat.conversation.schemas import CompactSessionRequest
        data = CompactSessionRequest()  # use schema defaults — keep_last_messages=20, summary_max_tokens=800

        with patch(
            "apps.chat.conversation.services.compaction_service.SessionCompactionService.compact_session",
            side_effect=SessionCompactionNotFoundError("sess-x"),
        ):
            response = session_api.compact_session(request, "sess-x", data)

        # error_response_with_status 返 (status_code, dict) tuple — 这是
        # 老 helper 的形态（§五 P1，留 W6/W7 统一）。本测试只校验 status=404
        # + body 的 code='NOT_FOUND'，明确"session 不存在"信号传到前端。
        self.assertIsInstance(response, tuple)
        status_code, body = response
        self.assertEqual(status_code, 404)
        self.assertEqual(body.get("code"), "NOT_FOUND")


class TestSshTestConnectionSoftFail(SimpleTestCase):
    """``test_ssh_connection`` view SSH 连接失败 → SOFT_FAIL（retryable）契约。"""

    def test_connection_failure_returns_softfail(self):
        from apps.tabtinspace.routers.remote_server import test_ssh_connection
        from uuid import uuid4

        request = _build_mock_request()

        with patch(
            "apps.tabtinspace.services.ssh_execution_service.SSHExecutionService.test_connection",
            return_value={"ok": False, "error": "ssh: connect timed out"},
        ):
            response = test_ssh_connection(request, uuid4())

        # Wave 1 A2 + review 自修：SSH 与 generate_title 同源走 _assert_softfail_envelope，
        # 强制 detail.reason + detail.fallback 同时存在（统一 SOFT_FAIL 子契约）。
        _assert_softfail_envelope(
            self, response,
            expected_reason="connection_failed",
            expected_fallback_keys={"error"},
        )
        self.assertTrue(response["error"].get("retryable"), "SSH 失败应可重试")
        self.assertEqual(
            response["error"]["detail"]["fallback"]["error"],
            "ssh: connect timed out",
        )

    def test_connection_success_returns_envelope_ok(self):
        from apps.tabtinspace.routers.remote_server import test_ssh_connection
        from uuid import uuid4

        request = _build_mock_request()

        with patch(
            "apps.tabtinspace.services.ssh_execution_service.SSHExecutionService.test_connection",
            return_value={"ok": True, "os_info": "Ubuntu 22.04 LTS"},
        ):
            response = test_ssh_connection(request, uuid4())

        # 成功路径用的是 ``apps.i18n.response.success_response`` 老 helper，
        # 形态是 ``{success: True, code: 'SUCCESS', message, data}`` —— 不是新
        # envelope ``{ok: True, data}``（W6 / W7 收口老 helper 后才会迁过来）。
        # W2 W2-ε 收紧（W1 §五 [P2]）：早期版本用 ``success or ok`` 兼容写法，
        # 但同时容忍两种形态会让"老 helper 哪天悄悄换成 envelope"被静默吞掉，
        # 本期改为精确断言现网实际形态——success_response 必须返 ``success=True``，
        # 真要换 helper 时这条测试会先 fail，提醒开发者同步迁全部 caller。
        self.assertIsInstance(response, dict)
        self.assertIs(
            response.get("success"),
            True,
            f"老 success_response 必须返 success=True；envelope 迁移见 W6/W7：{response}",
        )


class TestAdminUpdateAppAuthorizationNotFound(SimpleTestCase):
    """``admin_update_app_authorization`` setting 不存在路径契约 —— err_response NOT_FOUND envelope。"""

    def test_setting_missing_returns_not_found_envelope(self):
        import json
        from uuid import uuid4
        from django.http import JsonResponse
        from apps.tabtinspace.admin_app_platform_api import (
            admin_update_app_authorization,
            UpdateAuthorizationRequest,
        )

        request = _build_mock_request()
        # 提升 request.auth 权限：admin endpoint 默认 SuperuserAuth，本测试绕开 auth 直接调
        # view 函数（不走 ninja decorator），所以无所谓 auth；但保留 spec 一致性。
        request.auth.is_staff = True
        request.auth.is_superuser = True

        # admin view 内是 ``from apps.tabtinspace.models import SpaceAppSettings`` 局部 import，
        # 必须 patch 到 model 真实位置（``apps.tabtinspace.models.SpaceAppSettings``），不是
        # admin_app_platform_api 模块下的别名。
        with patch(
            "apps.tabtinspace.models.SpaceAppSettings.objects"
        ) as mock_objects:
            mock_qs = MagicMock()
            mock_qs.first.return_value = None
            mock_objects.filter.return_value = mock_qs

            data = UpdateAuthorizationRequest()
            response = admin_update_app_authorization(request, setting_id=uuid4(), data=data)

        self.assertIsInstance(response, JsonResponse)
        self.assertEqual(response.status_code, 404)
        body = json.loads(response.content.decode("utf-8"))
        # err_response 形态：{ok: false, error: {code, message, ...}}
        self.assertFalse(body.get("ok"))
        self.assertEqual(body.get("error", {}).get("code"), "NOT_FOUND")
