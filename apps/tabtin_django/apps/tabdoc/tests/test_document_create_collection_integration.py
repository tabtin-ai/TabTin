from __future__ import annotations

import os
from unittest.mock import patch
from uuid import uuid4

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings_plan_integration_test")

import django  # noqa: E402
from django.apps import apps  # noqa: E402

if not apps.ready and not getattr(apps, "loading", False):
    django.setup()

from django.contrib.auth import get_user_model  # noqa: E402
from django.test import TransactionTestCase  # noqa: E402

from apps.tabdoc.services.document_service import DocumentService  # noqa: E402
from apps.tabtinspace.models import (  # noqa: E402
    Agent,
    Collection,
    ContextItem,
    Space,
    SpaceMembership,
    Organization,
)

User = get_user_model()


def _noop(*args, **kwargs):
    pass


_SIDE_EFFECT_MOCKS = [
    "apps.tabtinspace.services.resource_bridge.ResourceBridge._update_search_vector",
    "apps.tabtinspace.services.resource_bridge.ResourceBridge._emit_signal",
    "apps.tabtinspace.services.resource_bridge.ResourceBridge._push_ws",
    "apps.tabtinspace.services.resource_bridge.ResourceBridge._emit_event_bus",
    "apps.tabdoc.services.document_service.DocumentService._init_description_binary",
    "apps.tabdoc.services.document_service.DocumentService._update_search_vector",
]


def _mock_side_effects(fn):
    for target in reversed(_SIDE_EFFECT_MOCKS):
        fn = patch(target, _noop)(fn)
    return fn


class DocumentCreateCollectionIntegrationTests(TransactionTestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.user = User.objects.create_user(
            email=f"doc_{uuid4().hex[:8]}@tabtin-test.local",
            password="testpass",
        )
        self.organization = Organization.objects.create(
            name="Test Organization",
            owner=self.user,
        )
        self.agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name="Test Agent",
            type="bot",
            is_active=True,
        )
        self.space = Space.objects.create(
            name="Test Space",
            organization=self.organization,
            agent=self.agent,
            type=Space.SpaceType.BOT,
        )
        SpaceMembership.objects.create(
            workspace=self.space,
            user=self.user,
            role="owner",
        )
        self.collection = Collection.objects.create(
            workspace=self.space,
            name="Selected folder",
            order=0,
        )

    @_mock_side_effects
    def test_create_document_binds_context_item_to_collection(self):
        service = DocumentService(user=self.user)

        document = service.create_document(
            organization_id=str(self.organization.id),
            space_id=str(self.space.id),
            parent_id=None,
            collection_id=str(self.collection.id),
            title="Doc in selected folder",
            initial_content_pm_json={},
            initial_content_markdown="",
            initial_content_plaintext="",
        )

        ctx_item = ContextItem.objects.filter(
            workspace_id=self.space.id,
            item_type="tabdoc",
            resource_id=str(document.id),
        ).first()

        assert ctx_item is not None
        assert str(ctx_item.collection_id) == str(self.collection.id)
