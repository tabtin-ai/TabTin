"""
TRANS-3 / TRANS-4 回归测试

验证:
  - TRANS-3: _validate_vision_request_against_model 不再对空图片列表检查视觉能力
  - TRANS-4: batch_process_llm_requests 使用 API 层传入的 batch_id
"""

from unittest.mock import patch, MagicMock
from django.test import TestCase
from decimal import Decimal
import uuid

from ..models import LLMProvider, LLMModel
from ..tasks.llm_tasks import (
    _validate_vision_request_against_model,
    batch_process_llm_requests,
    _process_single_llm_request,
)


class TestTrans3VisionValidation(TestCase):
    """TRANS-3: 非视觉请求不应触发视觉能力校验"""

    def setUp(self):
        self.provider = LLMProvider.objects.create(
            name='openai',
            display_name='OpenAI',
            base_url='https://api.openai.com/v1',
            api_key='sk-test',
            is_global=True,
            is_active=True,
        )
        self.non_vision_model = LLMModel.objects.create(
            provider=self.provider,
            model_name='gpt-4',
            display_name='GPT-4',
            max_tokens=8000,
            supports_vision=False,
            billing_type='token',
            input_price_per_1k=Decimal('0.01'),
            output_price_per_1k=Decimal('0.03'),
            is_active=True,
        )
        self.vision_model = LLMModel.objects.create(
            provider=self.provider,
            model_name='gpt-4-vision',
            display_name='GPT-4 Vision',
            max_tokens=8000,
            supports_vision=True,
            max_images_per_request=5,
            billing_type='token',
            input_price_per_1k=Decimal('0.01'),
            output_price_per_1k=Decimal('0.03'),
            is_active=True,
        )

    def test_empty_images_skips_validation(self):
        """空图片列表 + 非视觉模型应直接通过"""
        _validate_vision_request_against_model(self.non_vision_model, [])

    def test_none_images_skips_validation(self):
        """None 图片列表 + 非视觉模型应直接通过"""
        _validate_vision_request_against_model(self.non_vision_model, None)

    def test_non_vision_model_with_images_raises(self):
        """非视觉模型携带图片时应拒绝"""
        with self.assertRaises(ValueError):
            _validate_vision_request_against_model(
                self.non_vision_model, ['https://example.com/img.png']
            )

    def test_vision_model_with_images_passes(self):
        """视觉模型携带图片应通过"""
        _validate_vision_request_against_model(
            self.vision_model, ['https://example.com/img.png']
        )

    def test_vision_model_exceeding_max_images_raises(self):
        """超出图片数量上限应拒绝"""
        images = [f'https://example.com/img{i}.png' for i in range(10)]
        with self.assertRaises(ValueError):
            _validate_vision_request_against_model(self.vision_model, images)

    @patch('apps.services.llm.tasks.llm_tasks.get_llm_service')
    @patch('apps.services.llm.tasks.llm_tasks.resolve_model')
    @patch('apps.services.llm.tasks.llm_tasks.check_budget_before_request', return_value=None)
    @patch('apps.services.llm.tasks.llm_tasks.charge_llm_usage')
    @patch('apps.services.llm.tasks.llm_tasks.record_usage_fact_safely')
    @patch('apps.services.llm.tasks.llm_tasks.report_provider_call_result')
    def test_process_single_llm_request_no_images(
        self,
        mock_report,
        mock_record,
        mock_charge,
        mock_budget,
        mock_resolve,
        mock_service,
    ):
        """_process_single_llm_request 应在无图片时跳过视觉校验"""
        mock_resolve.return_value = self.non_vision_model

        mock_llm = MagicMock()
        mock_llm.chat.return_value = {
            'success': True,
            'content': 'hello',
            'usage': {'input_tokens': 10, 'output_tokens': 5},
            'cost': {},
            'response_time': 0.5,
        }
        mock_service.return_value = mock_llm

        request_data = {
            'request_id': str(uuid.uuid4()),
            'model_id': str(self.non_vision_model.id),
            'messages': [{'role': 'user', 'content': 'hi'}],
            'user_id': str(uuid.uuid4()),
            'organization_id': str(uuid.uuid4()),
            'parameters': {},
        }

        result = _process_single_llm_request(request_data)
        self.assertTrue(result['success'])


class TestTrans4BatchIdConsistency(TestCase):
    """TRANS-4: batch_id 必须由 API 层传入并透传到 Worker"""

    def setUp(self):
        self.provider = LLMProvider.objects.create(
            name='openai',
            display_name='OpenAI',
            base_url='https://api.openai.com/v1',
            api_key='sk-test',
            is_global=True,
            is_active=True,
        )
        self.model = LLMModel.objects.create(
            provider=self.provider,
            model_name='gpt-4',
            display_name='GPT-4',
            max_tokens=8000,
            supports_vision=False,
            billing_type='token',
            input_price_per_1k=Decimal('0.01'),
            output_price_per_1k=Decimal('0.03'),
            is_active=True,
        )

    @patch('apps.services.llm.tasks.llm_tasks._process_single_llm_request')
    def test_batch_uses_provided_batch_id(self, mock_process):
        """传入 batch_id 时 Worker 应使用该值"""
        api_batch_id = str(uuid.uuid4())

        mock_process.return_value = {
            'success': True,
            'request_id': f'{api_batch_id}_0',
            'content': 'ok',
        }

        requests_data = [
            {
                'request_id': f'{api_batch_id}_0',
                'model_id': str(self.model.id),
                'messages': [{'role': 'user', 'content': 'hi'}],
                'user_id': str(uuid.uuid4()),
                'organization_id': str(uuid.uuid4()),
                'parameters': {},
            }
        ]

        result = batch_process_llm_requests(
            requests_data, callback_url=None, batch_id=api_batch_id
        )

        self.assertEqual(result['batch_id'], api_batch_id)
        call_data = mock_process.call_args[0][0]
        self.assertTrue(call_data['request_id'].startswith(api_batch_id))

    @patch('apps.services.llm.tasks.llm_tasks._process_single_llm_request')
    def test_batch_generates_id_when_none(self, mock_process):
        """未传入 batch_id 时 Worker 应自动生成"""
        mock_process.return_value = {
            'success': True,
            'request_id': 'will_be_overwritten',
            'content': 'ok',
        }

        requests_data = [
            {
                'request_id': 'placeholder_0',
                'model_id': str(self.model.id),
                'messages': [{'role': 'user', 'content': 'hi'}],
                'user_id': str(uuid.uuid4()),
                'organization_id': str(uuid.uuid4()),
                'parameters': {},
            }
        ]

        result = batch_process_llm_requests(
            requests_data, callback_url=None, batch_id=None
        )

        self.assertIsNotNone(result['batch_id'])
        self.assertEqual(len(result['batch_id']), 36)  # UUID format
