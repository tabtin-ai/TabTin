"""
附件服务单元测试
"""
import json
from unittest.mock import MagicMock, patch
from django.db import transaction
from django.db.utils import OperationalError
from django.test import TestCase, override_settings, SimpleTestCase
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from uuid import UUID, uuid4

from apps.tabtinspace.models import Organization, OrganizationMember, Project
from apps.tabdata.models import (
    Table,
    TableField,
    TableRecord,
    TablePermission,
    AttachmentUpload,
    AttachmentReference,
    RecordHistory,
    RecordHistoryItem,
)
from apps.tabdata.api_attachment import resolve_attachment_access
from apps.tabdata.api_open_storage import (
    storage_download_impl,
    storage_file_info_impl,
    storage_list_impl,
    storage_upload_impl,
)
from apps.tabdata.services.attachment_service import AttachmentService
from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.services.oss.models import FileRecord, UploadTask


class AttachmentServiceTest(TestCase):
    """验证附件上传、复用与清理能力"""
    databases = ['default', 'postgresql']

    def setUp(self):
        User = get_user_model()
        self.user = User.objects.create_user(
            username='attachment-user',
            email='attachment@example.com',
            password='testpass123'
        )
        self.organization = Organization.objects.create(
            name='附件工作区',
            owner=self.user
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.user,
            role='owner',
        )
        self.space = Project.objects.create(
            name='附件项目',
            organization=self.organization
        )
        self.table = Table.objects.create(
            name='附件表格',
            space_id=self.space.id,
            organization_id=self.space.organization_id,
            owner=self.user
        )
        self.field = TableField.objects.create(
            table=self.table,
            name='附件',
            field_type='attachment'
        )
        self.record = TableRecord.objects.create(
            table=self.table,
            data={},
            created_by=self.user,
            updated_by=self.user
        )

        self.service = AttachmentService(user=self.user)

        self.mock_oss = MagicMock()
        self.mock_oss.init_multipart_upload.return_value = {
            'success': True,
            'data': {'upload_id': 'UPLOAD123'}
        }
        self.mock_oss.upload_part.return_value = {
            'success': True,
            'data': {'etag': 'ETAG-PART'}
        }
        self.mock_oss.complete_multipart_upload.return_value = {
            'success': True,
            'data': {
                'etag': 'ETAG-FILE',
                'access_url': 'https://oss.example.com/tabdata/file.pdf'
            }
        }
        self.mock_oss.get_file_info.return_value = {
            'success': True,
            'data': {
                'content_length': 11,
                'content_type': 'application/pdf',
                'access_url': 'https://oss.example.com/tabdata/file.pdf'
            }
        }
        self.mock_oss.set_object_public_read.return_value = True
        self.mock_oss.set_object_private.return_value = True
        self.mock_oss.delete_file.return_value = {'success': True}
        self.mock_oss.abort_multipart_upload.return_value = {'success': True}
        self.mock_oss.config = {'bucket_name': 'test-bucket', 'access_mode': 'private'}

    @patch('apps.tabdata.services.attachment_service.resolve_authorized_file')
    def test_collaborator_can_refresh_private_attachment_from_exact_cell_context(
        self,
        mock_resolve_authorized_file,
    ):
        """合法协作者可用 file_id + 单元格上下文刷新上传者的私有附件。"""
        collaborator = get_user_model().objects.create_user(
            username='attachment-collaborator',
            email='attachment-collaborator@example.com',
            password='testpass123',
        )
        TablePermission.objects.create(
            table=self.table,
            subject_type='user',
            subject_id=str(collaborator.id),
            permission='viewer',
            granted_by=str(self.user.id),
        )
        file_record = FileRecord.objects.create(
            file_name='private-collaboration.pdf',
            file_key='tabdata/test/private-collaboration.pdf',
            file_path='tabdata/test',
            file_size=512,
            file_type='document',
            mime_type='application/pdf',
            file_extension='pdf',
            file_hash='HASH-PRIVATE-COLLABORATION',
            bucket_name='test-bucket',
            is_public=False,
            upload_user=str(self.user.id),
            organization_id=self.organization.id,
            status='completed',
        )
        reference = AttachmentReference.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            table=self.table,
            field=self.field,
            record=self.record,
            file_id=file_record.id,
            created_by=self.user,
            permission_scope={},
            usage_metadata={},
        )
        mock_resolve_authorized_file.return_value = MagicMock(
            url='https://oss.example.com/private-collaboration.pdf?sig=fresh',
            expires_in=3600,
        )

        result = resolve_attachment_access(
            request=MagicMock(auth=collaborator),
            data=MagicMock(
                file_id=file_record.id,
                table_id=self.table.id,
                field_id=self.field.id,
                record_id=self.record.id,
                reference_id=None,
            ),
        )

        self.assertEqual(
            result['data'],
            {
                'reference_id': str(reference.id),
                'file_id': str(file_record.id),
                'url': 'https://oss.example.com/private-collaboration.pdf?sig=fresh',
                'expires_in': 3600,
            },
        )
        self.assertTrue(
            AttachmentService(user=collaborator).can_access_existing_reference(file_record),
        )

    def test_user_without_table_permission_cannot_refresh_private_attachment(self):
        outsider = get_user_model().objects.create_user(
            username='attachment-outsider',
            email='attachment-outsider@example.com',
            password='testpass123',
        )

        result = resolve_attachment_access(
            request=MagicMock(auth=outsider),
            data=MagicMock(
                file_id=uuid4(),
                table_id=self.table.id,
                field_id=self.field.id,
                record_id=self.record.id,
                reference_id=None,
            ),
        )

        payload = json.loads(result.content)
        self.assertFalse(payload['success'])
        self.assertEqual(payload['code'], 'PERMISSION_DENIED')

    @patch('apps.tabdata.services.attachment_service.resolve_authorized_file')
    def test_cross_organization_private_file_is_not_signed_from_dirty_reference(
        self,
        mock_resolve_authorized_file,
    ):
        other_organization = Organization.objects.create(
            name='附件换签其他组织',
            owner=self.user,
        )
        file_record = FileRecord.objects.create(
            file_name='cross-org-private.pdf',
            file_key='tabdata/other/cross-org-private.pdf',
            file_path='tabdata/other',
            file_size=512,
            file_type='document',
            mime_type='application/pdf',
            file_extension='pdf',
            file_hash='HASH-CROSS-ORG-ACCESS-URL',
            bucket_name='test-bucket',
            is_public=False,
            upload_user=str(self.user.id),
            organization_id=other_organization.id,
            status='completed',
        )
        AttachmentReference.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            table=self.table,
            field=self.field,
            record=self.record,
            file_id=file_record.id,
            created_by=self.user,
            permission_scope={},
            usage_metadata={},
        )

        result = resolve_attachment_access(
            request=MagicMock(auth=self.user),
            data=MagicMock(
                file_id=file_record.id,
                table_id=self.table.id,
                field_id=self.field.id,
                record_id=self.record.id,
                reference_id=None,
            ),
        )

        payload = json.loads(result.content)
        self.assertFalse(payload['success'])
        self.assertEqual(payload['code'], 'NOT_FOUND')
        mock_resolve_authorized_file.assert_not_called()
        self.assertFalse(self.service.can_access_existing_reference(file_record))

    @patch('apps.tabdata.services.attachment_service.get_oss_service')
    def test_upload_and_complete_attachment(self, mock_get_service):
        """完整的上传-完成流程应创建文件记录和引用，并写入记录数据"""
        mock_get_service.return_value = self.mock_oss

        task = self.service.create_upload_task(
            table_id=self.table.id,
            field_id=self.field.id,
            record_id=self.record.id,
            files=[{
                'file_name': '说明文档.pdf',
                'file_size': 11,
                'mime_type': 'application/pdf'
            }]
        )

        task_id = UUID(task['task_id'])
        upload_item_id = UUID(task['files'][0]['upload_item_id'])

        chunk = SimpleUploadedFile('part.bin', b'hello world', content_type='application/octet-stream')
        part_resp = self.service.upload_part(task_id, upload_item_id, 1, chunk)
        self.assertEqual(part_resp['completed_parts'], 1)

        complete = self.service.complete_upload(task_id, upload_item_id)
        self.assertIsNotNone(complete['file_id'])
        self.assertEqual(complete['status'], 'completed')
        self.assertIsNotNone(complete['reference'])

        file_record = FileRecord.objects.get(id=complete['file_id'])
        self.assertEqual(file_record.file_name, '说明文档.pdf')
        self.assertFalse(file_record.is_public)
        self.mock_oss.set_object_public_read.assert_not_called()
        self.mock_oss.set_object_private.assert_called_once_with(file_record.file_key)
        self.mock_oss.generate_presigned_url.assert_any_call(
            file_record.file_key,
            expiration=3600,
            method='GET',
        )

        reference = AttachmentReference.objects.get(id=complete['reference']['reference_id'])
        self.assertFalse(reference.is_deleted)

        # complete_upload only creates the stable reference. The client writes
        # that reference into the cell through the normal update_record path,
        # avoiding the historical double-write race.
        self.record.refresh_from_db()
        self.assertIsNone(self.record.data.get(str(self.field.id)))
        self.assertFalse(RecordHistory.objects.filter(record=self.record, action='update').exists())

    @patch(
        'apps.tabdata.services.attachment_service.'
        'OrganizationStorageBillingService.assert_storage_upload_allowed',
    )
    @patch('apps.tabdata.services.attachment_service.get_oss_service')
    def test_create_upload_task_aborts_multipart_when_transaction_rolls_back(
        self,
        mock_get_service,
        _mock_storage_allowed,
    ):
        """事务退出时发生写争用，必须先补偿 OSS 副作用再允许客户端重试。"""
        mock_get_service.return_value = self.mock_oss
        initial_task_count = UploadTask.objects.using(TABDATA_DB_ALIAS).count()
        transactional_impl = AttachmentService._create_upload_task_transactional.__wrapped__

        db_cause = RuntimeError('canceling statement due to lock timeout')
        db_cause.pgcode = '55P03'
        lock_error = OperationalError('attachment upload task commit failed')
        lock_error.__cause__ = db_cause

        def fail_when_transaction_exits(**kwargs):
            with transaction.atomic(using=TABDATA_DB_ALIAS):
                transactional_impl(self.service, **kwargs)
                raise lock_error

        with patch.object(
            self.service,
            '_create_upload_task_transactional',
            side_effect=fail_when_transaction_exits,
        ):
            with self.assertRaises(OperationalError) as raised:
                self.service.create_upload_task(
                    table_id=self.table.id,
                    field_id=self.field.id,
                    record_id=self.record.id,
                    files=[{
                        'file_name': 'write-contention.pdf',
                        'file_size': 11,
                        'mime_type': 'application/pdf',
                    }],
                )

        self.assertIs(raised.exception, lock_error)
        self.mock_oss.abort_multipart_upload.assert_called_once()
        abort_object_key, abort_upload_id = self.mock_oss.abort_multipart_upload.call_args.args
        self.assertIn('write-contention', abort_object_key)
        self.assertEqual(abort_upload_id, 'UPLOAD123')
        self.assertEqual(
            UploadTask.objects.using(TABDATA_DB_ALIAS).count(),
            initial_task_count,
        )
        self.assertFalse(
            AttachmentUpload.objects.using(TABDATA_DB_ALIAS).filter(
                upload_id='UPLOAD123',
            ).exists(),
        )

    @patch('apps.tabdata.services.attachment_service.get_oss_service')
    def test_create_upload_task_hides_retryable_error_when_multipart_abort_fails(
        self,
        mock_get_service,
    ):
        """补偿失败时降级为普通错误，禁止客户端继续重放 POST。"""
        self.mock_oss.abort_multipart_upload.return_value = {
            'success': False,
            'message': 'abort unavailable',
        }
        mock_get_service.return_value = self.mock_oss

        db_cause = RuntimeError('canceling statement due to lock timeout')
        db_cause.pgcode = '55P03'
        lock_error = OperationalError('attachment upload task commit failed')
        lock_error.__cause__ = db_cause

        def fail_after_multipart_init(**kwargs):
            kwargs['initialized_multipart_uploads'].append(
                ('tabdata/write-contention.pdf', 'UPLOAD123'),
            )
            raise lock_error

        with patch.object(
            self.service,
            '_create_upload_task_transactional',
            side_effect=fail_after_multipart_init,
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                'OSS multipart 补偿未完成',
            ) as raised:
                self.service.create_upload_task(
                    table_id=self.table.id,
                    field_id=self.field.id,
                    record_id=self.record.id,
                    files=[{
                        'file_name': 'write-contention.pdf',
                        'file_size': 11,
                        'mime_type': 'application/pdf',
                    }],
                )

        self.assertIs(raised.exception.__cause__, lock_error)
        self.mock_oss.abort_multipart_upload.assert_called_once_with(
            'tabdata/write-contention.pdf',
            'UPLOAD123',
        )

    @patch(
        'apps.tabdata.services.attachment_service.'
        'OrganizationStorageBillingService.assert_storage_upload_allowed',
    )
    @patch('apps.tabdata.services.attachment_service.get_oss_service')
    def test_complete_upload_keeps_declared_mime_when_storage_returns_generic_type(
        self,
        mock_get_service,
        _mock_storage_allowed,
    ):
        """本地存储返回 octet-stream 时，文件记录仍应保留客户端声明的图片类型。"""
        self.mock_oss.get_file_info.return_value['data'].update({
            'content_type': 'application/octet-stream',
            'access_url': 'https://oss.example.com/tabdata/image.jpg',
        })
        mock_get_service.return_value = self.mock_oss

        task = self.service.create_upload_task(
            table_id=self.table.id,
            field_id=self.field.id,
            record_id=self.record.id,
            files=[{
                'file_name': 'image.jpg',
                'file_size': 11,
                'mime_type': 'image/jpeg',
            }],
        )
        task_id = UUID(task['task_id'])
        upload_item_id = UUID(task['files'][0]['upload_item_id'])
        chunk = SimpleUploadedFile(
            'part.bin',
            b'hello world',
            content_type='application/octet-stream',
        )
        self.service.upload_part(task_id, upload_item_id, 1, chunk)

        complete = self.service.complete_upload(task_id, upload_item_id)

        file_record = FileRecord.objects.get(id=complete['file_id'])
        self.assertEqual(file_record.mime_type, 'image/jpeg')

    @override_settings(
        ASSET_PUBLIC_DOMAIN='https://assets.example.test',
        SERVICES_OSS_PROVIDER='aliyun',
    )
    def test_reference_payload_uses_public_asset_url_for_public_files(self):
        """公开附件返回统一公共资产域名，不透出可能 403 的原始 OSS URL"""
        file_record = FileRecord.objects.create(
            file_name='image.png',
            file_key='tabdata/test/public-image.png',
            file_path='tabdata/test',
            file_size=1024,
            file_type='image',
            mime_type='image/png',
            file_extension='png',
            file_hash='HASH-PUBLIC',
            bucket_name='test-bucket',
            access_url='https://oss.example.com/tabdata/test/public-image.png',
            is_public=True,
            status='completed',
        )
        reference = AttachmentReference.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            table=self.table,
            field=self.field,
            record=self.record,
            file_id=file_record.id,
            created_by=self.user,
            permission_scope={},
            usage_metadata={},
        )

        payload = self.service._reference_to_payload(reference)

        self.assertEqual(
            payload['url'],
            'https://assets.example.test/tabdata/test/public-image.png',
        )

    @patch('apps.services.oss.services.file_access.get_oss_service')
    def test_reference_payload_signs_private_file_at_read_time(self, mock_get_service):
        """成员读取附件引用时动态换签，数据库只保留稳定 file_id。"""
        oss = MagicMock()
        oss.generate_presigned_url.return_value = (
            'https://oss.example.com/tabdata/test/private-image.png?sig=short'
        )
        mock_get_service.return_value = oss
        file_record = FileRecord.objects.create(
            file_name='private-image.png',
            file_key='tabdata/test/private-image.png',
            file_path='tabdata/test',
            file_size=1024,
            file_type='image',
            mime_type='image/png',
            file_extension='png',
            file_hash='HASH-PRIVATE',
            bucket_name='test-bucket',
            access_url='https://oss.example.com/tabdata/test/private-image.png',
            is_public=False,
            status='completed',
        )
        reference = AttachmentReference.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            table=self.table,
            field=self.field,
            record=self.record,
            file_id=file_record.id,
            created_by=self.user,
            permission_scope={},
            usage_metadata={},
        )

        payload = self.service._reference_to_payload(reference)

        self.assertEqual(
            payload['url'],
            'https://oss.example.com/tabdata/test/private-image.png?sig=short',
        )
        file_record.refresh_from_db()
        self.assertNotIn('sig=', file_record.access_url)

    @patch('apps.services.oss.services.file_access.get_oss_service')
    def test_sync_private_attachment_never_persists_signed_url(self, mock_get_service):
        oss = MagicMock()
        oss.generate_presigned_url.return_value = (
            'https://oss.example.com/tabdata/test/private-sync.png?sig=short'
        )
        mock_get_service.return_value = oss
        file_record = FileRecord.objects.create(
            file_name='private-sync.png',
            file_key='tabdata/test/private-sync.png',
            file_path='tabdata/test',
            file_size=1024,
            file_type='image',
            mime_type='image/png',
            file_extension='png',
            file_hash='HASH-PRIVATE-SYNC',
            bucket_name='test-bucket',
            access_url='https://oss.example.com/tabdata/test/private-sync.png',
            is_public=False,
            status='completed',
        )
        reference = AttachmentReference.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            table=self.table,
            field=self.field,
            record=self.record,
            file_id=file_record.id,
            created_by=self.user,
            permission_scope={},
            usage_metadata={'source': 'sync'},
        )
        self.record.data = {
            str(self.field.id): [{
                'file_id': str(file_record.id),
                'reference_id': str(reference.id),
                'name': file_record.file_name,
                'url': 'https://oss.example.com/tabdata/test/private-sync.png?sig=short',
            }],
        }
        self.record.save(update_fields=['data'])

        self.service.sync_record_attachments(self.record)

        self.record.refresh_from_db()
        persisted = self.record.data[str(self.field.id)][0]
        self.assertEqual(persisted['file_id'], str(file_record.id))
        self.assertEqual(persisted['url'], '')
        oss.generate_presigned_url.assert_not_called()

    def test_sync_claims_orphan_reference_when_record_data_uses_hex_field_key(self):
        """协作落库用 field.id.hex；sync 必须能认领 record=null 的 orphan 引用。"""
        file_record = FileRecord.objects.create(
            file_name='orphan-hex.png',
            file_key='tabdata/test/orphan-hex.png',
            file_path='tabdata/test',
            file_size=128,
            file_type='image',
            mime_type='image/png',
            file_extension='png',
            file_hash='HASH-ORPHAN-HEX',
            bucket_name='test-bucket',
            is_public=False,
            status='completed',
            organization_id=self.organization.id,
            upload_user=str(self.user.id),
        )
        orphan = AttachmentReference.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            table=self.table,
            field=self.field,
            record=None,
            file_id=file_record.id,
            created_by=self.user,
            permission_scope={},
            usage_metadata={'source': 'upload_complete'},
        )
        self.record.data = {
            self.field.id.hex: [{
                'file_id': str(file_record.id),
                'reference_id': str(orphan.id),
                'name': file_record.file_name,
            }],
        }
        self.record.save(update_fields=['data'])

        self.service.sync_record_attachments(self.record)

        orphan.refresh_from_db()
        self.assertEqual(orphan.record_id, self.record.id)
        self.assertFalse(orphan.is_deleted)

    @patch('apps.tabdata.services.attachment_service.emit_record_history_event')
    def test_sync_normalization_does_not_emit_competing_history_event(self, mock_emit_history):
        """记录更新已负责历史时，附件引用规范化不能再写一条同字段历史。"""
        file_record = FileRecord.objects.create(
            file_name='history-normalization.png',
            file_key='tabdata/test/history-normalization.png',
            file_path='tabdata/test',
            file_size=128,
            file_type='image',
            mime_type='image/png',
            file_extension='png',
            file_hash='HASH-HISTORY-NORMALIZATION',
            bucket_name='test-bucket',
            is_public=False,
            status='completed',
            organization_id=self.organization.id,
            upload_user=str(self.user.id),
        )
        reference = AttachmentReference.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            table=self.table,
            field=self.field,
            record=self.record,
            file_id=file_record.id,
            created_by=self.user,
            permission_scope={},
            usage_metadata={'source': 'upload_complete'},
        )
        self.record.data = {
            self.field.id.hex: [{
                'file_id': str(file_record.id),
                'reference_id': str(reference.id),
                'name': file_record.file_name,
                'url': 'https://oss.example.com/tabdata/test/history-normalization.png?sig=short',
            }],
        }
        self.record.save(update_fields=['data'])

        self.service.sync_record_attachments(self.record)

        mock_emit_history.assert_not_called()

    @override_settings(
        ASSET_PUBLIC_DOMAIN='https://assets.example.test',
        SERVICES_OSS_PROVIDER='aliyun',
    )
    @patch('apps.tabdata.api_open_storage.get_oss_service')
    def test_public_file_download_returns_long_lived_asset_url(self, mock_get_service):
        """公开附件下载返回长期公共资产 URL，而不是短期签名 URL"""
        file_record = FileRecord.objects.create(
            file_name='shared.pdf',
            file_key='tabdata/test/shared.pdf',
            file_path='tabdata/test',
            file_size=2048,
            file_type='document',
            mime_type='application/pdf',
            file_extension='pdf',
            file_hash='HASH-DOWNLOAD',
            bucket_name='test-bucket',
            access_url='https://oss.example.com/tabdata/test/shared.pdf',
            is_public=True,
            status='completed',
        )
        AttachmentReference.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            table=self.table,
            field=self.field,
            record=self.record,
            file_id=file_record.id,
            created_by=self.user,
            permission_scope={},
            usage_metadata={},
        )

        result = storage_download_impl(
            request=MagicMock(auth=self.user),
            table_id=self.table.id,
            file_id=file_record.id,
        )

        self.assertTrue(result['success'])
        self.assertEqual(
            result['data']['download_url'],
            'https://assets.example.test/tabdata/test/shared.pdf',
        )
        self.assertIsNone(result['data']['expires_in'])
        mock_get_service.assert_not_called()

    @patch('apps.services.billing.services.OrganizationStorageBillingService.assert_storage_upload_allowed')
    @patch('apps.tabdata.api_open_storage.get_oss_service')
    def test_open_storage_upload_creates_private_file_and_returns_temporary_url(
        self,
        mock_get_service,
        _mock_assert_quota,
    ):
        oss = MagicMock()
        oss.config = {'bucket_name': 'test-bucket', 'access_mode': 'private'}
        oss.upload_file.return_value = {
            'success': True,
            'data': {
                'access_url': 'https://oss.example.com/tabdata/private-image.jpg',
                'cdn_url': '',
            },
        }
        oss.generate_presigned_url.return_value = 'https://oss.example.com/tabdata/private-image.jpg?sig=short'
        mock_get_service.return_value = oss

        result = storage_upload_impl(
            request=MagicMock(auth=self.user),
            table_id=self.table.id,
            field_id=str(self.field.id),
            file=SimpleUploadedFile('private-image.jpg', b'jpeg-bytes', content_type='image/jpeg'),
            record_id=str(self.record.id),
        )

        self.assertTrue(result['success'])
        file_record = FileRecord.objects.get(id=result['data']['file_id'])
        self.assertFalse(file_record.is_public)
        self.assertEqual(
            result['data']['access_url'],
            'https://oss.example.com/tabdata/private-image.jpg?sig=short',
        )
        self.assertEqual(result['data']['expires_in'], 3600)
        oss.set_object_public_read.assert_not_called()
        oss.set_object_private.assert_called_once_with(file_record.file_key)

    @patch('apps.tabdata.api_open_storage.get_oss_service')
    def test_open_storage_list_and_info_keep_private_access_url_usable(self, mock_get_service):
        """旧 Open API 客户端继续从 access_url 获取可用的私有附件短链。"""
        oss = MagicMock()
        oss.generate_presigned_url.return_value = (
            'https://oss.example.com/tabdata/private-list.pdf?sig=short'
        )
        mock_get_service.return_value = oss
        file_record = FileRecord.objects.create(
            file_name='private-list.pdf',
            file_key='tabdata/test/private-list.pdf',
            file_path='tabdata/test',
            file_size=2048,
            file_type='document',
            mime_type='application/pdf',
            file_extension='pdf',
            file_hash='HASH-PRIVATE-LIST',
            bucket_name='test-bucket',
            access_url='https://oss.example.com/tabdata/private-list.pdf',
            cdn_url='https://cdn.example.com/tabdata/private-list.pdf',
            is_public=False,
            organization_id=self.organization.id,
            status='completed',
        )
        reference = AttachmentReference.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            table=self.table,
            field=self.field,
            record=self.record,
            file_id=file_record.id,
            created_by=self.user,
            permission_scope={},
            usage_metadata={},
        )

        list_result = storage_list_impl(
            request=MagicMock(auth=self.user),
            table_id=self.table.id,
        )
        info_result = storage_file_info_impl(
            request=MagicMock(auth=self.user),
            table_id=self.table.id,
            file_id=file_record.id,
        )

        expected_url = 'https://oss.example.com/tabdata/private-list.pdf?sig=short'
        self.assertEqual(list_result['data']['files'][0]['reference_id'], str(reference.id))
        self.assertEqual(list_result['data']['files'][0]['access_url'], expected_url)
        self.assertEqual(list_result['data']['files'][0]['cdn_url'], '')
        self.assertEqual(list_result['data']['files'][0]['expires_in'], 3600)
        self.assertEqual(info_result['data']['access_url'], expected_url)
        self.assertEqual(info_result['data']['cdn_url'], '')
        self.assertEqual(info_result['data']['expires_in'], 3600)
        self.assertNotIn('sig=', file_record.access_url)

    def test_reuse_private_attachment_rejects_cross_organization_file(self):
        """已知其他组织 file_id 也不能把私有对象挂进当前表后换签。"""
        other_organization = Organization.objects.create(
            name='其他组织',
            owner=self.user,
        )
        file_record = FileRecord.objects.create(
            file_name='other-private.pdf',
            file_key='tabdata/other/private.pdf',
            file_path='tabdata/other',
            file_size=512,
            file_type='document',
            mime_type='application/pdf',
            file_extension='pdf',
            file_hash='HASH-CROSS-ORG-REUSE',
            bucket_name='test-bucket',
            access_url='https://oss.example.com/tabdata/other/private.pdf',
            is_public=False,
            organization_id=other_organization.id,
            status='completed',
        )

        with self.assertRaisesRegex(PermissionError, '附件不属于当前组织'):
            self.service.reuse_attachment(
                file_id=file_record.id,
                table_id=self.table.id,
                field_id=self.field.id,
                record_id=self.record.id,
            )

        self.assertFalse(AttachmentReference.objects.filter(file_id=file_record.id).exists())

    def test_reuse_private_attachment_requires_source_table_access(self):
        source_table = Table.objects.create(
            name='private source',
            space_id=self.space.id,
            organization_id=self.organization.id,
            owner=self.user,
        )
        source_field = TableField.objects.create(
            table=source_table,
            name='source attachment',
            field_type='attachment',
        )
        file_record = FileRecord.objects.create(
            file_name='same-org-secret.pdf',
            file_key='tabdata/source/same-org-secret.pdf',
            file_path='tabdata/source',
            file_size=512,
            file_type='document',
            mime_type='application/pdf',
            file_extension='pdf',
            file_hash='HASH-SAME-ORG-IDOR',
            bucket_name='test-bucket',
            is_public=False,
            upload_user=str(uuid4()),
            organization_id=self.organization.id,
            status='completed',
        )
        AttachmentReference.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            table=source_table,
            field=source_field,
            file_id=file_record.id,
            created_by=self.user,
            permission_scope={},
            usage_metadata={'source': 'upload_complete'},
        )

        with patch.object(
            self.service,
            'check_table_permission',
            side_effect=lambda table_id, _role: str(table_id) == str(self.table.id),
        ), self.assertRaisesRegex(PermissionError, '无权复用该附件'):
            self.service.reuse_attachment(
                file_id=file_record.id,
                table_id=self.table.id,
                field_id=self.field.id,
                record_id=self.record.id,
            )

        self.assertFalse(AttachmentReference.objects.filter(
            table=self.table,
            file_id=file_record.id,
            is_deleted=False,
        ).exists())

    def test_sync_private_attachment_requires_source_table_access(self):
        source_table = Table.objects.create(
            name='private sync source',
            space_id=self.space.id,
            organization_id=self.organization.id,
            owner=self.user,
        )
        source_field = TableField.objects.create(
            table=source_table,
            name='source attachment',
            field_type='attachment',
        )
        file_record = FileRecord.objects.create(
            file_name='same-org-sync-secret.pdf',
            file_key='tabdata/source/same-org-sync-secret.pdf',
            file_path='tabdata/source',
            file_size=512,
            file_type='document',
            mime_type='application/pdf',
            file_extension='pdf',
            file_hash='HASH-SAME-ORG-SYNC-IDOR',
            bucket_name='test-bucket',
            is_public=False,
            upload_user=str(uuid4()),
            organization_id=self.organization.id,
            status='completed',
        )
        AttachmentReference.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            table=source_table,
            field=source_field,
            file_id=file_record.id,
            created_by=self.user,
            permission_scope={},
            usage_metadata={'source': 'upload_complete'},
        )
        self.record.data = {
            str(self.field.id): [{'file_id': str(file_record.id)}],
        }
        self.record.save(update_fields=['data'])

        with patch.object(
            self.service,
            'check_table_permission',
            return_value=False,
        ):
            self.service.sync_record_attachments(self.record)

        self.assertFalse(AttachmentReference.objects.filter(
            table=self.table,
            file_id=file_record.id,
            is_deleted=False,
        ).exists())

    def test_dirty_cross_organization_source_cannot_authorize_reuse_or_sync(self):
        """A readable but inconsistent source reference is not an access grant."""
        other_organization = Organization.objects.create(
            name='dirty source organization',
            owner=self.user,
        )
        other_space = Project.objects.create(
            name='dirty source project',
            organization=other_organization,
        )
        source_table = Table.objects.create(
            name='dirty source table',
            space_id=other_space.id,
            organization_id=other_organization.id,
            owner=self.user,
        )
        source_field = TableField.objects.create(
            table=source_table,
            name='source attachment',
            field_type='attachment',
        )
        file_record = FileRecord.objects.create(
            file_name='dirty-source.pdf',
            file_key='tabdata/source/dirty-source.pdf',
            file_path='tabdata/source',
            file_size=512,
            file_type='document',
            mime_type='application/pdf',
            file_extension='pdf',
            file_hash='HASH-DIRTY-SOURCE',
            bucket_name='test-bucket',
            is_public=False,
            upload_user=str(uuid4()),
            # The file can bind to the target organization, but not to the
            # source table's organization. The dirty source must be ignored.
            organization_id=self.organization.id,
            status='completed',
        )
        AttachmentReference.objects.create(
            organization_id=other_organization.id,
            space_id=other_space.id,
            table=source_table,
            field=source_field,
            file_id=file_record.id,
            created_by=self.user,
            permission_scope={},
            usage_metadata={'source': 'dirty_fixture'},
        )

        with patch.object(
            self.service,
            'check_table_permission',
            return_value=True,
        ), self.assertRaises(PermissionError):
            self.service.reuse_attachment(
                file_id=file_record.id,
                table_id=self.table.id,
                field_id=self.field.id,
                record_id=self.record.id,
            )

        self.record.data = {
            str(self.field.id): [{'file_id': str(file_record.id)}],
        }
        self.record.save(update_fields=['data'])
        with patch.object(
            self.service,
            'check_table_permission',
            return_value=True,
        ):
            self.service.sync_record_attachments(self.record)

        self.assertFalse(AttachmentReference.objects.filter(
            table=self.table,
            file_id=file_record.id,
            is_deleted=False,
        ).exists())

    @patch('apps.services.oss.services.file_access.get_oss_service')
    def test_cross_organization_reference_is_never_signed(self, mock_get_service):
        """即使数据库中已有脏引用，读取投影也必须在换签前 fail closed。"""
        other_organization = Organization.objects.create(
            name='脏引用来源组织',
            owner=self.user,
        )
        file_record = FileRecord.objects.create(
            file_name='leaked.png',
            file_key='tabdata/other/leaked.png',
            file_path='tabdata/other',
            file_size=512,
            file_type='image',
            mime_type='image/png',
            file_extension='png',
            file_hash='HASH-CROSS-ORG-HYDRATE',
            bucket_name='test-bucket',
            access_url='https://oss.example.com/tabdata/other/leaked.png',
            is_public=False,
            organization_id=other_organization.id,
            status='completed',
        )
        reference = AttachmentReference.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            table=self.table,
            field=self.field,
            record=self.record,
            file_id=file_record.id,
            created_by=self.user,
            permission_scope={},
            usage_metadata={},
        )

        payload = self.service._reference_to_payload(reference)

        self.assertEqual(payload['url'], '')
        mock_get_service.assert_not_called()

    @patch('apps.tabdata.api_open_storage.get_oss_service')
    def test_cross_organization_reference_cannot_download(self, mock_get_service):
        other_organization = Organization.objects.create(
            name='下载脏引用来源组织',
            owner=self.user,
        )
        file_record = FileRecord.objects.create(
            file_name='leaked-download.pdf',
            file_key='tabdata/other/leaked-download.pdf',
            file_path='tabdata/other',
            file_size=512,
            file_type='document',
            mime_type='application/pdf',
            file_extension='pdf',
            file_hash='HASH-CROSS-ORG-DOWNLOAD',
            bucket_name='test-bucket',
            is_public=False,
            organization_id=other_organization.id,
            status='completed',
        )
        AttachmentReference.objects.create(
            # Even a reference whose denormalized organization matches the
            # table cannot expose a private file owned by another organization.
            organization_id=self.organization.id,
            space_id=self.space.id,
            table=self.table,
            field=self.field,
            record=self.record,
            file_id=file_record.id,
            created_by=self.user,
            permission_scope={},
            usage_metadata={},
        )

        result = storage_download_impl(
            request=MagicMock(auth=self.user),
            table_id=self.table.id,
            file_id=file_record.id,
        )
        list_result = storage_list_impl(
            request=MagicMock(auth=self.user),
            table_id=self.table.id,
        )
        info_result = storage_file_info_impl(
            request=MagicMock(auth=self.user),
            table_id=self.table.id,
            file_id=file_record.id,
        )

        payload = json.loads(result.content)
        self.assertFalse(payload['success'])
        self.assertEqual(payload['code'], 'NOT_FOUND')
        self.assertEqual(list_result['data']['total'], 0)
        info_payload = json.loads(info_result.content)
        self.assertFalse(info_payload['success'])
        self.assertEqual(info_payload['code'], 'NOT_FOUND')
        mock_get_service.assert_not_called()

    @patch('apps.tabdata.services.attachment_service.get_oss_service')
    def test_reuse_and_remove_attachment(self, mock_get_service):
        """复用与删除引用"""
        mock_get_service.return_value = self.mock_oss

        # 先创建一个文件记录并引用
        file_record = FileRecord.objects.create(
            file_name='图像.png',
            file_key='tabdata/test/image.png',
            file_path='tabdata/test',
            file_size=1024,
            file_type='image',
            mime_type='image/png',
            file_extension='png',
            file_hash='HASH',
            bucket_name='test-bucket',
            access_url='https://oss.example.com/tabdata/test/image.png',
            upload_user=str(self.user.id),
            organization_id=self.organization.id,
            status='completed'
        )

        reference = self.service.reuse_attachment(
            file_id=file_record.id,
            table_id=self.table.id,
            field_id=self.field.id,
            record_id=self.record.id
        )

        self.assertEqual(reference['file_id'], str(file_record.id))
        self.assertEqual(reference['record_id'], str(self.record.id))

        ref_id = reference['reference_id']
        result = self.service.remove_reference(UUID(ref_id))
        self.assertEqual(result['reference_id'], ref_id)

        ref_obj = AttachmentReference.objects.get(id=ref_id)
        self.assertTrue(ref_obj.is_deleted)

        self.record.refresh_from_db()
        attachments = self.record.data.get(str(self.field.id), [])
        self.assertFalse(attachments)

    def test_reuse_attachment_emits_explicit_update_history(self):
        file_record = FileRecord.objects.create(
            file_name='manual.pdf',
            file_key='tabdata/test/manual.pdf',
            file_path='tabdata/test',
            file_size=512,
            file_type='document',
            mime_type='application/pdf',
            file_extension='pdf',
            file_hash='HASH-2',
            bucket_name='test-bucket',
            access_url='https://oss.example.com/tabdata/test/manual.pdf',
            upload_user=str(self.user.id),
            organization_id=self.organization.id,
            status='completed'
        )

        RecordHistory.objects.filter(record=self.record).delete()

        reference = self.service.reuse_attachment(
            file_id=file_record.id,
            table_id=self.table.id,
            field_id=self.field.id,
            record_id=self.record.id
        )
        self.assertEqual(reference['file_id'], str(file_record.id))

        histories = RecordHistory.objects.filter(record=self.record, action='update')
        self.assertEqual(histories.count(), 1)
        history = histories.first()
        self.assertIsNotNone(history)
        field_key = str(self.field.id)
        self.assertIn(field_key, history.field_changes)
        self.assertEqual(history.field_changes[field_key]['old'], [])
        self.assertEqual(len(history.field_changes[field_key]['new']), 1)

        item = RecordHistoryItem.objects.filter(history=history, field_key=field_key).first()
        self.assertIsNotNone(item)
        self.assertEqual(item.before, [])
        self.assertEqual(len(item.after), 1)

    def test_remove_reference_emits_explicit_update_history(self):
        file_record = FileRecord.objects.create(
            file_name='archive.zip',
            file_key='tabdata/test/archive.zip',
            file_path='tabdata/test',
            file_size=2048,
            file_type='archive',
            mime_type='application/zip',
            file_extension='zip',
            file_hash='HASH-3',
            bucket_name='test-bucket',
            access_url='https://oss.example.com/tabdata/test/archive.zip',
            upload_user=str(self.user.id),
            organization_id=self.organization.id,
            status='completed'
        )
        reference = self.service.reuse_attachment(
            file_id=file_record.id,
            table_id=self.table.id,
            field_id=self.field.id,
            record_id=self.record.id
        )

        RecordHistory.objects.filter(record=self.record).delete()

        result = self.service.remove_reference(UUID(reference['reference_id']))
        self.assertEqual(result['reference_id'], reference['reference_id'])

        histories = RecordHistory.objects.filter(record=self.record, action='update')
        self.assertEqual(histories.count(), 1)
        history = histories.first()
        self.assertIsNotNone(history)
        field_key = str(self.field.id)
        self.assertIn(field_key, history.field_changes)
        self.assertEqual(len(history.field_changes[field_key]['old']), 1)
        self.assertEqual(history.field_changes[field_key]['new'], [])

        item = RecordHistoryItem.objects.filter(history=history, field_key=field_key).first()
        self.assertIsNotNone(item)
        self.assertEqual(len(item.before), 1)
        self.assertEqual(item.after, [])

    def test_attach_file_respects_inherited_skip_history_flag(self):
        file_record = FileRecord.objects.create(
            file_name='skip-flag.txt',
            file_key='tabdata/test/skip-flag.txt',
            file_path='tabdata/test',
            file_size=64,
            file_type='document',
            mime_type='text/plain',
            file_extension='txt',
            file_hash='HASH-4',
            bucket_name='test-bucket',
            access_url='https://oss.example.com/tabdata/test/skip-flag.txt',
            status='completed'
        )
        reference = AttachmentReference.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            table=self.table,
            field=self.field,
            record=self.record,
            file_id=file_record.id,
            created_by=self.user,
            permission_scope={},
            usage_metadata={'source': 'test'}
        )

        RecordHistory.objects.filter(record=self.record).delete()

        self.record._skip_record_history = True
        try:
            self.service._attach_file_to_record(self.record, self.field, reference)
            self.assertTrue(getattr(self.record, '_skip_record_history', False))
        finally:
            if hasattr(self.record, '_skip_record_history'):
                delattr(self.record, '_skip_record_history')

        self.record.refresh_from_db()
        attachments = self.record.data.get(str(self.field.id), [])
        self.assertEqual(len(attachments), 1)
        self.assertEqual(RecordHistory.objects.filter(record=self.record).count(), 0)


class AttachmentObjectKeyTestCase(SimpleTestCase):
    """object_key 生成规则的单测，不依赖数据库。"""

    def test_build_object_key_truncates_long_slug(self):
        service = AttachmentService(user=None)
        long_name = 'a' * 120 + '.png'
        key = service._build_object_key(
            organization_id=str(uuid4()),
            table_id=str(uuid4()),
            file_name=long_name,
        )
        slug_with_ext = key.rsplit('/', 1)[-1].split('_', 2)[-1]
        slug_part = slug_with_ext.rsplit('.', 1)[0]
        self.assertLessEqual(len(slug_part), AttachmentService.OBJECT_KEY_SAFE_NAME_MAX_LEN)
