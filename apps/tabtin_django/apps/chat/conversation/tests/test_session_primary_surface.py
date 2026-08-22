"""ChatSession.primary_surface：策略纯函数 + 弱写入 + 强证据升格 + 列表透出。"""

from datetime import timedelta
from types import SimpleNamespace
from unittest import mock
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase, override_settings
from django.utils import timezone

from apps.chat.conversation.api._common import _session_to_schema
from apps.chat.conversation.api.context import update_context
from apps.chat.conversation.models import ChatSession
from apps.chat.conversation.schemas import (
    ChatSessionSchema,
    ChatSessionWithAgentSchema,
    UpdateContextRequest,
)
from apps.chat.conversation.services.session_surface_policy import (
    DEFAULT_SURFACE,
    app_type_to_surface,
    apply_weak_primary_surface_from_app_type,
    normalize_surface,
    promote_session_from_app_id,
    promote_session_from_resource_type,
    promote_session_primary_surface,
    promote_surface,
    resource_type_to_surface,
    session_id_from_thread_id,
)
from apps.users.auth.models import UserSession
from apps.users.auth.session_manager import SessionManager
from apps.users.auth.utils import generate_jwt_token

User = get_user_model()


class SessionSurfacePolicyTests(SimpleTestCase):
    """纯函数：映射 / 归一 / 强证据 promote。"""

    def test_default_and_unknown_normalize_to_chat(self):
        self.assertEqual(normalize_surface(None), 'chat')
        self.assertEqual(normalize_surface(''), 'chat')
        self.assertEqual(normalize_surface('bogus'), 'chat')
        self.assertEqual(normalize_surface('DOC'), 'doc')

    def test_app_type_mapping(self):
        self.assertEqual(app_type_to_surface('tabdoc'), 'doc')
        self.assertEqual(app_type_to_surface('tabdata'), 'doc')
        self.assertEqual(app_type_to_surface('tabweb'), 'browser')
        self.assertEqual(app_type_to_surface('browser'), 'browser')
        self.assertEqual(app_type_to_surface('tabcode'), 'code')
        self.assertIsNone(app_type_to_surface('tabmemo'))
        self.assertIsNone(app_type_to_surface('tracker'))
        self.assertIsNone(app_type_to_surface(''))
        self.assertIsNone(app_type_to_surface(None))

    def test_resource_type_mapping(self):
        self.assertEqual(resource_type_to_surface('docs'), 'doc')
        self.assertEqual(resource_type_to_surface('table'), 'doc')
        self.assertEqual(resource_type_to_surface('file'), 'code')
        self.assertIsNone(resource_type_to_surface('slide'))
        self.assertIsNone(resource_type_to_surface('canvas'))
        self.assertIsNone(resource_type_to_surface('tabtracker'))
        self.assertIsNone(resource_type_to_surface(None))

    def test_promote_matrix_chat_to_doc_to_browser_to_doc(self):
        """覆盖矩阵：chat→doc、doc→browser、browser→doc、code 不被 chat 打回。"""
        self.assertEqual(promote_surface('chat', 'doc'), 'doc')
        self.assertEqual(promote_surface('doc', 'browser'), 'browser')
        self.assertEqual(promote_surface('browser', 'doc'), 'doc')
        self.assertEqual(promote_surface('code', 'browser'), 'browser')
        self.assertEqual(promote_surface('code', 'chat'), 'code')

    def test_promote_chat_does_not_demote(self):
        self.assertEqual(promote_surface('doc', 'chat'), 'doc')
        self.assertEqual(promote_surface('browser', 'chat'), 'browser')

    def test_promote_unknown_evidence_ignored(self):
        self.assertEqual(promote_surface('doc', 'tabtracker'), 'doc')
        self.assertEqual(promote_surface('chat', 'made-up'), 'chat')

    def test_session_id_from_thread_id(self):
        sid = str(uuid4())
        self.assertEqual(session_id_from_thread_id(f'chat-session-{sid}'), sid)
        self.assertIsNone(session_id_from_thread_id('tin-abc'))
        self.assertIsNone(session_id_from_thread_id('browser-xyz'))
        self.assertIsNone(session_id_from_thread_id(None))


class SessionPrimarySurfaceSchemaContractTests(SimpleTestCase):
    def test_schemas_expose_primary_surface_default_chat(self):
        self.assertIn('primary_surface', ChatSessionSchema.model_fields)
        self.assertIn('primary_surface', ChatSessionWithAgentSchema.model_fields)
        self.assertEqual(
            ChatSessionSchema.model_fields['primary_surface'].default,
            'chat',
        )


@override_settings(TABTIN_REQUIRE_INVITE_CODE=False)
class SessionPrimarySurfaceWriteAndListTests(TestCase):
    """弱写入守卫 + list_all_sessions 透出。"""

    databases = {'default', 'postgresql'}

    def setUp(self):
        self.user = User.objects.create_user(
            email='primary_surface@example.com',
            password='testpass',
        )
        self.session = ChatSession.objects.create(
            user=self.user,
            organization_id='org-primary-surface',
            title='surface test',
        )
        self.assertEqual(self.session.primary_surface, DEFAULT_SURFACE)

        self.raw_session_key = 'primary_surface_test_session_key_00000001'
        UserSession.objects.create(
            user=self.user,
            session_key=SessionManager.hash_session_key(self.raw_session_key),
            session_type='web',
            ip_address='127.0.0.1',
            user_agent='primary-surface-test',
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

    def _request(self):
        return SimpleNamespace(auth=self.user)

    def test_new_session_defaults_to_chat(self):
        self.assertEqual(self.session.primary_surface, 'chat')
        schema = _session_to_schema(self.session, message_count=0)
        self.assertEqual(schema.primary_surface, 'chat')

    def test_session_detail_preserves_legacy_frozen_execution_target(self):
        self.session.target_device_id = 'frozen-device'
        self.session.save(update_fields=['target_device_id'])

        schema = _session_to_schema(self.session, message_count=0)

        self.assertEqual(schema.execution_target, {
            'kind': 'bound_device',
            'device_identity_key': 'frozen-device',
        })

    def test_weak_write_maps_app_types(self):
        cases = (
            ('tabdoc', 'doc'),
            ('tabdata', 'doc'),
            ('tabweb', 'browser'),
            ('tabcode', 'code'),
        )
        for app_type, expected in cases:
            with self.subTest(app_type=app_type):
                s = ChatSession.objects.create(
                    user=self.user,
                    organization_id='org-primary-surface',
                    title=f'weak-{app_type}',
                )
                resp = update_context(
                    self._request(),
                    str(s.id),
                    UpdateContextRequest(current_app_type=app_type),
                )
                self.assertTrue(resp['success'])
                s.refresh_from_db()
                self.assertEqual(s.primary_surface, expected)

    def test_weak_write_skips_unmapped_app_type(self):
        resp = update_context(
            self._request(),
            str(self.session.id),
            UpdateContextRequest(current_app_type='tabmemo'),
        )
        self.assertTrue(resp['success'])
        self.session.refresh_from_db()
        self.assertEqual(self.session.primary_surface, 'chat')

    def test_weak_write_does_not_override_non_chat(self):
        self.session.primary_surface = 'browser'
        self.session.save(update_fields=['primary_surface'])

        resp = update_context(
            self._request(),
            str(self.session.id),
            UpdateContextRequest(current_app_type='tabdoc'),
        )
        self.assertTrue(resp['success'])
        self.session.refresh_from_db()
        self.assertEqual(self.session.primary_surface, 'browser')

        # 直接调守卫函数也应拒绝
        changed = apply_weak_primary_surface_from_app_type(self.session, 'tabcode')
        self.assertFalse(changed)
        self.session.refresh_from_db()
        self.assertEqual(self.session.primary_surface, 'browser')

    def test_list_all_sessions_emits_primary_surface(self):
        self.session.primary_surface = 'code'
        self.session.save(update_fields=['primary_surface'])

        with mock.patch(
            'apps.chat.conversation.api.session._batch_resolve_tracker_run_meta',
            return_value={},
        ):
            resp = self.client.get(
                '/api/chat/sessions/all'
                f'?organization_id={self.session.organization_id}&limit=50',
                **self.auth_headers,
            )
        self.assertEqual(resp.status_code, 200, resp.content)
        body = resp.json()
        self.assertTrue(body.get('success'), body)
        sessions = (body.get('data') or {}).get('sessions') or []
        match = next((s for s in sessions if s['id'] == str(self.session.id)), None)
        self.assertIsNotNone(match, sessions)
        self.assertEqual(match['primary_surface'], 'code')

    def test_promote_session_matrix_persists(self):
        sid = str(self.session.id)
        self.assertTrue(promote_session_primary_surface(sid, 'doc'))
        self.session.refresh_from_db()
        self.assertEqual(self.session.primary_surface, 'doc')

        self.assertTrue(promote_session_primary_surface(sid, 'browser'))
        self.session.refresh_from_db()
        self.assertEqual(self.session.primary_surface, 'browser')

        self.assertTrue(promote_session_primary_surface(sid, 'doc'))
        self.session.refresh_from_db()
        self.assertEqual(self.session.primary_surface, 'doc')

        # chat 不降级
        self.assertFalse(promote_session_primary_surface(sid, 'chat'))
        self.session.refresh_from_db()
        self.assertEqual(self.session.primary_surface, 'doc')

    def test_record_change_hook_promotes_and_list_emits(self):
        """集成：模拟产物 ChangeLog（docs）后会话升格，list 透出变化。"""
        from apps.collab.api import record_change

        self.assertEqual(self.session.primary_surface, 'chat')
        resource_id = uuid4()

        with mock.patch('apps.collab.models.ChangeLog') as mock_cl:
            mock_cl.objects.using.return_value.create.return_value = SimpleNamespace(
                id=uuid4(),
            )
            record_change(
                'docs',
                resource_id,
                change_type='create',
                session_id=str(self.session.id),
                summary='phase-c-doc-create',
            )

        self.session.refresh_from_db()
        self.assertEqual(self.session.primary_surface, 'doc')

        # 最近强证据覆盖：browser 工具 app_id
        self.assertTrue(
            promote_session_from_app_id(str(self.session.id), 'browser')
        )
        self.session.refresh_from_db()
        self.assertEqual(self.session.primary_surface, 'browser')

        with mock.patch(
            'apps.chat.conversation.api.session._batch_resolve_tracker_run_meta',
            return_value={},
        ):
            resp = self.client.get(
                '/api/chat/sessions/all'
                f'?organization_id={self.session.organization_id}&limit=50',
                **self.auth_headers,
            )
        self.assertEqual(resp.status_code, 200, resp.content)
        body = resp.json()
        sessions = (body.get('data') or {}).get('sessions') or []
        match = next((s for s in sessions if s['id'] == str(self.session.id)), None)
        self.assertIsNotNone(match, sessions)
        self.assertEqual(match['primary_surface'], 'browser')

    def test_unmapped_resource_type_does_not_promote(self):
        self.assertFalse(
            promote_session_from_resource_type(str(self.session.id), 'slide')
        )
        self.session.refresh_from_db()
        self.assertEqual(self.session.primary_surface, 'chat')
