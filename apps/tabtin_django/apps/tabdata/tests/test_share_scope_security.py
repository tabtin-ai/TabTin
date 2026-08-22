"""TabData 分享安全收口：默认组织内、公网扩权确认、范围互斥。

对齐 TabDoc （test_share_scope_security.py）。
"""

from __future__ import annotations

import json
import uuid

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.http import JsonResponse
from django.test import RequestFactory, TestCase

from apps.tabdata.api_share import (
    CreateDataShareRequest,
    create_data_share,
    get_data_share,
)
from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import Table, TableShare
from apps.tabdata.services.share_service import TableShareService
from apps.tabtinspace.models import Organization, OrganizationMember, Project

User = get_user_model()


def _extract(response):
    if isinstance(response, JsonResponse):
        return json.loads(response.content.decode("utf-8")), response.status_code
    if isinstance(response, dict):
        return response, 200
    if isinstance(response, tuple) and len(response) == 2:
        status, body = response
        return body, status
    raise AssertionError(f"unexpected view response type: {type(response)!r}")


class TableShareScopeSecurityTests(TestCase):
    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from apps.tabtinspace.signals import create_default_organization

        try:
            post_save.disconnect(create_default_organization, sender=User)
        except Exception:
            pass

    def setUp(self):
        self.factory = RequestFactory()
        self.owner = User.objects.create_user(
            username=f"tbl_scope_owner_{uuid.uuid4().hex[:8]}",
            email=f"tbl_scope_{uuid.uuid4().hex[:8]}@example.com",
            password="x",
        )
        self.organization = Organization.objects.create(
            name="Table Scope WT", owner=self.owner, type="team",
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.owner,
            role="owner",
        )
        self.space = Project.objects.create(
            organization=self.organization,
            name="Table Scope Space",
        )
        self.table = Table.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            owner_id=self.owner.id,
            name="scope security table",
        )

    def _request(self, *, method="POST", body=None, path_suffix=""):
        path = f"/api/tabdata/tables/{self.table.id}/share{path_suffix}"
        kwargs = {}
        if body is not None:
            kwargs["data"] = json.dumps(body)
            kwargs["content_type"] = "application/json"
        request = getattr(self.factory, method.lower())(path, **kwargs)
        request.auth = self.owner
        return request

    def _share_count(self, share_type: str | None = None) -> int:
        qs = TableShare.objects.using(TABDATA_DB_ALIAS).filter(table=self.table)
        if share_type:
            qs = qs.filter(share_type=share_type)
        else:
            qs = qs.filter(share_type__in=["data", "organization"])
        return qs.count()

    def test_default_create_is_organization(self):
        data = CreateDataShareRequest()
        self.assertEqual(data.share_type, "organization")
        result = create_data_share(self._request(body={}), self.table.id, data)
        payload, status = _extract(result)
        self.assertEqual(status, 200, payload)
        share = payload["data"]["share"]
        self.assertEqual(share["share_type"], "organization")
        self.assertEqual(self._share_count(), 1)
        self.assertEqual(self._share_count("organization"), 1)

    def test_data_without_ack_returns_409(self):
        data = CreateDataShareRequest(share_type="data", permission="view")
        result = create_data_share(
            self._request(body={"share_type": "data", "permission": "view"}),
            self.table.id,
            data,
        )
        payload, status = _extract(result)
        self.assertEqual(status, 409, payload)
        self.assertEqual(payload.get("code"), "PUBLIC_EXPOSURE_ACK_REQUIRED")
        self.assertEqual(self._share_count(), 0)

    def test_data_with_ack_succeeds(self):
        data = CreateDataShareRequest(
            share_type="data",
            permission="view",
            acknowledge_public_exposure=True,
        )
        result = create_data_share(
            self._request(
                body={
                    "share_type": "data",
                    "permission": "view",
                    "acknowledge_public_exposure": True,
                },
            ),
            self.table.id,
            data,
        )
        payload, status = _extract(result)
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["data"]["share"]["share_type"], "data")

    def test_scope_switch_deletes_previous_data_link(self):
        data_share = TableShare(
            table=self.table,
            share_type="data",
            share_id=TableShareService.generate_share_id(),
            permission="view",
            created_by=self.owner,
        )
        data_share.save(using=TABDATA_DB_ALIAS)
        old_share_id = data_share.share_id

        result = create_data_share(
            self._request(
                body={
                    "share_type": "organization",
                    "organization_id": str(self.organization.id),
                },
            ),
            self.table.id,
            CreateDataShareRequest(
                share_type="organization",
                organization_id=str(self.organization.id),
            ),
        )
        payload, status = _extract(result)
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["data"]["share"]["share_type"], "organization")
        self.assertEqual(self._share_count("data"), 0)
        self.assertEqual(self._share_count("organization"), 1)
        self.assertFalse(
            TableShare.objects.using(TABDATA_DB_ALIAS)
            .filter(share_id=old_share_id)
            .exists()
        )

    def test_get_share_returns_effective_organization_without_type(self):
        create_data_share(
            self._request(
                body={
                    "share_type": "organization",
                    "organization_id": str(self.organization.id),
                },
            ),
            self.table.id,
            CreateDataShareRequest(
                share_type="organization",
                organization_id=str(self.organization.id),
            ),
        )
        result = get_data_share(self._request(method="GET"), self.table.id, share_type="")
        payload, status = _extract(result)
        self.assertEqual(status, 200, payload)
        self.assertTrue(payload["data"]["enabled"])
        self.assertEqual(payload["data"]["share"]["share_type"], "organization")

    def test_already_data_update_permission_no_ack_required(self):
        create_data_share(
            self._request(
                body={
                    "share_type": "data",
                    "permission": "view",
                    "acknowledge_public_exposure": True,
                },
            ),
            self.table.id,
            CreateDataShareRequest(
                share_type="data",
                permission="view",
                acknowledge_public_exposure=True,
            ),
        )
        result = create_data_share(
            self._request(body={"share_type": "data", "permission": "edit"}),
            self.table.id,
            CreateDataShareRequest(share_type="data", permission="edit"),
        )
        payload, status = _extract(result)
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["data"]["share"]["permission"], "edit")

    def test_get_prefers_data_when_legacy_both_exist(self):
        """历史并存：管理 GET 优先暴露公网 data，避免静默隐藏。"""
        org_share = TableShare(
            table=self.table,
            share_type="organization",
            share_id=TableShareService.generate_share_id(),
            permission="view",
            organization_id=str(self.organization.id),
            created_by=self.owner,
        )
        org_share.save(using=TABDATA_DB_ALIAS)
        data_share = TableShare(
            table=self.table,
            share_type="data",
            share_id=TableShareService.generate_share_id(),
            permission="view",
            created_by=self.owner,
        )
        data_share.save(using=TABDATA_DB_ALIAS)

        result = get_data_share(self._request(method="GET"), self.table.id, share_type="")
        payload, status = _extract(result)
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["data"]["share"]["share_type"], "data")
        self.assertEqual(payload["data"]["share"]["share_id"], data_share.share_id)
