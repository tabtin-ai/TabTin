"""
Context sync topic validator regression tests.

覆盖：
- context.sync.{space_id}
- context.sync.organization.{organization_id}
- context.sync.user.{user_id}
"""
import asyncio
import os
import sys
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402
django.setup()

from apps.services.common.ws.handlers.subscription_validators import ContextSyncValidator
from apps.services.common.ws.organization_context import OrganizationContext


def _make_consumer(organization_id=None):
    consumer = MagicMock()
    if organization_id:
        consumer.organization_ctx = OrganizationContext(organization_id, {organization_id})
    else:
        consumer.organization_ctx = OrganizationContext(None, set())
    consumer.organization_id = organization_id
    return consumer


class TestContextSyncValidator:
    def test_allows_space_topic_in_same_organization(self):
        validator = ContextSyncValidator()
        consumer = _make_consumer(str(uuid.uuid4()))
        space_id = str(uuid.uuid4())
        topic = f"context.sync.{space_id}"
        parts = topic.split(".", 2)

        with patch(
            "apps.services.common.ws.handlers.subscription_validators.GitStatusValidator._check_space_organization",
            new_callable=AsyncMock,
            return_value=True,
        ):
            result = asyncio.run(validator.validate(consumer, topic, parts))

        assert result is None

    def test_allows_organization_topic_when_organization_matches(self):
        validator = ContextSyncValidator()
        organization_id = str(uuid.uuid4())
        consumer = _make_consumer(organization_id)
        topic = f"context.sync.organization.{organization_id}"
        parts = topic.split(".", 2)

        result = asyncio.run(validator.validate(consumer, topic, parts))

        assert result is None

    def test_rejects_organization_topic_when_organization_mismatch(self):
        validator = ContextSyncValidator()
        consumer = _make_consumer(str(uuid.uuid4()))
        topic = f"context.sync.organization.{uuid.uuid4()}"
        parts = topic.split(".", 2)

        result = asyncio.run(validator.validate(consumer, topic, parts))

        assert result == "organization mismatch"

    def test_allows_own_user_topic(self):
        validator = ContextSyncValidator()
        user_id = str(uuid.uuid4())
        consumer = _make_consumer(str(uuid.uuid4()))
        consumer.user_id = user_id
        topic = f"context.sync.user.{user_id}"
        parts = topic.split(".", 2)

        result = asyncio.run(validator.validate(consumer, topic, parts))

        assert result is None

    def test_rejects_other_user_topic(self):
        validator = ContextSyncValidator()
        consumer = _make_consumer(str(uuid.uuid4()))
        consumer.user_id = str(uuid.uuid4())
        topic = f"context.sync.user.{uuid.uuid4()}"
        parts = topic.split(".", 2)

        result = asyncio.run(validator.validate(consumer, topic, parts))

        assert result == "user mismatch"
