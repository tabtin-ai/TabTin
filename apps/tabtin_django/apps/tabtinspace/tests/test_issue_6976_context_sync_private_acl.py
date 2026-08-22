"""#6976：云盘私有资源 context.sync 扇出到用户 topic，不写组织 topic。"""
from __future__ import annotations

import os
import sys
from unittest.mock import MagicMock, patch

import pytest

django_root = os.path.abspath(
    os.path.join(os.path.dirname(__file__), os.pardir, os.pardir, os.pardir, os.pardir)
)
if django_root not in sys.path:
    sys.path.insert(0, django_root)
if "DJANGO_SETTINGS_MODULE" not in os.environ:
    os.environ["DJANGO_SETTINGS_MODULE"] = "tabtin.settings"

import django
from django.apps import apps

if not apps.ready:
    django.setup()


class TestContextSyncPublisherHelpers:
    def test_permission_change_is_sent_only_to_affected_user(self):
        from apps.tabtinspace.services.context_sync_publisher import (
            publish_resource_access_changed,
        )

        published = []

        def capture_publish(envelope, users, *, using=None):
            published.append((dict(envelope), users, using))

        with (
            patch(
                "apps.tabtinspace.services.context_sync_publisher._intersect_org_members",
                side_effect=lambda user_ids, _organization_id: {str(user_id) for user_id in user_ids},
            ),
            patch(
                "apps.tabtinspace.services.context_sync_publisher._schedule_publish",
                side_effect=capture_publish,
            ),
        ):
            publish_resource_access_changed(
                resource_type="tabdoc",
                resource_id="doc-1",
                organization_id="org-1",
                user_ids=["receiver-1"],
                actor_user_id="owner-1",
                space_id="space-1",
                db_alias="postgresql",
            )

        assert published == [(
            {
                "type": "resource_access_changed",
                "resource_type": "tabdoc",
                "resource_id": "doc-1",
                "space_id": "space-1",
                "organization_id": "org-1",
                "user_id": "owner-1",
            },
            ["receiver-1"],
            "postgresql",
        )]

    def test_permission_change_keeps_cross_organization_acl_recipient(self):
        """私信资源卡允许跨组织协作，ACL 目标不能被组织成员交集过滤。"""
        from apps.tabtinspace.services.context_sync_publisher import (
            publish_resource_access_changed,
        )

        published = []

        def capture_publish(envelope, users, *, using=None):
            published.append((dict(envelope), users, using))

        with (
            patch(
                "apps.tabtinspace.services.context_sync_publisher._intersect_org_members",
                return_value=set(),
            ),
            patch(
                "apps.tabtinspace.services.context_sync_publisher._schedule_publish",
                side_effect=capture_publish,
            ),
        ):
            publish_resource_access_changed(
                resource_type="tabdoc",
                resource_id="doc-1",
                organization_id="resource-org",
                user_ids=["cross-org-receiver"],
                actor_user_id="owner-1",
                space_id="space-1",
                db_alias="postgresql",
            )

        assert published == [(
            {
                "type": "resource_access_changed",
                "resource_type": "tabdoc",
                "resource_id": "doc-1",
                "space_id": "space-1",
                "organization_id": "resource-org",
                "user_id": "owner-1",
            },
            ["cross-org-receiver"],
            "postgresql",
        )]

    def test_should_drop_leaked_cloud_on_org_topic(self):
        from apps.tabtinspace.services.context_sync_publisher import (
            should_drop_leaked_cloud_context_sync,
        )

        assert should_drop_leaked_cloud_context_sync(
            {
                "_topic": "context.sync.organization.org-1",
                "type": "resource_created",
                "resource_type": "tabdoc",
                "resource_id": "doc-1",
                "title": "secret",
            }
        )
        assert should_drop_leaked_cloud_context_sync(
            {
                "_topic": "context.sync.space-1",
                "type": "resource_updated",
                "resource_type": "tabdata",
                "resource_id": "t-1",
            }
        )

    def test_allow_user_topic_and_non_cloud(self):
        from apps.tabtinspace.services.context_sync_publisher import (
            should_drop_leaked_cloud_context_sync,
        )

        assert not should_drop_leaked_cloud_context_sync(
            {
                "_topic": "context.sync.user.user-1",
                "type": "resource_created",
                "resource_type": "tabdoc",
                "resource_id": "doc-1",
            }
        )
        assert not should_drop_leaked_cloud_context_sync(
            {
                "_topic": "context.sync.organization.org-1",
                "type": "resource_created",
                "resource_type": "tabsite",
                "resource_id": "site-1",
            }
        )
        assert not should_drop_leaked_cloud_context_sync(
            {
                "_topic": "context.sync.organization.org-1",
                "type": "items_moved",
                "space_id": "space-1",
            }
        )


class TestResourceBridgeCloudFanout:
    @patch("apps.tabtinspace.services.resource_bridge.ResourceBridge._validate_resource")
    def test_cloud_resource_publishes_only_user_topics(self, _mock_validate):
        from apps.tabtinspace.services.resource_bridge import ResourceBridge
        from apps.tabtinspace.tests.test_tsi005_006_resource_bridge_ws import FakeResource

        org_id = "11111111-1111-1111-1111-111111111111"
        resource = FakeResource(context_type="tabdoc", organization_id=org_id, space_id="space-1")
        published = []

        def capture_ws(topic, envelope):
            published.append((topic, dict(envelope)))
            return True

        with (
            patch(
                "apps.tabtinspace.services.context_sync_publisher.resolve_cloud_resource_recipient_user_ids",
                return_value={"owner-1", "viewer-2"},
            ),
            patch(
                "apps.tabtinspace.services.context_sync_publisher._intersect_org_members",
                side_effect=lambda user_ids, organization_id: {str(u) for u in user_ids},
            ),
            patch(
                "apps.services.common.ws.bus.publish_ws_event",
                side_effect=capture_ws,
            ),
            patch("apps.services.common.ws.protocol.ContextSyncEvent") as mock_proto,
        ):
            mock_proto.PREFIX = "context.sync"
            ResourceBridge._push_ws(resource, "created", None)

        topics = sorted(topic for topic, _ in published)
        assert topics == [
            "context.sync.user.owner-1",
            "context.sync.user.viewer-2",
        ]
        for topic, envelope in published:
            assert envelope["type"] == "resource_created"
            assert envelope["resource_type"] == "tabdoc"
            assert "title" in envelope

    @patch("apps.tabtinspace.services.resource_bridge.ResourceBridge._validate_resource")
    def test_non_cloud_still_broadcasts_space_and_org(self, _mock_validate):
        from apps.tabtinspace.services.resource_bridge import ResourceBridge
        from apps.tabtinspace.tests.test_tsi005_006_resource_bridge_ws import FakeResource

        resource = FakeResource(context_type="tabsite", organization_id="org-1", space_id="space-1")
        published = []

        def capture_ws(topic, envelope):
            published.append(topic)
            return True

        with (
            patch("apps.services.common.ws.bus.publish_ws_event", side_effect=capture_ws),
            patch("apps.services.common.ws.protocol.ContextSyncEvent") as mock_proto,
        ):
            mock_proto.PREFIX = "context.sync"
            ResourceBridge._push_ws(resource, "updated", None)

        assert published == [
            "context.sync.space-1",
            "context.sync.organization.org-1",
        ]


class TestContextSyncUserTopicValidator:
    def test_allows_own_user_topic(self):
        import asyncio
        import uuid

        from apps.services.common.ws.handlers.subscription_validators import (
            ContextSyncValidator,
        )

        validator = ContextSyncValidator()
        user_id = str(uuid.uuid4())
        consumer = MagicMock()
        consumer.user_id = user_id
        topic = f"context.sync.user.{user_id}"
        parts = topic.split(".", 2)
        assert asyncio.run(validator.validate(consumer, topic, parts)) is None

    def test_rejects_other_user_topic(self):
        import asyncio
        import uuid

        from apps.services.common.ws.handlers.subscription_validators import (
            ContextSyncValidator,
        )

        validator = ContextSyncValidator()
        consumer = MagicMock()
        consumer.user_id = str(uuid.uuid4())
        topic = f"context.sync.user.{uuid.uuid4()}"
        parts = topic.split(".", 2)
        assert asyncio.run(validator.validate(consumer, topic, parts)) == "user mismatch"


class TestGatewayFailClosed:
    def test_drop_helper_used_by_gateway(self):
        from apps.services.common.ws.gateway import GatewayConsumer

        dropped = GatewayConsumer._should_drop_leaked_cloud_context_sync(
            {
                "_topic": "context.sync.organization.org-1",
                "type": "resource_created",
                "resource_type": "tabfiles",
                "resource_id": "f-1",
            }
        )
        assert dropped is True

        kept = GatewayConsumer._should_drop_leaked_cloud_context_sync(
            {
                "_topic": "context.sync.user.u-1",
                "type": "resource_access_revoked",
                "resource_type": "tabfiles",
                "resource_id": "f-1",
            }
        )
        assert kept is False
