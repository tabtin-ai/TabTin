"""share.events 订阅校验：须登录 + 有效 sct_* + comment/edit 分享。"""

from __future__ import annotations

import asyncio
import uuid
from types import SimpleNamespace
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import SimpleTestCase, TestCase

from apps.services.common.public_share.collab_token import issue_share_collab_token
from apps.services.common.public_share.exceptions import ShareNotFoundError
from apps.services.common.ws.handlers.subscription_validators import ShareEventsValidator
from apps.tabdoc.models import Document, DocumentShare
from apps.tabdoc.services.share_service import TABDOC_DB
from apps.tabtinspace.models import Organization, Space

User = get_user_model()


class ShareEventsValidatorTests(TestCase):
    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from apps.tabtinspace.signals import create_default_organization
        from apps.users.auth.signals import create_user_profile, save_user_profile

        for handler in (create_default_organization, create_user_profile, save_user_profile):
            try:
                post_save.disconnect(handler, sender=User)
            except Exception:
                pass

    def setUp(self):
        self.owner = User.objects.db_manager(TABDOC_DB).create_user(
            username=f"share_events_owner_{uuid.uuid4().hex[:8]}",
            email=f"share_events_owner_{uuid.uuid4().hex[:8]}@example.com",
            password="x",
        )
        self.organization = Organization.objects.using(TABDOC_DB).create(
            name="Share Events Org",
            owner_id=self.owner.id,
        )
        self.space = Space.objects.using(TABDOC_DB).create(
            organization_id=self.organization.id,
            name="Share Events Space",
            type="team",
        )
        self.document = Document.objects.using(TABDOC_DB).create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            owner_id=self.owner.id,
            title="share events doc",
            description_markdown="x",
            description_plaintext="x",
            description_json={"type": "doc", "content": []},
        )
        self.comment_share = DocumentShare.objects.using(TABDOC_DB).create(
            document=self.document,
            share_type="public",
            permission="comment",
        )
        self.view_share = DocumentShare.objects.using(TABDOC_DB).create(
            document=self.document,
            share_type="public",
            permission="view",
        )
        self.validator = ShareEventsValidator()

    def _run(self, coro):
        return asyncio.run(coro)

    def _consumer(self, *, user_id: str | None, topic: str, token: str | None):
        ctx = {}
        if token:
            ctx[topic] = {"share_collab_token": token}
        return SimpleNamespace(
            user_id=user_id,
            _pending_topic_contexts=ctx,
        )

    def _token(self, share: DocumentShare, *, share_permission: str | None = None) -> str:
        return issue_share_collab_token(
            share_id=share.share_id,
            resource_type="docs",
            resource_id=str(self.document.id),
            share_permission=share_permission or share.permission,
            guest_id=f"share:{share.share_id}:{self.owner.id}",
        )

    def _patch_get_share(self, share: DocumentShare | None = None, *, error: Exception | None = None):
        async def _loader(_share_id: str):
            if error is not None:
                raise error
            return share

        return patch(
            "apps.services.common.ws.handlers.subscription_validators.database_sync_to_async",
            side_effect=lambda _fn: _loader,
        )

    def test_accepts_valid_comment_share_token(self):
        topic = f"share.events.{self.comment_share.share_id}"
        token = self._token(self.comment_share)
        consumer = self._consumer(user_id=str(self.owner.id), topic=topic, token=token)
        with self._patch_get_share(self.comment_share):
            error = self._run(self.validator.validate(consumer, topic, topic.split(".", 2)))
        self.assertIsNone(error)

    def test_rejects_missing_token(self):
        topic = f"share.events.{self.comment_share.share_id}"
        consumer = self._consumer(user_id=str(self.owner.id), topic=topic, token=None)
        error = self._run(self.validator.validate(consumer, topic, topic.split(".", 2)))
        self.assertIsNotNone(error)
        self.assertIn("share_collab_token", error)

    def test_rejects_view_share(self):
        topic = f"share.events.{self.view_share.share_id}"
        token = self._token(self.view_share)
        consumer = self._consumer(user_id=str(self.owner.id), topic=topic, token=token)
        with self._patch_get_share(self.view_share):
            error = self._run(self.validator.validate(consumer, topic, topic.split(".", 2)))
        self.assertIsNotNone(error)
        self.assertIn("commenting", error.lower())

    def test_rejects_share_id_mismatch(self):
        topic = f"share.events.{self.comment_share.share_id}"
        token = self._token(self.view_share)
        consumer = self._consumer(user_id=str(self.owner.id), topic=topic, token=token)
        error = self._run(self.validator.validate(consumer, topic, topic.split(".", 2)))
        self.assertIsNotNone(error)
        self.assertIn("mismatch", error.lower())

    def test_rejects_unauthenticated(self):
        topic = f"share.events.{self.comment_share.share_id}"
        token = self._token(self.comment_share)
        consumer = self._consumer(user_id=None, topic=topic, token=token)
        error = self._run(self.validator.validate(consumer, topic, topic.split(".", 2)))
        self.assertIsNotNone(error)
        self.assertIn("authenticated", error.lower())

    def test_rejects_token_user_mismatch(self):
        topic = f"share.events.{self.comment_share.share_id}"
        token = issue_share_collab_token(
            share_id=self.comment_share.share_id,
            resource_type="docs",
            resource_id=str(self.document.id),
            share_permission="comment",
            guest_id=f"share:{self.comment_share.share_id}:{uuid.uuid4()}",
        )
        consumer = self._consumer(user_id=str(self.owner.id), topic=topic, token=token)
        error = self._run(self.validator.validate(consumer, topic, topic.split(".", 2)))
        self.assertIsNotNone(error)
        self.assertIn("user mismatch", error.lower())

    def test_rejects_missing_share(self):
        topic = f"share.events.{self.comment_share.share_id}"
        token = self._token(self.comment_share)
        consumer = self._consumer(user_id=str(self.owner.id), topic=topic, token=token)
        with self._patch_get_share(error=ShareNotFoundError("gone")):
            error = self._run(self.validator.validate(consumer, topic, topic.split(".", 2)))
        self.assertIsNotNone(error)
        self.assertIn("not found", error.lower())


class ShareEventsCapabilityRegistrationTests(SimpleTestCase):
    def test_resolve_validator_registers_share_events(self):
        from apps.services.common.ws.handlers.subscription_validators import resolve_validator
        from apps.services.common.ws.protocol import resolve_required_capability

        topic = "share.events.some-share-id"
        self.assertEqual(resolve_required_capability(topic), "share.events")
        self.assertIsInstance(resolve_validator(topic), ShareEventsValidator)
