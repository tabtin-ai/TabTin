"""FP-022 反向回归测试: Wave 4 后 Centrifugo connect proxy 不再校验 organization_id 归属。

历史背景：
    旧 FP-022 要求 connect handler 校验 ``data.organization_id`` —— 用户不是
    organization 成员则清空字段。Wave 4（PRD §4.7）的明确决策 D10 取消了这层
    校验：Centrifugo 频道 ``personal:{userId}`` / ``chat:{convId}`` 本就
    用户级，不依赖 organization；conversation 级访问控制完全交给 subscribe
    proxy 的 ``ConversationMember`` + ``is_organization_member`` 双重校验，
    覆盖面与原 connect-时校验等价、粒度更细。

本测试保留为反向回归网，确保未来不会有人「好心」把 organization 校验加回来。
若产品后续重新引入连接级 organization 绑定，需要先和 PRD owner 评审，再删除本测试。
"""

from unittest.mock import patch, MagicMock

from django.test import SimpleTestCase


class TestWave4ConnectIgnoresOrganizationId(SimpleTestCase):
    """connect proxy 不再校验 organization_id 归属（Wave 4 决策 D10）。"""

    @patch("apps.tabchat.centrifugo_proxy._check_proxy_secret", return_value=None)
    @patch("apps.tabchat.centrifugo_proxy.verify_jwt_token")
    @patch("apps.tabchat.centrifugo_proxy.SessionManager")
    def test_payload_organization_id_does_not_trigger_membership_query(
        self, mock_session_mgr, mock_verify, _mock_secret,
    ):
        """即使 payload 带了非法 organization_id，connect handler 也不会去查
        Organization / OrganizationMember 表，且不会因此拒绝连接。
        """
        from django.contrib.auth import get_user_model

        User = get_user_model()

        mock_verify.return_value = {
            "token_type": "access",
            "user_id": "test-user-id",
            "sid": "test-session-key",
            "exp": 9999999999,
        }

        mock_user = MagicMock()
        mock_user.id = "test-user-id"
        mock_user.is_active = True
        mock_user.display_name = "Test"

        mock_session = MagicMock()
        mock_session.user_id = "test-user-id"
        mock_session_mgr.validate_session.return_value = mock_session

        from apps.tabchat.centrifugo_proxy import ConnectRequest

        with patch.object(User.objects, "get", return_value=mock_user):
            with patch("apps.tabchat.centrifugo_proxy.cache") as mock_cache:
                mock_cache.incr.side_effect = ValueError
                mock_cache.set.return_value = True

                from apps.tabchat.centrifugo_proxy import centrifugo_connect_proxy

                with patch("apps.tabtinspace.models.Organization") as MockWS:
                    with patch("apps.tabtinspace.models.OrganizationMember") as MockWM:
                        # 故意把 mock 设为「不是成员」（旧 FP-022 拒绝场景）
                        MockWS.objects.filter.return_value.exists.return_value = False
                        MockWM.objects.filter.return_value.exists.return_value = False

                        request = MagicMock()
                        payload = ConnectRequest(
                            client="test-client",
                            data={
                                "token": "fake-token",
                                "organization_id": "other-organization",
                            },
                        )

                        response = centrifugo_connect_proxy(request, payload)

                        # Wave 4: connect 直接成功，不依赖 organization membership
                        assert response.disconnect is None, (
                            "connect proxy 不应因 organization membership 失败而 disconnect"
                        )
                        assert response.result is not None
                        # 字段固定为空，不再回写 payload 提供的 organization_id
                        assert response.result.data.organization_id == ""
                        # 决定性断言：不查 Organization/OrganizationMember 表
                        MockWS.objects.filter.assert_not_called()
                        MockWM.objects.filter.assert_not_called()
