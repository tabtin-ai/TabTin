"""
 回归测试：归档会话无法恢复 / 查看。

根因是前端归档管理面板只有查看 + 永久删除，没有把会话恢复回主列表的
入口；后端一直支持通用 ``PUT /chat/sessions/{id} {status: 'active'}``
（与归档时写 ``status='archived'`` 对称），只是前端没接。本测试锁定
后端这段能力链路，防止将来有人在 update_session / list_sessions 里
悄悄加上"archived 不可再改回 active"之类的限制：

  1. 归档后：主列表（``status=active``）不再返回该会话，
     归档列表（``status=archived``）能查到；详情接口（GET /{id}）
     不受 status 影响，仍可"查看"。
  2. 恢复（``PUT status=active``）后：主列表重新包含该会话，
     归档列表不再包含。

测试设计参考 ``test_list_sessions_tracker_bucketing.py`` / ``test_session_reuse.py``：
跨库 fixture 用 ``TransactionTestCase`` + ``databases = {"default", "postgresql"}``。
"""
import uuid
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.test import TransactionTestCase, override_settings
from django.utils import timezone

from apps.chat.conversation.models import ChatSession
from apps.users.auth.models import UserSession
from apps.users.auth.session_manager import SessionManager
from apps.users.auth.utils import generate_jwt_token

User = get_user_model()


@override_settings(TABTIN_REQUIRE_INVITE_CODE=False)
class SessionArchiveRestoreTest(TransactionTestCase):
    """归档 / 恢复会话的完整闭环。"""

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
        from apps.tabtinspace.tests.fixtures import create_test_organization_with_agent
        ctx = create_test_organization_with_agent(prefix="archive_restore")
        self.user = ctx["user"]
        self.organization = ctx["organization"]
        self.space = ctx["space"]

        self.raw_session_key = "archive_restore_test_session_key_00000001"
        UserSession.objects.create(
            user=self.user,
            session_key=SessionManager.hash_session_key(self.raw_session_key),
            session_type="web",
            ip_address="127.0.0.1",
            user_agent="archive-restore-test",
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
        self.auth_headers = {"HTTP_AUTHORIZATION": f"Bearer {self.token}"}

        self.session = ChatSession.objects.create(
            id=uuid.uuid4(),
            user=self.user,
            organization_id=str(self.organization.id),
            space_id=self.space.id if self.space else None,
            title="待归档对话",
            status="active",
        )

    def tearDown(self):
        from apps.tabtinspace.tests.fixtures import cleanup_test_organization
        cleanup_test_organization(self.organization, delete_user=True)

    def _get(self, url):
        return self.client.get(url, **self.auth_headers)

    def _put(self, url, data):
        return self.client.put(url, data=data, content_type="application/json", **self.auth_headers)

    def _list_session_ids(self, status=None):
        url = f"/api/chat/sessions?space_id={self.space.id}&limit=50"
        if status:
            url += f"&status={status}"
        response = self._get(url)
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        data = payload.get("data", payload)
        sessions = data.get("sessions", data if isinstance(data, list) else [])
        return {s["id"] for s in sessions}

    def test_archive_removes_from_active_list_but_visible_via_detail_and_archived_list(self):
        """归档：退出主列表，但归档列表能看到、详情接口仍可查看（ 之"查看"半句）。"""
        session_id = str(self.session.id)

        response = self._put(f"/api/chat/sessions/{session_id}", {"status": "archived"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["data"]["status"], "archived")

        self.assertNotIn(session_id, self._list_session_ids(status="active"))
        self.assertIn(session_id, self._list_session_ids(status="archived"))

        detail = self._get(f"/api/chat/sessions/{session_id}")
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(detail.json()["data"]["status"], "archived")

    def test_restore_moves_session_back_to_active_list(self):
        """恢复：PUT status=active 后会话回到主列表，归档列表不再有它（ 之"恢复"半句）。"""
        session_id = str(self.session.id)
        self._put(f"/api/chat/sessions/{session_id}", {"status": "archived"})
        self.assertNotIn(session_id, self._list_session_ids(status="active"))

        response = self._put(f"/api/chat/sessions/{session_id}", {"status": "active"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["data"]["status"], "active")

        self.assertIn(session_id, self._list_session_ids(status="active"))
        self.assertNotIn(session_id, self._list_session_ids(status="archived"))

    def test_restore_is_idempotent_for_already_active_session(self):
        """会话本来就是 active 时再 PUT status=active 不应报错（防御式覆盖）。"""
        session_id = str(self.session.id)
        response = self._put(f"/api/chat/sessions/{session_id}", {"status": "active"})
        self.assertEqual(response.status_code, 200)
        self.assertIn(session_id, self._list_session_ids(status="active"))
