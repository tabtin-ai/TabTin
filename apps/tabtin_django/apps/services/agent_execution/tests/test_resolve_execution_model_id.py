"""#5814：preferred_model_id 必须落在 chat catalog，否则回落默认链。"""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.test import SimpleTestCase, override_settings

from apps.services.agent_execution.model_resolver import resolve_execution_model_id


def _catalog_entry(model_id, *, mode="chat"):
    return {"id": str(model_id), "mode": mode, "capability_domain": mode}


class ResolveExecutionModelIdTests(SimpleTestCase):
    @override_settings(DEFAULT_LLM_MODEL="kimi-k2.6")
    def test_preferred_in_catalog_is_used(self):
        preferred = uuid4()
        other = uuid4()
        model = SimpleNamespace(id=preferred)

        with patch(
            "apps.services.agent_execution.model_resolver._chat_catalog_model_ids",
            return_value=[str(preferred), str(other)],
        ), patch(
            "apps.services.agent_execution.model_resolver._load_catalog_model",
            side_effect=lambda mid: model if str(mid) == str(preferred) else None,
        ), patch(
            "apps.services.llm.api_common._get_organization_default_model_id",
            return_value=None,
        ):
            result = resolve_execution_model_id(
                preferred_model_id=str(preferred),
                organization_id="org-1",
                user_id="user-1",
            )

        self.assertEqual(result, str(preferred))

    @override_settings(DEFAULT_LLM_MODEL="kimi-k2.6")
    def test_stale_preferred_falls_back_to_org_default_in_catalog(self):
        stale = uuid4()
        org_default = uuid4()
        model = SimpleNamespace(id=org_default)

        with patch(
            "apps.services.agent_execution.model_resolver._chat_catalog_model_ids",
            return_value=[str(org_default)],
        ), patch(
            "apps.services.agent_execution.model_resolver._load_catalog_model",
            side_effect=lambda mid: model if str(mid) == str(org_default) else None,
        ), patch(
            "apps.services.llm.api_common._get_organization_default_model_id",
            return_value=str(org_default),
        ):
            result = resolve_execution_model_id(
                preferred_model_id=str(stale),
                organization_id="org-1",
                user_id="user-1",
            )

        self.assertEqual(result, str(org_default))

    @override_settings(DEFAULT_LLM_MODEL="kimi-k2.6")
    def test_stale_preferred_falls_back_to_catalog_first(self):
        stale = uuid4()
        first = uuid4()
        model = SimpleNamespace(id=first)

        with patch(
            "apps.services.agent_execution.model_resolver._chat_catalog_model_ids",
            return_value=[str(first)],
        ), patch(
            "apps.services.agent_execution.model_resolver._load_catalog_model",
            side_effect=lambda mid: model if str(mid) == str(first) else None,
        ), patch(
            "apps.services.llm.api_common._get_organization_default_model_id",
            return_value=None,
        ), patch(
            "apps.services.llm.services.capability_guard.apply_chat_model_filter",
            side_effect=lambda q: q,
        ), patch(
            "apps.services.llm.models.LLMModel.objects.select_related",
        ) as select_related:
            name_qs = MagicMock()
            name_qs.filter.return_value = name_qs
            name_qs.order_by.return_value.first.return_value = None
            select_related.return_value = name_qs

            result = resolve_execution_model_id(
                preferred_model_id=str(stale),
                organization_id="org-1",
                user_id="user-1",
            )

        self.assertEqual(result, str(first))

    @override_settings(DEFAULT_LLM_MODEL="kimi-k2.6")
    def test_empty_preferred_uses_session_sticky_when_in_catalog(self):
        sticky = uuid4()
        model = SimpleNamespace(id=sticky)
        session = SimpleNamespace(current_model_id=sticky, default_model_id=None)

        with patch(
            "apps.services.agent_execution.model_resolver._chat_catalog_model_ids",
            return_value=[str(sticky)],
        ), patch(
            "apps.services.agent_execution.model_resolver._load_catalog_model",
            side_effect=lambda mid: model if str(mid) == str(sticky) else None,
        ), patch(
            "apps.services.llm.api_common._get_organization_default_model_id",
            return_value=None,
        ):
            result = resolve_execution_model_id(
                preferred_model_id=None,
                organization_id="org-1",
                user_id="user-1",
                session=session,
            )

        self.assertEqual(result, str(sticky))

    @override_settings(DEFAULT_LLM_MODEL="kimi-k2.6")
    def test_empty_catalog_returns_none_even_with_session_and_system_model(self):
        """成员档位过滤后 catalog 为空时，不得回退到 catalog 外 session/系统模型。"""
        preferred = uuid4()
        session_model = uuid4()
        outside_system = uuid4()
        session = SimpleNamespace(
            current_model_id=session_model,
            default_model_id=session_model,
        )

        with patch(
            "apps.services.agent_execution.model_resolver._chat_catalog_model_ids",
            return_value=[],
        ), patch(
            "apps.services.agent_execution.model_resolver._load_catalog_model",
            return_value=None,
        ), patch(
            "apps.services.llm.api_common._get_organization_default_model_id",
            return_value=str(session_model),
        ), patch(
            "apps.services.agent_execution.model_resolver.resolve_model",
            return_value=SimpleNamespace(
                instance=SimpleNamespace(id=outside_system),
                fell_back=True,
            ),
        ) as resolve_model_mock:
            result = resolve_execution_model_id(
                preferred_model_id=str(preferred),
                organization_id="org-1",
                user_id="user-1",
                session=session,
            )

        self.assertIsNone(result)
        resolve_model_mock.assert_not_called()
