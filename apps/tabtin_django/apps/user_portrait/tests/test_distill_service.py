"""
M2 单测 · PortraitDistillService（/#4118 画像 per-Agent 化）

覆盖：
  - prompts: format_memo_line / format_hint_line（小工具）
  - distill_service: _strip_code_fence / _validate_portrait_md
  - PortraitDistillService.run: 完整流程（mock LLM）
    - 成功路径：portrait 更新 + version+1 + snapshot 归档
    - LLM 失败：状态机回到 failed + 旧 content_md 保留
    - 输出格式不对：失败兜底
    - 无新输入：跳过蒸馏，状态回 idle
    - 【关键 /#4118】缺失 agent_id：整体 skip，不建 portrait、不 mark pending
  - call_llm: 通过 LLMSceneBinding factory + 失败兜底
  - 【v0.2 关键】构造时必须传 organization_id，否则抛 ValueError

注：v0.1 修复阶段后 prompt 文本已迁到 LLMSceneBinding bundle，
原本的 inline prompt + user message 拼装测试已删除——bundle 渲染层由 PromptRegistry 测试覆盖。
"""

from __future__ import annotations

import uuid
from unittest.mock import patch

from django.apps import apps as django_apps
from django.test import TestCase

from apps.user_portrait.constants import USER_PORTRAIT_DB
from apps.user_portrait.error_codes import ErrorCode, ServiceError
from apps.user_portrait.models import UserPortrait
from apps.user_portrait.prompts import (
    SECTION_TITLES,
    format_hint_line,
    format_memo_line,
)
from apps.user_portrait.services.distill_service import (
    USER_PORTRAIT_DISTILL_SCENE_KEY,
    DistillInput,
    PortraitDistillService,
    _strip_code_fence,
    _validate_portrait_md,
)
from apps.user_portrait.services.portrait_service import UserPortraitService
from apps.users.auth.models import User


def _fake_tabtinspace_loaded() -> bool:
    return django_apps.is_installed("apps.user_portrait.tests._fake_tabtinspace")


VALID_PORTRAIT_MD = """\
## 工作背景

Uncle 是 TabTin 的独立创始人。

## 个人背景

Uncle 即将 30 岁。

## 最近在想

Uncle 最近在思考记忆系统。

## 近期历史

最近几周完成 PRD。

## 长期背景

对 AI Agent 架构有长期兴趣。
"""


# ── Prompts 工具函数 ─────────────────────────────────


class PromptUtilsTests(TestCase):
    def test_format_memo_line_basic(self):
        line = format_memo_line(
            organization_name="个人",
            created_at_iso="2026-04-15T10:00:00+00:00",
            content="我把家里的三条狗都送人了",
        )
        self.assertEqual(line, "[Organization: 个人, 2026-04-15] 我把家里的三条狗都送人了")

    def test_format_memo_line_truncates_long_content(self):
        line = format_memo_line(
            organization_name="W",
            created_at_iso="2026-04-15",
            content="x" * 1000,
        )
        self.assertIn("...", line)
        self.assertLess(len(line), 700)

    def test_format_memo_line_collapses_newlines(self):
        line = format_memo_line(
            organization_name="W",
            created_at_iso="2026-04-15",
            content="第一行\n第二行",
        )
        self.assertIn("第一行 第二行", line)

    def test_format_hint_line_with_timestamp(self):
        line = format_hint_line(
            text="我已经把狗送人了",
            submitted_at="2026-04-22T10:00:00+00:00",
        )
        self.assertEqual(line, "- [2026-04-22] 我已经把狗送人了")

    def test_format_hint_line_without_timestamp(self):
        line = format_hint_line(text="忘了吧")
        self.assertEqual(line, "- 忘了吧")


# v0.1 修复阶段：原本的 inline system prompt 常量 + user-message 拼装函数
# 已删除（违反 AI 能力统一宪法 §A.2）。
# Prompt 文本 SSoT 在 LLMSceneBinding bundle：
#   apps/services/llm/scenes/bundled/user_portrait_distill/{system.md, user.md.tmpl, SCENE.md}
# 相关测试请改到 prompt bundle 渲染层（PromptRegistry）。


# ── 工具函数 ─────────────────────────────────────────


class DistillUtilsTests(TestCase):
    def test_strip_code_fence_removes_markdown_fence(self):
        self.assertEqual(_strip_code_fence("```markdown\n## 标题\n```"), "## 标题")

    def test_strip_code_fence_removes_plain_fence(self):
        self.assertEqual(_strip_code_fence("```\nabc\n```"), "abc")

    def test_strip_code_fence_no_fence(self):
        self.assertEqual(_strip_code_fence("plain text"), "plain text")

    def test_validate_portrait_md_valid(self):
        self.assertEqual(_validate_portrait_md(VALID_PORTRAIT_MD), VALID_PORTRAIT_MD)

    def test_validate_portrait_md_empty_raises(self):
        with self.assertRaises(ServiceError) as ctx:
            _validate_portrait_md("")
        self.assertEqual(ctx.exception.code, ErrorCode.DISTILL_FAILED)

    def test_validate_portrait_md_missing_section_raises(self):
        """v0.2 🟡-4：用户视角文案是中文人话；技术细节进 ServiceError.data。"""
        broken = VALID_PORTRAIT_MD.replace("## 长期背景", "## 不存在的段")
        with self.assertRaises(ServiceError) as ctx:
            _validate_portrait_md(broken)
        # ServiceError.message 是面向用户的中文人话——不能再含技术原文里的段名
        self.assertNotIn("长期背景", ctx.exception.message)
        self.assertNotIn("LLM", ctx.exception.message)
        # 用户应该被告知"已为你保留旧画像 + 可稍后重试"
        self.assertIn("保留", ctx.exception.message)
        # 技术原文落到 data.raw_detail，便于日志和调试，但不直接给用户看
        self.assertIsNotNone(ctx.exception.data)
        self.assertIn("长期背景", ctx.exception.data["raw_detail"])


# ── DistillInput ─────────────────────────────────────


class DistillInputTests(TestCase):
    # v0.1 修复阶段：DistillInput 的 messages 拼装方法已删除
    # （现走 unified_llm_call(scene_key='user_portrait_distill')，bundle 渲染由 PromptRegistry 负责）。
    # 这里只保留 input_summary 校验。

    def test_input_summary_includes_organization_name(self):
        """v0.2: input_summary 含 organization_name 而非 organizations 列表。"""
        di = DistillInput(
            user_display_name="X",
            organization_name="TabTin Team",
            previous_portrait_md="",
            memos_for_prompt=[],
            hints=[{"text": "h1"}, {"text": "h2"}],
            memo_count=10,
            truncated_memos=2,
        )
        summary = di.to_input_summary()
        self.assertEqual(summary["memo_count"], 10)
        self.assertEqual(summary["memo_truncated"], 2)
        self.assertEqual(summary["hint_count"], 2)
        self.assertEqual(summary["organization_name"], "TabTin Team")


# ── PortraitDistillService.run（完整流程） ──────────


class PortraitDistillServiceTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.user = User.objects.create_user(
            email="distill@portrait.test",
            password="StrongPass123!",
            nickname="Uncle",
        )
        self.organization_id = str(uuid.uuid4())
        self.agent_id = str(uuid.uuid4())
        self.portrait_svc = UserPortraitService(user=self.user)
        self.distill_svc = PortraitDistillService(
            user=self.user,
            organization_id=self.organization_id,
            agent_id=self.agent_id,
        )
        # tabtinspace 装载时 membership 真校验——预建 Organization（owner=self.user）。
        if _fake_tabtinspace_loaded():
            from apps.user_portrait.tests._fake_tabtinspace.models import Organization
            Organization.objects.create(
                id=self.organization_id,
                name=f"WT-{self.organization_id[:8]}",
                owner_id=self.user.id,
            )
        else:
            from apps.tabtinspace.models import Organization
            Organization.objects.create(
                id=self.organization_id,
                name=f"WT-{self.organization_id[:8]}",
                owner=self.user,
            )

    def test_constructor_requires_organization_id(self):
        """v0.2 关键：必须传 organization_id 否则抛 ValueError。"""
        with self.assertRaises(ValueError):
            PortraitDistillService(user=self.user, organization_id="")
        with self.assertRaises(ValueError):
            PortraitDistillService(user=self.user, organization_id=None)  # type: ignore[arg-type]

    def test_constructor_requires_user(self):
        with self.assertRaises(ValueError):
            PortraitDistillService(user=None, organization_id=self.organization_id)

    def _patch_collect_input(self, *, has_inputs: bool = True):
        if has_inputs:
            di = DistillInput(
                user_display_name="Uncle",
                organization_name="TabTin",
                previous_portrait_md="",
                memos_for_prompt=[
                    {
                        "organization_name": "TabTin",
                        "created_at": "2026-04-15",
                        "content": "测试 memo 内容",
                    }
                ],
                hints=[],
                memo_count=1,
                truncated_memos=0,
            )
        else:
            di = DistillInput(
                user_display_name="Uncle",
                organization_name="",
                previous_portrait_md="",
                memos_for_prompt=[],
                hints=[],
                memo_count=0,
                truncated_memos=0,
            )
        return patch.object(self.distill_svc, "collect_input", return_value=di)

    def test_run_success_creates_snapshot_and_increments_version(self):
        self.portrait_svc.get_or_create_portrait(self.organization_id, self.agent_id)

        with self._patch_collect_input(has_inputs=True), patch.object(
            self.distill_svc, "call_llm", return_value=VALID_PORTRAIT_MD,
        ):
            portrait = self.distill_svc.run(trigger_reason="manual")

        self.assertEqual(portrait.content_md, VALID_PORTRAIT_MD)
        self.assertEqual(portrait.version, 1)
        self.assertEqual(portrait.last_distill_status, UserPortrait.DistillStatus.IDLE)
        self.assertEqual(str(portrait.organization_id), self.organization_id)
        self.assertEqual(str(portrait.agent_id), self.agent_id)

        snapshots = self.portrait_svc.list_snapshots(self.organization_id, self.agent_id)
        self.assertEqual(len(snapshots), 1)
        self.assertEqual(snapshots[0].trigger_reason, "manual")

    def test_run_without_agent_id_skips_and_creates_no_portrait(self):
        """#4090/#4118：agent_id 缺失 → run() 返回 None、不建 portrait、不 mark pending。"""
        svc_no_agent = PortraitDistillService(
            user=self.user, organization_id=self.organization_id,
        )
        with patch.object(svc_no_agent, "collect_input") as mock_collect, patch.object(
            svc_no_agent, "call_llm"
        ) as mock_llm:
            result = svc_no_agent.run(trigger_reason="manual")
        self.assertIsNone(result)
        mock_collect.assert_not_called()
        mock_llm.assert_not_called()
        # 未落任何 portrait 行（fail-closed，不写无主画像）
        self.assertEqual(
            UserPortrait.objects.using(USER_PORTRAIT_DB)
            .filter(user_id=self.user.id, organization_id=self.organization_id)
            .count(),
            0,
        )

    def test_run_llm_failure_marks_failed_and_preserves_old_content(self):
        portrait = self.portrait_svc.get_or_create_portrait(self.organization_id, self.agent_id)
        portrait.content_md = "## 旧画像内容"
        portrait.version = 2
        portrait.save(using=USER_PORTRAIT_DB)

        with self._patch_collect_input(has_inputs=True), patch.object(
            self.distill_svc, "call_llm",
            side_effect=ServiceError(ErrorCode.DISTILL_FAILED, "LLM timeout", 500),
        ):
            with self.assertRaises(ServiceError):
                self.distill_svc.run(trigger_reason="manual")

        portrait_after = self.portrait_svc.get_portrait(self.organization_id, self.agent_id)
        self.assertEqual(portrait_after.content_md, "## 旧画像内容")
        self.assertEqual(portrait_after.version, 2)
        self.assertEqual(
            portrait_after.last_distill_status,
            UserPortrait.DistillStatus.FAILED,
        )

    def test_run_retryable_failure_keeps_pending_until_final_attempt(self):
        """任务还有重试机会时，用户侧状态必须保持处理中而非提前失败。"""
        self.portrait_svc.get_or_create_portrait(
            self.organization_id, self.agent_id,
        )

        with self._patch_collect_input(has_inputs=True), patch.object(
            self.distill_svc,
            "call_llm",
            side_effect=ServiceError(ErrorCode.DISTILL_FAILED, "LLM timeout", 500),
        ):
            with self.assertRaises(ServiceError):
                self.distill_svc.run(
                    trigger_reason="manual",
                    mark_failed_on_error=False,
                )

        portrait_after = self.portrait_svc.get_portrait(
            self.organization_id, self.agent_id,
        )
        self.assertEqual(
            portrait_after.last_distill_status,
            UserPortrait.DistillStatus.PENDING,
        )
        self.assertEqual(portrait_after.last_distill_error, "")

    def test_run_retry_resumes_pending_and_commits_success(self):
        """Celery retry 续跑同一 pending，成功后正常提交而不是被并发锁拒绝。"""
        self.portrait_svc.mark_distill_pending(
            self.organization_id, self.agent_id,
        )

        with self._patch_collect_input(has_inputs=True), patch.object(
            self.distill_svc, "call_llm", return_value=VALID_PORTRAIT_MD,
        ):
            portrait = self.distill_svc.run(
                trigger_reason="manual",
                resume_pending=True,
                mark_failed_on_error=True,
            )

        self.assertEqual(
            portrait.last_distill_status,
            UserPortrait.DistillStatus.IDLE,
        )
        self.assertEqual(portrait.version, 1)
        self.assertEqual(portrait.content_md, VALID_PORTRAIT_MD)

    def test_run_invalid_output_format_marks_failed(self):
        self.portrait_svc.get_or_create_portrait(self.organization_id, self.agent_id)
        broken_md = "## 工作背景\n只有一段"

        with self._patch_collect_input(has_inputs=True), patch.object(
            self.distill_svc, "call_llm", return_value=broken_md,
        ):
            with self.assertRaises(ServiceError):
                self.distill_svc.run()

        portrait_after = self.portrait_svc.get_portrait(self.organization_id, self.agent_id)
        self.assertEqual(
            portrait_after.last_distill_status,
            UserPortrait.DistillStatus.FAILED,
        )

    def test_run_no_inputs_skips_distill(self):
        self.portrait_svc.get_or_create_portrait(self.organization_id, self.agent_id)

        with self._patch_collect_input(has_inputs=False), patch.object(
            self.distill_svc, "call_llm",
        ) as mock_llm:
            portrait = self.distill_svc.run()
            mock_llm.assert_not_called()

        self.assertEqual(portrait.last_distill_status, UserPortrait.DistillStatus.IDLE)
        self.assertEqual(portrait.version, 0)

    def test_has_distill_materials_matches_run_skip_predicate(self):
        """#7117：API 预检与 run() no-input skip 共用同一判定。"""
        self.portrait_svc.get_or_create_portrait(self.organization_id, self.agent_id)
        self.assertFalse(self.distill_svc.has_distill_materials())
        with self._patch_collect_input(has_inputs=False), patch.object(
            self.distill_svc, "call_llm",
        ) as mock_llm:
            skipped = self.distill_svc.run()
            mock_llm.assert_not_called()
        self.assertEqual(skipped.last_distill_status, UserPortrait.DistillStatus.IDLE)

        self.portrait_svc.add_hint(
            self.organization_id, self.agent_id, text="请记住我偏好深色模式",
        )
        self.assertTrue(self.distill_svc.has_distill_materials())

    def test_has_distill_materials_does_not_create_portrait_row(self):
        """预检只读：无材料时不得 get_or_create 落空画像行。"""
        from apps.user_portrait.models import UserPortrait

        self.assertFalse(
            UserPortrait.objects.using(USER_PORTRAIT_DB).filter(
                user_id=self.user.id,
                organization_id=self.organization_id,
                agent_id=self.agent_id,
            ).exists()
        )
        self.assertFalse(self.distill_svc.has_distill_materials())
        self.assertFalse(
            UserPortrait.objects.using(USER_PORTRAIT_DB).filter(
                user_id=self.user.id,
                organization_id=self.organization_id,
                agent_id=self.agent_id,
            ).exists()
        )

    def test_has_distill_materials_true_with_previous_portrait_only(self):
        portrait = self.portrait_svc.get_or_create_portrait(
            self.organization_id, self.agent_id,
        )
        portrait.content_md = "## 工作背景\n已有正文\n\n## 个人背景\n-\n\n## 最近在想\n-\n\n## 近期历史\n-\n\n## 长期背景\n-"
        portrait.version = 1
        portrait.save(
            using=USER_PORTRAIT_DB,
            update_fields=["content_md", "version", "updated_at"],
        )
        self.assertTrue(self.distill_svc.has_distill_materials())

    def test_has_distill_materials_false_when_only_empty_memories(self):
        """空内容记忆不得让预检与 run() 分叉（不得假入队）。"""
        self.portrait_svc.get_or_create_portrait(self.organization_id, self.agent_id)

        class _EmptyMemorySource:
            @staticmethod
            def collect(**_kwargs):
                return (
                    [{
                        "content_plaintext": "   ",
                        "content_markdown": "",
                        "memo_type": "about_you",
                        "created_at": None,
                    }],
                    1,
                    0,
                )

            @staticmethod
            def has_new(**_kwargs):
                return True  # 旧 has_new 会误报；预检应走 collect 过滤

        with patch.object(
            self.distill_svc,
            "_portrait_memory_source",
            return_value=_EmptyMemorySource,
        ):
            self.assertFalse(self.distill_svc.has_distill_materials())
            with patch.object(self.distill_svc, "call_llm") as mock_llm:
                portrait = self.distill_svc.run()
                mock_llm.assert_not_called()
            self.assertEqual(
                portrait.last_distill_status,
                UserPortrait.DistillStatus.IDLE,
            )

    def test_run_when_already_pending_raises(self):
        self.portrait_svc.mark_distill_pending(self.organization_id, self.agent_id)
        with self.assertRaises(ServiceError) as ctx:
            self.distill_svc.run()
        self.assertEqual(ctx.exception.code, ErrorCode.DISTILL_IN_PROGRESS)

    def test_run_clears_pending_hints_after_success(self):
        self.portrait_svc.add_hint(self.organization_id, self.agent_id, text="some hint")

        with self._patch_collect_input(has_inputs=True), patch.object(
            self.distill_svc, "call_llm", return_value=VALID_PORTRAIT_MD,
        ):
            portrait = self.distill_svc.run()

        self.assertEqual(portrait.pending_hints, [])

    def test_run_preserves_pending_hints_after_failure(self):
        self.portrait_svc.add_hint(self.organization_id, self.agent_id, text="must survive")

        with self._patch_collect_input(has_inputs=True), patch.object(
            self.distill_svc, "call_llm",
            side_effect=ServiceError(ErrorCode.DISTILL_FAILED, "boom", 500),
        ):
            with self.assertRaises(ServiceError):
                self.distill_svc.run()

        portrait = self.portrait_svc.get_portrait(self.organization_id, self.agent_id)
        self.assertEqual(len(portrait.pending_hints), 1)


# ── LLM Scene 接入测试 ───────────────────────────────


class LLMSceneIntegrationTests(TestCase):
    """验证 call_llm 通过 LLMSceneBinding 选模型 + 计费用 organization_id。"""

    databases = {"default", "postgresql"}

    def setUp(self):
        self.user = User.objects.create_user(
            email="scene@portrait.test",
            password="StrongPass123!",
        )
        self.organization_id = str(uuid.uuid4())
        self.agent_id = str(uuid.uuid4())
        self.distill_svc = PortraitDistillService(
            user=self.user,
            organization_id=self.organization_id,
            agent_id=self.agent_id,
        )
        if _fake_tabtinspace_loaded():
            from apps.user_portrait.tests._fake_tabtinspace.models import Organization
            Organization.objects.create(
                id=self.organization_id,
                name=f"WT-{self.organization_id[:8]}",
                owner_id=self.user.id,
            )
        else:
            from apps.tabtinspace.models import Organization
            Organization.objects.create(
                id=self.organization_id,
                name=f"WT-{self.organization_id[:8]}",
                owner=self.user,
            )

    def test_scene_key_constant_value(self):
        self.assertEqual(USER_PORTRAIT_DISTILL_SCENE_KEY, "user_portrait_distill")

    def _make_distill_input(self) -> DistillInput:
        return DistillInput(
            user_display_name="Test",
            organization_name="TabTin",
            previous_portrait_md="",
            memos_for_prompt=[],
            hints=[{"text": "x"}],
            memo_count=0,
            truncated_memos=0,
        )

    def _make_unified_result(self, content: str):
        """构造一个最小可用的 LLMCallResult 替身。

        call_llm 只读 result.content，故只需提供 content 字段即可；其它字段
        测试用 SimpleNamespace 占位避免拉重 unified_llm_call 真实依赖。
        """
        from types import SimpleNamespace
        return SimpleNamespace(content=content)

    def test_call_llm_uses_unified_llm_call_with_organization_id(self):
        """call_llm 应该把 self.organization_id 透传给 chat 入口（v0.2: 不再是空字符串兜底）。

        v0.1 修复阶段后 call_llm 走 chat 入口 unified_llm_call(scene_key='user_portrait_distill', ...)
        旧版基于 LLM service 工厂的 patch 已废弃。
        """
        di = self._make_distill_input()

        with patch(
            "apps.services.llm.services.chat.unified_llm_call",
            return_value=self._make_unified_result(VALID_PORTRAIT_MD),
        ) as mock_call:
            content = self.distill_svc.call_llm(di)

        mock_call.assert_called_once()
        call_kwargs = mock_call.call_args.kwargs
        self.assertEqual(call_kwargs["scene_key"], USER_PORTRAIT_DISTILL_SCENE_KEY)
        self.assertEqual(call_kwargs["user_id"], str(self.user.id))
        self.assertEqual(call_kwargs["organization_id"], self.organization_id)
        # variables 必须包含蒸馏所需 5 个字段
        variables = call_kwargs["variables"]
        self.assertIn("user_display_name", variables)
        self.assertIn("organization_name", variables)
        self.assertIn("previous_portrait", variables)
        self.assertIn("memos_summary", variables)
        self.assertIn("hints_text", variables)

        self.assertEqual(content.strip(), VALID_PORTRAIT_MD.strip())

    def test_call_llm_unified_call_exception_raises_service_error(self):
        """unified_llm_call 抛异常时 → ServiceError(DISTILL_FAILED, kind=LLM_CALL_FAILED)，
        且原始技术细节进 data['raw_detail']，不渗透到面向用户的 message。"""
        di = self._make_distill_input()

        with patch(
            "apps.services.llm.services.chat.unified_llm_call",
            side_effect=ValueError("rate limit"),
        ):
            with self.assertRaises(ServiceError) as ctx:
                self.distill_svc.call_llm(di)

        self.assertEqual(ctx.exception.code, ErrorCode.DISTILL_FAILED)
        # 用户视角文案：不暴露技术细节
        self.assertNotIn("rate limit", ctx.exception.message)
        self.assertIn("不可用", ctx.exception.message)
        self.assertIn("旧画像", ctx.exception.message)
        # raw_detail 保留技术原文便于日志排查
        self.assertIn("rate limit", ctx.exception.data["raw_detail"])
        self.assertEqual(ctx.exception.data["kind"], "llm_call_failed")

    def test_call_llm_unified_call_scene_binding_unavailable(self):
        """SceneBinding 缺失（E14）等 SceneCallError 同样会被 call_llm 包成 ServiceError，
        当前实现统一进 LLM_CALL_FAILED kind（用户视角"暂时不可用 + 旧画像仍在 + 稍后重试"）。"""
        from apps.services.llm.scenes.exceptions import SceneBindingUnavailable
        di = self._make_distill_input()

        with patch(
            "apps.services.llm.services.chat.unified_llm_call",
            side_effect=SceneBindingUnavailable(
                "scene 'user_portrait_distill' 无对应 binding",
                scene_key="user_portrait_distill",
            ),
        ):
            with self.assertRaises(ServiceError) as ctx:
                self.distill_svc.call_llm(di)

        self.assertEqual(ctx.exception.code, ErrorCode.DISTILL_FAILED)
        self.assertEqual(ctx.exception.data["kind"], "llm_call_failed")
        # 错误码 / 内部 detail 进 raw_detail 而非 message
        self.assertIn("user_portrait_distill", ctx.exception.data["raw_detail"])
