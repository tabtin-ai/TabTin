"""
字段类型校验测试
"""
from django.test import TestCase
from django.contrib.auth import get_user_model

from apps.tabtinspace.models import Organization, OrganizationMember, Space
from apps.tabdata.models import Table, TableField, TableRecord
from apps.tabdata.services.record_service import RecordService
from apps.services.oss.models import FileRecord
from apps.tabdata.utils.record_serializers import serialize_record


class FieldTypeValidationTest(TestCase):
    """验证新扩展字段类型的服务端校验与格式化"""

    def setUp(self):
        User = get_user_model()
        self.user = User.objects.create_user(
            username='fieldtype-user',
            email='fieldtype@example.com',
            password='testpass123'
        )
        self.organization = Organization.objects.create(
            name='字段类型工作区',
            owner=self.user
        )
        self.space = Space.objects.create(
            name='字段类型项目',
            organization=self.organization
        )
        self.table = Table.objects.create(
            name='字段类型表格',
            project_id=self.space.id,
            organization_id=self.space.organization_id,
            owner=self.user
        )

        self.url_field = TableField.objects.create(
            table=self.table,
            name='官网',
            field_type='url'
        )
        self.email_field = TableField.objects.create(
            table=self.table,
            name='邮箱',
            field_type='email'
        )
        self.phone_field = TableField.objects.create(
            table=self.table,
            name='手机号',
            field_type='phone'
        )
        self.attachment_field = TableField.objects.create(
            table=self.table,
            name='附件',
            field_type='attachment'
        )
        self.file_record = FileRecord.objects.create(
            file_name='说明文档.pdf',
            file_key='docs/doc.pdf',
            file_path='docs',
            file_size=1024,
            file_type='document',
            mime_type='application/pdf',
            file_extension='pdf',
            file_hash='a' * 32,
            bucket_name='test-bucket',
            access_url='https://oss.example.com/doc.pdf',
            status='completed'
        )

        self.service = RecordService(user=self.user)

    def test_invalid_values_blocked(self):
        """非法值应被校验拦截"""
        data = {
            '官网': 'ftp://example.com',
            '邮箱': 'not-email',
            '手机号': '12345',
            '附件': [{'name': '', 'url': 'http://example.com/file'}],
        }
        result = self.service.create_record(self.table.id, data)
        self.assertIsNotNone(result)
        record, error = result
        self.assertIsNone(record)
        self.assertIsNotNone(error)

        self.assertEqual(TableRecord.objects.filter(table=self.table).count(), 0)

    def test_valid_values_pass(self):
        """合法值应成功创建并格式化"""
        data = {
            '官网': 'https://example.com',
            '邮箱': 'user@example.com',
            '手机号': '138-0000-0000',
            '附件': [
                {
                    'file_id': str(self.file_record.id)
                }
            ],
        }
        result = self.service.create_record(self.table.id, data)
        self.assertIsNotNone(result)
        record, error = result
        self.assertIsNone(error)
        self.assertIsNotNone(record)

        record.refresh_from_db()
        self.assertEqual(record.data['官网'], 'https://example.com')
        self.assertEqual(record.data['邮箱'], 'user@example.com')
        self.assertEqual(record.data['手机号'], '13800000000')
        attachment = record.data['附件'][0]
        self.assertEqual(attachment['name'], '说明文档.pdf')
        self.assertEqual(attachment['url'], 'https://oss.example.com/doc.pdf')
        self.assertEqual(attachment['size'], 1024)
        self.assertEqual(attachment['file_id'], str(self.file_record.id))

    def test_validation_rules_enforced(self):
        """验证字段自定义规则生效"""
        self.url_field.validation_rules = {
            'pattern': r'^https://',
            'message': '官网必须以 https:// 开头'
        }
        self.url_field.save(update_fields=['validation_rules'])

        # 提交不符合规则的值
        invalid_result = self.service.create_record(self.table.id, {
            '官网': 'http://example.com'
        })
        self.assertIsNotNone(invalid_result)
        record, error = invalid_result
        self.assertIsNone(record)
        self.assertIn('https://', error)

        # 合规数据可以落库
        valid_result = self.service.create_record(self.table.id, {
            '官网': 'https://secure.example.com'
        })
        record, error = valid_result
        self.assertIsNone(error)
        self.assertIsNotNone(record)

    def test_visibility_roles_filter(self):
        """字段可见角色配置应限制查看数据"""
        confidential_field = TableField.objects.create(
            table=self.table,
            name='机密信息',
            field_type='text',
            config={'visibility_roles': ['owner', 'admin']}
        )

        TableRecord.objects.create(
            table=self.table,
            data={
                '官网': 'https://example.com',
                '机密信息': '内部数据'
            }
        )

        viewer = get_user_model().objects.create_user(
            username='viewer-user',
            email='viewer@example.com',
            password='testpass123'
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=viewer,
            role='viewer'
        )

        viewer_service = RecordService(user=viewer)
        viewer_result = viewer_service.list_records(self.table.id)
        viewer_record = viewer_result['records'][0]
        viewer_serialized = serialize_record(viewer_record)
        self.assertNotIn('机密信息', viewer_serialized['data'])

        owner_service = RecordService(user=self.user)
        owner_result = owner_service.list_records(self.table.id)
        owner_record = owner_result['records'][0]
        owner_serialized = serialize_record(owner_record)
        self.assertIn('机密信息', owner_serialized['data'])
