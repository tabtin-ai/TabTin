"""
会话标题生成服务

根据用户首条消息即时生成标题。
通过 unified_llm_call(scene_key="title_generation") 调用 LLM，
模型按会话当前模型、请求模型、用户默认模型、组织默认模型依次选择。
未配置可用模型时，直接根据首条用户消息生成本地临时标题。

调用模型
--------

``TitleGeneratorService.generate_title`` 是**同步阻塞**调用——内部走
``unified_llm_call`` 同步 HTTP 请求；调用方必须在**后台线程**上下文里执行。
"""

import logging
import re
from typing import Optional, List, Dict

from django.core.exceptions import ValidationError
from django.db import close_old_connections

logger = logging.getLogger(__name__)

_RETRYABLE_SCENE_ERROR_CODES = frozenset({
    "RATE_LIMIT",
    "PROVIDER_DOWN",
})

_RETRYABLE_SCENE_ERROR_MARKERS = tuple(sorted(_RETRYABLE_SCENE_ERROR_CODES))


def _build_default_titles() -> frozenset:
    """收集所有语言的 new_session_title 翻译值，用于判断标题是否为默认值。

    同时硬编码保留历史默认值（"新对话" / "New chat" 等）——存量会话仍带这些
    旧默认标题，术语从"对话"改为"任务"后仍需把它们识别为默认标题以触发标题生成。
    """
    titles = {"新任务", "New task", "新对话", "New Conversation", "New chat", ""}
    try:
        from apps.i18n.manager import i18n_manager
        for lang_translations in i18n_manager.translations.values():
            chat_section = lang_translations.get("chat", {})
            val = chat_section.get("new_session_title", "")
            if val:
                titles.add(val)
    except Exception:
        pass
    return frozenset(titles)


_DEFAULT_TITLES: frozenset = None  # type: ignore[assignment]

# LLM / 计费 scene 名泄漏成「标题」时的黑名单（ Unsend 复现过「会话标题生成」）。
_REJECTED_GENERATED_TITLES = frozenset({
    "会话标题生成",
    "对话标题生成",
    "title generation",
    "Title Generation",
    "Title generation",
})


def _get_default_titles() -> frozenset:
    global _DEFAULT_TITLES
    if _DEFAULT_TITLES is None:
        _DEFAULT_TITLES = _build_default_titles()
    return _DEFAULT_TITLES


def default_session_title() -> str:
    """新建 / 撤回复位用的默认会话标题（跟 create_session 同源）。"""
    try:
        from apps.i18n import get_text
        return get_text("chat.new_session_title") or "新任务"
    except Exception:
        return "新任务"


def _is_rejected_generated_title(title: str) -> bool:
    if title in _REJECTED_GENERATED_TITLES:
        return True
    try:
        from apps.services.llm.scenes.registry import SCENES
        spec = SCENES.get("title_generation")
        display = getattr(spec, "display_name", None) if spec else None
        if display and title == display:
            return True
    except Exception:
        pass
    return False


class TitleGeneratorService:
    """会话标题生成服务"""

    @classmethod
    def _is_retryable_generation_error(cls, exc: Exception) -> bool:
        """让可恢复的 provider 错误交给 Celery 退避，而不是吞成空标题。"""
        context = getattr(exc, "context", {}) or {}
        error_code = str(context.get("error_code") or "").upper()
        if error_code in _RETRYABLE_SCENE_ERROR_CODES:
            return True
        message = str(exc).upper()
        return any(marker in message for marker in _RETRYABLE_SCENE_ERROR_MARKERS)

    @classmethod
    def generate_title(
        cls,
        messages: List[Dict[str, str]],
        config: Optional[dict] = None,
        session=None,
        requested_model_id: Optional[str] = None,
    ) -> Optional[str]:
        """
        根据会话消息生成标题，支持重试。

        ⚠️ **同步阻塞**——禁止从 sync / async ASGI view 里直接调用。
        """
        _uid = str(getattr(session, "user_id", "") or "") if session else ""
        _wid = str(getattr(session, "organization_id", "") or "") if session else ""
        selected_model_id = cls._resolve_selected_model_id(
            session=session,
            requested_model_id=requested_model_id,
            user_id=_uid,
            organization_id=_wid,
        )

        if not selected_model_id:
            return cls._build_local_title(messages)

        retry_count = 2
        for attempt in range(retry_count):
            try:
                title = cls._call_llm(
                    messages,
                    user_id=_uid,
                    organization_id=_wid,
                    selected_model_id=selected_model_id,
                )
                if title:
                    return title
            except Exception as exc:
                logger.warning(
                    "[TitleGenerator] 第 %d/%d 次尝试失败: %s",
                    attempt + 1, retry_count, exc,
                )
                if cls._is_retryable_generation_error(exc):
                    raise

        return cls._build_local_title(messages)

    @classmethod
    def _resolve_selected_model_id(
        cls,
        *,
        session,
        requested_model_id: Optional[str],
        user_id: str,
        organization_id: str,
    ) -> str:
        """按会话 → 请求 → 用户默认 → 组织默认解析一个可见且兼容的模型。"""
        if not session or not organization_id:
            return ""

        from apps.services.llm.api_common import (
            _get_organization_default_model_id,
            _read_user_default_model_id,
        )
        from apps.services.llm.scenes.capability_check import (
            check_model_capability_match,
        )
        from apps.services.llm.scenes.registry import SCENES
        from apps.services.llm.services.model_resolver import (
            is_model_visible_for_user,
            resolve_model,
        )

        user = getattr(session, "user", None)
        def candidates():
            yield getattr(session, "current_model_id", None)
            yield requested_model_id
            yield _read_user_default_model_id(user, organization_id)
            yield _get_organization_default_model_id(organization_id)

        seen: set[str] = set()
        scene = SCENES["title_generation"]
        for candidate in candidates():
            model_id = str(candidate or "").strip()
            if not model_id or model_id in seen:
                continue
            seen.add(model_id)
            try:
                model = resolve_model(
                    model_id=model_id,
                    organization_id=organization_id,
                    user_id=user_id,
                    allowed_modes=("chat", "completion"),
                )
            except (TypeError, ValueError, ValidationError):
                logger.info(
                    "[TitleGenerator] ignore invalid model candidate=%s",
                    model_id,
                )
                continue
            if not is_model_visible_for_user(model, organization_id, user_id):
                continue
            if check_model_capability_match(
                model=model,
                requirements=scene.capability_requirements,
                capability_domain=scene.capability_domain,
            ) is not None:
                continue
            return str(model.id)
        return ""

    @classmethod
    def _build_local_title(
        cls,
        messages: List[Dict[str, str]],
        max_length: int = 20,
    ) -> str:
        """无可用模型时从首条用户消息生成稳定、无重试的本地标题。"""
        content = next(
            (
                str(message.get("content") or "")
                for message in messages
                if message.get("role") == "user" and message.get("content")
            ),
            "",
        )
        normalized = re.sub(r"^\s*(?:#{1,6}|[-*+>])\s*", "", content)
        normalized = re.sub(r"\s+", " ", normalized).strip()
        if not normalized:
            return default_session_title()
        return normalized[:max_length]

    @classmethod
    def _call_llm(
        cls,
        messages: List[Dict[str, str]],
        user_id: str,
        organization_id: str,
        selected_model_id: str,
    ) -> Optional[str]:
        from apps.services.llm.services.chat import unified_llm_call

        result = unified_llm_call(
            scene_key="title_generation",
            variables={"messages": messages[:4]},
            user_id=user_id,
            organization_id=organization_id,
            selected_model_id=selected_model_id,
        )

        raw = result.content.strip()
        return cls._clean_title(raw) if raw else None

    @classmethod
    def should_generate_title(cls, session) -> bool:
        """仅当标题是默认值时才需要生成。"""
        return session.title in _get_default_titles()

    @classmethod
    def is_fork_title_pending(cls, session) -> bool:
        """fork 子会话且标题流程仍为 pending（可自动重命名）。

        只信血缘 + ``title_generation_status``，不靠标题文本猜占位——
        避免「Sprint 12」这类正常标题被 ``\\s+\\d+$`` 误伤。
        """
        if not getattr(session, "forked_from_id", None):
            return False
        return getattr(session, "title_generation_status", None) == "pending"

    @classmethod
    def should_auto_generate_title(cls, session) -> bool:
        """自动补标题路径使用：手动/系统已完成标题流程后不再兜底生成。

        fork 会话创建时用 ``{根标题} {n}`` 占位，``title_generation_status``
        保持 pending；首次发送新消息触发 generate-title 时由此放行。
        """
        if getattr(session, 'title_generation_status', None) == 'done':
            return False
        if cls.should_generate_title(session):
            return True
        return cls.is_fork_title_pending(session)

    @classmethod
    def _clean_title(cls, title: str, max_length: int = 20) -> Optional[str]:
        title = title.strip().strip('"\'""''《》【】')
        if len(title) > max_length:
            title = title[:max_length]
        if not title:
            return "新任务"
        if _is_rejected_generated_title(title):
            logger.warning("[TitleGenerator] reject polluted title=%r", title)
            return None
        return title

    @classmethod
    def cancel_title_generation_for_empty_session(
        cls,
        session,
        *,
        publish: bool = True,
    ) -> Optional[str]:
        """#6154：撤回未答后会话已无 user 消息时，取消标题生成并复位默认标题。

        同时挡住仍在跑的 Celery/同步任务：它们在 persist 前会再查 user 消息，
        发现为空则不再写标题。本方法负责立刻复位 DB + 推 WS，让侧栏不再显示
        「会话标题生成」这类脏标题。

        Returns:
            复位后的默认标题；若仍有 user 消息则不做处理，返回 ``None``。
        """
        if session.messages.filter(role="user").exists():
            return None

        restored = default_session_title()
        session.title = restored
        session.title_generation_status = "pending"
        session.title_generation_failed_at = None
        # 不 bump updated_at：撤回未答不是用户新活动。
        session.save(update_fields=[
            "title",
            "title_generation_status",
            "title_generation_failed_at",
        ])

        if publish:
            user_id = str(getattr(session, "user_id", "") or "")
            if user_id:
                try:
                    from apps.services.common.chat_stream_publisher import (
                        ChatStreamPublisher,
                    )
                    ChatStreamPublisher.publish_title_update(
                        user_id,
                        session_id=str(session.id),
                        title=restored,
                        thread_id=getattr(session, "thread_id", None),
                    )
                except Exception:
                    logger.exception(
                        "[TitleGenerator] publish title reset failed session=%s",
                        session.id,
                    )

        logger.info(
            "[TitleGenerator] cancelled title gen for empty session=%s title=%r",
            session.id,
            restored,
        )
        return restored


def generate_session_title(session, force: bool = False) -> bool:
    """
    为会话生成标题（便捷函数，在后台线程中调用）。

    自动处理 DB 连接关闭，防止连接泄漏。
    """
    close_old_connections()
    try:
        if not force and not TitleGeneratorService.should_auto_generate_title(session):
            return False

        # ：排除 system_prompt_context 等注入 kind；只取首条真实 user。
        from apps.chat.conversation.services.semantic_message_count import (
            CONTEXT_INJECTION_KINDS,
        )
        user_text = (
            session.messages.filter(role='user')
            .exclude(message_kind__in=CONTEXT_INJECTION_KINDS)
            .order_by('created_at')
            .values_list('text_summary', flat=True)
            .first()
        )
        user_text = (user_text or '').strip()
        if not user_text:
            return False
        messages = [{'role': 'user', 'content': user_text}]

        title = TitleGeneratorService.generate_title(messages, session=session)

        if title:
            session.title = title
            session.title_generation_status = 'done'
            session.title_generation_failed_at = None
            session.save(update_fields=[
                'title',
                'title_generation_status',
                'title_generation_failed_at',
                'updated_at',
            ])
            logger.info("[TitleGenerator] 会话 %s 标题已更新: %s", session.id, title)
            return True

        return False
    except Exception as exc:
        logger.error("[TitleGenerator] 生成失败: %s", exc, exc_info=True)
        return False
    finally:
        close_old_connections()
