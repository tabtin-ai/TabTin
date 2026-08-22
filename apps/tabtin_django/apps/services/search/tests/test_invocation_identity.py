from __future__ import annotations

import json
import uuid
from types import SimpleNamespace
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import RequestFactory, SimpleTestCase, TestCase

from apps.chat.conversation.models import ChatSession
from apps.services.agent_engine.models import ExecutionRun
from apps.services.search.api import WebSearchRequest, web_search
from apps.services.search.constants import SEARCH_BILLING_METER_KEY
from apps.services.search.services.invocation_identity import (
    SearchInvocationValidationError,
    VerifiedSearchInvocationIdentity,
    build_search_request_fingerprint,
    resolve_verified_search_invocation,
)
from apps.services.search.services.search_service import SearchService
from apps.services.search.services.types import (
    SearchRequest,
    SearchResponse,
)
from apps.tabtinspace.models import Organization, OrganizationMember


class SearchRequestFingerprintTests(SimpleTestCase):
    def _request(self, **overrides) -> SearchRequest:
        values = {
            "query": "OpenAI release notes",
            "count": 8,
            "summary": True,
            "freshness": "noLimit",
            "include": "a.com,b.com",
            "exclude": "c.com",
        }
        values.update(overrides)
        return SearchRequest(**values)

    def test_same_effective_request_has_same_fingerprint(self):
        first = build_search_request_fingerprint(self._request())
        second = build_search_request_fingerprint(self._request())

        self.assertEqual(first.request_fingerprint, second.request_fingerprint)

    def test_different_query_has_different_fingerprint(self):
        first = build_search_request_fingerprint(self._request(query="OpenAI"))
        second = build_search_request_fingerprint(self._request(query="Apple"))

        self.assertNotEqual(first.request_fingerprint, second.request_fingerprint)

    def test_different_provider_execution_option_has_different_fingerprint(self):
        first = build_search_request_fingerprint(self._request(count=8))
        second = build_search_request_fingerprint(self._request(count=12))

        self.assertNotEqual(first.request_fingerprint, second.request_fingerprint)

    def test_domain_order_case_and_duplicates_do_not_change_fingerprint(self):
        first = build_search_request_fingerprint(
            self._request(include=" a.com,B.COM,a.com ")
        )
        second = build_search_request_fingerprint(
            self._request(include="b.com,a.com")
        )

        self.assertEqual(first.request_fingerprint, second.request_fingerprint)

    def test_fingerprint_context_never_contains_plain_query(self):
        plain_query = "private acquisition plan 2026"

        fingerprint = build_search_request_fingerprint(
            self._request(query=plain_query)
        )

        serialized = json.dumps(
            {
                "fingerprint_version": fingerprint.fingerprint_version,
                "meter_key": fingerprint.meter_key,
                "query_sha256": fingerprint.query_sha256,
                "request_fingerprint": fingerprint.request_fingerprint,
            },
            sort_keys=True,
        )
        self.assertNotIn(plain_query, serialized)
        self.assertEqual(fingerprint.meter_key, SEARCH_BILLING_METER_KEY)


class SearchServiceInvocationContextTests(SimpleTestCase):
    def _verified_identity(self) -> VerifiedSearchInvocationIdentity:
        user_id = str(uuid.uuid4())
        organization_id = str(uuid.uuid4())
        run_id = str(uuid.uuid4())
        run = SimpleNamespace(
            run_id=run_id,
            user_id=user_id,
            organization_id=organization_id,
            session_id="",
            thread_id="",
        )
        with (
            patch(
                "apps.services.search.services.invocation_identity._verify_search_organization_access"
            ),
            patch(
                "apps.services.agent_engine.models.ExecutionRun.objects.filter"
            ) as filter_runs,
        ):
            filter_runs.return_value.first.return_value = run
            identity = resolve_verified_search_invocation(
                authenticated_user=SimpleNamespace(id=user_id),
                organization_id=organization_id,
                agent_run_id=run_id,
                client_tool_invocation_component="tool-service-test",
            )
        assert identity is not None
        return identity

    def _search(self, **overrides) -> SearchResponse:
        config = SimpleNamespace(
            default_provider_key="bocha",
            default_count=8,
            default_summary_enabled=True,
            default_freshness="noLimit",
        )
        runtime_provider = SimpleNamespace(
            provider_key="bocha",
            api_key="sk-test",
        )

        class FakeProvider:
            def search(self, request: SearchRequest) -> SearchResponse:
                return SearchResponse(
                    provider_key="bocha",
                    provider_type="bocha",
                    provider_display_name="Bocha",
                    request_id="provider-request-id",
                    query=request.query,
                    count=request.count,
                    summary_enabled=request.summary,
                    freshness=request.freshness,
                )

        params = {
            "query": "OpenAI release notes",
            "charge_billing": False,
        }
        params.update(overrides)
        with (
            patch(
                "apps.services.search.services.search_service.SearchProviderRuntime.get_global_config",
                return_value=config,
            ),
            patch(
                "apps.services.search.services.search_service.SearchProviderRuntime.resolve_provider",
                return_value=runtime_provider,
            ),
            patch(
                "apps.services.search.services.search_service.SearchProviderRuntime.create_provider_client",
                return_value=FakeProvider(),
            ),
        ):
            return SearchService.search(**params)

    def test_omitted_and_explicit_effective_defaults_have_same_fingerprint(self):
        verified = self._verified_identity()
        omitted = self._search(verified_invocation=verified)
        explicit = self._search(
            count=8,
            summary=True,
            freshness="noLimit",
            verified_invocation=verified,
        )

        self.assertEqual(
            omitted.invocation_context.request_fingerprint,
            explicit.invocation_context.request_fingerprint,
        )

    def test_legacy_search_has_no_invocation_context(self):
        result = self._search()

        self.assertIsNone(result.invocation_context)
        self.assertEqual(result.provider_key, "bocha")
        self.assertNotIn("invocation_context", result.to_dict())

    def test_raw_identity_arguments_are_not_part_of_search_service_contract(self):
        with self.assertRaises(TypeError):
            self._search(
                agent_run_id=str(uuid.uuid4()),
                client_tool_invocation_component="forged-tool-id",
            )

    def test_unverified_value_object_is_rejected_before_provider_execution(self):
        with self.assertRaises(TypeError):
            self._search(
                verified_invocation=SimpleNamespace(
                    logical_search_invocation_id=str(uuid.uuid4()),
                    agent_run_id=str(uuid.uuid4()),
                )
            )

    def test_verified_identity_cannot_be_constructed_without_server_token(self):
        with self.assertRaises(TypeError):
            VerifiedSearchInvocationIdentity(
                logical_search_invocation_id=str(uuid.uuid4()),
                agent_run_id=str(uuid.uuid4()),
            )


class SearchInvocationAuthorizationTests(TestCase):
    databases = {"default"}

    @classmethod
    def setUpTestData(cls):
        User = get_user_model()
        cls.user = User.objects.create_user(email="search-user@example.com")
        cls.other_user = User.objects.create_user(email="other-search-user@example.com")
        cls.organization = Organization.objects.create(
            name="Search Team",
            owner=cls.user,
        )
        cls.other_organization = Organization.objects.create(
            name="Other Search Team",
            owner=cls.other_user,
        )
        OrganizationMember.objects.get_or_create(
            organization=cls.organization,
            user=cls.user,
            defaults={"role": "owner"},
        )
        cls.session = ChatSession.objects.create(
            user=cls.user,
            organization_id=str(cls.organization.id),
            title="Search invocation test",
        )
        cls.execution_run = ExecutionRun.objects.create(
            thread_id=cls.session.thread_id,
            graph_type="chat",
            session_id=str(cls.session.id),
            organization_id=str(cls.organization.id),
            user_id=str(cls.user.id),
        )

    def test_different_valid_runs_with_same_component_get_different_ids(self):
        second_run = ExecutionRun.objects.create(
            thread_id=":second-valid-run",
            graph_type="chat",
            organization_id=str(self.organization.id),
            user_id=str(self.user.id),
        )

        first = resolve_verified_search_invocation(
            authenticated_user=self.user,
            organization_id=str(self.organization.id),
            agent_run_id=str(self.execution_run.run_id),
            client_tool_invocation_component="tool-shared",
        )
        second = resolve_verified_search_invocation(
            authenticated_user=self.user,
            organization_id=str(self.organization.id),
            agent_run_id=str(second_run.run_id),
            client_tool_invocation_component="tool-shared",
        )

        self.assertNotEqual(
            first.logical_search_invocation_id,
            second.logical_search_invocation_id,
        )

    def test_same_valid_run_and_component_get_same_id(self):
        inputs = {
            "authenticated_user": self.user,
            "organization_id": str(self.organization.id),
            "agent_run_id": str(self.execution_run.run_id),
            "client_tool_invocation_component": "tool-repeat",
        }

        first = resolve_verified_search_invocation(**inputs)
        second = resolve_verified_search_invocation(**inputs)

        self.assertEqual(
            first.logical_search_invocation_id,
            second.logical_search_invocation_id,
        )

    def test_same_valid_run_and_different_component_get_different_ids(self):
        first = resolve_verified_search_invocation(
            authenticated_user=self.user,
            organization_id=str(self.organization.id),
            agent_run_id=str(self.execution_run.run_id),
            client_tool_invocation_component="tool-first",
        )
        second = resolve_verified_search_invocation(
            authenticated_user=self.user,
            organization_id=str(self.organization.id),
            agent_run_id=str(self.execution_run.run_id),
            client_tool_invocation_component="tool-second",
        )

        self.assertNotEqual(
            first.logical_search_invocation_id,
            second.logical_search_invocation_id,
        )

    def test_run_owned_by_another_user_is_forbidden(self):
        foreign_run = ExecutionRun.objects.create(
            thread_id="foreign-thread",
            graph_type="chat",
            organization_id=str(self.organization.id),
            user_id=str(self.other_user.id),
        )

        with self.assertRaises(SearchInvocationValidationError) as raised:
            resolve_verified_search_invocation(
                authenticated_user=self.user,
                organization_id=str(self.organization.id),
                agent_run_id=str(foreign_run.run_id),
                client_tool_invocation_component="tool-foreign",
            )

        self.assertEqual(raised.exception.status_code, 403)

    def test_run_organization_mismatch_is_forbidden(self):
        mismatched_run = ExecutionRun.objects.create(
            thread_id="other-organization-thread",
            graph_type="chat",
            organization_id=str(self.other_organization.id),
            user_id=str(self.user.id),
        )

        with self.assertRaises(SearchInvocationValidationError) as raised:
            resolve_verified_search_invocation(
                authenticated_user=self.user,
                organization_id=str(self.organization.id),
                agent_run_id=str(mismatched_run.run_id),
                client_tool_invocation_component="tool-mismatch",
            )

        self.assertEqual(raised.exception.status_code, 403)

    def test_agent_run_without_tool_component_fails_closed(self):
        with self.assertRaises(SearchInvocationValidationError) as raised:
            resolve_verified_search_invocation(
                authenticated_user=self.user,
                organization_id=str(self.organization.id),
                agent_run_id=str(self.execution_run.run_id),
                client_tool_invocation_component=None,
            )

        self.assertEqual(raised.exception.status_code, 400)

    def test_run_session_organization_mismatch_is_forbidden(self):
        mismatched_session = ChatSession.objects.create(
            user=self.user,
            organization_id=str(self.other_organization.id),
            title="Mismatched invocation session",
        )
        mismatched_run = ExecutionRun.objects.create(
            thread_id=mismatched_session.thread_id,
            graph_type="chat",
            session_id=str(mismatched_session.id),
            organization_id=str(self.organization.id),
            user_id=str(self.user.id),
        )

        with self.assertRaises(SearchInvocationValidationError) as raised:
            resolve_verified_search_invocation(
                authenticated_user=self.user,
                organization_id=str(self.organization.id),
                agent_run_id=str(mismatched_run.run_id),
                client_tool_invocation_component="tool-session-mismatch",
            )

        self.assertEqual(raised.exception.status_code, 403)

    def test_python_legacy_helper_foreign_valid_tuple_cannot_activate_identity(self):
        foreign_run = ExecutionRun.objects.create(
            thread_id="foreign-valid-python-run",
            graph_type="chat",
            organization_id=str(self.other_organization.id),
            user_id=str(self.other_user.id),
        )
        response_data = SearchResponse(
            provider_key="bocha",
            provider_type="bocha",
            provider_display_name="Bocha",
            request_id="provider-request-id",
            query="OpenAI",
            count=8,
            summary_enabled=True,
            freshness="noLimit",
        )
        from apps.services.tools.domains.common._web_helpers import do_web_search

        with (
            patch.object(SearchService, "search", return_value=response_data) as search,
            patch.object(SearchService, "format_for_llm", return_value="legacy result"),
        ):
            do_web_search(
                "OpenAI",
                organization_id=str(self.other_organization.id),
                user_id=str(self.other_user.id),
                thread_id=foreign_run.thread_id,
            )

        search_kwargs = search.call_args.kwargs
        self.assertNotIn("verified_invocation", search_kwargs)
        self.assertNotIn("agent_run_id", search_kwargs)
        self.assertNotIn("client_tool_invocation_component", search_kwargs)


class SearchApiInvocationSecurityTests(TestCase):
    databases = {"default"}

    @classmethod
    def setUpTestData(cls):
        User = get_user_model()
        cls.user = User.objects.create_user(email="search-api-user@example.com")
        cls.other_user = User.objects.create_user(email="search-api-other@example.com")
        cls.organization = Organization.objects.create(
            name="Search API Team",
            owner=cls.user,
        )
        cls.unauthorized_organization = Organization.objects.create(
            name="Unauthorized Search API Team",
            owner=cls.other_user,
        )
        cls.session = ChatSession.objects.create(
            user=cls.user,
            organization_id=str(cls.organization.id),
            title="Search API invocation test",
        )
        cls.execution_run = ExecutionRun.objects.create(
            thread_id=cls.session.thread_id,
            graph_type="chat",
            session_id=str(cls.session.id),
            organization_id=str(cls.organization.id),
            user_id=str(cls.user.id),
        )

    def _request(self, organization_id: uuid.UUID):
        request = RequestFactory().post(
            "/api/search/web",
            HTTP_X_TABTIN_ORGANIZATION_ID=str(organization_id),
        )
        request.auth = self.user
        return request

    def test_unauthorized_organization_header_is_rejected_before_search(self):
        with patch.object(SearchService, "search") as search:
            response = web_search(
                self._request(self.unauthorized_organization.id),
                WebSearchRequest(query="OpenAI"),
            )

        self.assertEqual(response.status_code, 403)
        search.assert_not_called()

    def test_agent_run_without_tool_component_returns_validation_error(self):
        response = web_search(
            self._request(self.organization.id),
            WebSearchRequest(
                query="OpenAI",
                agent_run_id=str(self.execution_run.run_id),
            ),
        )

        self.assertEqual(response.status_code, 400)

    def test_authenticated_agent_request_passes_verified_identity_to_search_service(self):
        response_data = SearchResponse(
            provider_key="bocha",
            provider_type="bocha",
            provider_display_name="Bocha",
            request_id="provider-request-id",
            query="OpenAI",
            count=8,
            summary_enabled=True,
            freshness="noLimit",
        )
        with patch.object(SearchService, "search", return_value=response_data) as search:
            response = web_search(
                self._request(self.organization.id),
                WebSearchRequest(
                    query="OpenAI",
                    agent_run_id=str(self.execution_run.run_id),
                    client_tool_invocation_component="tool-api-1",
                ),
            )

        self.assertIsInstance(response, dict)
        verified = search.call_args.kwargs["verified_invocation"]
        self.assertIsInstance(verified, VerifiedSearchInvocationIdentity)
        self.assertEqual(verified.agent_run_id, str(self.execution_run.run_id))
        self.assertTrue(verified.logical_search_invocation_id)

    def test_legacy_http_request_passes_no_verified_identity(self):
        response_data = SearchResponse(
            provider_key="bocha",
            provider_type="bocha",
            provider_display_name="Bocha",
            request_id="provider-request-id",
            query="OpenAI",
            count=8,
            summary_enabled=True,
            freshness="noLimit",
        )
        with patch.object(SearchService, "search", return_value=response_data) as search:
            response = web_search(
                self._request(self.organization.id),
                WebSearchRequest(query="OpenAI"),
            )

        self.assertIsInstance(response, dict)
        self.assertIsNone(search.call_args.kwargs["verified_invocation"])

    def test_client_supplied_final_namespace_is_ignored(self):
        data = WebSearchRequest.model_validate(
            {
                "query": "OpenAI",
                "agent_run_id": str(self.execution_run.run_id),
                "client_tool_invocation_component": "tool-api-1",
                "logical_search_invocation_id": "attacker-controlled",
            }
        )

        self.assertFalse(hasattr(data, "logical_search_invocation_id"))
