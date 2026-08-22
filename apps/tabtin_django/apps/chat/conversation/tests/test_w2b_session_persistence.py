"""W2b Session API:切模型保留 intent + model-params v1→v2。"""

import json
import uuid
from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from django.utils import timezone

from apps.chat.conversation.models import ChatSession
from apps.services.llm.models import LLMModel, LLMProvider
from apps.users.auth.models import UserSession
from apps.users.auth.session_manager import SessionManager
from apps.users.auth.utils import generate_jwt_token

User = get_user_model()


@override_settings(TABTIN_REQUIRE_INVITE_CODE=False)
class W2bSessionPersistenceApiTests(TestCase):

    def setUp(self):
        self.user = User.objects.create_user(
            email=f'w2b_{uuid.uuid4().hex[:8]}@example.com',
            password='testpass123',
        )
        self.raw_session_key = f'w2b_session_key_{uuid.uuid4().hex}'
        UserSession.objects.create(
            user=self.user,
            session_key=SessionManager.hash_session_key(self.raw_session_key),
            session_type='web',
            ip_address='127.0.0.1',
            user_agent='w2b-test',
            device_info={},
            expires_at=timezone.now() + timedelta(hours=24),
            is_active=True,
        )
        self.token = generate_jwt_token(
            self.user,
            expire_hours=1,
            token_type='access',
            session_key=self.raw_session_key,
        )
        self.auth_headers = {'HTTP_AUTHORIZATION': f'Bearer {self.token}'}

        provider = LLMProvider.objects.create(
            name=f'w2b-prov-{uuid.uuid4().hex[:8]}',
            display_name='W2b Provider',
            api_key='test-key',
            base_url='https://example.com/v1',
            capability_domains=['chat'],
            is_global=True,
            is_active=True,
        )
        self.model_a = LLMModel.objects.create(
            id=uuid.uuid4(),
            provider=provider,
            model_name=f'w2b-a-{uuid.uuid4().hex[:6]}',
            display_name='W2b A',
            max_tokens=8000,
            capability_domain='chat',
            wave_status='ready',
        )
        self.model_b = LLMModel.objects.create(
            id=uuid.uuid4(),
            provider=provider,
            model_name=f'w2b-b-{uuid.uuid4().hex[:6]}',
            display_name='W2b B',
            max_tokens=8000,
            capability_domain='chat',
            wave_status='ready',
        )

    def test_switch_model_preserves_and_upgrades_v1_intent(self):
        session = ChatSession.objects.create(
            user=self.user,
            organization_id='test',
            title='w2b preserve',
            current_model_id=self.model_a.id,
            default_model_id=self.model_a.id,
            model_param_overrides={'reasoning_effort': 'high'},
        )

        with patch(
            'apps.services.llm.services.model_resolver.resolve_model',
            return_value=self.model_b,
        ), patch(
            'apps.services.llm.services.capability_guard.is_llm_model_instance',
            return_value=True,
        ), patch(
            'apps.chat.conversation.api.session._is_model_visible_for_user',
            return_value=True,
        ):
            response = self.client.put(
                f'/api/chat/sessions/{session.id}/model',
                data=json.dumps({'model_id': str(self.model_b.id)}),
                content_type='application/json',
                **self.auth_headers,
            )

        self.assertEqual(response.status_code, 200, response.content)
        body = response.json()
        payload = body.get('data', body)
        self.assertNotIn('resolved', payload)

        session.refresh_from_db()
        self.assertEqual(session.current_model_id, self.model_b.id)
        self.assertEqual(session.model_param_overrides.get('v'), 2)
        self.assertEqual(session.model_param_overrides.get('thinking_mode'), 'deep')
        self.assertIsNone(session.model_param_overrides.get('reasoning_effort'))
        self.assertNotIn('resolved', session.model_param_overrides)

    def test_update_model_params_v1_write_v2_storage_and_compat_read(self):
        session = ChatSession.objects.create(
            user=self.user,
            organization_id='test',
            title='w2b params',
            current_model_id=self.model_a.id,
            default_model_id=self.model_a.id,
        )

        response = self.client.put(
            f'/api/chat/sessions/{session.id}/model-params',
            data=json.dumps({
                'model_param_overrides': {'reasoning_effort': 'high'},
            }),
            content_type='application/json',
            **self.auth_headers,
        )
        self.assertEqual(response.status_code, 200, response.content)
        body = response.json()
        payload = body.get('data', body)
        overrides = payload['model_param_overrides']
        self.assertEqual(overrides['v'], 2)
        self.assertEqual(overrides['thinking_mode'], 'deep')
        # 响应投影给旧客户端
        self.assertEqual(overrides['reasoning_effort'], 'high')

        session.refresh_from_db()
        # 库内单事实源:无等价 high
        self.assertEqual(session.model_param_overrides['thinking_mode'], 'deep')
        self.assertIsNone(session.model_param_overrides['reasoning_effort'])
