"""Wave 6 续作 P0-3 / P0-4 — envelope 透传 artifact_ref + recovery_actions。

业务约束(charter v1.8 §4.4 / plan §Phase 6 验收 #1):
  1. notify_run_completed 的 envelope.payload.artifact_ref 必须从
     ``TrackerRun.context["agent_result"]`` 提取关键产物字段
     (memo_id / record_ids / doc_id / slide_id / code_path 等)。
     否则用户点"看产物"只跳到 app 主面板,违反"看产物 1 步可达"。

  2. notify_run_failed 的 envelope.payload.recovery_actions 必须从
     ``TrackerRun.context["recovery_actions"]`` 提取结构化 dict list
     (每条含 kind + label,可选 model)。前端 TrackerRunStatusIndicator
     依此渲染按钮。
"""

from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.tracker.services.tracker_notification import (
    _extract_artifact_ref,
    _extract_recovery_actions,
)


class ExtractArtifactRefTests(SimpleTestCase):
    """_extract_artifact_ref 的纯函数契约测试。"""

    def _gr(self, ctx):
        gr = MagicMock()
        gr.context = ctx
        return gr

    def test_returns_none_when_context_empty(self):
        self.assertIsNone(_extract_artifact_ref(self._gr(None)))
        self.assertIsNone(_extract_artifact_ref(self._gr({})))

    def test_returns_none_when_no_artifact_fields(self):
        ctx = {"agent_result": {"foo": "bar"}}
        self.assertIsNone(_extract_artifact_ref(self._gr(ctx)))

    def test_extracts_memo_id_from_agent_result(self):
        ctx = {
            "agent_result": {
                "memo_id": "memo-1234",
                "preview": "test memo",
            }
        }
        out = _extract_artifact_ref(self._gr(ctx))
        self.assertEqual(out, {"memoId": "memo-1234"})

    def test_extracts_multiple_fields(self):
        ctx = {
            "agent_result": {
                "memo_id": "memo-1",
                "record_ids": ["r1", "r2"],
                "doc_id": "doc-9",
            }
        }
        out = _extract_artifact_ref(self._gr(ctx))
        self.assertEqual(out, {
            "memoId": "memo-1",
            "recordIds": ["r1", "r2"],
            "docId": "doc-9",
        })

    def test_top_level_context_fallback(self):
        # 某些 Skill 直接写 context.memo_id(没包 agent_result)
        ctx = {"memo_id": "memo-xyz"}
        out = _extract_artifact_ref(self._gr(ctx))
        self.assertEqual(out, {"memoId": "memo-xyz"})

    def test_agent_result_has_priority_over_top_level(self):
        ctx = {
            "memo_id": "memo-top",
            "agent_result": {"memo_id": "memo-result"},
        }
        out = _extract_artifact_ref(self._gr(ctx))
        # agent_result 优先
        self.assertEqual(out["memoId"], "memo-result")

    def test_skips_empty_string_and_none_values(self):
        ctx = {"agent_result": {"memo_id": "", "doc_id": None, "code_path": "src/x.py"}}
        out = _extract_artifact_ref(self._gr(ctx))
        self.assertEqual(out, {"codePath": "src/x.py"})


class ExtractRecoveryActionsTests(SimpleTestCase):
    """_extract_recovery_actions 的纯函数契约测试。"""

    def _gr(self, ctx):
        gr = MagicMock()
        gr.context = ctx
        return gr

    def test_empty_when_no_actions(self):
        self.assertEqual(_extract_recovery_actions(self._gr({})), [])
        self.assertEqual(_extract_recovery_actions(self._gr(None)), [])

    def test_extracts_well_formed_actions(self):
        ctx = {
            "recovery_actions": [
                {"kind": "rerun", "label": "重新运行"},
                {"kind": "retry_with_model", "label": "换 GPT-4 重试", "model": "gpt-4"},
            ]
        }
        out = _extract_recovery_actions(self._gr(ctx))
        self.assertEqual(len(out), 2)
        self.assertEqual(out[0], {"kind": "rerun", "label": "重新运行"})
        self.assertEqual(out[1], {"kind": "retry_with_model", "label": "换 GPT-4 重试", "model": "gpt-4"})

    def test_drops_malformed_entries(self):
        ctx = {
            "recovery_actions": [
                {"kind": "rerun", "label": "重新运行"},  # ✓
                "not a dict",                              # ✗ 丢
                {"kind": "rerun"},                         # ✗ 缺 label
                {"label": "no kind"},                      # ✗ 缺 kind
                None,                                      # ✗
            ]
        }
        out = _extract_recovery_actions(self._gr(ctx))
        self.assertEqual(len(out), 1)


class EnvelopeIncludesArtifactRefTests(SimpleTestCase):
    """notify_run_completed 的 envelope.payload 必须含 artifact_ref(charter §4.4)。"""

    def _make_service(self, ctx_data: dict) -> tuple:
        """构造 TrackerNotificationService + fake TrackerRun,返回 (svc, gr, captured)。"""
        from apps.tracker.services.tracker_notification import TrackerNotificationService

        gr = MagicMock()
        gr.id = "11111111-1111-1111-1111-111111111111"
        gr.tracker_id = "22222222-2222-2222-2222-222222222222"
        gr.status = "success"
        gr.duration = 1.5
        gr.context = ctx_data

        gr.tracker = MagicMock()
        gr.tracker.organization_id = "wt-1"
        gr.tracker.space_id = "sp-1"
        gr.tracker.skill_key = "tabmemo.organize"
        gr.tracker.created_by_id = "user-1"

        svc = TrackerNotificationService.__new__(TrackerNotificationService)
        svc.tracker_run = gr
        svc.organization_id = "wt-1"
        svc.tracker_topic = "tracker.events.wt-1"

        captured = {}
        def fake_publish(envelope):
            captured["envelope"] = envelope
            return True
        svc._publish_with_fallback = fake_publish
        svc._notify_owner_user = lambda *a, **k: None

        return svc, gr, captured

    def test_envelope_includes_artifact_ref_when_context_has_memo_id(self):
        svc, gr, captured = self._make_service({
            "agent_result": {
                "memo_id": "memo-2025-04-27",
                "preview": "已整理",
            }
        })
        svc.notify_run_completed(gr)
        env = captured["envelope"]
        self.assertIn("payload", env)
        self.assertIn("artifact_ref", env["payload"])
        self.assertEqual(env["payload"]["artifact_ref"], {"memoId": "memo-2025-04-27"})

    def test_envelope_artifact_ref_none_when_no_data(self):
        svc, gr, captured = self._make_service({})
        svc.notify_run_completed(gr)
        env = captured["envelope"]
        # artifact_ref 字段存在但 = None
        self.assertIn("artifact_ref", env["payload"])
        self.assertIsNone(env["payload"]["artifact_ref"])


class EnvelopeIncludesRecoveryActionsTests(SimpleTestCase):
    """notify_run_failed 的 envelope.payload 必须含 recovery_actions(plan §Phase 6 验收 #1)。"""

    def _make_service(self, ctx_data: dict, error_summary: str = "kimi 失败") -> tuple:
        from apps.tracker.services.tracker_notification import TrackerNotificationService

        gr = MagicMock()
        gr.id = "11111111-1111-1111-1111-111111111111"
        gr.tracker_id = "22222222-2222-2222-2222-222222222222"
        gr.status = "failed"
        gr.error_summary = error_summary
        gr.duration = 2.0
        gr.context = ctx_data

        gr.tracker = MagicMock()
        gr.tracker.organization_id = "wt-1"
        gr.tracker.space_id = "sp-1"
        gr.tracker.skill_key = "tabmemo.organize"
        gr.tracker.created_by_id = "user-1"

        svc = TrackerNotificationService.__new__(TrackerNotificationService)
        svc.tracker_run = gr
        svc.organization_id = "wt-1"
        svc.tracker_topic = "tracker.events.wt-1"

        captured = {}
        def fake_publish(envelope):
            captured["envelope"] = envelope
            return True
        svc._publish_with_fallback = fake_publish
        svc._notify_owner_user = lambda *a, **k: None

        return svc, gr, captured

    def test_envelope_includes_recovery_actions_when_present(self):
        svc, gr, captured = self._make_service({
            "recovery_actions": [
                {"kind": "rerun", "label": "重新运行"},
                {"kind": "retry_with_model", "label": "换 Claude", "model": "claude-sonnet-4"},
            ]
        })
        svc.notify_run_failed(gr)
        env = captured["envelope"]
        self.assertIn("recovery_actions", env["payload"])
        actions = env["payload"]["recovery_actions"]
        self.assertEqual(len(actions), 2)
        self.assertEqual(actions[0]["kind"], "rerun")
        self.assertEqual(actions[1]["model"], "claude-sonnet-4")

    def test_envelope_recovery_actions_empty_when_no_data(self):
        svc, gr, captured = self._make_service({})
        svc.notify_run_failed(gr)
        env = captured["envelope"]
        self.assertEqual(env["payload"]["recovery_actions"], [])
