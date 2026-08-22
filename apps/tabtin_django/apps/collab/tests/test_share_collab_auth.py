"""share collab token 签发 / 验签 / collab_auth 双轨回归。"""

from __future__ import annotations

import os
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

django.setup()

import pytest  # noqa: E402

from apps.services.common.public_share.collab_token import (
    ShareCollabClaims,
    ShareCollabPrincipal,
    build_share_guest_id,
    issue_share_collab_token,
    parse_share_guest_id,
    resolve_share_collab_auth,
    verify_share_collab_token,
)
from apps.services.common.public_share.exceptions import SharePermissionDeniedError


class TestShareCollabToken:
    def test_issue_and_verify_roundtrip(self):
        guest_id = build_share_guest_id("abc123", None)
        token = issue_share_collab_token(
            share_id="abc123",
            resource_type="docs",
            resource_id=str(uuid.uuid4()),
            share_permission="view",
            guest_id=guest_id,
        )
        assert token.startswith("sct_")
        claims = verify_share_collab_token(token)
        assert claims is not None
        assert claims.share_id == "abc123"
        assert claims.resource_type == "docs"
        assert claims.permission == "view"
        assert claims.guest_id == guest_id

    def test_comment_share_maps_to_view_collab_permission(self):
        token = issue_share_collab_token(
            share_id="share1",
            resource_type="docs",
            resource_id=str(uuid.uuid4()),
            share_permission="comment",
            guest_id="share:share1:guest",
        )
        claims = verify_share_collab_token(token)
        assert claims is not None
        assert claims.permission == "view"

    def test_edit_share_requires_logged_in_guest(self):
        with pytest.raises(SharePermissionDeniedError):
            issue_share_collab_token(
                share_id="share1",
                resource_type="docs",
                resource_id=str(uuid.uuid4()),
                share_permission="edit",
                guest_id="share:share1:guest",
            )

    def test_edit_share_roundtrip_for_logged_in_user(self):
        user = SimpleNamespace(id="user-42")
        guest_id = build_share_guest_id("share1", user)
        token = issue_share_collab_token(
            share_id="share1",
            resource_type="docs",
            resource_id=str(uuid.uuid4()),
            share_permission="edit",
            guest_id=guest_id,
        )
        claims = verify_share_collab_token(token)
        assert claims is not None
        assert claims.permission == "edit"
        assert claims.guest_id == guest_id

    def test_parse_share_guest_id(self):
        assert parse_share_guest_id("share:abc:user-1") == ("abc", "user-1")
        assert parse_share_guest_id("share:abc:guest") == ("abc", None)

    def test_invalid_token_returns_none(self):
        assert verify_share_collab_token("not-a-token") is None
        assert verify_share_collab_token("sct_bad") is None

    def test_logged_in_guest_id_contains_user_id(self):
        user = SimpleNamespace(id="user-42")
        guest_id = build_share_guest_id("sid", user)
        assert guest_id == "share:sid:user-42"


class TestShareCollabAuthEndpoint:
    def _make_share_auth_request(self, claims: ShareCollabClaims):
        req = MagicMock()
        req.auth = ShareCollabPrincipal(claims=claims)
        return req

    @patch("apps.tabdoc.services.share_service.DocumentShareService.get_share_by_id")
    @patch("apps.tabdoc.services.share_service.DocumentShareService._resource_from_share")
    def test_collab_auth_accepts_edit_share_token(self, mock_resource_from_share, mock_get_share):
        from apps.collab.api import collab_auth

        doc_id = uuid.uuid4()
        share = SimpleNamespace(share_id="abc", permission="edit", is_active=True)
        resource = SimpleNamespace(id=doc_id)
        mock_get_share.return_value = share
        mock_resource_from_share.return_value = resource

        claims = ShareCollabClaims(
            share_id="abc",
            resource_type="docs",
            resource_id=str(doc_id),
            permission="edit",
            guest_id="share:abc:user-42",
        )
        req = self._make_share_auth_request(claims)
        result = collab_auth(req, "docs", doc_id)

        assert result["status"] == "ok"
        assert result["data"]["permission"] == "edit"
        assert result["data"]["user_id"] == "share:abc:user-42"

    @patch("apps.tabdoc.services.share_service.DocumentShareService.get_share_by_id")
    @patch("apps.tabdoc.services.share_service.DocumentShareService._resource_from_share")
    def test_collab_auth_accepts_valid_share_token(self, mock_resource_from_share, mock_get_share):
        from apps.collab.api import collab_auth

        doc_id = uuid.uuid4()
        share = SimpleNamespace(share_id="abc", permission="view", is_active=True)
        resource = SimpleNamespace(id=doc_id)
        mock_get_share.return_value = share
        mock_resource_from_share.return_value = resource

        claims = ShareCollabClaims(
            share_id="abc",
            resource_type="docs",
            resource_id=str(doc_id),
            permission="view",
            guest_id="share:abc:guest",
        )
        req = self._make_share_auth_request(claims)
        result = collab_auth(req, "docs", doc_id)

        assert result["status"] == "ok"
        assert result["data"]["authorized"] is True
        assert result["data"]["permission"] == "view"
        assert result["data"]["user_id"] == "share:abc:guest"

    @patch("apps.tabdoc.services.share_service.DocumentShareService.get_share_by_id")
    def test_collab_auth_rejects_revoked_share(self, mock_get_share):
        from apps.collab.api import collab_auth
        from apps.services.common.public_share.exceptions import ShareNotFoundError

        mock_get_share.side_effect = ShareNotFoundError("inactive")

        claims = ShareCollabClaims(
            share_id="revoked",
            resource_type="docs",
            resource_id=str(uuid.uuid4()),
            permission="view",
            guest_id="share:revoked:guest",
        )
        req = self._make_share_auth_request(claims)
        status, body = collab_auth(req, "docs", uuid.uuid4())
        assert status == 403

    def test_collab_auth_rejects_resource_mismatch(self):
        from apps.collab.api import collab_auth

        claims = ShareCollabClaims(
            share_id="abc",
            resource_type="docs",
            resource_id=str(uuid.uuid4()),
            permission="view",
            guest_id="share:abc:guest",
        )
        req = self._make_share_auth_request(claims)
        status, body = collab_auth(req, "docs", uuid.uuid4())
        assert status == 403


class TestResolveShareCollabAuth:
    @patch("apps.tabdata.services.share_service.TableShareService.get_share_by_id")
    @patch("apps.tabdata.services.share_service.TableShareService._resource_from_share")
    def test_resolve_returns_none_on_resource_mismatch(self, mock_resource_from_share, mock_get_share):
        table_id = uuid.uuid4()
        other_id = uuid.uuid4()
        share = SimpleNamespace(share_id="t1", permission="view")
        mock_get_share.return_value = share
        mock_resource_from_share.return_value = SimpleNamespace(id=other_id)

        claims = ShareCollabClaims(
            share_id="t1",
            resource_type="table",
            resource_id=str(table_id),
            permission="view",
            guest_id="share:t1:guest",
        )
        result = resolve_share_collab_auth(
            claims,
            "table",
            str(table_id),
            share_service_cls=__import__(
                "apps.tabdata.services.share_service",
                fromlist=["TableShareService"],
            ).TableShareService,
        )
        assert result is None


class TestShareCollabPersistAuth:
    @patch("apps.tabdoc.services.share_service.DocumentShareService.get_share_by_id")
    @patch("apps.tabdoc.services.share_service.DocumentShareService._resource_from_share")
    @patch("apps.collab.services.permission.get_user_model")
    def test_assert_share_collab_write_allowed(self, mock_get_user_model, mock_resource_from_share, mock_get_share):
        from apps.collab.services.permission import _assert_share_collab_write_allowed

        doc_id = str(uuid.uuid4())
        user_id = str(uuid.uuid4())
        share = SimpleNamespace(share_id="share-1", permission="edit")
        resource = SimpleNamespace(id=doc_id)
        mock_get_share.return_value = share
        mock_resource_from_share.return_value = resource
        mock_user = SimpleNamespace(id=user_id)
        mock_get_user_model.return_value.objects.filter.return_value.first.return_value = mock_user

        subject = _assert_share_collab_write_allowed(
            editor_id=f"share:share-1:{user_id}",
            resource_type="docs",
            resource_id=doc_id,
        )
        assert subject is mock_user

    @patch("apps.tabdoc.services.share_service.DocumentShareService.get_share_by_id")
    def test_assert_share_collab_write_denied_when_revoked(self, mock_get_share):
        from apps.collab.services.permission import CollabPermissionError, _assert_share_collab_write_allowed
        from apps.services.common.public_share.exceptions import ShareNotFoundError

        mock_get_share.side_effect = ShareNotFoundError("inactive")
        with pytest.raises(CollabPermissionError) as ctx:
            _assert_share_collab_write_allowed(
                editor_id=f"share:revoked:{uuid.uuid4()}",
                resource_type="docs",
                resource_id=str(uuid.uuid4()),
            )
        assert ctx.value.code == "collab_share_grant_denied"
