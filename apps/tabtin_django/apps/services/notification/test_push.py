"""移动端远程推送单测：usersig / 注册管理 / 分发编排。

Provider 网络调用全 mock。DB 用例标记 ``requires_pg_native``：默认 SQLite
suite 在 setup_databases 阶段会撞 agent_engine 的 PG 方言 RunSQL 迁移
（与本测试无关的既有限制，同 conftest 注释），用
``USE_SQLITE_FOR_TESTS=0 pytest apps/services/notification/test_push.py`` 真库跑。
"""

from __future__ import annotations

import json
import uuid
from unittest.mock import MagicMock, patch

import httpx
import pytest
from django.test import SimpleTestCase, TestCase
from pydantic import ValidationError

from apps.services.notification.models import DevicePushRegistration
from apps.services.notification.push.providers import (
    APNsPushProvider,
    PushMessage,
    PushSendResult,
)
from apps.services.notification.push.service import (
    SCENE_AGENT_DONE,
    SCENE_INTERACTION,
    SCENE_IM_MESSAGE,
    _dispatch,
    _preference_enabled,
    _summarize_interaction,
    notify_agent_done,
    notify_interaction_requested,
    notify_im_message,
    register_push_token,
    revoke_push_token,
)
from apps.services.notification.tasks import push_im_message, push_im_message_recipient
from apps.tabtinspace.schemas.device import DevicePushTokenRegister

_SVC = "apps.services.notification.push.service"

class ProviderTests(SimpleTestCase):
    def test_unconfigured_provider_reports_error(self):
        provider = APNsPushProvider(team_id="", key_id="", private_key="", bundle_id="")
        result = provider.send(["token-1"], PushMessage(title="t", body="b"))
        self.assertFalse(result.ok)
        self.assertIn("APNs not configured", result.error)

    def test_empty_targets_is_noop_success(self):
        provider = APNsPushProvider(team_id="", key_id="", private_key="", bundle_id="")
        self.assertTrue(provider.send([], PushMessage(title="t", body="b")).ok)

    @patch("apps.services.notification.push.providers.jwt.encode", return_value="signed-jwt")
    def test_sends_native_apns_alert_and_route_payload(self, _encode):
        client = MagicMock()
        client.post.return_value.status_code = 200
        provider = APNsPushProvider(
            team_id="TEAM123456",
            key_id="KEY1234567",
            private_key="private-key",
            bundle_id="com.tabtin.mobile",
            environment="sandbox",
            client=client,
        )

        result = provider.send(
            ["device-token"],
            PushMessage(
                title="Agent 在等你",
                body="点开处理",
                ext={"scene": "interaction_requested", "session_id": "session-1"},
            ),
        )

        self.assertTrue(result.ok)
        url = client.post.call_args.args[0]
        kwargs = client.post.call_args.kwargs
        self.assertEqual(url, "https://api.sandbox.push.apple.com/3/device/device-token")
        self.assertEqual(kwargs["headers"]["authorization"], "bearer signed-jwt")
        self.assertEqual(kwargs["headers"]["apns-topic"], "com.tabtin.mobile")
        self.assertEqual(kwargs["headers"]["apns-push-type"], "alert")
        self.assertEqual(kwargs["json"]["aps"]["alert"]["title"], "Agent 在等你")
        self.assertEqual(
            json.loads(kwargs["json"]["ext"]),
            {"scene": "interaction_requested", "session_id": "session-1"},
        )

    @patch("apps.services.notification.push.providers.jwt.encode", return_value="signed-jwt")
    def test_marks_unregistered_apns_token_invalid(self, _encode):
        client = MagicMock()
        client.post.return_value.status_code = 410
        client.post.return_value.json.return_value = {"reason": "Unregistered"}
        provider = APNsPushProvider(
            team_id="TEAM123456",
            key_id="KEY1234567",
            private_key="private-key",
            bundle_id="com.tabtin.mobile",
            environment="production",
            client=client,
        )

        result = provider.send(["expired-token"], PushMessage(title="t", body="b"))

        self.assertFalse(result.ok)
        self.assertEqual(result.invalid_registration_ids, ["expired-token"])

    @patch("apps.services.notification.push.providers.jwt.encode", return_value="signed-jwt")
    def test_network_failures_are_reported_without_raising(self, _encode):
        client = MagicMock()
        client.post.side_effect = httpx.ConnectTimeout("timed out")
        provider = APNsPushProvider(
            team_id="TEAM123456",
            key_id="KEY1234567",
            private_key="private-key",
            bundle_id="com.tabtin.mobile",
            client=client,
        )

        result = provider.send(["device-token"], PushMessage(title="t", body="b"))

        self.assertFalse(result.ok)
        self.assertIn("timed out", result.error)

    @patch("apps.services.notification.push.providers.jwt.encode", return_value="signed-jwt")
    def test_unexpected_failures_are_not_swallowed(self, _encode):
        client = MagicMock()
        client.post.side_effect = RuntimeError("task interrupted")
        provider = APNsPushProvider(
            team_id="TEAM123456",
            key_id="KEY1234567",
            private_key="private-key",
            bundle_id="com.tabtin.mobile",
            client=client,
        )

        with self.assertRaisesRegex(RuntimeError, "task interrupted"):
            provider.send(["device-token"], PushMessage(title="t", body="b"))


class RegistrationSchemaTests(SimpleTestCase):
    def test_native_apns_defaults_are_explicit(self):
        payload = DevicePushTokenRegister(registration_id="a" * 64)

        self.assertEqual(payload.provider, "apns")
        self.assertEqual(payload.platform, "ios")
        self.assertEqual(payload.environment, "production")

    def test_rejects_removed_tencent_provider(self):
        with self.assertRaises(ValidationError):
            DevicePushTokenRegister(
                registration_id="legacy-registration-id",
                provider="tencent_push",
            )


@pytest.mark.requires_pg_native
class RegistrationTests(TestCase):
    databases = {"default", "postgresql"}

    def test_register_is_idempotent_upsert(self):
        first = register_push_token(
            user_id="user-1", registration_id="reg-a", platform="ios",
            environment="sandbox", device_fingerprint="ios-abc", app_version="1.0.0",
        )
        second = register_push_token(
            user_id="user-1", registration_id="reg-a", platform="ios",
            app_version="1.0.1",
        )
        self.assertEqual(first.id, second.id)
        self.assertEqual(
            DevicePushRegistration.objects.filter(registration_id="reg-a").count(), 1,
        )
        self.assertEqual(second.app_version, "1.0.1")
        self.assertEqual(second.provider, "apns")

    def test_register_rebinds_token_to_latest_user(self):
        register_push_token(user_id="user-1", registration_id="reg-a", platform="ios")
        rebound = register_push_token(user_id="user-2", registration_id="reg-a", platform="ios")
        self.assertEqual(rebound.user_id, "user-2")

    def test_revoke_scopes_to_owner(self):
        register_push_token(user_id="user-1", registration_id="reg-a", platform="ios")
        self.assertFalse(revoke_push_token(user_id="user-2", registration_id="reg-a"))
        self.assertTrue(
            DevicePushRegistration.objects.get(registration_id="reg-a").is_active,
        )
        self.assertTrue(revoke_push_token(user_id="user-1", registration_id="reg-a"))
        self.assertFalse(
            DevicePushRegistration.objects.get(registration_id="reg-a").is_active,
        )

    def test_new_token_deactivates_stale_token_for_same_device(self):
        register_push_token(
            user_id="user-1", registration_id="old-token", platform="ios",
            environment="sandbox", device_fingerprint="ios-abc",
        )
        register_push_token(
            user_id="user-1", registration_id="new-token", platform="ios",
            environment="sandbox", device_fingerprint="ios-abc",
        )

        self.assertFalse(
            DevicePushRegistration.objects.get(registration_id="old-token").is_active,
        )
        self.assertTrue(
            DevicePushRegistration.objects.get(registration_id="new-token").is_active,
        )


@pytest.mark.requires_pg_native
class DispatchTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.user_id = str(uuid.uuid4())
        register_push_token(
            user_id=self.user_id, registration_id="reg-live", platform="ios",
            environment="production",
        )

    def _dispatch(self):
        return _dispatch(
            user_id=self.user_id,
            scene=SCENE_AGENT_DONE,
            title="t",
            body="b",
            ext={"scene": SCENE_AGENT_DONE},
        )

    @patch(f"{_SVC}.get_push_provider")
    @patch(f"{_SVC}.has_mobile_foreground", return_value=False)
    def test_dispatch_sends_to_active_registrations(self, _presence, mock_provider):
        mock_provider.return_value.provider_name = "apns"
        mock_provider.return_value.send.return_value = PushSendResult(ok=True)

        self.assertTrue(self._dispatch())
        args, _ = mock_provider.return_value.send.call_args
        self.assertEqual(args[0], ["reg-live"])
        self.assertEqual(args[1].title, "t")
        mock_provider.assert_called_once_with("production")

    @patch(f"{_SVC}.get_push_provider")
    @patch(f"{_SVC}.has_mobile_foreground", return_value=True)
    def test_dispatch_suppressed_when_mobile_foreground(self, _presence, mock_provider):
        self.assertFalse(self._dispatch())
        mock_provider.return_value.send.assert_not_called()

    @patch(f"{_SVC}.get_push_provider")
    @patch(f"{_SVC}._preference_enabled", return_value=False)
    @patch(f"{_SVC}.has_mobile_foreground", return_value=False)
    def test_dispatch_suppressed_when_preference_off(self, _presence, _pref, mock_provider):
        self.assertFalse(self._dispatch())
        mock_provider.return_value.send.assert_not_called()

    @patch(f"{_SVC}.get_push_provider")
    @patch(f"{_SVC}.has_mobile_foreground", return_value=False)
    def test_dispatch_deactivates_invalid_registrations(self, _presence, mock_provider):
        mock_provider.return_value.provider_name = "apns"
        mock_provider.return_value.send.return_value = PushSendResult(
            ok=True, invalid_registration_ids=["reg-live"],
        )

        self.assertTrue(self._dispatch())
        self.assertFalse(
            DevicePushRegistration.objects.get(registration_id="reg-live").is_active,
        )

    @patch(f"{_SVC}.get_push_provider")
    @patch(f"{_SVC}.has_mobile_foreground", return_value=False)
    def test_dispatch_routes_tokens_to_their_apns_environment(self, _presence, mock_provider):
        register_push_token(
            user_id=self.user_id, registration_id="reg-sandbox", platform="ios",
            environment="sandbox",
        )
        mock_provider.return_value.provider_name = "apns"
        mock_provider.return_value.send.return_value = PushSendResult(ok=True)

        self.assertTrue(self._dispatch())

        environments = {call.args[0] for call in mock_provider.call_args_list}
        self.assertEqual(environments, {"production", "sandbox"})

    @patch(f"{_SVC}.get_push_provider")
    @patch(f"{_SVC}.has_mobile_foreground", return_value=False)
    def test_dispatch_skips_user_without_registrations(self, _presence, mock_provider):
        result = _dispatch(
            user_id=str(uuid.uuid4()), scene=SCENE_AGENT_DONE,
            title="t", body="b", ext={},
        )
        self.assertFalse(result)
        mock_provider.return_value.send.assert_not_called()


class AgentDonePushDisabledTests(SimpleTestCase):
    """产品决策（2026-07-06）：普通聊天回复不该推系统通知，只有打断用户
    （审批/权限确认/选择/表单）才推。``agent.stream.done`` 覆盖任意一轮 turn
    结束，没有「是否值得叫醒用户」的语义过滤，因此 notify_agent_done 暂停发送。
    """

    @patch(f"{_SVC}.get_push_provider")
    def test_notify_agent_done_short_circuits_without_touching_provider(self, mock_provider):
        self.assertFalse(notify_agent_done("session-id-does-not-matter", {"content": "hi"}))
        mock_provider.assert_not_called()


class InteractionPushTests(SimpleTestCase):
    @patch(f"{_SVC}._dispatch", return_value=True)
    @patch(f"{_SVC}._acquire_once", return_value=True)
    @patch(f"{_SVC}.is_push_enabled", return_value=True)
    @patch("apps.chat.conversation.models.ChatSession.objects.filter")
    @patch("apps.services.agent_engine.models.PendingInteraction.objects.filter")
    def test_interaction_push_carries_message_route(
        self,
        mock_interaction_filter,
        mock_session_filter,
        _enabled,
        _once,
        mock_dispatch,
    ):
        interaction = MagicMock(
            id="interaction-1",
            status="pending",
            kind="ask_choice",
            payload={"message_id": "message-1"},
            session_id="session-1",
            user_id="user-1",
            organization_id="organization-b",
            thread_id="thread-1",
        )
        mock_interaction_filter.return_value.first.return_value = interaction
        mock_session_filter.return_value.values.return_value.first.return_value = {
            "workspace_id": "workspace-b",
            "project_id": "project-b",
        }

        self.assertTrue(notify_interaction_requested("interaction-1"))

        ext = mock_dispatch.call_args.kwargs["ext"]
        self.assertEqual(ext["scene"], SCENE_INTERACTION)
        self.assertEqual(ext["organization_id"], "organization-b")
        self.assertEqual(ext["workspace_id"], "workspace-b")
        self.assertEqual(ext["session_id"], "session-1")
        self.assertEqual(ext["message_id"], "message-1")


class MobilePushPreferenceTests(SimpleTestCase):
    def _profile_settings(self, value):
        query = MagicMock()
        query.values_list.return_value.first.return_value = value
        return patch("apps.users.auth.models.UserProfile.objects.filter", return_value=query)

    def test_missing_preferences_default_to_enabled(self):
        with self._profile_settings({}):
            self.assertTrue(_preference_enabled("user-1", SCENE_IM_MESSAGE))

    def test_messages_enabled_receives_all_messages(self):
        ui_settings = {
            "mobilePushPrefs": {
                "value": {"messages": True, "mentions": False},
                "updatedAt": 1,
            },
        }
        with self._profile_settings(ui_settings):
            self.assertTrue(_preference_enabled("user-1", SCENE_IM_MESSAGE))

    def test_messages_disabled_receives_mentions_when_enabled(self):
        ui_settings = {
            "mobilePushPrefs": {
                "value": {"messages": False, "mentions": True},
                "updatedAt": 1,
            },
        }
        with self._profile_settings(ui_settings):
            self.assertFalse(_preference_enabled("user-1", SCENE_IM_MESSAGE))
            self.assertTrue(_preference_enabled("user-1", SCENE_IM_MESSAGE, mention=True))

    def test_messages_and_mentions_disabled_suppresses_all(self):
        ui_settings = {
            "mobilePushPrefs": {
                "value": {"messages": False, "mentions": False},
                "updatedAt": 1,
            },
        }
        with self._profile_settings(ui_settings):
            self.assertFalse(_preference_enabled("user-1", SCENE_IM_MESSAGE, mention=True))


class IMMessagePushTests(SimpleTestCase):
    @patch(f"{_SVC}._dispatch", return_value=True)
    @patch(f"{_SVC}._acquire_once", return_value=True)
    @patch(f"{_SVC}._preference_enabled", return_value=True)
    @patch(f"{_SVC}.is_push_enabled", return_value=True)
    def test_message_push_dispatches_conversation_deep_link(
        self,
        _enabled,
        mock_preference,
        _once,
        mock_dispatch,
    ):
        self.assertTrue(notify_im_message(
            user_id="recipient",
            organization_id="org-1",
            conversation_id="conversation-1",
            message_id="message-1",
            sender_id="sender",
            sender_name="小明",
            preview="你好",
            mention=True,
        ))
        mock_preference.assert_called_once_with("recipient", SCENE_IM_MESSAGE, mention=True)
        kwargs = mock_dispatch.call_args.kwargs
        self.assertEqual(kwargs["title"], "小明")
        self.assertEqual(kwargs["body"], "你好")
        self.assertEqual(kwargs["ext"]["conversation_id"], "conversation-1")
        self.assertEqual(kwargs["ext"]["message_id"], "message-1")
        self.assertTrue(kwargs["ext"]["mention"])

    @patch(f"{_SVC}._dispatch")
    @patch(f"{_SVC}._acquire_once", return_value=False)
    @patch(f"{_SVC}._preference_enabled", return_value=True)
    @patch(f"{_SVC}.is_push_enabled", return_value=True)
    def test_message_push_is_idempotent_per_user_and_message(
        self,
        _enabled,
        _preference,
        mock_once,
        mock_dispatch,
    ):
        self.assertFalse(notify_im_message(
            user_id="recipient",
            organization_id="org-1",
            conversation_id="conversation-1",
            message_id="message-1",
        ))
        mock_once.assert_called_once_with(
            "push:sent:im:recipient:message-1",
            7 * 24 * 60 * 60,
        )
        mock_dispatch.assert_not_called()

    @patch(f"{_SVC}._dispatch")
    @patch(f"{_SVC}.is_push_enabled", return_value=True)
    def test_message_push_never_notifies_sender(self, _enabled, mock_dispatch):
        self.assertFalse(notify_im_message(
            user_id="same-user",
            organization_id="org-1",
            conversation_id="conversation-1",
            message_id="message-1",
            sender_id="same-user",
        ))
        mock_dispatch.assert_not_called()


class IMMessagePushTaskTests(SimpleTestCase):
    @patch("apps.services.notification.tasks.push_im_message_recipient")
    def test_task_fans_out_recipient_mention_flags(self, mock_recipient_task):
        push_im_message({
            "organization_id": "org-1",
            "conversation_id": "conversation-1",
            "message_id": "message-1",
            "sender_id": "sender",
            "sender_name": "小明",
            "preview": "你好",
            "recipients": [
                {"user_id": "user-1", "mention": False},
                {
                    "user_id": "user-2",
                    "mention": True,
                    "organization_id": "participant-org",
                },
            ],
        })
        self.assertEqual(mock_recipient_task.delay.call_count, 2)
        first = mock_recipient_task.delay.call_args_list[0].args[0]
        second = mock_recipient_task.delay.call_args_list[1].args[0]
        self.assertFalse(first["mention"])
        self.assertTrue(second["mention"])
        self.assertEqual(first["sender_name"], "小明")
        self.assertEqual(first["organization_id"], "org-1")
        self.assertEqual(second["organization_id"], "participant-org")

    @patch("apps.services.notification.tasks._resolve_sender_name", return_value="小明")
    @patch("apps.services.notification.tasks.push_im_message_recipient")
    def test_task_resolves_user_sender_name_once(self, mock_recipient_task, mock_resolve):
        push_im_message({
            "conversation_id": "conversation-1",
            "message_id": "message-1",
            "sender_id": "sender",
            "recipients": [
                {"user_id": "user-1"},
                {"user_id": "user-2"},
            ],
        })
        mock_resolve.assert_called_once_with("sender")
        self.assertEqual(mock_recipient_task.delay.call_count, 2)
        self.assertEqual(
            mock_recipient_task.delay.call_args_list[0].args[0]["sender_name"],
            "小明",
        )

    @patch(f"{_SVC}.notify_im_message")
    def test_recipient_task_delivers_one_user(self, mock_notify):
        push_im_message_recipient({
            "user_id": "user-1",
            "mention": True,
            "organization_id": "org-1",
            "conversation_id": "conversation-1",
            "message_id": "message-1",
            "sender_id": "sender",
            "sender_name": "小明",
            "preview": "你好",
        })

        mock_notify.assert_called_once_with(
            user_id="user-1",
            mention=True,
            organization_id="org-1",
            conversation_id="conversation-1",
            message_id="message-1",
            sender_id="sender",
            sender_name="小明",
            preview="你好",
        )


class SummarizeInteractionTests(SimpleTestCase):
    def test_summarize_tool_names(self):
        payload = {"approvals": [
            {"tool_name": "shell_execute"},
            {"tool_name": "send_email"},
        ]}
        self.assertEqual(_summarize_interaction(payload), "待审批：shell_execute、send_email")

    def test_summarize_truncates_long_batches(self):
        payload = {"approvals": [{"tool_name": f"tool_{i}"} for i in range(5)]}
        summary = _summarize_interaction(payload)
        self.assertIn("等 5 项", summary)

    def test_summarize_falls_back_to_question(self):
        self.assertEqual(_summarize_interaction({"question": "选哪个方案？"}), "选哪个方案？")

    def test_summarize_empty_payload(self):
        self.assertEqual(_summarize_interaction({}), "")
