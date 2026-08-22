"""``/sessions/{id}/generate-title`` —  必带 user_message，不读库正文。"""
from __future__ import annotations

import asyncio
import os
from json import loads as json_loads
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")
if not django.apps.apps.ready:
    django.setup()

from django.test import SimpleTestCase  # noqa: E402

from apps.chat.conversation.api import session as session_api  # noqa: E402
from apps.chat.conversation.schemas import GenerateTitleRequest  # noqa: E402
from apps.chat.conversation.services.title_generator import TitleGeneratorService  # noqa: E402


def _run_async(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _build_mock_request():
    request = MagicMock()
    request.auth = MagicMock(id="u-1")
    request.headers = {}
    request.META = {}
    request.request_id = None
    return request


def _patch_session(*, session):
    mock_objects = MagicMock()
    mock_qs = MagicMock()
    mock_qs.first.return_value = session
    mock_objects.filter.return_value = mock_qs
    return patch(
        "apps.chat.conversation.api.session.ChatSession.objects",
        mock_objects,
    )


def _unwrap_response(response) -> dict:
    assert isinstance(response, dict), f"expect dict response, got {type(response)}"
    if "data" in response:
        return response["data"]
    return response


class TestGenerateTitleFireAndForget(SimpleTestCase):
    _FF_PATH = "apps.services.common.executor.fire_and_forget_in_agent_executor"
    _ENSURE_PATH = "apps.services.agent_engine.services.persistence_pipeline.ensure_thread_id"
    _TGS_PATH = "apps.chat.conversation.services.title_generator.TitleGeneratorService"

    def test_view_schedules_with_request_user_message(self):
        sess = MagicMock(id="sess-fast", title="新对话", user_id="u-1")
        sess.id = "sess-fast"
        captured: dict = {}
        with _patch_session(session=sess):
            with (
                patch(f"{self._TGS_PATH}.should_auto_generate_title", return_value=True),
                patch(self._ENSURE_PATH, return_value="chat-session-sess-fast"),
                patch(self._FF_PATH, side_effect=lambda fn: captured.update({"fn": fn})) as mock_ff,
            ):
                response = _run_async(
                    session_api.generate_title(
                        _build_mock_request(),
                        "sess-fast",
                        data=GenerateTitleRequest(user_message="你好"),
                    )
                )

        body = _unwrap_response(response)
        self.assertIs(body["accepted"], True)
        mock_ff.assert_called_once()
        fn = captured["fn"]
        self.assertEqual(fn.keywords["session_id"], "sess-fast")
        self.assertEqual(fn.keywords["thread_id"], "chat-session-sess-fast")
        self.assertEqual(fn.keywords["user_message"], "你好")
        self.assertEqual(fn.keywords["user_id"], "u-1")
        self.assertIs(fn.keywords["force"], False)

    def test_view_accepts_camel_case_model_id_and_propagates_it(self):
        sess = MagicMock(id="sess-model", title="新对话", user_id="u-1")
        sess.id = "sess-model"
        captured: dict = {}
        data = GenerateTitleRequest.model_validate({
            "user_message": "你好",
            "modelId": "model-byok",
        })

        with _patch_session(session=sess):
            with (
                patch(f"{self._TGS_PATH}.should_auto_generate_title", return_value=True),
                patch(self._ENSURE_PATH, return_value="chat-session-sess-model"),
                patch(self._FF_PATH, side_effect=lambda fn: captured.update({"fn": fn})),
            ):
                response = _run_async(
                    session_api.generate_title(
                        _build_mock_request(),
                        "sess-model",
                        data=data,
                    )
                )

        self.assertIs(_unwrap_response(response)["accepted"], True)
        self.assertEqual(data.model_id, "model-byok")
        self.assertEqual(
            captured["fn"].keywords["selected_model_id"],
            "model-byok",
        )

    def test_request_accepts_snake_case_model_id(self):
        data = GenerateTitleRequest.model_validate({
            "user_message": "你好",
            "model_id": "model-snake",
        })

        self.assertEqual(data.model_id, "model-snake")

    def test_accepted_false_when_already_has_title(self):
        sess = MagicMock(id="sess-2", title="已有标题", user_id="u-1")
        sess.id = "sess-2"
        with _patch_session(session=sess):
            with (
                patch(f"{self._TGS_PATH}.should_auto_generate_title", return_value=False),
                patch(self._FF_PATH) as mock_ff,
            ):
                response = _run_async(
                    session_api.generate_title(
                        _build_mock_request(),
                        "sess-2",
                        data=GenerateTitleRequest(user_message="hi"),
                    )
                )

        body = _unwrap_response(response)
        self.assertIs(body["accepted"], False)
        self.assertEqual(body["reason"], "already_has_title")
        mock_ff.assert_not_called()

    def test_accepted_false_when_empty_user_message(self):
        sess = MagicMock(id="sess-3", title="新对话", user_id="u-1")
        sess.id = "sess-3"
        with _patch_session(session=sess):
            with patch(self._FF_PATH) as mock_ff:
                response = _run_async(
                    session_api.generate_title(
                        _build_mock_request(),
                        "sess-3",
                        data=GenerateTitleRequest(user_message="   "),
                    )
                )

        body = _unwrap_response(response)
        self.assertIs(body["accepted"], False)
        self.assertEqual(body["reason"], "empty_user_message")
        mock_ff.assert_not_called()

    def test_force_true_bypasses_already_has_title_check(self):
        sess = MagicMock(id="sess-4", title="已有标题", user_id="u-1")
        sess.id = "sess-4"
        captured: dict = {}
        with _patch_session(session=sess):
            with (
                patch(f"{self._TGS_PATH}.should_auto_generate_title", return_value=False),
                patch(self._ENSURE_PATH, return_value="chat-session-sess-4"),
                patch(self._FF_PATH, side_effect=lambda fn: captured.update({"fn": fn})),
            ):
                response = _run_async(
                    session_api.generate_title(
                        _build_mock_request(),
                        "sess-4",
                        data=GenerateTitleRequest(user_message="Test", force=True),
                    )
                )

        body = _unwrap_response(response)
        self.assertIs(body["accepted"], True)
        self.assertIs(captured["fn"].keywords["force"], True)
        self.assertEqual(captured["fn"].keywords["user_message"], "Test")

    def test_session_not_found_returns_404(self):
        with _patch_session(session=None):
            response = _run_async(
                session_api.generate_title(
                    _build_mock_request(),
                    "missing",
                    data=GenerateTitleRequest(user_message="x"),
                )
            )

        if isinstance(response, tuple):
            status_code, body = response
        else:
            status_code = response.status_code
            body = json_loads(response.content.decode("utf-8"))
        self.assertEqual(status_code, 404)
        self.assertEqual(body.get("code"), "NOT_FOUND")


class TestDispatchTitleGenerationSyncFirst(SimpleTestCase):
    _PP = "apps.services.agent_engine.services.persistence_pipeline"
    _SPAWN_PATH = f"{_PP}.spawn_title_thread"
    _LOCK_PATH = f"{_PP}._try_mark_title_in_progress"
    _GEN_PATH = (
        "apps.chat.conversation.services.title_generator."
        "TitleGeneratorService.generate_title"
    )
    _AUTO_PATH = (
        "apps.chat.conversation.services.title_generator."
        "TitleGeneratorService.should_auto_generate_title"
    )
    _PUBLISH_PATH = "apps.services.common.chat_stream_publisher.ChatStreamPublisher.publish_title_update"
    _MARK_FAILED = "apps.chat.conversation.tasks._mark_title_generation_failed"

    def _dispatch(self):
        from apps.services.agent_engine.services.persistence_pipeline import (
            dispatch_title_generation_sync_first,
        )
        return dispatch_title_generation_sync_first

    def test_sync_success_uses_request_body_and_skips_spawn(self):
        sess = MagicMock(id="sess-sync", title="新对话", title_generation_status="pending")
        with (
            patch("apps.chat.conversation.models.ChatSession.objects") as mock_objects,
            patch(self._AUTO_PATH, return_value=True),
            patch(self._LOCK_PATH, return_value=True) as mock_lock,
            patch(self._GEN_PATH, return_value="问候") as mock_gen,
            patch(self._PUBLISH_PATH) as mock_publish,
            patch(self._SPAWN_PATH) as mock_spawn,
        ):
            mock_objects.filter.return_value.first.return_value = sess
            self._dispatch()("sess-sync", "thread-1", "你好", "u-1", force=False)

        mock_lock.assert_called_once()
        mock_gen.assert_called_once_with(
            [{"role": "user", "content": "你好"}],
            session=sess,
        )
        mock_publish.assert_called_once()
        mock_spawn.assert_not_called()
        self.assertEqual(sess.title, "问候")
        sess.save.assert_called_once()

    def test_sync_generation_propagates_selected_model(self):
        sess = MagicMock(id="sess-model", title="新对话", title_generation_status="pending")
        with (
            patch("apps.chat.conversation.models.ChatSession.objects") as mock_objects,
            patch(self._AUTO_PATH, return_value=True),
            patch(self._LOCK_PATH, return_value=True),
            patch(self._GEN_PATH, return_value="问候") as mock_gen,
            patch(self._PUBLISH_PATH),
        ):
            mock_objects.filter.return_value.first.return_value = sess
            self._dispatch()(
                "sess-model",
                "thread-model",
                "你好",
                "u-1",
                force=False,
                selected_model_id="model-byok",
            )

        mock_gen.assert_called_once_with(
            [{"role": "user", "content": "你好"}],
            session=sess,
            requested_model_id="model-byok",
        )

    def test_sync_failure_marks_failed_without_celery_fallback(self):
        sess = MagicMock(id="sess-fail", title="新对话", title_generation_status="pending")
        with (
            patch("apps.chat.conversation.models.ChatSession.objects") as mock_objects,
            patch(self._AUTO_PATH, return_value=True),
            patch(self._LOCK_PATH, return_value=True),
            patch(self._GEN_PATH, return_value=None),
            patch(self._PUBLISH_PATH) as mock_publish,
            patch(self._SPAWN_PATH) as mock_spawn,
            patch(self._MARK_FAILED) as mock_failed,
        ):
            mock_objects.filter.return_value.first.return_value = sess
            self._dispatch()("sess-fail", "thread-2", "你好", "u-1", force=False)

        mock_publish.assert_not_called()
        mock_spawn.assert_not_called()
        mock_failed.assert_called_once_with("sess-fail", reason="llm_returned_empty")

    def test_already_has_title_skips_generation(self):
        sess = MagicMock(id="sess-done", title="已有标题", title_generation_status="done")
        with (
            patch("apps.chat.conversation.models.ChatSession.objects") as mock_objects,
            patch(self._AUTO_PATH, return_value=False),
            patch(self._LOCK_PATH) as mock_lock,
            patch(self._GEN_PATH) as mock_gen,
            patch(self._PUBLISH_PATH) as mock_publish,
            patch(self._SPAWN_PATH) as mock_spawn,
        ):
            mock_objects.filter.return_value.first.return_value = sess
            self._dispatch()("sess-done", "thread-3", "你好", "u-1", force=False)

        mock_lock.assert_not_called()
        mock_gen.assert_not_called()
        mock_publish.assert_not_called()
        mock_spawn.assert_not_called()

    def test_lock_not_acquired_skips_generation(self):
        sess = MagicMock(id="sess-locked", title="新对话", title_generation_status="pending")
        with (
            patch("apps.chat.conversation.models.ChatSession.objects") as mock_objects,
            patch(self._AUTO_PATH, return_value=True),
            patch(self._LOCK_PATH, return_value=False) as mock_lock,
            patch(self._GEN_PATH) as mock_gen,
            patch(self._PUBLISH_PATH) as mock_publish,
            patch(self._SPAWN_PATH) as mock_spawn,
        ):
            mock_objects.filter.return_value.first.return_value = sess
            self._dispatch()("sess-locked", "thread-4", "你好", "u-1", force=False)

        mock_lock.assert_called_once()
        mock_gen.assert_not_called()
        mock_publish.assert_not_called()
        mock_spawn.assert_not_called()


class TestCommunityTitleModelSelection(SimpleTestCase):
    _UNIFIED_CALL = "apps.services.llm.services.chat.unified_llm_call"

    def test_title_scene_allows_user_selected_byok(self):
        from apps.services.llm.scenes.registry import SCENES
        from apps.services.llm.scenes.types import ModelSource, ScenePayer

        policy = SCENES["title_generation"].policy

        self.assertEqual(policy.payer, ScenePayer.USER)
        self.assertIn(ModelSource.BYOK, policy.allowed_model_sources)

    def test_session_current_model_wins_and_reaches_unified_call(self):
        model = SimpleNamespace(id="model-current", provider=SimpleNamespace())
        session = SimpleNamespace(
            current_model_id="model-current",
            user_id="user-1",
            organization_id="org-1",
            user=SimpleNamespace(id="user-1"),
        )

        with (
            patch(
                "apps.services.llm.services.model_resolver.resolve_model",
                return_value=model,
            ),
            patch(
                "apps.services.llm.services.model_resolver.is_model_visible_for_user",
                return_value=True,
            ),
            patch(
                "apps.services.llm.scenes.capability_check.check_model_capability_match",
                return_value=None,
            ),
            patch(
                "apps.services.llm.api_common._read_user_default_model_id",
                return_value="model-user-default",
            ),
            patch(
                "apps.services.llm.api_common._get_organization_default_model_id",
                return_value="model-org-default",
            ),
            patch(
                self._UNIFIED_CALL,
                return_value=SimpleNamespace(content="当前模型标题"),
            ) as unified_call,
        ):
            title = TitleGeneratorService.generate_title(
                [{"role": "user", "content": "你好"}],
                session=session,
            )

        self.assertEqual(title, "当前模型标题")
        self.assertEqual(
            unified_call.call_args.kwargs["selected_model_id"],
            "model-current",
        )

    def test_missing_model_uses_clean_local_title(self):
        session = SimpleNamespace(
            current_model_id=None,
            user_id="",
            organization_id="",
            user=None,
        )

        title = TitleGeneratorService.generate_title(
            [{"role": "user", "content": "  # 帮我   制定开源计划  "}],
            session=session,
        )

        self.assertEqual(title, "帮我 制定开源计划")
        self.assertLessEqual(len(title), 20)

    def test_requested_model_precedes_user_and_organization_defaults(self):
        requested_model = SimpleNamespace(
            id="model-requested",
            provider=SimpleNamespace(),
        )
        session = SimpleNamespace(
            current_model_id=None,
            user_id="user-1",
            organization_id="org-1",
            user=SimpleNamespace(id="user-1"),
        )

        with (
            patch(
                "apps.services.llm.services.model_resolver.resolve_model",
                return_value=requested_model,
            ),
            patch(
                "apps.services.llm.services.model_resolver.is_model_visible_for_user",
                return_value=True,
            ),
            patch(
                "apps.services.llm.scenes.capability_check.check_model_capability_match",
                return_value=None,
            ),
            patch(
                "apps.services.llm.api_common._read_user_default_model_id",
            ) as read_user_default,
            patch(
                "apps.services.llm.api_common._get_organization_default_model_id",
            ) as read_org_default,
            patch(
                self._UNIFIED_CALL,
                return_value=SimpleNamespace(content="请求模型标题"),
            ) as unified_call,
        ):
            title = TitleGeneratorService.generate_title(
                [{"role": "user", "content": "你好"}],
                session=session,
                requested_model_id="model-requested",
            )

        self.assertEqual(title, "请求模型标题")
        self.assertEqual(
            unified_call.call_args.kwargs["selected_model_id"],
            "model-requested",
        )
        read_user_default.assert_not_called()
        read_org_default.assert_not_called()

    def test_user_default_precedes_organization_default(self):
        user_default_model = SimpleNamespace(
            id="model-user-default",
            provider=SimpleNamespace(),
        )
        session = SimpleNamespace(
            current_model_id=None,
            user_id="user-1",
            organization_id="org-1",
            user=SimpleNamespace(id="user-1"),
        )

        with (
            patch(
                "apps.services.llm.services.model_resolver.resolve_model",
                return_value=user_default_model,
            ),
            patch(
                "apps.services.llm.services.model_resolver.is_model_visible_for_user",
                return_value=True,
            ),
            patch(
                "apps.services.llm.scenes.capability_check.check_model_capability_match",
                return_value=None,
            ),
            patch(
                "apps.services.llm.api_common._read_user_default_model_id",
                return_value="model-user-default",
            ),
            patch(
                "apps.services.llm.api_common._get_organization_default_model_id",
            ) as read_org_default,
            patch(
                self._UNIFIED_CALL,
                return_value=SimpleNamespace(content="用户默认标题"),
            ) as unified_call,
        ):
            title = TitleGeneratorService.generate_title(
                [{"role": "user", "content": "你好"}],
                session=session,
            )

        self.assertEqual(title, "用户默认标题")
        self.assertEqual(
            unified_call.call_args.kwargs["selected_model_id"],
            "model-user-default",
        )
        read_org_default.assert_not_called()

    def test_organization_default_is_final_model_choice(self):
        organization_default_model = SimpleNamespace(
            id="model-org-default",
            provider=SimpleNamespace(),
        )
        session = SimpleNamespace(
            current_model_id=None,
            user_id="user-1",
            organization_id="org-1",
            user=SimpleNamespace(id="user-1"),
        )

        def resolve_candidate(*, model_id, **_kwargs):
            if model_id == "model-org-default":
                return organization_default_model
            return None

        with (
            patch(
                "apps.services.llm.services.model_resolver.resolve_model",
                side_effect=resolve_candidate,
            ),
            patch(
                "apps.services.llm.services.model_resolver.is_model_visible_for_user",
                side_effect=lambda model, *_args: model is not None,
            ),
            patch(
                "apps.services.llm.scenes.capability_check.check_model_capability_match",
                return_value=None,
            ),
            patch(
                "apps.services.llm.api_common._read_user_default_model_id",
                return_value="model-user-default",
            ),
            patch(
                "apps.services.llm.api_common._get_organization_default_model_id",
                return_value="model-org-default",
            ),
            patch(
                self._UNIFIED_CALL,
                return_value=SimpleNamespace(content="组织默认标题"),
            ) as unified_call,
        ):
            title = TitleGeneratorService.generate_title(
                [{"role": "user", "content": "你好"}],
                session=session,
            )

        self.assertEqual(title, "组织默认标题")
        self.assertEqual(
            unified_call.call_args.kwargs["selected_model_id"],
            "model-org-default",
        )
