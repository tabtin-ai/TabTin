"""
billing_required 装饰器 + organization_resolver 单元测试。
"""

from __future__ import annotations

import uuid
from decimal import Decimal
from unittest.mock import MagicMock, patch

from django.http import HttpRequest
from django.test import SimpleTestCase, override_settings
from ninja.errors import HttpError

from apps.services.billing.decorators import (
    _extract_request,
    _extract_organization_from_payload,
    billing_required,
)
from apps.services.billing.organization_resolver import (
    extract_user_id,
    resolve_organization_id,
)
from apps.services.billing.task_billing import BillingTaskMixin, BillingBlockedTaskError
from apps.services.billing.tests.org_test_utils import fake_org_id


# ---------------------------------------------------------------------------
# organization_resolver
# ---------------------------------------------------------------------------

class TestExtractUserId(SimpleTestCase):
    def test_from_auth(self):
        request = HttpRequest()
        request.auth = MagicMock(id=uuid.uuid4())
        self.assertEqual(extract_user_id(request), str(request.auth.id))

    def test_no_auth(self):
        request = HttpRequest()
        self.assertEqual(extract_user_id(request), "")


class TestResolveOrganizationId(SimpleTestCase):
    def test_returns_payload_when_provided(self):
        wt = str(uuid.uuid4())
        result = resolve_organization_id(payload_organization_id=wt)
        self.assertEqual(result, wt)

    def test_payload_returned_directly_without_membership_check(self):
        """payload_organization_id 非空时直接返回，不做成员校验。"""
        wt = str(uuid.uuid4())
        result = resolve_organization_id(
            payload_organization_id=wt,
            request=HttpRequest(),
        )
        self.assertEqual(result, wt)

    def test_api_key_organization_id_used_when_no_payload(self):
        api_wt = str(uuid.uuid4())
        result = resolve_organization_id(api_key_organization_id=api_wt)
        self.assertEqual(result, api_wt)

    @patch("apps.services.billing.organization_resolver._resolve_from_space")
    def test_space_id_resolved(self, mock_space):
        wt = str(uuid.uuid4())
        mock_space.return_value = wt
        result = resolve_organization_id(space_id="some-space")
        self.assertEqual(result, wt)
        mock_space.assert_called_once_with("some-space")

    @patch("apps.services.billing.organization_resolver.get_personal_organization_id_by_user_id")
    def test_falls_back_to_personal_when_opted_in(self, mock_personal):
        personal_id = str(uuid.uuid4())
        mock_personal.return_value = personal_id
        request = HttpRequest()
        request.auth = MagicMock(id=uuid.uuid4())
        result = resolve_organization_id(request=request, fallback_to_personal=True)
        self.assertEqual(result, personal_id)

    def test_no_fallback_by_default(self):
        """W2-1c: 默认 fallback_to_personal=False，解析失败返回空字符串。"""
        request = HttpRequest()
        request.auth = MagicMock(id=uuid.uuid4())
        result = resolve_organization_id(request=request)
        self.assertEqual(result, "")


# ---------------------------------------------------------------------------
# decorators: helpers
# ---------------------------------------------------------------------------

class TestExtractRequest(SimpleTestCase):
    def test_from_args(self):
        req = HttpRequest()
        self.assertIs(_extract_request((req,), {}), req)

    def test_from_kwargs(self):
        req = HttpRequest()
        self.assertIs(_extract_request((), {"request": req}), req)

    def test_none_when_missing(self):
        self.assertIsNone(_extract_request(("not_a_request",), {}))


class TestExtractOrganizationFromPayload(SimpleTestCase):
    def test_from_kwargs(self):
        result = _extract_organization_from_payload((), {"organization_id": "ws-1"}, "organization_id")
        self.assertEqual(result, "ws-1")

    def test_from_payload_object(self):
        payload = MagicMock(organization_id=fake_org_id("ws-2"))
        result = _extract_organization_from_payload((), {"payload": payload}, "organization_id")
        self.assertEqual(result, fake_org_id("ws-2"))

    def test_from_args_object(self):
        payload = MagicMock(organization_id=fake_org_id("ws-3"))
        result = _extract_organization_from_payload((payload,), {}, "organization_id")
        self.assertEqual(result, fake_org_id("ws-3"))

    def test_missing(self):
        result = _extract_organization_from_payload((), {}, "organization_id")
        self.assertEqual(result, "")


# ---------------------------------------------------------------------------
# billing_required: integration
# ---------------------------------------------------------------------------

class TestBillingRequired(SimpleTestCase):
    def _make_request(self, user_id=None):
        req = HttpRequest()
        if user_id:
            req.auth = MagicMock(id=user_id)
        return req

    @patch("apps.services.billing.decorators._run_precheck", return_value=None)
    @patch("apps.services.billing.organization_resolver.get_personal_organization_id_by_user_id", return_value="personal-wt-1")
    def test_passes_through_on_success(self, mock_personal, mock_precheck):
        """require_organization defaults to True, so we supply organization_id explicitly."""
        user_id = str(uuid.uuid4())
        wt_id = str(uuid.uuid4())

        @billing_required(service_key="media.image", require_organization=False)
        def my_view(request):
            return {"ok": True, "wt": request._billing_organization_id}

        req = self._make_request(user_id=user_id)
        req.META = {"HTTP_X_TABTIN_ORGANIZATION_ID": wt_id}
        result = my_view(req)
        self.assertTrue(result["ok"])
        self.assertEqual(result["wt"], wt_id)
        mock_precheck.assert_called_once()

    @patch("apps.services.billing.decorators._run_precheck")
    @patch("apps.services.billing.organization_resolver.get_personal_organization_id_by_user_id", return_value="wt-1")
    def test_blocks_when_precheck_raises_http_error(self, mock_personal, mock_precheck):
        mock_precheck.side_effect = HttpError(402, "no credits")
        wt_id = str(uuid.uuid4())

        @billing_required(service_key="speech.asr", require_organization=False)
        def my_view(request):
            return {"should_not_reach": True}

        req = self._make_request(user_id=str(uuid.uuid4()))
        req.META = {"HTTP_X_TABTIN_ORGANIZATION_ID": wt_id}
        with self.assertRaises(HttpError) as ctx:
            my_view(req)
        self.assertEqual(ctx.exception.status_code, 402)

    @patch("apps.services.billing.decorators._run_precheck")
    @patch("apps.services.billing.organization_resolver.get_personal_organization_id_by_user_id", return_value="")
    def test_require_organization_rejects_when_empty(self, mock_personal, mock_precheck):
        @billing_required(service_key="media.image", require_organization=True)
        def my_view(request):
            return {"should_not_reach": True}

        req = self._make_request(user_id=str(uuid.uuid4()))
        with self.assertRaises(HttpError) as ctx:
            my_view(req)
        self.assertEqual(ctx.exception.status_code, 400)
        mock_precheck.assert_not_called()

    @patch("apps.services.billing.decorators._run_precheck", side_effect=RuntimeError("db down"))
    @patch("apps.services.billing.organization_resolver.get_personal_organization_id_by_user_id", return_value="wt-1")
    def test_error_passthrough_on_precheck_exception(self, mock_personal, mock_precheck):
        """非 HttpError 异常时，装饰器应放行（fail-open）。"""
        wt_id = str(uuid.uuid4())

        @billing_required(service_key="rag.embedding", require_organization=False)
        def my_view(request):
            return {"ok": True}

        req = self._make_request(user_id=str(uuid.uuid4()))
        req.META = {"HTTP_X_TABTIN_ORGANIZATION_ID": wt_id}
        result = my_view(req)
        self.assertTrue(result["ok"])

    @patch("apps.services.billing.decorators._run_precheck", return_value=None)
    def test_custom_resolver(self, mock_precheck):
        def my_resolver(request, kwargs):
            return "custom-wt-from-resolver"

        @billing_required(
            service_key="speech.tts",
            organization_id_resolver=my_resolver,
        )
        def my_view(request, video_id: str):
            return {"wt": request._billing_organization_id}

        req = self._make_request(user_id=str(uuid.uuid4()))
        result = my_view(req, video_id="vid-1")
        self.assertEqual(result["wt"], "custom-wt-from-resolver")


# ---------------------------------------------------------------------------
# BillingTaskMixin
# ---------------------------------------------------------------------------

class TestBillingTaskMixin(SimpleTestCase):
    @patch("apps.services.llm.services.billed_call.check_balance_before_request", return_value=None)
    def test_allows_when_balance_ok(self, mock_check):
        mixin = BillingTaskMixin()
        mixin.update_state = MagicMock()
        mixin.before_start(
            "task-1", [],
            {"user_id": "u1", "organization_id": "wt1"}
        )
        mock_check.assert_called_once_with("u1", "wt1")
        mixin.update_state.assert_not_called()

    @patch(
        "apps.services.llm.services.billed_call.check_balance_before_request",
        return_value={"blocked": True},
    )
    def test_blocks_when_balance_insufficient(self, mock_check):
        mixin = BillingTaskMixin()
        mixin.update_state = MagicMock()
        with self.assertRaises(BillingBlockedTaskError):
            mixin.before_start(
                "task-2", [],
                {"user_id": "u2", "organization_id": "wt2"}
            )

    def test_skips_when_no_user_id(self):
        mixin = BillingTaskMixin()
        mixin.update_state = MagicMock()
        mixin.before_start("task-3", [], {"organization_id": "wt3"})
