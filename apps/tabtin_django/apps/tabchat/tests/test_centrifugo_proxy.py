"""centrifugo_proxy.py 测试套件。

覆盖 Centrifugo Proxy 全部五个端点 + 内部鉴权函数，为 IM 全链路鉴权
建立安全网，防止重构回归。

场景清单：
1. Connect Proxy — proxy secret/IP/JWT/session/organization 全链路
2. Subscribe Proxy — chat 频道 + personal 频道权限校验
3. Publish Proxy — 事件类型白名单 + 频道限制
4. Refresh Proxy — 续期/用户禁用/session 吊销
5. Sub Refresh Proxy — 订阅持续权限验证
6. _check_chat_channel_access — DB 级别权限判定
7. 辅助函数 — _parse_chat_conv_id / _ip_matches_list / _resolve_source_ip
"""

from __future__ import annotations

import ipaddress
import os
import sys
import time
import uuid
from contextlib import ExitStack
from unittest.mock import MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")
if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402

django.setup()

from django.contrib.auth import get_user_model  # noqa: E402
from django.http import JsonResponse  # noqa: E402
from django.test import SimpleTestCase, override_settings  # noqa: E402

from apps.tabchat.centrifugo_proxy import (  # noqa: E402
    ConnectRequest,
    PublishRequest,
    RefreshRequest,
    SubRefreshRequest,
    SubscribeRequest,
    _check_chat_channel_access,
    _check_proxy_ip,
    _check_space_channel_access,
    _check_proxy_secret,
    _ip_matches_list,
    _parse_chat_conv_id,
    _resolve_source_ip,
    centrifugo_connect_proxy,
    centrifugo_publish_proxy,
    centrifugo_refresh_proxy,
    centrifugo_sub_refresh_proxy,
    centrifugo_subscribe_proxy,
)

User = get_user_model()

_MOCK_PROXY_SECRET = "apps.tabchat.centrifugo_proxy._check_proxy_secret"
_MOCK_VERIFY_JWT = "apps.tabchat.centrifugo_proxy.verify_jwt_token"
_MOCK_SESSION_MGR = "apps.tabchat.centrifugo_proxy.SessionManager"
_MOCK_JTI_REVOKED = "apps.tabtinspace.services.daemon_token_service.is_daemon_token_revoked"
_MOCK_REDIS = "django_redis.get_redis_connection"
_MOCK_CONVERSATION = "apps.tabchat.models.Conversation"
_MOCK_CONVERSATION_ACCESS = (
    "apps.tabchat.services.conversation_access.ConversationAccessResolver.resolve"
)
_MOCK_ORGANIZATION = "apps.tabtinspace.models.Organization"
_MOCK_WT_MEMBER = "apps.tabtinspace.models.OrganizationMember"
_MOCK_USER_SESSION = "apps.users.auth.models.UserSession"
_MOCK_CHAT_ACCESS = "apps.tabchat.centrifugo_proxy._check_chat_channel_access"
_MOCK_SPACE_ACCESS = "apps.tabchat.centrifugo_proxy._check_space_channel_access"

# ---------------------------------------------------------------------------
# 测试常量
# ---------------------------------------------------------------------------

_USER_ID = str(uuid.uuid4())
_OTHER_USER_ID = str(uuid.uuid4())
_ORGANIZATION_ID = str(uuid.uuid4())
_CONV_ID = str(uuid.uuid4())
_SPACE_ID = str(uuid.uuid4())
_SESSION_KEY = "test-session-key-abc123"
_PROXY_SECRET = "centrifugo-shared-secret-xyz"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _jwt_payload(**overrides) -> dict:
    base = {
        "token_type": "access",
        "user_id": _USER_ID,
        "sid": _SESSION_KEY,
        "exp": int(time.time()) + 3600,
        "jti": "test-jti-001",
    }
    base.update(overrides)
    return base


def _make_user(user_id=None, display_name="TestUser"):
    user = MagicMock()
    user.id = user_id or _USER_ID
    user.is_active = True
    user.display_name = display_name
    user.username = "testuser"
    return user


def _make_session(user_id=None):
    session = MagicMock()
    session.user_id = user_id or _USER_ID
    return session


def _make_request(remote_addr="127.0.0.1", proxy_secret=_PROXY_SECRET):
    """构造模拟 Django request，满足 proxy 端点的属性访问。"""
    request = MagicMock()
    request.META = {"REMOTE_ADDR": remote_addr}
    request.headers = {"X-Centrifugo-Proxy-Secret": proxy_secret}
    request.path = ""
    return request


def _connect_payload(token="fake-jwt", organization_id="", **extra):
    data = {"token": token}
    if organization_id:
        data["organization_id"] = organization_id
    data.update(extra)
    return ConnectRequest(client="test-client", data=data)


def _patch_connect(
    *,
    jwt_payload=None,
    jwt_default=True,
    user=None,
    user_not_found=False,
    session=None,
    session_valid=True,
    jti_revoked=False,
) -> ExitStack:
    """返回 ExitStack，配置 connect proxy 的全部 happy-path mock。

    调用方可通过参数覆盖特定步骤以测试失败分支。
    """
    stack = ExitStack()

    stack.enter_context(patch(_MOCK_PROXY_SECRET, return_value=None))

    jwt_val = (
        jwt_payload
        if jwt_payload is not None
        else (_jwt_payload() if jwt_default else None)
    )
    stack.enter_context(patch(_MOCK_VERIFY_JWT, return_value=jwt_val))

    mock_sm = stack.enter_context(patch(_MOCK_SESSION_MGR))
    if session_valid:
        mock_sm.validate_session.return_value = session or _make_session()
    else:
        mock_sm.validate_session.return_value = None

    stack.enter_context(patch(_MOCK_JTI_REVOKED, return_value=jti_revoked))

    if user_not_found:
        stack.enter_context(
            patch.object(User.objects, "get", side_effect=User.DoesNotExist)
        )
    else:
        stack.enter_context(
            patch.object(User.objects, "get", return_value=user or _make_user())
        )

    mock_redis = stack.enter_context(patch(_MOCK_REDIS))
    mock_pipe = MagicMock()
    mock_pipe.execute.return_value = (None, None, 1)
    mock_redis.return_value.pipeline.return_value = mock_pipe

    return stack


# ===========================================================================
# 1. 辅助函数测试
# ===========================================================================


class TestParseConvId(SimpleTestCase):
    """_parse_chat_conv_id: 从频道名提取并校验 UUID。"""

    def test_valid_uuid(self):
        conv_id = str(uuid.uuid4())
        self.assertEqual(_parse_chat_conv_id(f"chat:{conv_id}"), conv_id)

    def test_invalid_uuid(self):
        self.assertIsNone(_parse_chat_conv_id("chat:not-a-uuid"))

    def test_no_colon(self):
        self.assertIsNone(_parse_chat_conv_id("chat"))

    def test_empty_after_colon(self):
        self.assertIsNone(_parse_chat_conv_id("chat:"))


class TestIpMatchesList(SimpleTestCase):
    """_ip_matches_list: IP 白名单匹配（单 IP + CIDR）。"""

    def test_exact_ipv4_match(self):
        self.assertTrue(_ip_matches_list(ipaddress.ip_address("10.0.0.1"), ["10.0.0.1"]))

    def test_exact_ipv4_no_match(self):
        self.assertFalse(_ip_matches_list(ipaddress.ip_address("10.0.0.2"), ["10.0.0.1"]))

    def test_cidr_match(self):
        self.assertTrue(_ip_matches_list(ipaddress.ip_address("10.0.0.55"), ["10.0.0.0/24"]))

    def test_cidr_no_match(self):
        self.assertFalse(_ip_matches_list(ipaddress.ip_address("10.0.1.1"), ["10.0.0.0/24"]))

    def test_ipv6_exact_match(self):
        self.assertTrue(_ip_matches_list(ipaddress.ip_address("::1"), ["::1"]))

    def test_invalid_entry_skipped(self):
        self.assertTrue(_ip_matches_list(ipaddress.ip_address("10.0.0.1"), ["garbage", "10.0.0.1"]))

    def test_empty_list(self):
        self.assertFalse(_ip_matches_list(ipaddress.ip_address("10.0.0.1"), []))


class TestResolveSourceIp(SimpleTestCase):
    """_resolve_source_ip: 反向代理穿透逻辑。"""

    def test_no_trusted_proxies_returns_remote_addr(self):
        req = MagicMock()
        req.META = {}
        with self.settings(CENTRIFUGO_TRUSTED_PROXIES=[]):
            self.assertEqual(_resolve_source_ip(req, "1.2.3.4"), "1.2.3.4")

    @override_settings(CENTRIFUGO_TRUSTED_PROXIES=["10.0.0.1"])
    def test_trusted_proxy_x_real_ip(self):
        req = MagicMock()
        req.META = {"HTTP_X_REAL_IP": "203.0.113.1"}
        self.assertEqual(_resolve_source_ip(req, "10.0.0.1"), "203.0.113.1")

    @override_settings(CENTRIFUGO_TRUSTED_PROXIES=["10.0.0.1"])
    def test_trusted_proxy_xff_rightmost(self):
        req = MagicMock()
        req.META = {"HTTP_X_REAL_IP": "", "HTTP_X_FORWARDED_FOR": "203.0.113.5, 10.0.0.1"}
        self.assertEqual(_resolve_source_ip(req, "10.0.0.1"), "203.0.113.5")

    @override_settings(CENTRIFUGO_TRUSTED_PROXIES=["10.0.0.1"])
    def test_non_trusted_remote_addr_passthrough(self):
        req = MagicMock()
        req.META = {"HTTP_X_REAL_IP": "spoofed"}
        self.assertEqual(_resolve_source_ip(req, "1.2.3.4"), "1.2.3.4")


# ===========================================================================
# 2. Proxy Secret + IP 白名单
# ===========================================================================


class TestCheckProxyIp(SimpleTestCase):
    """_check_proxy_ip: 来源 IP 白名单校验。"""

    def test_localhost_allowed_by_default(self):
        self.assertIsNone(_check_proxy_ip(_make_request(remote_addr="127.0.0.1")))

    def test_ipv6_localhost_allowed_by_default(self):
        self.assertIsNone(_check_proxy_ip(_make_request(remote_addr="::1")))

    def test_non_whitelisted_ip_rejected(self):
        resp = _check_proxy_ip(_make_request(remote_addr="1.2.3.4"))
        self.assertIsInstance(resp, JsonResponse)
        self.assertEqual(resp.status_code, 403)

    @override_settings(CENTRIFUGO_ALLOWED_PROXY_IPS=["10.0.0.0/24"])
    def test_custom_cidr_allowed(self):
        self.assertIsNone(_check_proxy_ip(_make_request(remote_addr="10.0.0.55")))

    def test_invalid_remote_addr_rejected(self):
        resp = _check_proxy_ip(_make_request(remote_addr="not-an-ip"))
        self.assertIsInstance(resp, JsonResponse)
        self.assertEqual(resp.status_code, 403)


class TestCheckProxySecret(SimpleTestCase):
    """_check_proxy_secret: IP + shared secret 双重校验。"""

    @override_settings(CENTRIFUGO_PROXY_SECRET=_PROXY_SECRET)
    def test_valid_secret_passes(self):
        self.assertIsNone(_check_proxy_secret(_make_request(proxy_secret=_PROXY_SECRET)))

    @override_settings(CENTRIFUGO_PROXY_SECRET=_PROXY_SECRET)
    def test_wrong_secret_rejected(self):
        resp = _check_proxy_secret(_make_request(proxy_secret="wrong"))
        self.assertIsInstance(resp, JsonResponse)
        self.assertEqual(resp.status_code, 403)

    @override_settings(CENTRIFUGO_PROXY_SECRET=_PROXY_SECRET)
    def test_missing_secret_header_rejected(self):
        req = _make_request()
        req.headers = {}
        resp = _check_proxy_secret(req)
        self.assertIsInstance(resp, JsonResponse)
        self.assertEqual(resp.status_code, 403)

    @override_settings(CENTRIFUGO_PROXY_SECRET="")
    def test_unconfigured_server_secret_returns_500(self):
        resp = _check_proxy_secret(_make_request())
        self.assertIsInstance(resp, JsonResponse)
        self.assertEqual(resp.status_code, 500)

    def test_ip_rejected_before_secret_check(self):
        resp = _check_proxy_secret(_make_request(remote_addr="1.2.3.4", proxy_secret=_PROXY_SECRET))
        self.assertIsInstance(resp, JsonResponse)
        self.assertEqual(resp.status_code, 403)


# ===========================================================================
# 3. Connect Proxy
# ===========================================================================


class TestConnectProxy(SimpleTestCase):
    """centrifugo_connect_proxy: Centrifugo 新连接鉴权全链路。"""

    # -- proxy secret --

    def test_proxy_secret_failure_forwarded(self):
        err = JsonResponse({"error": {"code": 403}}, status=403)
        with patch(_MOCK_PROXY_SECRET, return_value=err):
            resp = centrifugo_connect_proxy(_make_request(), _connect_payload())
        self.assertIsInstance(resp, JsonResponse)
        self.assertEqual(resp.status_code, 403)

    # -- JWT --

    def test_no_token_disconnect_4001(self):
        with _patch_connect():
            resp = centrifugo_connect_proxy(_make_request(), _connect_payload(token=""))
        self.assertEqual(resp.disconnect["code"], 4001)

    def test_invalid_jwt_disconnect_4002(self):
        with _patch_connect(jwt_default=False, jwt_payload=None):
            resp = centrifugo_connect_proxy(_make_request(), _connect_payload())
        self.assertEqual(resp.disconnect["code"], 4002)

    def test_non_access_token_disconnect_4003(self):
        with _patch_connect(jwt_payload=_jwt_payload(token_type="refresh")):
            resp = centrifugo_connect_proxy(_make_request(), _connect_payload())
        self.assertEqual(resp.disconnect["code"], 4003)

    def test_missing_user_id_disconnect_4004(self):
        with _patch_connect(jwt_payload=_jwt_payload(user_id="")):
            resp = centrifugo_connect_proxy(_make_request(), _connect_payload())
        self.assertEqual(resp.disconnect["code"], 4004)

    # -- JTI --

    def test_revoked_jti_disconnect_4007(self):
        with _patch_connect(jti_revoked=True):
            resp = centrifugo_connect_proxy(_make_request(), _connect_payload())
        self.assertEqual(resp.disconnect["code"], 4007)

    def test_no_jti_skips_revocation_check(self):
        with _patch_connect(jwt_payload=_jwt_payload(jti=None)):
            resp = centrifugo_connect_proxy(_make_request(), _connect_payload())
        self.assertIsNotNone(resp.result)
        self.assertEqual(resp.result.user, _USER_ID)

    # -- User --

    def test_user_not_found_disconnect_4005(self):
        with _patch_connect(user_not_found=True):
            resp = centrifugo_connect_proxy(_make_request(), _connect_payload())
        self.assertEqual(resp.disconnect["code"], 4005)

    # -- Session --

    def test_missing_sid_disconnect_4008(self):
        jwt = _jwt_payload()
        del jwt["sid"]
        with _patch_connect(jwt_payload=jwt):
            resp = centrifugo_connect_proxy(_make_request(), _connect_payload())
        self.assertEqual(resp.disconnect["code"], 4008)

    def test_invalid_session_disconnect_4009(self):
        with _patch_connect(session_valid=False):
            resp = centrifugo_connect_proxy(_make_request(), _connect_payload())
        self.assertEqual(resp.disconnect["code"], 4009)

    def test_session_user_mismatch_disconnect_4009(self):
        with _patch_connect(session=_make_session(user_id=_OTHER_USER_ID)):
            resp = centrifugo_connect_proxy(_make_request(), _connect_payload())
        self.assertEqual(resp.disconnect["code"], 4009)

    # -- Organization (Wave 4: connect 不再绑 organization) --

    def test_organization_id_in_payload_is_ignored(self):
        """Wave 4 决策 D10：连接维度去掉 organization，传入 organization_id 也不再校验。

        FP-022 旧契约：user 不是 organization 成员 → 清空 organization_id。
        Wave 4 新契约：result.data.organization_id 始终为 ""，且 Organization/OrganizationMember
        DB 不会被 connect handler 查询。Conversation 级访问控制由 subscribe
        proxy 通过 ConversationMember + is_organization_member 兜底。
        """
        with _patch_connect():
            with patch(_MOCK_ORGANIZATION) as MockWT, patch(_MOCK_WT_MEMBER) as MockWM:
                # 即使 mock 显式拒绝（FP-022 旧场景），connect 也成功
                MockWT.objects.filter.return_value.exists.return_value = False
                MockWM.objects.filter.return_value.exists.return_value = False
                resp = centrifugo_connect_proxy(
                    _make_request(), _connect_payload(organization_id=_ORGANIZATION_ID)
                )
        # connect 直接成功，不再依赖 organization_id 校验结果
        self.assertIsNone(resp.disconnect)
        self.assertEqual(resp.result.user, _USER_ID)
        self.assertEqual(resp.result.data.organization_id, "")
        # 关键：Organization / OrganizationMember 不应被 connect handler 触发查询
        MockWT.objects.filter.assert_not_called()
        MockWM.objects.filter.assert_not_called()

    def test_no_organization_id_in_payload_still_succeeds(self):
        """Wave 4: payload 不带 organization_id 也直接成功（与原 skips_check 行为一致）。"""
        with _patch_connect():
            resp = centrifugo_connect_proxy(
                _make_request(), _connect_payload(organization_id="")
            )
        self.assertIsNone(resp.disconnect)
        self.assertEqual(resp.result.data.organization_id, "")

    # -- 成功路径 --

    def test_success_complete_result(self):
        user = _make_user(display_name="Alice")
        with _patch_connect(user=user):
            resp = centrifugo_connect_proxy(_make_request(), _connect_payload())

        self.assertIsNone(resp.disconnect)
        self.assertIsNotNone(resp.result)
        self.assertEqual(resp.result.user, _USER_ID)
        # TC-22：connect 不再下发 personal:{uid} 作为 server-side 订阅，
        # 该频道改由前端 client-side 订阅（避免与 client subs recovery 冲突）。
        self.assertEqual(resp.result.channels, [])
        self.assertEqual(resp.result.data.display_name, "Alice")
        self.assertGreater(resp.result.expire_at, int(time.time()))

    def test_expire_at_from_jwt_exp(self):
        future_exp = int(time.time()) + 7200
        with _patch_connect(jwt_payload=_jwt_payload(exp=future_exp)):
            resp = centrifugo_connect_proxy(_make_request(), _connect_payload())
        self.assertEqual(resp.result.expire_at, future_exp)

    def test_fallback_to_username_when_no_display_name(self):
        """无 display_name 属性时回退到 username。"""

        class _Stub:
            id = _USER_ID
            is_active = True
            username = "fallback_user"

        with _patch_connect(user=_Stub()):
            resp = centrifugo_connect_proxy(_make_request(), _connect_payload())
        self.assertEqual(resp.result.data.display_name, "fallback_user")


# ===========================================================================
# 4. Subscribe Proxy
# ===========================================================================


def _subscribe_payload(channel, user_id=_USER_ID):
    return SubscribeRequest(client="test-client", user=user_id, channel=channel)


def _patch_subscribe(user_active=True) -> ExitStack:
    """Subscribe proxy 公共 mock：proxy secret + User active check。"""
    stack = ExitStack()
    stack.enter_context(patch(_MOCK_PROXY_SECRET, return_value=None))
    mock_qs = MagicMock()
    mock_qs.exists.return_value = user_active
    stack.enter_context(patch.object(User.objects, "filter", return_value=mock_qs))
    return stack


class TestSubscribeProxy(SimpleTestCase):
    """centrifugo_subscribe_proxy: 频道订阅权限校验。"""

    # -- 通用 --

    def test_missing_user_id_403(self):
        with _patch_subscribe():
            resp = centrifugo_subscribe_proxy(
                _make_request(), _subscribe_payload(f"chat:{_CONV_ID}", user_id="")
            )
        self.assertEqual(resp.error["code"], 403)

    def test_inactive_user_403(self):
        with _patch_subscribe(user_active=False):
            resp = centrifugo_subscribe_proxy(
                _make_request(), _subscribe_payload(f"personal:{_USER_ID}")
            )
        self.assertEqual(resp.error["code"], 403)
        self.assertIn("inactive", resp.error["message"])

    def test_unknown_namespace_403(self):
        with _patch_subscribe():
            resp = centrifugo_subscribe_proxy(
                _make_request(), _subscribe_payload("unknown:chan")
            )
        self.assertEqual(resp.error["code"], 403)

    # -- personal --

    def test_personal_owner_allowed(self):
        with _patch_subscribe():
            resp = centrifugo_subscribe_proxy(
                _make_request(), _subscribe_payload(f"personal:{_USER_ID}")
            )
        self.assertIsNotNone(resp.result)
        self.assertIsNone(resp.error)

    def test_personal_non_owner_403(self):
        with _patch_subscribe():
            resp = centrifugo_subscribe_proxy(
                _make_request(), _subscribe_payload(f"personal:{_OTHER_USER_ID}")
            )
        self.assertEqual(resp.error["code"], 403)

    def test_personal_invalid_uuid_400(self):
        with _patch_subscribe():
            resp = centrifugo_subscribe_proxy(
                _make_request(), _subscribe_payload("personal:bad-uuid")
            )
        self.assertEqual(resp.error["code"], 400)

    # -- chat --

    def test_chat_member_allowed(self):
        with _patch_subscribe():
            with patch(_MOCK_CHAT_ACCESS, return_value=(True, None)):
                resp = centrifugo_subscribe_proxy(
                    _make_request(), _subscribe_payload(f"chat:{_CONV_ID}")
                )
        self.assertIsNotNone(resp.result)
        self.assertIsNone(resp.error)

    def test_chat_conv_not_found_404(self):
        with _patch_subscribe():
            with patch(_MOCK_CHAT_ACCESS, return_value=(False, "conversation not found")):
                resp = centrifugo_subscribe_proxy(
                    _make_request(), _subscribe_payload(f"chat:{_CONV_ID}")
                )
        self.assertEqual(resp.error["code"], 404)

    def test_chat_not_member_403(self):
        with _patch_subscribe():
            with patch(_MOCK_CHAT_ACCESS, return_value=(False, "not a member of this conversation")):
                resp = centrifugo_subscribe_proxy(
                    _make_request(), _subscribe_payload(f"chat:{_CONV_ID}")
                )
        self.assertEqual(resp.error["code"], 403)

    def test_chat_invalid_conv_id_400(self):
        with _patch_subscribe():
            resp = centrifugo_subscribe_proxy(
                _make_request(), _subscribe_payload("chat:bad-uuid")
            )
        self.assertEqual(resp.error["code"], 400)

    # -- space（团队 Space presence） --

    def test_space_member_allowed(self):
        with _patch_subscribe():
            with patch(_MOCK_SPACE_ACCESS, return_value=(True, None)):
                resp = centrifugo_subscribe_proxy(
                    _make_request(), _subscribe_payload(f"space:{_SPACE_ID}")
                )
        self.assertIsNotNone(resp.result)
        self.assertIsNone(resp.error)

    def test_space_not_found_404(self):
        with _patch_subscribe():
            with patch(_MOCK_SPACE_ACCESS, return_value=(False, "space not found")):
                resp = centrifugo_subscribe_proxy(
                    _make_request(), _subscribe_payload(f"space:{_SPACE_ID}")
                )
        self.assertEqual(resp.error["code"], 404)

    def test_space_not_member_403(self):
        with _patch_subscribe():
            with patch(_MOCK_SPACE_ACCESS, return_value=(False, "not a member of this space")):
                resp = centrifugo_subscribe_proxy(
                    _make_request(), _subscribe_payload(f"space:{_SPACE_ID}")
                )
        self.assertEqual(resp.error["code"], 403)

    def test_space_not_team_space_403(self):
        with _patch_subscribe():
            with patch(
                _MOCK_SPACE_ACCESS,
                return_value=(False, "presence channel is only available for team spaces"),
            ):
                resp = centrifugo_subscribe_proxy(
                    _make_request(), _subscribe_payload(f"space:{_SPACE_ID}")
                )
        self.assertEqual(resp.error["code"], 403)

    def test_space_invalid_uuid_400(self):
        with _patch_subscribe():
            resp = centrifugo_subscribe_proxy(
                _make_request(), _subscribe_payload("space:bad-uuid")
            )
        self.assertEqual(resp.error["code"], 400)


# ===========================================================================
# 5. Publish Proxy
# ===========================================================================


def _publish_payload(channel, event_type="im.typing", user_id=_USER_ID, data=None):
    if data is None:
        data = {"type": event_type} if event_type else {}
    return PublishRequest(client="test-client", user=user_id, channel=channel, data=data)


class TestPublishProxy(SimpleTestCase):
    """centrifugo_publish_proxy: 客户端发布白名单限制。"""

    @patch(_MOCK_PROXY_SECRET, return_value=None)
    @patch(_MOCK_CHAT_ACCESS, return_value=(True, None))
    def test_typing_on_chat_allowed(self, *_):
        resp = centrifugo_publish_proxy(
            _make_request(), _publish_payload(f"chat:{_CONV_ID}", "im.typing")
        )
        self.assertIsNotNone(resp.result)
        self.assertIsNone(resp.error)

    @patch(_MOCK_PROXY_SECRET, return_value=None)
    def test_non_allowed_type_rejected(self, _):
        resp = centrifugo_publish_proxy(
            _make_request(), _publish_payload(f"chat:{_CONV_ID}", "im.message")
        )
        self.assertEqual(resp.error["code"], 403)
        self.assertIn("not allowed", resp.error["message"])

    @patch(_MOCK_PROXY_SECRET, return_value=None)
    def test_empty_type_rejected(self, _):
        resp = centrifugo_publish_proxy(
            _make_request(), _publish_payload(f"chat:{_CONV_ID}", event_type="")
        )
        self.assertEqual(resp.error["code"], 403)

    @patch(_MOCK_PROXY_SECRET, return_value=None)
    def test_personal_channel_rejected(self, _):
        resp = centrifugo_publish_proxy(
            _make_request(), _publish_payload(f"personal:{_USER_ID}", "im.typing")
        )
        self.assertEqual(resp.error["code"], 403)
        self.assertIn("chat channels", resp.error["message"])

    @patch(_MOCK_PROXY_SECRET, return_value=None)
    def test_invalid_conv_id_400(self, _):
        resp = centrifugo_publish_proxy(
            _make_request(), _publish_payload("chat:bad-uuid", "im.typing")
        )
        self.assertEqual(resp.error["code"], 400)

    @patch(_MOCK_PROXY_SECRET, return_value=None)
    @patch(_MOCK_CHAT_ACCESS, return_value=(False, "not a member of this conversation"))
    def test_non_member_rejected(self, *_):
        resp = centrifugo_publish_proxy(
            _make_request(), _publish_payload(f"chat:{_CONV_ID}", "im.typing")
        )
        self.assertEqual(resp.error["code"], 403)

    @patch(_MOCK_PROXY_SECRET, return_value=None)
    def test_null_data_rejected(self, _):
        payload = PublishRequest(
            client="c", user=_USER_ID, channel=f"chat:{_CONV_ID}", data=None
        )
        resp = centrifugo_publish_proxy(_make_request(), payload)
        self.assertEqual(resp.error["code"], 403)


# ===========================================================================
# 6. _check_chat_channel_access
# ===========================================================================


class TestCheckChatChannelAccess(SimpleTestCase):
    """_check_chat_channel_access: DB 级别频道权限判定（Fail-Close）。"""

    def _setup_access_mocks(self, *, conv_exists=True, is_conv_active=True, is_wt_member=True):
        """返回统一权限判定所需 mock 的 ExitStack。"""
        stack = ExitStack()
        mock_conv = stack.enter_context(patch(_MOCK_CONVERSATION))
        if conv_exists:
            mock_conv.objects.filter.return_value.first.return_value = MagicMock()
        else:
            mock_conv.objects.filter.return_value.first.return_value = None

        resolved = MagicMock()
        resolved.can_subscribe = is_conv_active and is_wt_member
        stack.enter_context(
            patch(_MOCK_CONVERSATION_ACCESS, return_value=resolved)
        )
        return stack

    def test_both_member_allowed(self):
        with self._setup_access_mocks():
            allowed, err = _check_chat_channel_access(_USER_ID, _CONV_ID)
        self.assertTrue(allowed)
        self.assertIsNone(err)

    def test_conv_not_found(self):
        with self._setup_access_mocks(conv_exists=False):
            allowed, err = _check_chat_channel_access(_USER_ID, _CONV_ID)
        self.assertFalse(allowed)
        self.assertEqual(err, "conversation not found")

    def test_not_conv_member_denied(self):
        with self._setup_access_mocks(is_conv_active=False):
            allowed, err = _check_chat_channel_access(_USER_ID, _CONV_ID)
        self.assertFalse(allowed)
        self.assertIn("not a member", err)

    def test_not_organization_member_denied(self):
        with self._setup_access_mocks(is_wt_member=False):
            allowed, err = _check_chat_channel_access(_USER_ID, _CONV_ID)
        self.assertFalse(allowed)
        self.assertIn("not a member", err)

    def test_neither_member_denied(self):
        with self._setup_access_mocks(is_conv_active=False, is_wt_member=False):
            allowed, err = _check_chat_channel_access(_USER_ID, _CONV_ID)
        self.assertFalse(allowed)
        self.assertIn("not a member", err)

    def test_db_exception_fail_close(self):
        """Fail-Close：DB 异常时拒绝访问。"""
        with patch(_MOCK_CONVERSATION) as mock_conv:
            mock_conv.objects.filter.side_effect = Exception("connection refused")
            allowed, err = _check_chat_channel_access(_USER_ID, _CONV_ID)
        self.assertFalse(allowed)
        self.assertEqual(err, "internal error")


# ===========================================================================
# 6b. _check_space_channel_access（团队 Space presence 频道）
# ===========================================================================


_MOCK_HOST_TYPE = "apps.tabtinspace.services.host_resolver.host_type"
_MOCK_PROJECT_MEMBERSHIP = "apps.tabtinspace.models.ProjectMembership"


class TestCheckSpaceChannelAccess(SimpleTestCase):
    """_check_space_channel_access: 团队 Space presence 频道权限判定（Fail-Close）。"""

    def _setup_access_mocks(self, *, space_exists=True, space_type="team_space", is_member=True):
        stack = ExitStack()
        stack.enter_context(
            patch(_MOCK_HOST_TYPE, return_value=space_type if space_exists else None)
        )
        mock_membership = stack.enter_context(patch(_MOCK_PROJECT_MEMBERSHIP))
        mock_membership.Status.ACTIVE = "active"
        mock_membership.objects.filter.return_value.exists.return_value = is_member
        return stack

    def test_team_space_member_allowed(self):
        with self._setup_access_mocks():
            allowed, err = _check_space_channel_access(_USER_ID, _SPACE_ID)
        self.assertTrue(allowed)
        self.assertIsNone(err)

    def test_space_not_found(self):
        with self._setup_access_mocks(space_exists=False):
            allowed, err = _check_space_channel_access(_USER_ID, _SPACE_ID)
        self.assertFalse(allowed)
        self.assertEqual(err, "space not found")

    def test_non_team_space_denied(self):
        with self._setup_access_mocks(space_type="workspace"):
            allowed, err = _check_space_channel_access(_USER_ID, _SPACE_ID)
        self.assertFalse(allowed)
        self.assertIn("team space", err)

    def test_not_member_denied(self):
        with self._setup_access_mocks(is_member=False):
            allowed, err = _check_space_channel_access(_USER_ID, _SPACE_ID)
        self.assertFalse(allowed)
        self.assertIn("not a member", err)

    def test_db_exception_fail_close(self):
        with patch(_MOCK_HOST_TYPE, side_effect=Exception("connection refused")):
            allowed, err = _check_space_channel_access(_USER_ID, _SPACE_ID)
        self.assertFalse(allowed)
        self.assertEqual(err, "internal error")


# ===========================================================================
# 7. Refresh Proxy
# ===========================================================================


def _refresh_payload(user_id=_USER_ID):
    return RefreshRequest(client="test-client", user=user_id)


class TestRefreshProxy(SimpleTestCase):
    """centrifugo_refresh_proxy: 连接续期。"""

    @patch(_MOCK_PROXY_SECRET, return_value=None)
    def test_success_new_expire_at(self, _):
        with patch.object(User.objects, "get", return_value=_make_user()):
            with patch(_MOCK_USER_SESSION) as MockUS:
                MockUS.objects.filter.return_value.exists.return_value = True
                resp = centrifugo_refresh_proxy(_make_request(), _refresh_payload())
        self.assertIsNone(resp.disconnect)
        self.assertFalse(resp.result.expired)
        self.assertGreater(resp.result.expire_at, int(time.time()))

    @patch(_MOCK_PROXY_SECRET, return_value=None)
    def test_user_not_found_disconnect_4005(self, _):
        with patch.object(User.objects, "get", side_effect=User.DoesNotExist):
            resp = centrifugo_refresh_proxy(_make_request(), _refresh_payload())
        self.assertEqual(resp.disconnect["code"], 4005)

    @patch(_MOCK_PROXY_SECRET, return_value=None)
    def test_no_active_session_disconnect_4006(self, _):
        with patch.object(User.objects, "get", return_value=_make_user()):
            with patch(_MOCK_USER_SESSION) as MockUS:
                MockUS.objects.filter.return_value.exists.return_value = False
                resp = centrifugo_refresh_proxy(_make_request(), _refresh_payload())
        self.assertEqual(resp.disconnect["code"], 4006)

    @patch(_MOCK_PROXY_SECRET, return_value=None)
    def test_empty_user_id_expired(self, _):
        resp = centrifugo_refresh_proxy(_make_request(), _refresh_payload(user_id=""))
        self.assertTrue(resp.result.expired)


# ===========================================================================
# 8. Sub Refresh Proxy
# ===========================================================================


def _sub_refresh_payload(channel, user_id=_USER_ID):
    return SubRefreshRequest(client="test-client", user=user_id, channel=channel)


class TestSubRefreshProxy(SimpleTestCase):
    """centrifugo_sub_refresh_proxy: 订阅持续权限验证。"""

    def _call(self, channel, user_id=_USER_ID, user_active=True, access=None, space_access=None):
        with patch(_MOCK_PROXY_SECRET, return_value=None):
            mock_qs = MagicMock()
            mock_qs.exists.return_value = user_active
            with patch.object(User.objects, "filter", return_value=mock_qs):
                if access is not None:
                    with patch(_MOCK_CHAT_ACCESS, return_value=access):
                        return centrifugo_sub_refresh_proxy(
                            _make_request(), _sub_refresh_payload(channel, user_id)
                        )
                if space_access is not None:
                    with patch(_MOCK_SPACE_ACCESS, return_value=space_access):
                        return centrifugo_sub_refresh_proxy(
                            _make_request(), _sub_refresh_payload(channel, user_id)
                        )
                return centrifugo_sub_refresh_proxy(
                    _make_request(), _sub_refresh_payload(channel, user_id)
                )

    def test_personal_owner_not_expired(self):
        self.assertFalse(self._call(f"personal:{_USER_ID}").result.expired)

    def test_personal_non_owner_expired(self):
        self.assertTrue(self._call(f"personal:{_OTHER_USER_ID}").result.expired)

    def test_personal_invalid_uuid_expired(self):
        self.assertTrue(self._call("personal:bad").result.expired)

    def test_chat_still_member_not_expired(self):
        self.assertFalse(self._call(f"chat:{_CONV_ID}", access=(True, None)).result.expired)

    def test_chat_removed_member_expired(self):
        self.assertTrue(
            self._call(f"chat:{_CONV_ID}", access=(False, "removed")).result.expired
        )

    def test_user_inactive_expired(self):
        self.assertTrue(self._call(f"personal:{_USER_ID}", user_active=False).result.expired)

    def test_empty_user_id_expired(self):
        with patch(_MOCK_PROXY_SECRET, return_value=None):
            resp = centrifugo_sub_refresh_proxy(
                _make_request(), _sub_refresh_payload(f"personal:{_USER_ID}", user_id="")
            )
        self.assertTrue(resp.result.expired)

    def test_unknown_namespace_expired(self):
        self.assertTrue(self._call("unknown:x").result.expired)

    def test_chat_invalid_conv_id_expired(self):
        self.assertTrue(self._call("chat:bad").result.expired)

    def test_space_still_member_not_expired(self):
        self.assertFalse(
            self._call(f"space:{_SPACE_ID}", space_access=(True, None)).result.expired
        )

    def test_space_removed_member_expired(self):
        self.assertTrue(
            self._call(
                f"space:{_SPACE_ID}", space_access=(False, "not a member of this space")
            ).result.expired
        )

    def test_space_invalid_uuid_expired(self):
        self.assertTrue(self._call("space:bad").result.expired)
