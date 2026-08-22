"""#3266：ContextItem/Collection 已无 space FK，API 仍暴露 space_id。"""

from __future__ import annotations

from django.test import TestCase

from apps.tabtinspace.models import Agent, Collection, ContextItem, Device
from apps.tabtinspace.schemas.collection import CollectionOut
from apps.tabtinspace.schemas.context_item import ContextItemOut
from apps.tabtinspace.tests.fixtures import (
    create_test_bot_space,
    create_test_organization,
    create_test_user,
)


class ContextItemSpaceIdCompatTests(TestCase):
    databases = {"default"}

    def setUp(self) -> None:
        self.owner = create_test_user(prefix="ci_space_compat")
        self.organization = create_test_organization(owner=self.owner, prefix="ci_space_compat")
        self.agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.owner,
            name="Compat Agent",
            type="bot",
            is_active=True,
        )
        self.device = Device.objects.create(
            organization=self.organization,
            user_id=self.owner.id,
            name="Compat Device",
            device_type="electron",
            role="control",
            fingerprint="fixture-ci-space-compat",
        )
        self.workspace = create_test_bot_space(
            organization=self.organization,
            agent=self.agent,
            name="Compat Workspace",
            device=self.device,
            created_by_id=self.owner.id,
        )

    def test_context_item_out_exposes_workspace_as_space_id(self) -> None:
        item = ContextItem.objects.create(
            workspace=self.workspace,
            item_type="tabdata",
            title="compat-table",
            resource_id="00000000-0000-0000-0000-000000000001",
        )
        payload = ContextItemOut.from_orm(item).dict()
        self.assertEqual(str(payload["space_id"]), str(self.workspace.id))
        self.assertEqual(item.space_id, self.workspace.id)
        self.assertEqual(item.space, self.workspace)

    def test_collection_out_exposes_workspace_as_space_id(self) -> None:
        coll = Collection.objects.create(
            workspace=self.workspace,
            name="compat-folder",
            created_by=self.owner,
        )
        payload = CollectionOut.from_orm(coll).dict()
        self.assertEqual(str(payload["space_id"]), str(self.workspace.id))
