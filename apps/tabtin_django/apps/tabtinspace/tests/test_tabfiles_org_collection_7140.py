"""#7140：TabFiles 组织级上传接入 Collection —— org collection 成功 / workspace collection 拒。"""
from __future__ import annotations

from uuid import uuid4

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.services.oss.models import FileRecord
from apps.tabtinspace.models import Collection, Device, Organization, OrganizationMember, Workspace
from apps.tabtinspace.services.base import ServiceError
from apps.tabtinspace.services.tabfiles_service import TabFilesService

User = get_user_model()


class TabFilesOrganizationCollectionTests(TestCase):
    databases = {'default', 'postgresql'}

    def setUp(self):
        self.owner = User.objects.db_manager('default').create_user(
            username='i7140-tf-owner',
            email='i7140-tf-owner@test.com',
            password='x',
        )
        self.organization = Organization.objects.create(
            name='I7140 TabFiles Org',
            owner_id=self.owner.id,
            is_default=False,
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.owner,
            role='owner',
        )
        self.service = TabFilesService(user=self.owner)

    def _make_file_record(self, *, upload_user: str = '') -> FileRecord:
        file_id = uuid4()
        return FileRecord.objects.create(
            id=file_id,
            file_name=f'{file_id}.pdf',
            file_key=f'test/7140/{file_id}/file.pdf',
            file_path=f'test/7140/{file_id}/file.pdf',
            file_size=1,
            file_type='document',
            mime_type='application/pdf',
            file_extension='pdf',
            file_hash='a' * 32,
            bucket_name='test',
            upload_user=upload_user or str(self.owner.id),
            organization_id=str(self.organization.id),
            status='completed',
        )

    def _make_workspace(self) -> Workspace:
        suffix = uuid4().hex[:8]
        device = Device.objects.create(
            organization=self.organization,
            user=self.owner,
            name=f'i7140-tf-device-{suffix}',
            device_type='electron',
            role='control',
            fingerprint=f'i7140-tf-{suffix}',
            status='online',
        )
        wd = f'/tmp/i7140-tf-{suffix}'
        return Workspace.objects.create(
            organization=self.organization,
            device=device,
            created_by=self.owner,
            name=f'I7140 TF WS {suffix}',
            working_dir=wd,
            normalized_working_dir=wd,
        )

    def test_upload_to_organization_with_org_collection_succeeds(self):
        collection = Collection.objects.create(
            organization=self.organization,
            parent=None,
            name='Org Folder',
            created_by=self.owner,
        )
        file_record = self._make_file_record()

        item = self.service.upload_to_organization(
            organization_id=self.organization.id,
            file_record_id=file_record.id,
            collection_id=collection.id,
        )

        self.assertIsNotNone(item)
        self.assertEqual(item.organization_id, self.organization.id)
        self.assertEqual(item.collection_id, collection.id)
        self.assertIsNone(item.workspace_id)
        self.assertIsNone(item.project_id)

    def test_upload_to_organization_rejects_workspace_hosted_collection(self):
        workspace = self._make_workspace()
        workspace_collection = Collection.objects.create(
            workspace=workspace, parent=None, name='Workspace Folder',
        )
        file_record = self._make_file_record()

        with self.assertRaises(ServiceError) as ctx:
            self.service.upload_to_organization(
                organization_id=self.organization.id,
                file_record_id=file_record.id,
                collection_id=workspace_collection.id,
            )
        self.assertEqual(ctx.exception.code, 'COLLECTION_NOT_FOUND')

    def test_upload_to_organization_rejects_collection_from_other_org(self):
        other_owner = User.objects.db_manager('default').create_user(
            username='i7140-tf-other-owner',
            email='i7140-tf-other-owner@test.com',
            password='x',
        )
        other_organization = Organization.objects.create(
            name='I7140 TabFiles Other Org',
            owner_id=other_owner.id,
            is_default=False,
        )
        foreign_collection = Collection.objects.create(
            organization=other_organization, parent=None, name='Foreign Org Folder',
        )
        file_record = self._make_file_record()

        with self.assertRaises(ServiceError) as ctx:
            self.service.upload_to_organization(
                organization_id=self.organization.id,
                file_record_id=file_record.id,
                collection_id=foreign_collection.id,
            )
        self.assertEqual(ctx.exception.code, 'COLLECTION_NOT_FOUND')

    def test_archive_from_chat_to_organization_forwards_collection_id(self):
        collection = Collection.objects.create(
            organization=self.organization,
            parent=None,
            name='Chat Archive Folder',
            created_by=self.owner,
        )
        file_record = self._make_file_record()

        item = self.service.archive_from_chat_to_organization(
            organization_id=self.organization.id,
            file_record_id=file_record.id,
            collection_id=collection.id,
        )

        self.assertIsNotNone(item)
        self.assertEqual(item.collection_id, collection.id)

    def test_upload_to_organization_without_collection_id_still_works(self):
        """#6603 既有行为不受影响：不传 collection_id 时正常落根级。"""
        file_record = self._make_file_record()

        item = self.service.upload_to_organization(
            organization_id=self.organization.id,
            file_record_id=file_record.id,
        )

        self.assertIsNotNone(item)
        self.assertIsNone(item.collection_id)

    def test_upload_to_organization_moves_existing_item_into_collection(self):
        """已存在同一 file_record 的 org-only ContextItem 时，补传 collection_id 应更新归属。"""
        file_record = self._make_file_record()
        first = self.service.upload_to_organization(
            organization_id=self.organization.id,
            file_record_id=file_record.id,
        )
        self.assertIsNone(first.collection_id)

        collection = Collection.objects.create(
            organization=self.organization,
            parent=None,
            name='Late Folder',
            created_by=self.owner,
        )
        second = self.service.upload_to_organization(
            organization_id=self.organization.id,
            file_record_id=file_record.id,
            collection_id=collection.id,
        )

        self.assertEqual(second.id, first.id)
        second.refresh_from_db()
        self.assertEqual(second.collection_id, collection.id)
