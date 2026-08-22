"""
TM-5 隐私关键路径 wiring 测试（纯 mock，无 DB）。

验证蒸馏链路在「用户级记录开关关闭」（``load_effective_record_style`` 返回
``enabled=False``）时**根本不调用** ``unified_llm_call`` —— 即隐私短路在 LLM
调用之前生效，既保护隐私又省 token。结合 TM-4：DB 读取异常时 fail-closed 成
``enabled=False``，于是异常态也走同一条短路（不记）。

覆盖两条蒸馏链路：
  - ``capture._extract_with_llm``（memory_capture 场景）
  - ``task_summary._generate_with_llm``（task_summary 场景）

并反向验证 ``enabled=True`` 时 ``unified_llm_call`` 会被调用（证明短路是条件性的，
不是无条件跳过），且 ``record_preference`` 进入了 variables 槽位。

patch 目标说明（两条链路 import 方式不同）：
  - capture 在**模块级** import ``resolve_organization_id_from_space``，故 patch
    capture 命名空间内的绑定名；
  - task_summary 经 ``_resolve_organization`` **函数内** import，patch 源模块；
  - ``load_effective_record_style`` / ``render_record_preference`` 现经
    ``record_style_service.resolve_record_preference`` 间接调用（TM-16 收口），
    ``unified_llm_call`` 仍函数内 import——三者均 patch 源模块即可命中（resolve
    内对 load 是同模块 bare-call、对 render 是函数内 import，都看源模块当前绑定）。
"""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

_CAPTURE = "apps.services.agent_engine.tasks.memory.capture"
_TASK_SUMMARY = "apps.services.agent_engine.tasks.memory.task_summary"
_LOAD_STYLE = "apps.tabmemo.services.record_style_service.load_effective_record_style"
_RENDER_PREF = "apps.tabmemo.services.record_preference.render_record_preference"
_UNIFIED_CALL = "apps.services.llm.services.chat.unified_llm_call"
_RESOLVE_WT_SRC = "apps.services.billing.organization_resolver.resolve_organization_id_from_space"
_WORKSPACE_EXECUTION = (
    "apps.agent_memory.workspace_memory_execution.resolve_workspace_memory_worker"
)

_WS = "11111111-1111-1111-1111-111111111111"
_USER = "22222222-2222-2222-2222-222222222222"
_SPACE = "33333333-3333-3333-3333-333333333333"
_MESSAGES = [{"role": "user", "content": "帮我重构认证模块"}]


def _cfg(enabled: bool) -> dict:
    return {
        "enabled": enabled,
        "style": "faithful",
        "custom_config": {},
        "extra_preference": "",
    }


class MemoryCaptureWiringTests(SimpleTestCase):
    """``capture._extract_with_llm`` 的隐私短路 wiring。"""

    @patch(_UNIFIED_CALL)
    @patch(_LOAD_STYLE)
    @patch(f"{_CAPTURE}.resolve_organization_id_from_space")
    def test_disabled_short_circuits_no_llm(self, mock_resolve, mock_load, mock_llm):
        """enabled=False（含 TM-4 fail-closed 态）→ 不调用 unified_llm_call。"""
        mock_resolve.return_value = _WS
        mock_load.return_value = _cfg(enabled=False)

        from apps.services.agent_engine.tasks.memory.capture import _extract_with_llm

        result = _extract_with_llm(_MESSAGES, user_id=_USER, space_id=_SPACE)

        self.assertEqual(result, [])
        mock_load.assert_called_once_with(_USER, _WS)
        mock_llm.assert_not_called()

    @patch(_RENDER_PREF)
    @patch(_UNIFIED_CALL)
    @patch(_LOAD_STYLE)
    @patch(f"{_CAPTURE}.resolve_organization_id_from_space")
    def test_enabled_calls_llm_with_record_preference(
        self, mock_resolve, mock_load, mock_llm, mock_render,
    ):
        """enabled=True → 调用 unified_llm_call，且注入 record_preference 变量。"""
        mock_resolve.return_value = _WS
        mock_load.return_value = _cfg(enabled=True)
        mock_render.return_value = "记录从简，只留要点。"
        mock_llm.return_value = MagicMock(content="[]")

        from apps.services.agent_engine.tasks.memory.capture import _extract_with_llm

        result = _extract_with_llm(_MESSAGES, user_id=_USER, space_id=_SPACE)

        self.assertEqual(result, [])
        mock_llm.assert_called_once()
        kwargs = mock_llm.call_args.kwargs
        self.assertEqual(kwargs["scene_key"], "memory_capture")
        self.assertIn("record_preference", kwargs["variables"])
        self.assertEqual(kwargs["variables"]["record_preference"], "记录从简，只留要点。")


class TaskSummaryWiringTests(SimpleTestCase):
    """``task_summary._generate_with_llm`` 的隐私短路 wiring。"""

    @patch(
        _WORKSPACE_EXECUTION,
        return_value=SimpleNamespace(
            enabled=True,
            selected_model_id="44444444-4444-4444-8444-444444444444",
        ),
    )
    @patch(_UNIFIED_CALL)
    @patch(_LOAD_STYLE)
    @patch(_RESOLVE_WT_SRC)
    def test_disabled_short_circuits_no_llm(
        self, mock_resolve, mock_load, mock_llm, _workspace_execution,
    ):
        """enabled=False（含 TM-4 fail-closed 态）→ 不调用 unified_llm_call。"""
        mock_resolve.return_value = _WS
        mock_load.return_value = _cfg(enabled=False)

        from apps.services.agent_engine.tasks.memory.task_summary import _generate_with_llm

        result = _generate_with_llm(
            _MESSAGES,
            user_id=_USER,
            space_id=_SPACE,
            selected_model_id="44444444-4444-4444-8444-444444444444",
        )

        self.assertEqual(result, {})
        mock_load.assert_called_once_with(_USER, _WS)
        mock_llm.assert_not_called()

    @patch(
        _WORKSPACE_EXECUTION,
        return_value=SimpleNamespace(
            enabled=True,
            selected_model_id="44444444-4444-4444-8444-444444444444",
        ),
    )
    @patch(_RENDER_PREF)
    @patch(_UNIFIED_CALL)
    @patch(_LOAD_STYLE)
    @patch(_RESOLVE_WT_SRC)
    def test_enabled_calls_llm_with_record_preference(
        self, mock_resolve, mock_load, mock_llm, mock_render,
        _workspace_execution,
    ):
        """enabled=True → 调用 unified_llm_call，且注入 record_preference 变量。"""
        mock_resolve.return_value = _WS
        mock_load.return_value = _cfg(enabled=True)
        mock_render.return_value = "以长期协作者视角记录。"
        mock_llm.return_value = MagicMock(content='{"title": "重构认证"}')

        from apps.services.agent_engine.tasks.memory.task_summary import _generate_with_llm

        result = _generate_with_llm(
            _MESSAGES,
            user_id=_USER,
            space_id=_SPACE,
            selected_model_id="44444444-4444-4444-8444-444444444444",
        )

        self.assertEqual(result, {"title": "重构认证"})
        mock_llm.assert_called_once()
        kwargs = mock_llm.call_args.kwargs
        self.assertEqual(kwargs["scene_key"], "task_summary")
        self.assertIn("record_preference", kwargs["variables"])
        self.assertEqual(kwargs["variables"]["record_preference"], "以长期协作者视角记录。")
