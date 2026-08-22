"""
LLM Admin 表单验证测试

测试条件验证逻辑是否正确工作
"""

from django.test import TestCase
from django.contrib.auth.models import User
from apps.services.llm.models import LLMProvider, LLMModel
from apps.services.llm.admin import LLMModelAdminForm
from decimal import Decimal


class LLMModelAdminFormTest(TestCase):
    """LLM模型Admin表单测试"""

    def setUp(self):
        """测试前准备"""
        # 创建测试用的 Provider
        self.provider = LLMProvider.objects.create(
            name='openai',
            display_name='OpenAI Test',
            base_url='https://api.openai.com/v1',
            api_key='test-key',
            is_global=True
        )

    def test_vision_disabled_fields_optional(self):
        """测试未启用图片支持时，图片相关字段可以为空"""
        form_data = {
            'provider': self.provider.id,
            'model_name': 'gpt-4',
            'display_name': 'GPT-4 Test',
            'max_tokens': 4096,
            'supports_vision': False,  # 不支持图片
            'billing_type': 'token',
            'input_price_per_1k': Decimal('0.03'),
            'output_price_per_1k': Decimal('0.06'),
            'is_active': True,
        }

        form = LLMModelAdminForm(data=form_data)
        self.assertTrue(form.is_valid(), f"表单验证失败: {form.errors}")

        # 验证保存的数据有默认值
        model = form.save()
        self.assertEqual(model.max_image_size, 20*1024*1024)
        self.assertEqual(model.max_images_per_request, 10)
        self.assertEqual(model.supported_image_formats, [])

    def test_vision_enabled_fields_can_be_filled(self):
        """测试启用图片支持时，可以填写图片相关字段"""
        form_data = {
            'provider': self.provider.id,
            'model_name': 'gpt-4-vision',
            'display_name': 'GPT-4 Vision Test',
            'max_tokens': 4096,
            'supports_vision': True,  # 支持图片
            'max_image_size': 10*1024*1024,
            'max_images_per_request': 5,
            'supported_image_formats': ['jpg', 'png'],
            'billing_type': 'token',
            'input_price_per_1k': Decimal('0.03'),
            'output_price_per_1k': Decimal('0.06'),
            'is_active': True,
        }

        form = LLMModelAdminForm(data=form_data)
        self.assertTrue(form.is_valid(), f"表单验证失败: {form.errors}")

        # 验证保存的数据
        model = form.save()
        self.assertEqual(model.max_image_size, 10*1024*1024)
        self.assertEqual(model.max_images_per_request, 5)
        self.assertEqual(model.supported_image_formats, ['jpg', 'png'])

    def test_token_billing_custom_config_optional(self):
        """测试Token计费时，自定义计费配置可以为空"""
        form_data = {
            'provider': self.provider.id,
            'model_name': 'gpt-4',
            'display_name': 'GPT-4 Test',
            'max_tokens': 4096,
            'supports_vision': False,
            'billing_type': 'token',  # Token计费
            'input_price_per_1k': Decimal('0.03'),
            'output_price_per_1k': Decimal('0.06'),
            # 不填写 custom_billing_config
            'is_active': True,
        }

        form = LLMModelAdminForm(data=form_data)
        self.assertTrue(form.is_valid(), f"表单验证失败: {form.errors}")

        # 验证保存的数据有默认值
        model = form.save()
        self.assertEqual(model.custom_billing_config, {})

    def test_custom_billing_requires_config(self):
        """测试自定义计费时，必须填写自定义计费配置"""
        form_data = {
            'provider': self.provider.id,
            'model_name': 'custom-model',
            'display_name': 'Custom Model Test',
            'max_tokens': 4096,
            'supports_vision': False,
            'billing_type': 'custom',  # 自定义计费
            # 不填写 custom_billing_config
            'is_active': True,
        }

        form = LLMModelAdminForm(data=form_data)
        self.assertFalse(form.is_valid(), "自定义计费时应该要求填写配置")
        self.assertIn('custom_billing_config', form.errors)

    def test_custom_billing_with_config_valid(self):
        """测试自定义计费时填写配置可以通过验证"""
        form_data = {
            'provider': self.provider.id,
            'model_name': 'custom-model',
            'display_name': 'Custom Model Test',
            'max_tokens': 4096,
            'supports_vision': False,
            'billing_type': 'custom',  # 自定义计费
            'custom_billing_config': {
                'unit': 'request',
                'price': 0.01
            },
            'is_active': True,
        }

        form = LLMModelAdminForm(data=form_data)
        self.assertTrue(form.is_valid(), f"表单验证失败: {form.errors}")

        # 验证保存的数据
        model = form.save()
        self.assertEqual(model.custom_billing_config, {
            'unit': 'request',
            'price': 0.01
        })

    def test_request_billing_custom_config_optional(self):
        """测试请求计费时，自定义计费配置可以为空"""
        form_data = {
            'provider': self.provider.id,
            'model_name': 'request-model',
            'display_name': 'Request Billing Test',
            'max_tokens': 4096,
            'supports_vision': False,
            'billing_type': 'request',  # 请求计费
            'price_per_request': Decimal('0.01'),
            # 不填写 custom_billing_config
            'is_active': True,
        }

        form = LLMModelAdminForm(data=form_data)
        self.assertTrue(form.is_valid(), f"表单验证失败: {form.errors}")

        # 验证保存的数据有默认值
        model = form.save()
        self.assertEqual(model.custom_billing_config, {})


if __name__ == '__main__':
    import django
    import os

    os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'tabtin.settings')
    django.setup()

    from django.test.utils import get_runner
    TestRunner = get_runner(django.conf.settings)
    test_runner = TestRunner()
    failures = test_runner.run_tests(['apps.services.llm.tests.test_admin_form'])
