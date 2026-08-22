"""
UserPortrait 蒸馏 Service（v0.2 per-Organization）

职责：
  1. 收集蒸馏输入（pending_hints + 上次蒸馏后的新 TabMemo + 上版 USER）
     —— 严格限定单 Organization 内的 TabMemo
  2. 调 LLM（按 D4 走贵模型，通过 LLMSceneBinding admindash 配置）
  3. 校验输出格式（5 段标题完整）
  4. 通过 UserPortraitService 提交结果（失败时不破坏旧 USER）

跟 task 层分离：本 Service 是同步的、可单测的；task 层只做 Celery 包装 + 异常处理。

关键不变量（v0.2 per-Organization）：
  - 蒸馏输入只来自单一 Organization 的 TabMemo
  - 计费直接走 portrait.organization_id（不再有"取 personal organization 兜底"的 hack）
  - 不存在跨 Organization 数据汇聚
"""

from __future__ import annotations

import logging
import re
from typing import Any, Dict, List, Optional

from apps.user_portrait.constants import USER_PORTRAIT_DB
from apps.user_portrait.error_codes import ErrorCode, ServiceError
from apps.user_portrait.models import UserPortrait
from apps.user_portrait.prompts import (
    SECTION_TITLES,
    format_hint_line,
    format_memo_line,
)
from apps.user_portrait.services.portrait_service import UserPortraitService
from apps.user_portrait.user_messages import (
    DistillFailureKind,
    humanize_api_error,
    humanize_distill_failure,
)

logger = logging.getLogger(__name__)


# 蒸馏输入的安全上限（防止 LLM input token 失控）
MAX_MEMOS_PER_DISTILL = 200
MAX_MEMO_CONTENT_CHARS = 500
# 单次蒸馏 input 文本上限（含 system + user message）
MAX_INPUT_CHARS = 60000


USER_PORTRAIT_DISTILL_SCENE_KEY = "user_portrait_distill"


def _strip_code_fence(text: str) -> str:
    """去掉 LLM 输出常见的 ```markdown ... ``` 围栏。"""
    if not text:
        return ""
    text = re.sub(r"^```\w*\s*\n?", "", text.strip())
    text = re.sub(r"\n?```\s*$", "", text.strip())
    return text.strip()


def _validate_portrait_md(md: str) -> str:
    """校验输出包含全部 5 个段标题。返回校验后的内容；不通过则抛 ServiceError。

    错误处理策略（v0.2 🟡-4）：
      - ServiceError.message 是面向用户的中文人话（写到 portrait.last_distill_error）
      - 技术原文（"LLM 返回空内容" / 缺失段落清单）走 logger，不进 message
      - data 字段保留 raw_detail 供日志和调试使用，不直接给前端展示
    """
    if not md or not md.strip():
        logger.warning("[Distill] validate failed: empty LLM output")
        raise ServiceError(
            ErrorCode.DISTILL_FAILED,
            humanize_distill_failure(DistillFailureKind.EMPTY_OUTPUT),
            500,
            data={"raw_detail": "empty LLM output", "kind": DistillFailureKind.EMPTY_OUTPUT},
        )
    missing = [t for t in SECTION_TITLES if f"## {t}" not in md]
    if missing:
        logger.warning("[Distill] validate failed: missing sections=%s", missing)
        raise ServiceError(
            ErrorCode.DISTILL_FAILED,
            humanize_distill_failure(DistillFailureKind.INCOMPLETE_OUTPUT),
            500,
            data={
                "raw_detail": f"missing sections: {', '.join(missing)}",
                "kind": DistillFailureKind.INCOMPLETE_OUTPUT,
            },
        )
    return md


class DistillInput:
    """单次蒸馏的输入材料容器（per-Organization）。"""

    def __init__(
        self,
        *,
        user_display_name: str,
        organization_name: str,
        previous_portrait_md: str,
        memos_for_prompt: List[Dict[str, Any]],
        hints: List[Dict[str, Any]],
        memo_count: int,
        truncated_memos: int,
    ):
        self.user_display_name = user_display_name
        self.organization_name = organization_name
        self.previous_portrait_md = previous_portrait_md
        self.memos_for_prompt = memos_for_prompt
        self.hints = hints
        self.memo_count = memo_count
        self.truncated_memos = truncated_memos

    def to_input_summary(self) -> Dict[str, Any]:
        """供 Snapshot.input_summary 字段使用。"""
        return {
            "memo_count": self.memo_count,
            "memo_truncated": self.truncated_memos,
            "hint_count": len(self.hints),
            "organization_name": self.organization_name,
        }

    def has_materials(self) -> bool:
        """是否具备一次有意义的蒸馏输入（hint / 新记忆 / 旧画像正文）。"""
        return bool(
            self.hints
            or self.memos_for_prompt
            or (self.previous_portrait_md or "").strip()
        )


class PortraitDistillService:
    """画像蒸馏 Service（/#4118 画像 per-(user, organization, agent)）。

    跟 UserPortraitService 不同：本 Service 不做 CRUD，只做"整理画像"这件事。
    所有持久化通过 UserPortraitService 完成（保证状态机一致性）。

    关键不变量：画像与记忆输入都按 (organization, agent, subject) 三键隔离。
    ``agent_id`` 缺失时该次蒸馏整体 **跳过（skip）**——既不召回任何记忆，也不落
    空画像、不触碰任何 portrait 行（fail-closed，绝不写 agent_id=NULL 的无主画像）。
    """

    def __init__(self, user, organization_id: str, agent_id: Optional[str] = None):
        if user is None or not getattr(user, "id", None):
            raise ValueError("PortraitDistillService requires a user with id")
        if not organization_id:
            raise ValueError("PortraitDistillService requires organization_id")
        self.user = user
        self.organization_id = str(organization_id)
        self.agent_id = str(agent_id) if agent_id else None
        self.portrait_svc = UserPortraitService(user=user)

    # ── 收集输入 ──────────────────────────────────────

    def has_distill_materials(self) -> bool:
        """API 入队前预检：与 ``run()`` 的 no-input skip 使用同一判定。

        ``agent_id`` 缺失时 fail-closed 返回 False（不入队、不落无主画像）。
        只读：不 ``get_or_create`` 画像行，避免用户点「立即整理」却跳过时
        仍落空 portrait。判定与 ``DistillInput.has_materials()`` 对齐
        （hint / 非空记忆 / 已有画像正文）。
        """
        if not self.agent_id:
            return False
        portrait = self.portrait_svc.get_portrait(
            self.organization_id, self.agent_id,
        )
        previous_md = (portrait.content_md or "") if portrait else ""
        hints = list(portrait.pending_hints or []) if portrait else []
        memos_for_prompt, _, _ = self._collect_new_memos(
            since=portrait.last_distilled_at if portrait else None,
        )
        return bool(
            hints
            or memos_for_prompt
            or previous_md.strip()
        )

    def collect_input(self) -> DistillInput:
        """收集本次蒸馏的所有输入材料（限定 self.organization_id + self.agent_id 内）。"""
        portrait = self.portrait_svc.get_or_create_portrait(
            self.organization_id, self.agent_id
        )

        # 1. 上一版 portrait 内容
        previous_md = portrait.content_md or ""

        # 2. pending hints
        hints = list(portrait.pending_hints or [])

        # 3. Organization 名称（用于 prompt 中的标注）
        organization_name = self._resolve_organization_name()

        # 4. TabMemo 输入（self.organization_id 内、自上次蒸馏到现在）
        memos_for_prompt, memo_count, truncated = self._collect_new_memos(
            since=portrait.last_distilled_at,
        )

        # 5. 用户称呼
        display_name = self._resolve_user_display_name()

        return DistillInput(
            user_display_name=display_name,
            organization_name=organization_name,
            previous_portrait_md=previous_md,
            memos_for_prompt=memos_for_prompt,
            hints=hints,
            memo_count=memo_count,
            truncated_memos=truncated,
        )

    def _resolve_user_display_name(self) -> str:
        """获取用户的称呼名（用于 prompt 第三人称叙事）。"""
        try:
            return self.user.get_display_name() or "用户"
        except Exception:
            return getattr(self.user, "nickname", None) or getattr(
                self.user, "username", None
            ) or "用户"

    def _resolve_organization_name(self) -> str:
        """获取当前 Organization 的名称（用于 prompt 注解）。

        测试 settings 没有 tabtinspace 时返回空字符串——prompt 在 organization_name
        为空时会跳过团队名标注，不会出现"默认全部"的歧义。
        """
        from django.apps import apps as django_apps
        try:
            Organization = django_apps.get_model("tabtinspace", "Organization")
        except LookupError:
            return ""
        try:
            wt = Organization.objects.filter(id=self.organization_id).only("name").first()
            return wt.name if wt else ""
        except Exception:
            return ""

    def _portrait_memory_source(self):
        """取 PortraitMemorySource；agent_memory 未装时返回 None（单测/最小 settings）。"""
        from django.apps import apps as django_apps

        if not django_apps.is_installed("apps.agent_memory"):
            return None
        from apps.agent_memory.portrait_adapter import PortraitMemorySource

        return PortraitMemorySource

    def _collect_new_memos(
        self,
        *,
        since: Optional[Any],
    ) -> tuple[List[Dict[str, Any]], int, int]:
        """收集当前 subject 在指定 Agent 下、自 since 之后的 AgentMemory。

        Returns:
            (memos_for_prompt, total_count, truncated_count)
        """
        source = self._portrait_memory_source()
        if source is None:
            return [], 0, 0

        memos, all_count, truncated = source.collect(
            organization_id=self.organization_id,
            agent_id=self.agent_id,
            subject_user_id=str(self.user.id),
            since=since,
            limit=MAX_MEMOS_PER_DISTILL,
        )

        organization_name = self._resolve_organization_name()
        prompt_items: List[Dict[str, Any]] = []
        for memo in memos:
            content = memo.get("content_plaintext") or memo.get("content_markdown") or ""
            if not content.strip():
                continue
            prompt_items.append({
                "organization_name": organization_name,
                "created_at": (
                    memo["created_at"].isoformat() if memo.get("created_at") else ""
                ),
                "content": f"({memo.get('memo_type') or 'memo'}) {content}",
            })
        return prompt_items, all_count, truncated

    # ── 调 LLM ──────────────────────────────────────

    def call_llm(
        self,
        distill_input: DistillInput,
        *,
        invocation_context: Any | None = None,
        selected_model_id: str = "",
    ) -> str:
        """调用 LLM 生成新版小传 markdown。

        通过 unified_llm_call + LLMSceneBinding 机制选模型。
        """
        from apps.services.llm.services.chat import unified_llm_call

        memos_text = "\n".join(
            format_memo_line(
                organization_name=m["organization_name"],
                created_at_iso=m["created_at"],
                content=m["content"],
            )
            for m in distill_input.memos_for_prompt
        )
        hints_text = "\n".join(
            format_hint_line(text=h["text"], submitted_at=h.get("submitted_at", ""))
            for h in distill_input.hints
        )

        try:
            result = unified_llm_call(
                scene_key=USER_PORTRAIT_DISTILL_SCENE_KEY,
                variables={
                    "user_display_name": distill_input.user_display_name,
                    "organization_name": distill_input.organization_name or "",
                    "previous_portrait": distill_input.previous_portrait_md,
                    "memos_summary": memos_text,
                    "hints_text": hints_text,
                },
                user_id=str(self.user.id),
                organization_id=self.organization_id,
                selected_model_id=selected_model_id or None,
                invocation_context=invocation_context,
                result_validator=lambda content: _validate_portrait_md(
                    _strip_code_fence(content)
                ),
            )
        except ServiceError:
            raise
        except Exception as exc:
            from apps.services.llm.scenes.exceptions import BYOKSceneError
            from apps.services.llm.services._runtime.background_invocation import (
                is_retryable_background_error,
            )

            if isinstance(exc, BYOKSceneError):
                raise
            logger.warning(
                "[Distill] unified_llm_call failed scene=%s err=%s",
                USER_PORTRAIT_DISTILL_SCENE_KEY, exc,
            )
            raise ServiceError(
                ErrorCode.DISTILL_FAILED,
                humanize_distill_failure(DistillFailureKind.LLM_CALL_FAILED),
                500,
                data={
                    "raw_detail": str(exc),
                    "kind": DistillFailureKind.LLM_CALL_FAILED,
                    "background_retryable": is_retryable_background_error(exc),
                },
            )

        return _strip_code_fence(result.content)

    # ── 完整蒸馏流程 ─────────────────────────────────

    def run(
        self,
        trigger_reason: str = "scheduled",
        *,
        resume_pending: bool = False,
        mark_failed_on_error: bool = True,
        invocation_context: Any | None = None,
        selected_model_id: str = "",
    ) -> Optional[UserPortrait]:
        """执行一次完整的蒸馏流程（针对 (self.organization_id, self.agent_id) 这一份画像）。

        /#4118：``agent_id`` 缺失时整体 **跳过**——返回 None，不
        mark_distill_pending、不建 portrait 行、不写空画像（fail-closed，绝不
        落无主画像）。此前版本在缺 agent_id 时仍会因 pending_hints / 旧
        previous_portrait_md 非空而 fail-open 调 LLM 并 commit 到无主画像行，
        本次改为在最前面短路，彻底堵死这个口子。

        流程（任何步骤失败都通过 mark_distill_failed 兜底，不破坏旧 USER）：
          1. collect_input；无材料则 skip（已 pending 则仍抛 DISTILL_IN_PROGRESS）
          2. mark_distill_pending（防并发）
          3. call_llm
          4. validate output
          5. commit_distill_result

        Celery 任务级重试会传 ``resume_pending=True``，继续第一次尝试持有的
        ``pending`` 状态；第一次可重试失败会传 ``mark_failed_on_error=False``，
        避免把“稍后自动重试”提前暴露成用户可见的终态失败。直接调用保持原语义：
        失败立即落 ``failed``。
        """
        # fail-closed：无 agent_id → 画像无归属，跳过整次蒸馏（不触碰任何 portrait）。
        if not self.agent_id:
            logger.info(
                "[Distill] user=%s organization=%s skipped: missing agent_id "
                "(per-Agent portrait requires agent scope)",
                self.user.id, self.organization_id,
            )
            return None

        # Phase 1: 先收集输入；无材料则不进 pending（避免 API 预检漏网时状态闪烁）。
        # 若已是 pending（另一 worker 持锁），不得把状态改回 idle——交给并发锁语义。
        distill_input = self.collect_input()
        if not distill_input.has_materials():
            portrait = self.portrait_svc.get_or_create_portrait(
                self.organization_id, self.agent_id
            )
            if portrait.last_distill_status == UserPortrait.DistillStatus.PENDING:
                raise ServiceError(
                    ErrorCode.DISTILL_IN_PROGRESS,
                    humanize_api_error(ErrorCode.DISTILL_IN_PROGRESS),
                    409,
                )
            logger.info(
                "[Distill] user=%s organization=%s agent=%s skipped: no input materials",
                self.user.id, self.organization_id, self.agent_id,
            )
            if portrait.last_distill_status != UserPortrait.DistillStatus.IDLE:
                portrait.last_distill_status = UserPortrait.DistillStatus.IDLE
                portrait.save(
                    using=USER_PORTRAIT_DB,
                    update_fields=["last_distill_status", "updated_at"],
                )
            return portrait

        # Phase 2: 状态机 → pending（防并发）。Celery retry 使用同一个逻辑任务
        # 续跑第一次尝试留下的 pending，不再次抢锁；若状态已被其它执行推进到
        # 终态，则本次 retry 已被更新结果取代，直接返回，绝不覆盖新结果。
        if resume_pending:
            current = self.portrait_svc.get_portrait(
                self.organization_id, self.agent_id,
            )
            if (
                current is None
                or current.last_distill_status
                != UserPortrait.DistillStatus.PENDING
            ):
                logger.info(
                    "[Distill] user=%s organization=%s agent=%s retry superseded "
                    "by status=%s",
                    self.user.id,
                    self.organization_id,
                    self.agent_id,
                    getattr(current, "last_distill_status", "missing"),
                )
                return current
        else:
            self.portrait_svc.mark_distill_pending(
                self.organization_id, self.agent_id,
            )

        try:
            input_summary = distill_input.to_input_summary()

            # Phase 3: 调 LLM
            new_md = self.call_llm(
                distill_input,
                invocation_context=invocation_context,
                selected_model_id=selected_model_id,
            )

            # Phase 4: 校验
            new_md = _validate_portrait_md(new_md)

            # Phase 5: 提交结果
            return self.portrait_svc.commit_distill_result(
                organization_id=self.organization_id,
                agent_id=self.agent_id,
                new_content_md=new_md,
                trigger_reason=trigger_reason,
                input_summary=input_summary,
            )

        except ServiceError as e:
            # ServiceError.message 已经是人话（在抛出点就 humanize 过了）；
            # raw_detail / stack 进 logger，不要把内部细节写到 portrait
            raw_detail = (e.data or {}).get("raw_detail") if e.data else None
            logger.warning(
                "[Distill] user=%s organization=%s agent=%s failed code=%s detail=%s",
                self.user.id, self.organization_id, self.agent_id, e.code,
                raw_detail or e.message,
            )
            if mark_failed_on_error:
                self.portrait_svc.mark_distill_failed(
                    self.organization_id,
                    self.agent_id,
                    e.message or humanize_distill_failure(DistillFailureKind.UNEXPECTED),
                )
            else:
                logger.info(
                    "[Distill] user=%s organization=%s agent=%s keeps pending "
                    "for task retry",
                    self.user.id,
                    self.organization_id,
                    self.agent_id,
                )
            raise
        except Exception as e:
            # 任何未预料的异常都要用人话兜底；技术细节进 logger（含 stack）
            logger.exception(
                "[Distill] user=%s organization=%s agent=%s unexpected error: %s",
                self.user.id, self.organization_id, self.agent_id, e,
            )
            if mark_failed_on_error:
                self.portrait_svc.mark_distill_failed(
                    self.organization_id,
                    self.agent_id,
                    humanize_distill_failure(DistillFailureKind.UNEXPECTED),
                )
            else:
                logger.info(
                    "[Distill] user=%s organization=%s agent=%s keeps pending "
                    "for task retry after unexpected error",
                    self.user.id,
                    self.organization_id,
                    self.agent_id,
                )
            raise


# ── 触发条件检查（D5：增量驱动） ────────────────────


def has_new_memos_since(
    user_id: str,
    organization_id: str,
    since,
    agent_id: Optional[str] = None,
) -> bool:
    """判断 subject 在指定 Agent 下从 `since` 之后是否有新 AgentMemory。

    UserPortrait 行仍是 per-(user, organization)；未提供 ``agent_id`` 时 fail-closed，
    不把多个 Agent 的记忆伪装成共享画像输入。

    Args:
        user_id: User ID
        organization_id: Organization ID（必传——v0.2 per-Organization 隔离）
        since: datetime；None 表示"从未蒸馏过"
        agent_id: Agent ID；缺失时返回 False
    """
    from apps.agent_memory.portrait_adapter import PortraitMemorySource

    return PortraitMemorySource.has_new(
        organization_id=organization_id,
        agent_id=agent_id,
        subject_user_id=user_id,
        since=since,
    )
