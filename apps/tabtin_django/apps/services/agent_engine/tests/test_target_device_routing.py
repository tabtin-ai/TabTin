from unittest.mock import patch

from django.test import SimpleTestCase, override_settings

from apps.services.agent_engine.services.prompt_forward_service import (
    PromptForwardService,
)
from apps.services.agent_engine.services.frontend_action_service import (
    FrontendActionService,
)
from apps.services.common.ws.handlers.localrt_user_response import (
    _resolve_runtime_device_fp_for_hitl,
)


class TargetDeviceRoutingTests(SimpleTestCase):
    @override_settings(DAEMON_CONTROL_ENABLED=True)
    @patch.object(
        PromptForwardService,
        "_get_frozen_target_device",
        return_value="daemon-frozen-target",
    )
    @patch.object(FrontendActionService, "_resolve_effective_auth_rules", return_value={})
    @patch.object(FrontendActionService, "_resolve_sandbox_policy", return_value={})
    def test_frontend_action_uses_frozen_target_instead_of_session_broadcast(
        self, _policy, _rules, _frozen,
    ):
        service = FrontendActionService()
        with patch.object(service._transport, "is_device_connected", return_value=True), patch.object(
            service._transport, "publish_device_action", return_value=1,
        ) as publish_device, patch.object(
            service._transport, "publish_session_action",
        ) as publish_session:
            published = service.publish_action(
                "chat-session-1",
                {"data": {"task_id": "task-1", "type": "navigate", "params": {}}},
            )

        self.assertEqual(published, 1)
        publish_device.assert_called_once()
        self.assertEqual(publish_device.call_args.args[0], "daemon-frozen-target")
        publish_session.assert_not_called()

    @override_settings(DAEMON_CONTROL_ENABLED=False)
    @patch.object(
        PromptForwardService,
        "_get_frozen_target_device",
        return_value="daemon-frozen-target",
    )
    def test_frontend_action_does_not_route_frozen_session_when_control_is_disabled(
        self, _frozen,
    ):
        service = FrontendActionService()
        with patch.object(service._transport, "publish_device_action") as publish_device, patch.object(
            service._transport, "publish_session_action",
        ) as publish_session:
            published = service.publish_action(
                "chat-session-1",
                {"data": {"task_id": "task-1", "type": "navigate", "params": {}}},
            )

        self.assertEqual(published, 0)
        publish_device.assert_not_called()
        publish_session.assert_not_called()

    @patch.object(PromptForwardService, "_bind_action_device_for_thread")
    @patch(
        "apps.services.agent_engine.services.prompt_forward_service.publish_device_ws_event_exact",
        return_value=True,
    )
    @patch.object(PromptForwardService, "_resolve_daemon_fingerprint")
    def test_target_is_sent_only_to_its_exact_device_topic(
        self, resolve_daemon, publish, bind
    ):
        service = PromptForwardService()

        published = service._route_to_device(
            "thread-1",
            None,
            {"type": "agent.prompt.forward"},
            reliable=True,
            target_device_fingerprint="daemon-target-1",
        )

        self.assertEqual(published, 1)
        publish.assert_called_once_with(
            "daemon-target-1",
            {"type": "agent.prompt.forward"},
            reliable=True,
        )
        bind.assert_called_once_with("thread-1", "daemon-target-1")
        resolve_daemon.assert_not_called()

    @patch.object(PromptForwardService, "_try_publish", return_value=False)
    @patch.object(PromptForwardService, "_persist_to_stream")
    @patch(
        "apps.services.agent_engine.services.prompt_forward_service.publish_device_ws_event_exact",
        return_value=False,
    )
    @patch.object(PromptForwardService, "_resolve_electron_control_fingerprint")
    def test_offline_target_does_not_switch_devices(
        self, resolve_electron, _online, persist, try_publish
    ):
        published = PromptForwardService()._route_to_device(
            "thread-1",
            None,
            {"type": "agent.prompt.forward"},
            reliable=True,
            target_device_fingerprint="daemon-target-1",
        )

        self.assertEqual(published, 0)
        persist.assert_called_once()
        self.assertEqual(persist.call_args.args[3], "daemon-target-1")
        try_publish.assert_called_once()
        self.assertEqual(try_publish.call_args.args[0], "agent.action.device.daemon-target-1")
        resolve_electron.assert_not_called()

    @patch.object(PromptForwardService, "_bind_action_device_for_thread")
    @patch.object(PromptForwardService, "_try_publish", return_value=True)
    @patch.object(PromptForwardService, "_persist_to_stream")
    @patch(
        "apps.services.agent_engine.services.prompt_forward_service.publish_device_ws_event_exact",
        return_value=False,
    )
    def test_stale_ready_lease_reuses_same_device_topic_group(
        self, _exact, persist, try_publish, bind
    ):
        published = PromptForwardService()._route_to_device(
            "thread-1",
            None,
            {"type": "agent.prompt.forward"},
            reliable=True,
            target_device_fingerprint="electron-1",
        )

        self.assertEqual(published, 1)
        persist.assert_called_once()
        try_publish.assert_called_once()
        self.assertEqual(try_publish.call_args.args[0], "agent.action.device.electron-1")
        bind.assert_called_once_with("thread-1", "electron-1")

    @patch.object(
        PromptForwardService,
        "_get_bound_action_device",
        return_value="daemon-target-1",
    )
    @patch.object(PromptForwardService, "_get_frozen_target_device", return_value=None)
    @patch.object(PromptForwardService, "_route_to_device", return_value=1)
    def test_control_events_reuse_the_device_that_accepted_the_prompt(
        self, route, _frozen, _bound
    ):
        service = PromptForwardService()

        published = service._publish_exclusive(
            "thread-1", None, {"type": "agent.prompt.cancel"}
        )

        self.assertEqual(published, 1)
        self.assertEqual(
            route.call_args.kwargs["target_device_fingerprint"],
            "daemon-target-1",
        )

    @patch.object(
        PromptForwardService,
        "_get_bound_action_device",
        return_value="daemon-stale-binding",
    )
    @patch.object(
        PromptForwardService,
        "_get_frozen_target_device",
        return_value="daemon-frozen-target",
    )
    @patch.object(PromptForwardService, "_route_to_device", return_value=1)
    def test_control_events_prefer_the_session_frozen_target(
        self, route, _frozen, _bound
    ):
        PromptForwardService()._publish_exclusive(
            "thread-1", None, {"type": "agent.prompt.cancel"}
        )

        self.assertEqual(
            route.call_args.kwargs["target_device_fingerprint"],
            "daemon-frozen-target",
        )

    @patch(
        "apps.services.common.ws.handlers.localrt_user_response._get_pending_owner",
        return_value={
            "thread_id": "chat-session-1",
            "device_fingerprint": "daemon-stale-owner",
        },
    )
    @patch(
        "apps.services.common.ws.handlers.localrt_user_response._get_frozen_runtime_device_fp",
        return_value="daemon-frozen-target",
    )
    def test_hitl_never_falls_back_from_the_frozen_target(self, _frozen, _owner):
        self.assertEqual(
            _resolve_runtime_device_fp_for_hitl(
                "chat-session-1",
                kind="request",
                target_id="approval-1",
            ),
            "daemon-frozen-target",
        )
