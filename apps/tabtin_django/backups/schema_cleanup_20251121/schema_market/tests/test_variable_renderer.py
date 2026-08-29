from django.test import SimpleTestCase

from apps.schema_market.services.variable_renderer import (
    VariableRenderer,
    VariableValidationError,
)


class VariableRendererTests(SimpleTestCase):
    def setUp(self) -> None:
        self.renderer = VariableRenderer({
            'keyword': {
                'type': 'string',
                'required': True,
                'pattern': r'^[^\s]{1,20}$',
            },
            'limit': {
                'type': 'int',
                'required': False,
                'min': 1,
                'max': 50,
                'default': 10,
            },
        })

    def test_validate_success(self):
        variables = self.renderer.validate({'keyword': 'AI', 'limit': 5})
        self.assertEqual(variables['keyword'], 'AI')
        self.assertEqual(variables['limit'], 5)

    def test_validate_default_value(self):
        variables = self.renderer.validate({'keyword': 'AI'})
        self.assertEqual(variables['limit'], 10)

    def test_validate_required_error(self):
        with self.assertRaises(VariableValidationError):
            self.renderer.validate({})

    def test_render_text_with_filter(self):
        variables = {'keyword': '魔珐科技'}
        rendered = self.renderer.render_text(
            'https://example.com?q={{ keyword|urlencode }}',
            variables,
        )
        self.assertIn('%E9%AD%94', rendered)

    def test_render_data_recursive(self):
        data = {
            'site': {'base_url': '{{ keyword }}'},
            'execution': {'reasoning': '使用 {{ keyword }} 模板'},
        }
        rendered = self.renderer.render_data(data, {'keyword': 'demo'})
        self.assertEqual(rendered['site']['base_url'], 'demo')
        self.assertEqual(rendered['execution']['reasoning'], '使用 demo 模板')
