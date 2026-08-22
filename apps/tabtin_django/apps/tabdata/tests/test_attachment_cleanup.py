"""
附件清理逻辑测试

覆盖 cleanup_record_attachments、cleanup_field_attachments、
_bulk_cleanup_references 的核心行为。

不依赖 Space 模型（避免 CHECK 约束问题），Table 使用 UUID 字段
关联 organization/space，无需真实的 Organization/Space 行。
"""
from unittest.mock import patch, MagicMock
from uuid import uuid4

from django.test import TestCase
from django.contrib.auth import get_user_model

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import (
    Table,
    TableField,
    TableRecord,
    AttachmentReference,
)
from apps.tabdata.services.attachment_service import AttachmentService
from apps.services.oss.models import FileRecord, FileUsage

User = get_user_model()


class AttachmentCleanupTestBase(TestCase):
    """附件清理测试基类，提供通用 fixture"""
    databases = ['default', 'postgresql']

    def setUp(self):
        self.user = User.objects.create_user(
            username=f'cleanup-user-{uuid4().hex[:8]}',
            email=f'cleanup-{uuid4().hex[:6]}@test.com',
            password='testpass123',
        )
        self.organization_id = uuid4()
        self.space_id = uuid4()

        self.table = Table.objects.using(TABDATA_DB_ALIAS).create(
            name='清理测试表格',
            organization_id=self.organization_id,
            space_id=self.space_id,
            owner=self.user,
        )
        self.field = TableField.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            name='附件字段',
            field_type='attachment',
        )
        self.record = TableRecord.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            data={},
            created_by=self.user,
            updated_by=self.user,
        )
        self.service = AttachmentService(user=self.user)

    def _create_file_record(self, name='test.pdf') -> FileRecord:
        return FileRecord.objects.using('default').create(
            file_name=name,
            file_key=f'tabdata/test/{uuid4().hex[:8]}_{name}',
            file_path='tabdata/test',
            file_size=1024,
            file_type='document',
            mime_type='application/pdf',
            file_extension=name.rsplit('.', 1)[-1],
            file_hash=uuid4().hex,
            bucket_name='test-bucket',
            access_url=f'https://oss.example.com/tabdata/test/{name}',
            status='completed',
        )

    def _create_reference(self, file_record, record=None, field=None) -> AttachmentReference:
        return AttachmentReference.objects.using(TABDATA_DB_ALIAS).create(
            organization_id=self.organization_id,
            space_id=self.space_id,
            table=self.table,
            field=field or self.field,
            record=record or self.record,
            file_id=file_record.id,
            created_by=self.user,
            permission_scope={},
            usage_metadata={'source': 'test'},
        )


class CleanupRecordAttachmentsTest(AttachmentCleanupTestBase):
    """cleanup_record_attachments 测试"""

    @patch.object(AttachmentService, '_deactivate_file_usage_for_table')
    @patch.object(AttachmentService, '_record_storage_release')
    @patch.object(AttachmentService, '_get_file_record')
    def test_marks_references_deleted(self, mock_get_file, mock_release, mock_deactivate):
        """记录删除后，其所有活跃引用应被 mark_deleted"""
        file_a = self._create_file_record('a.pdf')
        file_b = self._create_file_record('b.png')
        ref_a = self._create_reference(file_a)
        ref_b = self._create_reference(file_b)

        self.service.cleanup_record_attachments(self.record.id)

        ref_a.refresh_from_db()
        ref_b.refresh_from_db()
        self.assertTrue(ref_a.is_deleted)
        self.assertTrue(ref_b.is_deleted)
        self.assertIsNotNone(ref_a.deleted_at)
        self.assertIsNotNone(ref_b.deleted_at)

    @patch.object(AttachmentService, '_deactivate_file_usage_for_table')
    @patch.object(AttachmentService, '_record_storage_release')
    def test_no_references_short_circuits(self, mock_release, mock_deactivate):
        """无引用时应短路返回，不触发任何操作"""
        empty_record = TableRecord.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table, data={}, created_by=self.user, updated_by=self.user,
        )
        self.service.cleanup_record_attachments(empty_record.id)
        mock_deactivate.assert_not_called()
        mock_release.assert_not_called()

    @patch.object(AttachmentService, '_deactivate_file_usage_for_table')
    @patch.object(AttachmentService, '_record_storage_release')
    @patch.object(AttachmentService, '_get_file_record')
    def test_does_not_affect_other_records(self, mock_get_file, mock_release, mock_deactivate):
        """只清理目标记录的引用，不影响同表其他记录"""
        file_rec = self._create_file_record('shared.pdf')
        other_record = TableRecord.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table, data={}, created_by=self.user, updated_by=self.user,
        )
        ref_target = self._create_reference(file_rec, record=self.record)
        ref_other = self._create_reference(file_rec, record=other_record)

        self.service.cleanup_record_attachments(self.record.id)

        ref_target.refresh_from_db()
        ref_other.refresh_from_db()
        self.assertTrue(ref_target.is_deleted)
        self.assertFalse(ref_other.is_deleted)


class CleanupFieldAttachmentsTest(AttachmentCleanupTestBase):
    """cleanup_field_attachments 测试"""

    @patch.object(AttachmentService, '_deactivate_file_usage_for_table')
    @patch.object(AttachmentService, '_record_storage_release')
    @patch.object(AttachmentService, '_get_file_record')
    def test_marks_references_deleted(self, mock_get_file, mock_release, mock_deactivate):
        """字段删除后，该字段所有活跃引用应被 mark_deleted"""
        file_a = self._create_file_record('field-a.pdf')
        file_b = self._create_file_record('field-b.png')
        ref_a = self._create_reference(file_a)
        ref_b = self._create_reference(file_b)

        self.service.cleanup_field_attachments(self.table.id, self.field.id)

        ref_a.refresh_from_db()
        ref_b.refresh_from_db()
        self.assertTrue(ref_a.is_deleted)
        self.assertTrue(ref_b.is_deleted)

    @patch.object(AttachmentService, '_deactivate_file_usage_for_table')
    @patch.object(AttachmentService, '_record_storage_release')
    @patch.object(AttachmentService, '_get_file_record')
    def test_only_target_field(self, mock_get_file, mock_release, mock_deactivate):
        """只清理目标字段的引用，不影响同表其他字段"""
        other_field = TableField.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table, name='其他附件字段', field_type='attachment',
        )
        file_rec = self._create_file_record('multi-field.pdf')
        ref_target = self._create_reference(file_rec, field=self.field)
        ref_other = self._create_reference(file_rec, field=other_field)

        self.service.cleanup_field_attachments(self.table.id, self.field.id)

        ref_target.refresh_from_db()
        ref_other.refresh_from_db()
        self.assertTrue(ref_target.is_deleted)
        self.assertFalse(ref_other.is_deleted)


class BulkCleanupDeactivationTest(AttachmentCleanupTestBase):
    """_bulk_cleanup_references 的 on_commit FileUsage deactivation 测试"""

    @patch.object(AttachmentService, '_record_storage_release')
    @patch.object(AttachmentService, '_get_file_record')
    @patch.object(AttachmentService, '_deactivate_file_usage_for_table')
    def test_deactivates_when_last_reference_deleted(
        self, mock_deactivate, mock_get_file, mock_release,
    ):
        """最后一个引用被删除后，on_commit 应调用 _deactivate_file_usage_for_table"""
        file_rec = self._create_file_record('sole.pdf')
        self._create_reference(file_rec)

        with self.captureOnCommitCallbacks(using=TABDATA_DB_ALIAS, execute=True):
            self.service.cleanup_record_attachments(self.record.id)

        mock_deactivate.assert_called_once_with(self.table.id, file_rec.id)

    @patch.object(AttachmentService, '_record_storage_release')
    @patch.object(AttachmentService, '_get_file_record')
    @patch.object(AttachmentService, '_deactivate_file_usage_for_table')
    def test_no_deactivate_when_other_active_refs_exist(
        self, mock_deactivate, mock_get_file, mock_release,
    ):
        """同一表的同一文件还有其他活跃引用时，不应 deactivate"""
        file_rec = self._create_file_record('shared.pdf')
        other_record = TableRecord.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table, data={}, created_by=self.user, updated_by=self.user,
        )
        self._create_reference(file_rec, record=self.record)
        self._create_reference(file_rec, record=other_record)

        with self.captureOnCommitCallbacks(using=TABDATA_DB_ALIAS, execute=True):
            self.service.cleanup_record_attachments(self.record.id)

        mock_deactivate.assert_not_called()

    @patch.object(AttachmentService, '_get_file_record')
    @patch.object(AttachmentService, '_deactivate_file_usage_for_table')
    def test_on_commit_failure_logged_not_raised(self, mock_deactivate, mock_get_file):
        """on_commit 回调失败时应记录日志而非抛出异常"""
        mock_deactivate.side_effect = Exception('MySQL connection lost')
        file_rec = self._create_file_record('fail.pdf')
        self._create_reference(file_rec)

        with self.captureOnCommitCallbacks(using=TABDATA_DB_ALIAS, execute=True):
            self.service.cleanup_record_attachments(self.record.id)

        mock_deactivate.assert_called_once()

    @patch.object(AttachmentService, '_record_storage_release')
    @patch.object(AttachmentService, '_get_file_record')
    @patch.object(AttachmentService, '_deactivate_file_usage_for_table')
    def test_storage_release_on_last_organization_reference(
        self, mock_deactivate, mock_get_file, mock_release,
    ):
        """organization 级最后一个引用删除后，on_commit 应触发 storage release"""
        file_rec = self._create_file_record('quota.pdf')
        mock_get_file.return_value = file_rec
        ref = self._create_reference(file_rec)

        with self.captureOnCommitCallbacks(using=TABDATA_DB_ALIAS, execute=True):
            self.service.cleanup_record_attachments(self.record.id)

        mock_release.assert_called_once()
        call_kwargs = mock_release.call_args[1]
        self.assertEqual(call_kwargs['organization_id'], str(self.organization_id))
        self.assertEqual(call_kwargs['file_record'], file_rec)
