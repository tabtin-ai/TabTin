from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import TestCase

from apps.tabdata.signals import create_default_workspace

from apps.schema_market.models import MarketTemplate
from apps.schema_market.services import TemplateService


class TemplateServiceTests(TestCase):
    databases = {'default', 'postgresql'}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.user_model = get_user_model()
        post_save.disconnect(create_default_workspace, sender=cls.user_model)

    @classmethod
    def tearDownClass(cls):
        post_save.connect(create_default_workspace, sender=cls.user_model)
        super().tearDownClass()
    def setUp(self):
        self.template = MarketTemplate.objects.create(
            name='Demo Template',
            slug='demo-template',
            icon='🧪',
            summary='测试模板',
            description='测试描述',
            category='general',
            tags=['demo'],
            schema_json={
                'metadata': {'name': 'Demo Template'},
                '_schema_status': 'executable',
                'site': {'base_url': 'https://example.com'},
                'extraction': {
                    'list_selector': '.item',
                    'fields': [
                        {
                            'name': 'title',
                            'selector': '.title',
                            'type': 'text',
                            'required': True,
                            'description': '标题',
                        }
                    ],
                    'confidence': 0.9,
                    'sample_data': [{'title': 'Demo'}],
                },
                'execution': {
                    'max_items': 5,
                    'extract_all': False,
                    'include_detail': False,
                },
            },
            variables_schema={
                'keyword': {
                    'type': 'string',
                    'required': True,
                    'pattern': r'^[^\s]{1,20}$',
                }
            },
            url_template='https://example.com/search?q={{ keyword|urlencode }}',
        )
        User = get_user_model()
        self.user = User.objects.create_user(email='tester@example.com', password='pass1234')

    def test_render_template(self):
        service = TemplateService(self.template)
        rendered = service.render({'keyword': 'AI'})
        self.assertIn('AI', rendered.source_url)
        self.assertEqual(rendered.schema_json['metadata']['name'], 'Demo Template')

    def test_persist_template(self):
        service = TemplateService(self.template)
        rendered = service.render({'keyword': 'AI'})
        result = service.persist(rendered, self.user)
        self.assertIsNotNone(result.generated_schema_id)
