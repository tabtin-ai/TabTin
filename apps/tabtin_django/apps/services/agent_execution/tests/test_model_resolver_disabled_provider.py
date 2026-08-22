"""#7397：禁用自定义渠道不得因会话粘性继续解析为可用模型。"""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.test import SimpleTestCase

from apps.services.agent_execution.model_resolver import resolve_model
from apps.services.llm.models import LLMModel


def _chat_model(*, model_id, routing_enabled=True, capability_domain="chat"):
    provider = SimpleNamespace(
        name="custom-openai",
        routing_enabled=routing_enabled,
        priority=10,
    )
    return SimpleNamespace(
        id=model_id,
        model_name="custom-model",
        capability_domain=capability_domain,
        provider=provider,
    )


class ResolveModelDisabledProviderTests(SimpleTestCase):
    def test_session_sticky_disabled_provider_falls_back_to_system_default(self):
        disabled_id = uuid4()
        system_id = uuid4()
        disabled = _chat_model(model_id=disabled_id, routing_enabled=False)
        system_default = _chat_model(model_id=system_id, routing_enabled=True)

        session = SimpleNamespace(
            current_model_id=disabled_id,
            default_model_id=disabled_id,
            current_model=disabled,
            default_model=disabled,
        )

        system_qs = MagicMock()
        system_qs.order_by.return_value.first.return_value = system_default

        select_related_qs = MagicMock()
        select_related_qs.get.side_effect = LLMModel.DoesNotExist

        with patch(
            "apps.services.llm.models.LLMModel.objects.select_related",
            return_value=select_related_qs,
        ), patch(
            "apps.services.llm.services.capability_guard.is_llm_model_instance",
            return_value=True,
        ), patch(
            "apps.services.llm.services.capability_guard.apply_chat_model_filter",
            side_effect=lambda q: q,
        ), patch(
            "apps.services.llm.models.LLMModel.objects.filter",
            return_value=system_qs,
        ):
            resolved = resolve_model(session, str(disabled_id))

        self.assertTrue(resolved.fell_back)
        self.assertIs(resolved.instance, system_default)

    def test_session_default_without_explicit_id_skips_disabled_provider(self):
        disabled_id = uuid4()
        system_id = uuid4()
        disabled = _chat_model(model_id=disabled_id, routing_enabled=False)
        system_default = _chat_model(model_id=system_id, routing_enabled=True)

        session = SimpleNamespace(
            current_model_id=disabled_id,
            default_model_id=None,
            current_model=disabled,
            default_model=None,
        )

        system_qs = MagicMock()
        system_qs.order_by.return_value.first.return_value = system_default

        with patch(
            "apps.services.llm.services.capability_guard.is_llm_model_instance",
            return_value=True,
        ), patch(
            "apps.services.llm.services.capability_guard.apply_chat_model_filter",
            side_effect=lambda q: q,
        ), patch(
            "apps.services.llm.models.LLMModel.objects.filter",
            return_value=system_qs,
        ):
            resolved = resolve_model(session, None)

        self.assertTrue(resolved.fell_back)
        self.assertIs(resolved.instance, system_default)

    def test_enabled_session_model_still_used_without_explicit_id(self):
        enabled_id = uuid4()
        enabled = _chat_model(model_id=enabled_id, routing_enabled=True)
        session = SimpleNamespace(
            current_model_id=enabled_id,
            default_model_id=None,
            current_model=enabled,
            default_model=None,
        )

        with patch(
            "apps.services.llm.services.capability_guard.is_llm_model_instance",
            return_value=True,
        ):
            resolved = resolve_model(session, None)

        self.assertFalse(resolved.fell_back)
        self.assertIs(resolved.instance, enabled)
