"""#6805: table.events 鉴权须对齐 HTTP check_table_permission。

回归：
- org-only（space_id=NULL）表：同 org viewer 可订
- 私有 Workspace 表：仅 org 成员、无 Space/ACL → 拒
- 显式 TablePermission：无 SpaceMembership 仍可订
"""

from __future__ import annotations

import asyncio
import uuid
from unittest.mock import AsyncMock

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import SimpleTestCase, TransactionTestCase

from apps.services.common.ws.gateway import GatewayConsumer
from apps.services.common.ws.handlers.subscription_validators import TableEventsValidator
from apps.services.common.ws.organization_context import OrganizationContext
from apps.tabdata.models import Table, TablePermission
from apps.tabdoc.models import Document, DocumentPermission
from apps.tabtinspace.models import Organization, OrganizationMember, SpaceMembership
from apps.users.membership.models import MembershipTier

User = get_user_model()


def _ensure_free_tier() -> None:
    MembershipTier.objects.update_or_create(
        tier_type='free',
        defaults={
            'name': '免费版',
            'description': 'WS table.events 权限测试',
            'max_tables': -1,
            'max_records_per_table': -1,
            'max_api_calls_per_day': -1,
            'max_crawl_tasks_per_day': -1,
            'features': {},
            'sort_order': 0,
            'is_active': True,
        },
    )


def _create_workspace(organization, owner, name):
    from apps.tabtinspace.models import Device, Workspace

    device = Device.objects.create(
        organization=organization,
        user=owner,
        name=f'{name}-设备',
        device_type='electron',
        role='control',
        fingerprint=f'ws-table-access-{uuid.uuid4().hex}',
    )
    working_dir = f'/tmp/ws-table-access-{uuid.uuid4().hex}'
    return Workspace.objects.create(
        organization=organization,
        device=device,
        name=name,
        working_dir=working_dir,
        normalized_working_dir=working_dir,
        created_by=owner,
    )


class TableEventsAccessTests(TransactionTestCase):
    """TransactionTestCase：database_sync_to_async 在线程池执行，须能看见已提交数据。"""

    databases = {'default'}

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
        _ensure_free_tier()
        suffix = uuid.uuid4().hex[:8]
        self.owner = User.objects.create_user(
            username=f'ws_tbl_owner_{suffix}',
            email=f'ws_tbl_owner_{suffix}@example.com',
            password='x',
        )
        self.member = User.objects.create_user(
            username=f'ws_tbl_member_{suffix}',
            email=f'ws_tbl_member_{suffix}@example.com',
            password='x',
        )
        self.outsider = User.objects.create_user(
            username=f'ws_tbl_out_{suffix}',
            email=f'ws_tbl_out_{suffix}@example.com',
            password='x',
        )
        self.organization = Organization.objects.create(
            name=f'WS Table Access Org {suffix}',
            owner=self.owner,
        )
        OrganizationMember.objects.create(
            organization=self.organization, user=self.owner, role='owner',
        )
        OrganizationMember.objects.create(
            organization=self.organization, user=self.member, role='viewer',
        )
        self.private_ws = _create_workspace(
            self.organization, self.owner, f'private-{suffix}',
        )
        SpaceMembership.objects.create(
            workspace=self.private_ws,
            user=self.owner,
            role='owner',
            is_active=True,
        )

    def _consumer(self, user, *, org_ids=None):
        consumer = GatewayConsumer()
        consumer.user = user
        consumer.user_id = str(user.id) if user else None
        ids = org_ids if org_ids is not None else {str(self.organization.id)}
        consumer.organization_ctx = OrganizationContext(
            str(self.organization.id), set(ids),
        )
        return consumer

    def _run(self, coro):
        return asyncio.run(coro)

    def test_org_only_table_allows_org_viewer(self):
        """#6805: space_id=NULL 时同 org viewer 可订 table.events。"""
        table = Table.objects.create(
            organization_id=self.organization.id,
            space_id=None,
            name='org-only-table',
            owner=self.owner,
        )
        consumer = self._consumer(self.member)
        self.assertTrue(
            self._run(consumer._check_table_access(str(table.id))),
        )

    def test_org_only_table_rejects_outsider(self):
        table = Table.objects.create(
            organization_id=self.organization.id,
            space_id=None,
            name='org-only-outsider',
            owner=self.owner,
        )
        consumer = self._consumer(
            self.outsider, org_ids={str(uuid.uuid4())},
        )
        self.assertFalse(
            self._run(consumer._check_table_access(str(table.id))),
        )

    def test_private_workspace_table_rejects_org_member_without_acl(self):
        """私有 Workspace 表不得凭 org 成员越权订阅。"""
        table = Table.objects.create(
            organization_id=self.organization.id,
            space_id=self.private_ws.id,
            name='private-ws-table',
            owner=self.owner,
        )
        consumer = self._consumer(self.member)
        self.assertFalse(
            self._run(consumer._check_table_access(str(table.id))),
        )

    def test_table_permission_grants_access_without_space_membership(self):
        table = Table.objects.create(
            organization_id=self.organization.id,
            space_id=self.private_ws.id,
            name='acl-table',
            owner=self.owner,
        )
        TablePermission.objects.create(
            table=table,
            subject_type='user',
            subject_id=str(self.member.id),
            permission='viewer',
            is_active=True,
            granted_by=str(self.owner.id),
        )
        consumer = self._consumer(self.member)
        self.assertTrue(
            self._run(consumer._check_table_access(str(table.id))),
        )

    def test_embedded_table_inherits_referenced_parent_document_access(self):
        """父文档 editor 可订阅真实内嵌表格，无需冗余 TablePermission。"""
        table = Table.objects.create(
            organization_id=self.organization.id,
            space_id=self.private_ws.id,
            name='embedded-table',
            owner=self.owner,
        )
        parent = Document.objects.create(
            organization_id=self.organization.id,
            space_id=self.private_ws.id,
            owner_id=self.owner.id,
            created_by=self.owner,
            updated_by=self.owner,
            title='embedded-parent',
            description_json={
                'type': 'doc',
                'content': [
                    {'type': 'tabdataBlock', 'attrs': {'tableId': str(table.id)}},
                ],
            },
        )
        DocumentPermission.objects.create(
            document=parent,
            subject_type='user',
            subject_id=str(self.member.id),
            permission='editor',
            is_active=True,
            granted_by=str(self.owner.id),
            created_by=self.owner,
        )
        consumer = self._consumer(self.member)

        self.assertFalse(
            self._run(consumer._check_table_access(str(table.id))),
        )
        self.assertTrue(
            self._run(consumer._check_table_access(
                str(table.id),
                parent_document_id=str(parent.id),
            )),
        )

    def test_embedded_table_rejects_forged_unreferenced_parent_document(self):
        table = Table.objects.create(
            organization_id=self.organization.id,
            space_id=self.private_ws.id,
            name='unreferenced-table',
            owner=self.owner,
        )
        parent = Document.objects.create(
            organization_id=self.organization.id,
            space_id=self.private_ws.id,
            owner_id=self.owner.id,
            created_by=self.owner,
            updated_by=self.owner,
            title='unrelated-parent',
            description_json={'type': 'doc', 'content': []},
        )
        DocumentPermission.objects.create(
            document=parent,
            subject_type='user',
            subject_id=str(self.member.id),
            permission='editor',
            is_active=True,
            granted_by=str(self.owner.id),
            created_by=self.owner,
        )
        consumer = self._consumer(self.member)

        self.assertFalse(
            self._run(consumer._check_table_access(
                str(table.id),
                parent_document_id=str(parent.id),
            )),
        )

    def test_missing_user_id_rejects(self):
        table = Table.objects.create(
            organization_id=self.organization.id,
            space_id=None,
            name='no-user',
            owner=self.owner,
        )
        consumer = self._consumer(self.member)
        consumer.user_id = None
        self.assertFalse(
            self._run(consumer._check_table_access(str(table.id))),
        )


class TableEventsAccessDocstringTests(SimpleTestCase):
    def test_gateway_docstring_mentions_org_only(self):
        self.assertIn('space_id', GatewayConsumer._check_table_access.__doc__ or '')

    def test_validator_passes_topic_parent_context_to_access_check(self):
        topic = 'table.events.table-1'
        consumer = type('Consumer', (), {})()
        consumer._pending_topic_contexts = {
            topic: {'parent_document_id': 'doc-parent'},
        }
        consumer._check_table_organization = AsyncMock(return_value=True)

        error = asyncio.run(
            TableEventsValidator().validate(
                consumer,
                topic,
                ['table', 'events', 'table-1'],
            ),
        )

        self.assertIsNone(error)
        consumer._check_table_organization.assert_awaited_once_with(
            'table-1',
            parent_document_id='doc-parent',
        )
