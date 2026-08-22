"""
测试模型切换功能 - 使用 UUID 方案
"""
import uuid
import json
from unittest.mock import patch
from django.test import TestCase
from django.contrib.auth import get_user_model
from apps.chat.conversation.models import ChatSession, ChatMessage
from apps.services.llm.models import LLMProvider, LLMModel
from apps.users.auth.utils import generate_jwt_token

User = get_user_model()


class ModelSwitchingTestCase(TestCase):
    """模型切换功能测试 - UUID方案"""

    @classmethod
    def setUpClass(cls):
        """类级别的设置，禁用 tabdata signal"""
        super().setUpClass()
        # 断开 tabdata 的 post_save signal
        from django.db.models.signals import post_save
        from apps.tabdata import signals as tabdata_signals
        cls._tabdata_user_signal = getattr(tabdata_signals, 'create_default_organization', None)
        if cls._tabdata_user_signal:
            post_save.disconnect(cls._tabdata_user_signal, sender=User)

    @classmethod
    def tearDownClass(cls):
        """类级别的清理，恢复 tabdata signal"""
        super().tearDownClass()
        # 重新连接 signal
        from django.db.models.signals import post_save
        if cls._tabdata_user_signal:
            post_save.connect(cls._tabdata_user_signal, sender=User)

    def setUp(self):
        """测试初始化"""
        # 创建测试用户
        self.user = User.objects.create_user(
            username='testuser',
            email='test@example.com',
            password='testpass123'
        )
        # 生成 JWT token
        self.token = generate_jwt_token(self.user, expire_hours=1)
        self.auth_headers = {
            'HTTP_AUTHORIZATION': f'Bearer {self.token}'
        }

        # 创建测试用的 LLM Provider 和 Models
        self.openai_provider = LLMProvider.objects.create(
            name='openai',
            display_name='OpenAI',
            api_key='test-key',
            base_url='https://api.openai.com/v1',
            is_global=True,
            is_active=True
        )

        self.gpt4o_model = LLMModel.objects.create(
            id=uuid.uuid4(),
            provider=self.openai_provider,
            model_name='gpt-4o',
            display_name='GPT-4 Omni',
            description='GPT-4 Omni 模型',
            max_tokens=128000,
            supports_streaming=True,
            supports_vision=True,
            is_active=True
        )

        self.qwen_provider = LLMProvider.objects.create(
            name='qwen',
            display_name='通义千问',
            api_key='test-key',
            base_url='https://dashscope.aliyuncs.com/compatible-mode/v1',
            is_global=True,
            is_active=True
        )

        self.qwen_model = LLMModel.objects.create(
            id=uuid.uuid4(),
            provider=self.qwen_provider,
            model_name='qwen-max',
            display_name='Qwen Max',
            description='通义千问最强模型',
            max_tokens=8000,
            supports_streaming=True,
            is_active=True
        )

    def _get(self, url):
        """带认证的 GET 请求"""
        return self.client.get(url, **self.auth_headers)

    def _post(self, url, data):
        """带认证的 POST 请求"""
        return self.client.post(url, data=json.dumps(data), content_type='application/json', **self.auth_headers)

    def _put(self, url, data):
        """带认证的 PUT 请求"""
        return self.client.put(url, data=json.dumps(data), content_type='application/json', **self.auth_headers)

    def test_get_available_models(self):
        """测试获取可用模型目录"""
        response = self._get('/api/services/llm/catalog?use_case=chat')

        self.assertEqual(response.status_code, 200)
        data = response.json()

        # 验证响应结构
        self.assertIn('models', data)
        self.assertIn('default_model_id', data)
        self.assertIn('default_model_name', data)
        self.assertIn('total', data)
        self.assertIsInstance(data['models'], list)

        # 验证至少有我们创建的两个模型
        self.assertGreaterEqual(data['total'], 2)

        # 验证模型包含 UUID
        for model in data['models']:
            self.assertIn('id', model)
            self.assertIn('name', model)
            # 验证 id 是有效的 UUID
            try:
                uuid.UUID(model['id'])
            except ValueError:
                self.fail(f"模型 ID 不是有效的 UUID: {model['id']}")

        print(f"✅ 测试通过：获取到 {data['total']} 个可用模型，均包含有效的 UUID")

    def test_create_session_with_model_id(self):
        """测试创建会话时使用 model_id 指定模型"""
        response = self._post('/api/chat/sessions', {
            'title': '测试会话',
            'organization_id': 'test',
            'model_id': str(self.gpt4o_model.id)
        })

        if response.status_code != 200:
            print(f"错误响应: {response.status_code} - {response.json()}")

        self.assertEqual(response.status_code, 200)
        data = response.json()

        # 验证返回的会话信息包含 model_id 和 model_name
        self.assertIn('id', data)
        self.assertEqual(data['current_model_id'], str(self.gpt4o_model.id))
        self.assertEqual(data['current_model_name'], 'gpt-4o')
        self.assertEqual(data['default_model_id'], str(self.gpt4o_model.id))

        # 验证数据库记录（v0.1：current_model 是软引用 property）
        session = ChatSession.objects.get(id=data['id'])
        self.assertEqual(session.current_model_id, self.gpt4o_model.id)
        self.assertEqual(session.default_model_id, self.gpt4o_model.id)
        self.assertEqual(session.current_model.id, self.gpt4o_model.id)
        self.assertEqual(session.default_model.id, self.gpt4o_model.id)

        print(f"✅ 测试通过：成功创建会话并指定模型 {session.current_model.model_name} (UUID: {session.current_model.id})")

    def test_switch_model_with_uuid(self):
        """测试使用 UUID 切换模型"""
        # 先创建一个会话
        session = ChatSession.objects.create(
            user=self.user,
            organization_id='test',
            title='测试会话',
            current_model_id=self.gpt4o_model.id,
            default_model_id=self.gpt4o_model.id,
        )

        # 切换到另一个模型（使用 UUID）
        response = self._put(f'/api/chat/sessions/{session.id}/model', {
            'model_id': str(self.qwen_model.id)
        })

        if response.status_code != 200:
            print(f"切换模型错误响应: {response.status_code} - {response.json()}")

        self.assertEqual(response.status_code, 200)
        data = response.json()

        # 验证返回数据包含 UUID 和名称
        self.assertEqual(data['session_id'], str(session.id))
        self.assertEqual(data['previous_model_id'], str(self.gpt4o_model.id))
        self.assertEqual(data['previous_model_name'], 'gpt-4o')
        self.assertEqual(data['current_model_id'], str(self.qwen_model.id))
        self.assertEqual(data['current_model_name'], 'qwen-max')

        # 验证数据库记录（v0.1：current_model_id 是软引用 UUIDField）
        session.refresh_from_db()
        self.assertEqual(session.current_model_id, self.qwen_model.id)

        print(f"✅ 测试通过：成功从 {data['previous_model_name']} 切换到 {data['current_model_name']}（使用 UUID）")

    @patch("apps.services.common.ws.bus.publish_ws_event")
    def test_switch_model_notifies_active_session_observers(self, mock_publish):
        from django.utils import timezone
        from apps.users.auth.models import UserSession
        from apps.users.auth.session_manager import SessionManager

        raw_session_key = 'model_sync_test_session_key_00000001'
        UserSession.objects.create(
            user=self.user,
            session_key=SessionManager.hash_session_key(raw_session_key),
            session_type='web',
            ip_address='127.0.0.1',
            user_agent='model-sync-test',
            device_info={},
            expires_at=timezone.now() + timezone.timedelta(hours=1),
            is_active=True,
        )
        token = generate_jwt_token(self.user, expire_hours=1, session_key=raw_session_key)
        self.auth_headers = {'HTTP_AUTHORIZATION': f'Bearer {token}'}
        session = ChatSession.objects.create(
            user=self.user,
            organization_id='test',
            title='共享模型通知',
            current_model_id=self.gpt4o_model.id,
            default_model_id=self.gpt4o_model.id,
        )

        with (
            patch(
                'apps.services.llm.services.model_resolver.resolve_model',
                return_value=self.qwen_model,
            ),
            patch(
                'apps.services.llm.services.capability_guard.is_llm_model_instance',
                return_value=True,
            ),
            patch(
                'apps.chat.conversation.api.session._is_model_visible_for_user',
                return_value=True,
            ),
            patch(
                'apps.users.auth.invite_gate_middleware.is_invite_gate_enabled',
                return_value=False,
            ),
            self.captureOnCommitCallbacks(execute=True),
        ):
            response = self._put(f'/api/chat/sessions/{session.id}/model', {
                'model_id': str(self.qwen_model.id),
            })

        self.assertEqual(response.status_code, 200)
        mock_publish.assert_called_once()
        topic, envelope = mock_publish.call_args.args
        self.assertEqual(topic, f'agent.session.{session.id}')
        self.assertEqual(envelope['type'], 'agent.session.model_changed')
        self.assertEqual(envelope['payload'], {'session_id': str(session.id)})

    def test_switch_model_rejects_declared_id_without_db_model(self):
        """声明式 catalog ID 没有对应 DB 模型时应返回受控 400，而不是 500。"""
        session = ChatSession.objects.create(
            user=self.user,
            organization_id='test',
            title='测试会话',
            current_model_id=self.gpt4o_model.id,
            default_model_id=self.gpt4o_model.id,
        )

        response = self._put(f'/api/chat/sessions/{session.id}/model', {
            'model_id': 'declared:openai:gpt-not-in-db'
        })

        self.assertEqual(response.status_code, 400)
        session.refresh_from_db()
        self.assertEqual(session.current_model_id, self.gpt4o_model.id)

    def test_list_sessions_includes_model_info(self):
        """测试列出会话包含模型 UUID 和名称"""
        # 创建几个会话
        ChatSession.objects.create(
            user=self.user,
            organization_id='test',
            title='GPT-4 会话',
            current_model_id=self.gpt4o_model.id,
            default_model_id=self.gpt4o_model.id,
        )
        ChatSession.objects.create(
            user=self.user,
            organization_id='test',
            title='Qwen 会话',
            current_model_id=self.qwen_model.id,
            default_model_id=self.qwen_model.id,
        )

        # 带 organization_id 参数查询
        response = self._get('/api/chat/sessions?organization_id=test')

        self.assertEqual(response.status_code, 200)
        data = response.json()

        # 验证返回结构
        self.assertIn('sessions', data)
        self.assertIn('total', data)
        sessions = data['sessions']

        # 验证返回的会话包含模型 UUID 和名称
        self.assertGreaterEqual(len(sessions), 2)
        for session in sessions:
            self.assertIn('current_model_id', session)
            self.assertIn('current_model_name', session)
            self.assertIn('default_model_id', session)
            self.assertIn('default_model_name', session)
            # 验证 UUID 格式
            try:
                uuid.UUID(session['current_model_id'])
                uuid.UUID(session['default_model_id'])
            except ValueError:
                self.fail("会话返回的模型 ID 不是有效的 UUID")

        print(f"✅ 测试通过：列出 {len(sessions)} 个会话，均包含模型 UUID 和名称")

    def test_model_relationship_persistence(self):
        """测试模型软引用持久化（v0.1 §5.1：FK→UUIDField + property accessor）"""
        # 创建会话（v0.1：用 _id 字段赋值；不再用 current_model=instance 的 FK 写法）
        session = ChatSession.objects.create(
            user=self.user,
            organization_id='test',
            title='持久化测试',
            current_model_id=self.gpt4o_model.id,
            default_model_id=self.gpt4o_model.id,
        )

        # 创建消息（v0.1：ChatMessage.model_id 软引用 UUIDField）
        message = ChatMessage.objects.create(
            session=session,
            role='user',
            content='测试消息',
            model_id=self.gpt4o_model.id,
        )

        # 从数据库重新读取——v0.1 不能 prefetch_related，property 单点 fallback fetch
        session_from_db = ChatSession.objects.get(id=session.id)
        message_from_db = ChatMessage.objects.get(id=message.id)

        # 验证软引用 property 链式访问（懒查询）
        self.assertEqual(session_from_db.current_model_id, self.gpt4o_model.id)
        self.assertEqual(session_from_db.current_model.id, self.gpt4o_model.id)
        self.assertEqual(session_from_db.current_model.model_name, 'gpt-4o')
        self.assertEqual(session_from_db.default_model_id, self.gpt4o_model.id)
        self.assertEqual(message_from_db.model_id, self.gpt4o_model.id)
        self.assertEqual(message_from_db.model.id, self.gpt4o_model.id)
        self.assertEqual(message_from_db.model.model_name, 'gpt-4o')

        print(f"✅ 测试通过：模型外键关系持久化正常")

    def test_invalid_model_uuid(self):
        """测试使用无效的模型 UUID"""
        invalid_uuid = str(uuid.uuid4())

        response = self._post('/api/chat/sessions', {
            'title': '测试会话',
            'organization_id': 'test',
            'model_id': invalid_uuid
        })

        # 应该返回错误
        self.assertEqual(response.status_code, 400)
        data = response.json()
        self.assertIn('detail', data)

        print(f"✅ 测试通过：正确拒绝无效的模型 UUID - {data['detail']}")

def run_tests():
    """手动运行测试并打印结果"""
    import django
    from django.test.utils import setup_test_environment, teardown_test_environment
    from django.test.runner import DiscoverRunner

    setup_test_environment()
    runner = DiscoverRunner(verbosity=2)
    failures = runner.run_tests(['apps.chat.conversation.tests.test_model_switching'])
    teardown_test_environment()

    return failures == 0


if __name__ == '__main__':
    run_tests()
