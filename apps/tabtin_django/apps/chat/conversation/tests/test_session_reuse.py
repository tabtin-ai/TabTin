import json
import uuid
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone

from apps.chat.conversation.models import ChatSession
from apps.services.llm.models import LLMModel, LLMProvider
from apps.tabtinspace.models import Agent, Space, Organization
from apps.users.auth.models import UserSession
from apps.users.auth.session_manager import SessionManager
from apps.users.auth.utils import generate_jwt_token

User = get_user_model()


class CreateSessionReuseTests(TestCase):
    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from django.db.models.signals import post_save
        from apps.tabtinspace.signals import create_default_organization

        post_save.disconnect(create_default_organization, sender=User)

    @classmethod
    def tearDownClass(cls):
        from django.db.models.signals import post_save
        from apps.tabtinspace.signals import create_default_organization

        post_save.connect(create_default_organization, sender=User)
        super().tearDownClass()

    def setUp(self):
        self.user = User.objects.create_user(
            username="reuse-user",
            email="reuse@example.com",
            password="testpass123",
        )
        self.raw_session_key = "session_reuse_test_key_0000000000000001"
        UserSession.objects.create(
            user=self.user,
            session_key=SessionManager.hash_session_key(self.raw_session_key),
            session_type="web",
            ip_address="127.0.0.1",
            user_agent="session-reuse-test-agent",
            device_info={},
            expires_at=timezone.now() + timedelta(hours=24),
            is_active=True,
        )
        self.token = generate_jwt_token(
            self.user,
            expire_hours=1,
            token_type="access",
            session_key=self.raw_session_key,
        )
        self.auth_headers = {
            "HTTP_AUTHORIZATION": f"Bearer {self.token}",
        }

        self.organization = Organization.objects.create(
            name="Reuse Team",
            owner=self.user,
            is_default=False,
            type=Organization.OrganizationType.TEAM,
        )
        self.agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name="Reuse Agent",
            type="bot",
            is_active=True,
        )
        self.space = Space.objects.create(
            organization=self.organization,
            agent=self.agent,
            type=Space.SpaceType.BOT,
            name="Reuse Team Space",
            status="active",
        )

        self.provider = LLMProvider.objects.create(
            name="reuse-provider",
            display_name="Reuse Provider",
            api_key="test-key",
            capability_domains=["chat"],
            base_url="https://example.com/v1",
            is_global=True,
            is_active=True,
        )
        self.model = LLMModel.objects.create(
            id=uuid.uuid4(),
            provider=self.provider,
            model_name="reuse-model",
            display_name="Reuse Model",
            description="reuse test model",
            max_tokens=32000,
            supports_streaming=True,
            is_active=True,
        )

    def _post(self, url, data):
        return self.client.post(
            url,
            data=json.dumps(data),
            content_type="application/json",
            **self.auth_headers,
        )

    def test_create_session_does_not_reuse_existing_empty_session(self):
        """产品决策：「+ 新对话」一定建新，不再复用空 session。

        老语义：同用户同 Space 有"无消息且 active"的旧 session 时，POST /sessions
        会复用它（只覆盖 current_model_id）。问题：旧 session 可能带 revert_message_id /
        旧 thread_id / 旧 tracker_run 关联，用户以为在新对话里实际落到了有遗留状态
        的旧 session 上，对话表现诡异（譬如显示"已回退到历史版本"横幅）。

        新语义：每次 createSession 都建一行新 ChatSession。空 session 由 GC 兜底。
        """
        existing = ChatSession.objects.create(
            user=self.user,
            organization_id=str(self.organization.id),
            space_id=self.space.id,
            title="新对话",
        )

        response = self._post("/api/chat/sessions", {
            "space_id": str(self.space.id),
            "organization_id": str(self.organization.id),
            "model_id": str(self.model.id),
        })

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        data = payload.get("data", payload)

        # 新 session 必须有不同的 ID（确认没有复用）
        self.assertNotEqual(data["id"], str(existing.id))
        # DB 里同 (user, space, active) 应该有 2 行——旧的 + 新建的
        self.assertEqual(
            ChatSession.objects.filter(
                user=self.user,
                organization_id=str(self.organization.id),
                space_id=self.space.id,
                status="active",
            ).count(),
            2,
        )

        # 旧 session 不应该被改动 model 字段
        existing.refresh_from_db()
        self.assertIsNone(existing.current_model_id)
        self.assertIsNone(existing.default_model_id)
