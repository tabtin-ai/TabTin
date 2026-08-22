from __future__ import annotations

import json
import uuid
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase, override_settings

from apps.services.media_generation.services.base import PollResult


class ImageFundingSettlementTests(SimpleTestCase):
    def _task(self, *, funding_mode: str = "provider_credit_v1"):
        return SimpleNamespace(
            id=uuid.UUID("11111111-1111-1111-1111-111111111111"),
            task_type="text2image",
            user_id="user-1",
            organization_id="org-1",
            parameters={
                "_llm_provider_name": "volcengine",
                "_llm_model_name": "seedream-test",
                "_llm_model_id": "22222222-2222-2222-2222-222222222222",
                "_funding_mode": funding_mode,
            },
            result_urls=[],
            cost_amount=Decimal("0"),
            cost_unit="",
            save=MagicMock(),
        )

    def _settle(self, successful_count: int, *, gateway_result=None):
        from apps.services.media_generation.billing import settle_image_task

        task = self._task()
        urls = [f"https://provider.test/{index}.png" for index in range(successful_count)]
        result = PollResult(status="succeeded", result_urls=urls)
        with patch(
            "apps.services.billing.services.gateway.BillingGateway.settle_fixed_usage",
            return_value=gateway_result or {"charge_mode": "provider_credit"},
        ) as gateway:
            settlement = settle_image_task(task, result)
        return settlement, gateway, task

    def test_one_success_costs_25_points(self):
        settlement, gateway, task = self._settle(1)

        self.assertEqual(settlement["total_credits"], "25.0000")
        self.assertEqual(gateway.call_args.kwargs["required_credits"], Decimal("25.0000"))
        self.assertEqual(gateway.call_args.kwargs["quantity"], Decimal("1"))
        self.assertEqual(task.cost_amount, Decimal("25.0000"))

    def test_three_successes_cost_75_points_in_one_settlement(self):
        settlement, gateway, _task = self._settle(3)

        self.assertEqual(settlement["total_credits"], "75.0000")
        gateway.assert_called_once()
        self.assertEqual(gateway.call_args.kwargs["quantity"], Decimal("3"))

    def test_zero_successes_settle_zero_points(self):
        settlement, gateway, _task = self._settle(0)

        self.assertEqual(settlement["total_credits"], "0.0000")
        gateway.assert_called_once()
        self.assertEqual(gateway.call_args.kwargs["required_credits"], Decimal("0.0000"))

    def test_requested_count_never_changes_final_charge(self):
        from apps.services.media_generation.billing import settle_image_task

        task = self._task()
        task.parameters["n"] = 4
        result = PollResult(
            status="succeeded",
            result_urls=[
                "https://provider.test/valid-1.png",
                "",
                "not-a-url",
                "https://provider.test/valid-2.png",
            ],
        )
        with patch(
            "apps.services.billing.services.gateway.BillingGateway.settle_fixed_usage",
            return_value={"charge_mode": "provider_credit"},
        ) as gateway:
            settlement = settle_image_task(task, result)

        self.assertEqual(settlement["successful_image_count"], 2)
        self.assertEqual(gateway.call_args.kwargs["required_credits"], Decimal("50.0000"))

    def test_duplicate_callback_reuses_one_business_settlement_key(self):
        from apps.services.media_generation.billing import settle_image_task

        task = self._task()
        result = PollResult(
            status="succeeded",
            result_urls=["https://provider.test/valid.png"],
        )
        deductions: set[str] = set()

        def idempotent_gateway(**kwargs):
            key = kwargs["idempotency_key"]
            already_seen = key in deductions
            deductions.add(key)
            return {
                "reason": "already_settled" if already_seen else "charged",
                "charge_mode": "idempotent" if already_seen else "provider_credit",
            }

        with patch(
            "apps.services.billing.services.gateway.BillingGateway.settle_fixed_usage",
            side_effect=idempotent_gateway,
        ) as gateway:
            first = settle_image_task(task, result)
            second = settle_image_task(task, result)

        self.assertEqual(first["idempotency_key"], second["idempotency_key"])
        self.assertEqual(len(deductions), 1)
        self.assertEqual(gateway.call_count, 2)

    def test_targeted_credit_can_fully_fund_image_settlement(self):
        settlement, _gateway, _task = self._settle(
            1,
            gateway_result={
                "charge_mode": "provider_credit",
                "funding_allocations": [
                    {"source_type": "provider_credit", "credits": "25.0000"}
                ],
            },
        )

        self.assertEqual(settlement["charge_mode"], "provider_credit")
        self.assertEqual(
            [item["source_type"] for item in settlement["funding_allocations"]],
            ["provider_credit"],
        )

    def test_targeted_then_general_can_partially_fund_image_settlement(self):
        settlement, _gateway, _task = self._settle(
            3,
            gateway_result={
                "charge_mode": "mixed_provider_funding",
                "funding_allocations": [
                    {"source_type": "provider_credit", "credits": "25.0000"},
                    {"source_type": "monthly_budget", "credits": "50.0000"},
                ],
            },
        )

        self.assertEqual(
            [item["source_type"] for item in settlement["funding_allocations"]],
            ["provider_credit", "monthly_budget"],
        )

    def test_targeted_general_and_wallet_keep_global_funding_order(self):
        settlement, _gateway, _task = self._settle(
            3,
            gateway_result={
                "charge_mode": "mixed_provider_funding",
                "funding_allocations": [
                    {"source_type": "provider_credit", "credits": "20.0000"},
                    {"source_type": "monthly_budget", "credits": "30.0000"},
                    {"source_type": "organization_wallet", "credits": "25.0000"},
                ],
            },
        )

        self.assertEqual(
            [item["source_type"] for item in settlement["funding_allocations"]],
            ["provider_credit", "monthly_budget", "organization_wallet"],
        )

    def test_zero_result_provider_callback_reaches_zero_settlement(self):
        from apps.services.media_generation.services.base import SubmitResult
        from apps.services.media_generation.tasks.execution import (
            complete_synchronous_media_task,
        )

        task = MagicMock()
        task.id = uuid.UUID("11111111-1111-1111-1111-111111111111")
        provider_result = SubmitResult(
            provider_task_id="provider-1",
            status="succeeded",
            metadata={"result_urls": []},
        )
        with (
            patch(
                "apps.services.media_generation.tasks.polling._charge_media_task"
            ) as settle,
            patch(
                "apps.services.media_generation.tasks.storage.store_media_results.delay"
            ),
        ):
            complete_synchronous_media_task(task, provider_result)

        settlement_result = settle.call_args.args[1]
        self.assertEqual(settlement_result.status, "succeeded")
        self.assertEqual(settlement_result.result_urls, [])
        settle.assert_called_once()
        task.mark_succeeded.assert_called_once_with(
            result_urls=[],
            metadata={"result_urls": []},
        )


class MediaSceneGuardTests(SimpleTestCase):
    def test_disabled_scene_maps_to_stable_http_error(self):
        from apps.services.llm.scenes.exceptions import SceneDisabled
        from apps.users.auth.exceptions import scene_call_error_handler

        response = scene_call_error_handler(
            None,
            SceneDisabled(
                "scene 已关闭",
                scene_key="media_video_generate",
            ),
        )

        self.assertEqual(response.status_code, 422)
        self.assertEqual(
            json.loads(response.content),
            {
                "success": False,
                "message": "scene 已关闭",
                "data": {"scene_key": "media_video_generate"},
                "code": "SCENE_DISABLED",
            },
        )

    def test_internal_scene_error_keeps_contract_without_leaking_details(self):
        from apps.services.llm.scenes.exceptions import (
            SceneBindingViolatesByokBoundary,
        )
        from apps.users.auth.exceptions import scene_call_error_handler

        internal_detail = (
            "provider scope=organization-secret model=internal-model "
            "prompt_variable=private_prompt"
        )
        with patch("apps.users.auth.exceptions.logger.error") as log_error:
            response = scene_call_error_handler(
                None,
                SceneBindingViolatesByokBoundary(
                    internal_detail,
                    scene_key="internal_scene_key",
                ),
            )
        payload = json.loads(response.content)

        self.assertEqual(response.status_code, 500)
        self.assertEqual(
            payload["code"],
            "E14_SCENE_BINDING_VIOLATES_BYOK_BOUNDARY",
        )
        self.assertEqual(payload["message"], "服务暂时不可用，请稍后重试")
        self.assertNotIn("organization-secret", payload["message"])
        self.assertNotIn("internal-model", payload["message"])
        self.assertNotIn("private_prompt", payload["message"])
        self.assertIn(internal_detail, str(log_error.call_args))

    def test_generic_exception_remains_sanitized(self):
        from apps.users.auth.exceptions import _generic_exception_handler

        with (
            patch("tabtin.sentry.capture_api_exception") as capture,
            patch("apps.users.auth.exceptions.logger.error"),
        ):
            response = _generic_exception_handler(
                None,
                RuntimeError("database_password=secret"),
            )

        self.assertEqual(response.status_code, 500)
        self.assertEqual(
            json.loads(response.content),
            {
                "success": False,
                "message": "服务暂时不可用，请稍后重试",
                "data": None,
                "code": "INTERNAL_ERROR",
            },
        )
        capture.assert_called_once()

    def test_disabled_decorator_stops_before_billing_precheck(self):
        from apps.services.billing.decorators import billing_required
        from apps.services.llm.scenes.exceptions import SceneDisabled

        provider_call = MagicMock()

        def provider():
            provider_call()

        guarded = billing_required(
            service_key="media.video",
            scene_key="media_video_generate",
        )(provider)
        with patch("apps.services.billing.decorators._run_precheck") as billing:
            with self.assertRaises(SceneDisabled):
                guarded()

        billing.assert_not_called()
        provider_call.assert_not_called()

    def test_real_video_api_stops_before_billing_and_provider(self):
        from apps.services.llm.scenes.exceptions import SceneDisabled
        from apps.services.media_generation.api import generate_video

        with (
            patch("apps.services.billing.decorators._run_precheck") as billing,
            patch("apps.services.media_generation.api.get_media_service") as provider,
        ):
            with self.assertRaises(SceneDisabled):
                generate_video()

        billing.assert_not_called()
        provider.assert_not_called()

    def test_real_music_api_stops_before_billing_and_provider(self):
        from apps.services.llm.scenes.exceptions import SceneDisabled
        from apps.services.music.api import music_generate

        with (
            patch("apps.services.billing.decorators._run_precheck") as billing,
            patch("apps.services.music.api.get_music_service") as provider,
        ):
            with self.assertRaises(SceneDisabled):
                music_generate()

        billing.assert_not_called()
        provider.assert_not_called()

    def test_video_stops_before_billing_provider_usage_and_asset(self):
        from apps.services.llm.scenes.exceptions import SceneDisabled
        from apps.services.llm.services.media import video_service

        with (
            patch("apps.services.llm.services._runtime.billing_precheck.check_billing") as billing,
            patch("apps.services.llm.services._runtime.model_resolver.resolve_model") as provider,
            patch("apps.services.llm.services._runtime.usage_recorder.record_usage_fact") as usage,
        ):
            with self.assertRaises(SceneDisabled):
                video_service.generate(
                    scene_key="media_video_generate",
                    prompt="disabled",
                    organization_id="org-1",
                    user_id="user-1",
                )

        billing.assert_not_called()
        provider.assert_not_called()
        usage.assert_not_called()

    def test_bgm_stops_before_billing_provider_usage_and_asset(self):
        from apps.services.llm.scenes.exceptions import SceneDisabled
        from apps.services.llm.services.media import audio_service

        with (
            patch("apps.services.llm.services._runtime.billing_precheck.check_billing") as billing,
            patch("apps.services.llm.services._runtime.model_resolver.resolve_model") as provider,
            patch("apps.services.llm.services._runtime.usage_recorder.record_usage_fact") as usage,
        ):
            with self.assertRaises(SceneDisabled):
                audio_service.generate(
                    scene_key="media_bgm_generate",
                    prompt="disabled",
                    organization_id="org-1",
                    user_id="user-1",
                )

        billing.assert_not_called()
        provider.assert_not_called()
        usage.assert_not_called()

class FundingModeSnapshotTests(SimpleTestCase):
    def test_existing_invocation_keeps_mode_after_flag_flip(self):
        from apps.services.llm.services._runtime.invocation import SceneInvocationContext

        with override_settings(PROVIDER_CREDIT_FUNDING_ENABLED=True):
            invocation_a = SceneInvocationContext.stable(
                invocation_id="invocation-a",
                scene_key="summarization",
                execution_key="summarization",
                organization_id="org-1",
                user_id="user-1",
            )
        with override_settings(PROVIDER_CREDIT_FUNDING_ENABLED=False):
            retry_a = invocation_a.start_attempt()
            invocation_b = SceneInvocationContext.stable(
                invocation_id="invocation-b",
                scene_key="summarization",
                execution_key="summarization",
                organization_id="org-1",
                user_id="user-1",
            )

        self.assertEqual(invocation_a.funding_mode, "provider_credit_v1")
        self.assertEqual(retry_a.funding_mode, "provider_credit_v1")
        self.assertEqual(invocation_b.funding_mode, "legacy_budget_wallet")

    def test_persisted_settlement_mode_wins_over_retry_flag(self):
        from apps.services.billing.services.gateway import BillingGateway

        event = SimpleNamespace(
            metadata={
                "status": "pending_deduction",
                "funding_mode": "provider_credit_v1",
            },
            save=MagicMock(),
        )
        manager = MagicMock()
        manager.get_or_create.return_value = (event, False)
        with (
            override_settings(PROVIDER_CREDIT_FUNDING_ENABLED=False),
            patch(
                "apps.services.billing.models.BillingUsageEvent.objects",
                manager,
            ),
        ):
            mode = BillingGateway._snapshot_funding_mode(
                organization_id="org-1",
                user_id="user-1",
                idempotency_key="ai-scene-settlement:v1:org-1:x:y",
                requested_mode="legacy_budget_wallet",
                scene_key="summarization",
                persist=True,
            )

        self.assertEqual(mode, "provider_credit_v1")
        event.save.assert_not_called()

    @override_settings(PROVIDER_CREDIT_FUNDING_ENABLED=True)
    def test_image_task_json_captures_mode_at_request_creation(self):
        from apps.services.media_generation.api import generate_image
        from apps.services.media_generation.schemas import GenerateImageRequest

        created_task = SimpleNamespace(
            id=uuid.UUID("33333333-3333-3333-3333-333333333333"),
            status="pending",
            provider_task_id="",
        )
        service = SimpleNamespace(
            provider_name="volcengine",
            model_obj=SimpleNamespace(
                id=uuid.UUID("22222222-2222-2222-2222-222222222222"),
                model_name="seedream-test",
            ),
        )
        payload = GenerateImageRequest(
            prompt="workspace",
            organization_id="org-1",
            model_name="seedream-test",
        )
        request = SimpleNamespace(
            auth=SimpleNamespace(id="user-1"),
            _billing_organization_id="org-1",
        )
        with (
            patch(
                "apps.services.media_generation.api.get_media_service",
                return_value=service,
            ),
            patch(
                "apps.services.media_generation.api.MediaTask.objects.create",
                return_value=created_task,
            ) as create_task,
            patch("apps.services.media_generation.api._enqueue_media_execution"),
        ):
            generate_image.__wrapped__(request, payload)

        parameters = create_task.call_args.kwargs["parameters"]
        self.assertEqual(parameters["_funding_mode"], "provider_credit_v1")
        self.assertEqual(
            parameters["_llm_model_id"],
            "22222222-2222-2222-2222-222222222222",
        )
