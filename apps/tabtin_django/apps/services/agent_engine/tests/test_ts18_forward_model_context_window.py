"""
test_ts18_forward_model_context_window.py — TS-18 H2 服务端接通覆盖。

钉死 forward 路径补发模型上下文窗口的两条不变量：

1. ``_resolve_model_capability_fields`` 从 LLMModel SSoT 解出
   ``context_window_tokens`` / ``max_output_tokens``；解析失败（缺省 /
   查无 / 异常）一律返回 ``{}``（客户端走原 fallback，绝不阻断 forward）。
2. ``PromptForwardService.forward_prompt`` 在给定 model_id 时把这两个字段
   真正写入 wire payload —— 修复「forward 路径从不发 context_window_tokens →
   Electron 解析端回落 32k → ~19k skill system prompt 触发 emergency_blocking」。

不连 DB（SimpleTestCase）：LLMModel.objects 全部被 mock。
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.services.agent_engine.services.prompt_forward_service import (
    PromptForwardService,
    _resolve_model_capability_fields,
)


def _make_space(space_id="space-1", organization_id="wt-1", space_type="solo"):
    space = MagicMock()
    space.id = space_id
    space.organization_id = organization_id
    space.type = space_type
    agent = MagicMock()
    agent.id = "agent-1"
    agent.custom_rules = ""
    agent.agent_config = {}
    space.agent = agent
    return space


def _make_model(
    context_window=200000,
    max_output=8192,
    *,
    provider_scope="global",
    supports_zip_input=False,
):
    model = MagicMock()
    model.context_window_tokens = context_window
    model.max_output_tokens_resolved = max_output
    model.capabilities_config = {"supports_zip_input": supports_zip_input}
    model.provider.scope = provider_scope
    return model


def _patch_llm_model(found_model):
    """patch 函数内部惰性 import 的 LLMModel.objects.filter(...).first()。"""
    fake_cls = MagicMock()
    fake_cls.objects.filter.return_value.first.return_value = found_model
    return patch("apps.services.llm.models.LLMModel", fake_cls)


class ResolveModelCapabilityFieldsTests(SimpleTestCase):
    def test_resolves_context_and_output_tokens_from_model(self):
        with _patch_llm_model(_make_model(200000, 8192)):
            fields = _resolve_model_capability_fields("11111111-1111-1111-1111-111111111111")
        self.assertEqual(fields.get("context_window_tokens"), 200000)
        self.assertEqual(fields.get("max_output_tokens"), 8192)

    def test_resolves_zip_input_from_model_config(self):
        with _patch_llm_model(_make_model(supports_zip_input=True)):
            fields = _resolve_model_capability_fields("zip-model")
        self.assertIs(fields.get("supports_zip_input"), True)

    def test_byok_provider_allows_zip_work_files(self):
        for scope in ("organization", "user"):
            with self.subTest(scope=scope), _patch_llm_model(
                _make_model(provider_scope=scope),
            ):
                fields = _resolve_model_capability_fields(f"{scope}-model")
            self.assertIs(fields.get("supports_zip_input"), True)

    def test_missing_model_id_returns_empty(self):
        # 不应触碰 DB —— 直接早返回。
        self.assertEqual(_resolve_model_capability_fields(None), {})
        self.assertEqual(_resolve_model_capability_fields(""), {})

    def test_model_not_found_returns_empty(self):
        with _patch_llm_model(None):
            fields = _resolve_model_capability_fields("does-not-exist")
        self.assertEqual(fields, {})

    def test_non_positive_context_window_returns_empty(self):
        with _patch_llm_model(_make_model(context_window=0, max_output=8192)):
            fields = _resolve_model_capability_fields("zero-ctx")
        self.assertEqual(fields, {})

    def test_db_exception_swallowed_returns_empty(self):
        fake_cls = MagicMock()
        fake_cls.objects.filter.side_effect = RuntimeError("db down")
        with patch("apps.services.llm.models.LLMModel", fake_cls):
            fields = _resolve_model_capability_fields("boom")
        self.assertEqual(fields, {})


class ForwardPromptIncludesModelCapabilityTests(SimpleTestCase):
    def _build_envelope_capture(self):
        captured = {}

        def fake_build_envelope(_type, _event_id, payload, **kwargs):
            captured["payload"] = payload
            return {"type": _type, "payload": payload, **kwargs}

        return captured, fake_build_envelope

    @patch(
        "apps.services.agent_engine.services.prompt_forward_service."
        "PromptForwardService._route_to_device",
        return_value=1,
    )
    def test_forward_prompt_emits_context_window_when_model_given(self, _route):
        captured, fake_build = self._build_envelope_capture()
        with _patch_llm_model(_make_model(200000, 8192)), patch(
            "apps.services.agent_engine.services.prompt_forward_service.build_envelope",
            side_effect=fake_build,
        ):
            svc = PromptForwardService()
            svc.forward_prompt(
                thread_id="chat-session-sess-1",
                space=_make_space(),
                prompt="run",
                attachments=[],
                agent_backend_config={"type": "local"},
                model_id="11111111-1111-1111-1111-111111111111",
            )
        payload = captured["payload"]
        self.assertEqual(payload.get("model_id"), "11111111-1111-1111-1111-111111111111")
        self.assertEqual(payload.get("context_window_tokens"), 200000)
        self.assertEqual(payload.get("max_output_tokens"), 8192)

    @patch(
        "apps.services.agent_engine.services.prompt_forward_service."
        "PromptForwardService._route_to_device",
        return_value=1,
    )
    def test_forward_prompt_emits_zip_input_capability(self, _route):
        captured, fake_build = self._build_envelope_capture()
        with _patch_llm_model(_make_model(supports_zip_input=True)), patch(
            "apps.services.agent_engine.services.prompt_forward_service.build_envelope",
            side_effect=fake_build,
        ):
            PromptForwardService().forward_prompt(
                thread_id="chat-session-sess-1",
                space=_make_space(),
                prompt="run",
                attachments=[],
                agent_backend_config={"type": "local"},
                model_id="zip-model",
            )
        self.assertIs(captured["payload"].get("supports_zip_input"), True)

    @patch(
        "apps.services.agent_engine.services.prompt_forward_service."
        "PromptForwardService._route_to_device",
        return_value=1,
    )
    def test_forward_prompt_projects_project_task_runtime_context(self, _route):
        captured, fake_build = self._build_envelope_capture()
        with patch(
            "apps.services.agent_engine.services.prompt_forward_service.build_envelope",
            side_effect=fake_build,
        ):
            PromptForwardService().forward_prompt(
                thread_id="chat-session-sess-1",
                space=_make_space(),
                prompt="run",
                attachments=[],
                agent_backend_config={"type": "local"},
                app_context={
                    "appType": "project_task",
                    "spaceId": "workspace-1",
                    "_server_focus_authority": {
                        "collaborationSpaceId": "project-1",
                        "executionSpaceId": "workspace-1",
                        "appMeta": {
                            "project_id": "project-1",
                            "task_id": "task-1",
                        },
                    },
                    "_project_task_id": "task-1",
                },
            )
        self.assertEqual(captured["payload"]["app_context"], {
            "appType": "project_task",
            "appMeta": {"project_id": "project-1", "task_id": "task-1"},
            "spaceId": "workspace-1",
            "executionSpaceId": "workspace-1",
            "collaborationSpaceId": "project-1",
        })

    @patch(
        "apps.services.agent_engine.services.prompt_forward_service."
        "PromptForwardService._route_to_device",
        return_value=1,
    )
    def test_forward_prompt_omits_capability_fields_when_no_model(self, _route):
        captured, fake_build = self._build_envelope_capture()
        with patch(
            "apps.services.agent_engine.services.prompt_forward_service.build_envelope",
            side_effect=fake_build,
        ):
            svc = PromptForwardService()
            svc.forward_prompt(
                thread_id="chat-session-sess-1",
                space=_make_space(),
                prompt="run",
                attachments=[],
                agent_backend_config={"type": "local"},
                model_id=None,
            )
        payload = captured["payload"]
        # 缺 model_id → 不写 model 能力字段（向后兼容，客户端走原 fallback）
        self.assertNotIn("context_window_tokens", payload)
        self.assertNotIn("max_output_tokens", payload)
