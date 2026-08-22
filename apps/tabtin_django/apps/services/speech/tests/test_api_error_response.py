from __future__ import annotations

import os

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django

django.setup()

import json
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import Client, SimpleTestCase, override_settings
from django.urls import path
from ninja import NinjaAPI

from apps.services.speech.api import router as speech_router
from apps.services.speech.asr.factory import ASRUpstreamError

_test_api = NinjaAPI(title="SpeechTestAPI", urls_namespace="speech_test")
_test_api.add_router("/speech", speech_router)

urlpatterns = [path("api/", _test_api.urls)]


def _fake_user():
    user_id = uuid.uuid4()
    return SimpleNamespace(
        id=user_id,
        is_authenticated=True,
        pk=user_id,
    )


@override_settings(ROOT_URLCONF="apps.services.speech.tests.test_api_error_response")
class SpeechErrorResponseTest(SimpleTestCase):
    def setUp(self):
        self.client = Client()
        self.user = _fake_user()

    def test_asr_recognize_returns_upstream_error_payload(self):
        mock_service = MagicMock()
        mock_service.recognize.side_effect = ASRUpstreamError("识别失败")

        with patch(
            "apps.users.auth.permissions.JWTAuth.authenticate",
            return_value=self.user,
        ), patch(
            "apps.services.billing.decorators._run_precheck",
        ) as mock_run_precheck, patch(
            "apps.tabtinspace.services.base.BaseService",
        ) as mock_base_service_cls, patch(
            "apps.services.speech.api.get_asr_service",
            return_value=mock_service,
        ):
            mock_run_precheck.return_value = None
            mock_base_service_cls.return_value.check_organization_permission.return_value = True
            response = self.client.post(
                "/api/speech/recognize/",
                data=json.dumps(
                    {
                        "audio_url": "https://example.com/audio.mp3",
                        "organization_id": str(uuid.uuid4()),
                    }
                ),
                content_type="application/json",
                HTTP_AUTHORIZATION="Bearer test-token",
            )

        self.assertEqual(response.status_code, 502)
        body = response.json()
        self.assertFalse(body["success"])
        self.assertEqual(body["code"], "ASR_RECOGNIZE_FAILED")
        self.assertEqual(body["message"], "语音识别服务暂时不可用，请稍后重试")

    def test_asr_recognize_rejects_unauthorized_organization_before_provider_call(self):
        with patch(
            "apps.users.auth.permissions.JWTAuth.authenticate",
            return_value=self.user,
        ), patch(
            "apps.services.billing.decorators._run_precheck",
        ) as mock_run_precheck, patch(
            "apps.tabtinspace.services.base.BaseService",
        ) as mock_base_service_cls, patch(
            "apps.services.speech.api.get_asr_service",
        ) as mock_get_asr_service:
            mock_run_precheck.return_value = None
            mock_base_service_cls.return_value.check_organization_permission.return_value = False
            response = self.client.post(
                "/api/speech/recognize/",
                data=json.dumps(
                    {
                        "audio_url": "https://example.com/audio.mp3",
                        "organization_id": str(uuid.uuid4()),
                    }
                ),
                content_type="application/json",
                HTTP_AUTHORIZATION="Bearer test-token",
            )

        self.assertEqual(response.status_code, 403)
        mock_run_precheck.assert_not_called()
        mock_get_asr_service.assert_not_called()

    def test_tts_synthesize_rejects_unauthorized_organization_before_provider_call(self):
        with patch(
            "apps.users.auth.permissions.JWTAuth.authenticate",
            return_value=self.user,
        ), patch(
            "apps.services.billing.decorators._run_precheck",
        ) as mock_run_precheck, patch(
            "apps.tabtinspace.services.base.BaseService",
        ) as mock_base_service_cls, patch(
            "apps.services.speech.api.get_tts_service",
        ) as mock_get_tts_service:
            mock_run_precheck.return_value = None
            mock_base_service_cls.return_value.check_organization_permission.return_value = False
            response = self.client.post(
                "/api/speech/tts/synthesize/",
                data=json.dumps(
                    {
                        "text": "hello",
                        "organization_id": str(uuid.uuid4()),
                    }
                ),
                content_type="application/json",
                HTTP_AUTHORIZATION="Bearer test-token",
            )

        self.assertEqual(response.status_code, 403)
        mock_run_precheck.assert_not_called()
        mock_get_tts_service.assert_not_called()
