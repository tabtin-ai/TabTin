"""
记忆提取异步任务 — 使用 LLM 从对话中提取结构化记忆片段，
去重后写入记忆片段表。
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, List, Optional

from celery import shared_task
from celery.signals import task_prerun, task_postrun

from apps.services.billing.organization_resolver import resolve_organization_id_from_space
from apps.services.agent_engine.utils.memory_constants import DEFAULT_DEDUP_THRESHOLD
from apps.services.common.unicode_security import sanitize_text_for_storage as _sanitize_text

logger = logging.getLogger(__name__)


_MEMORY_TASK_PREFIX = "apps.services.agent_engine.tasks.memory."


def build_memory_capture_event_id(
    *, thread_id: str, start_index: int, end_index: int, agent_id: str
) -> str:
    """Identify one legitimate capture window; Celery retry reuses the same value."""
    if not thread_id or not agent_id:
        raise ValueError("memory capture event 缺少 thread_id 或 agent_id")
    start = int(start_index)
    end = int(end_index)
    if start < 0 or end <= start:
        raise ValueError("memory capture event 消息区间无效")
    return f"{thread_id}:{start}:{end}:{agent_id}"


def _safe_clear_context():
    try:
        from apps.services.common.thread_context import clear_context
        clear_context()
    except Exception:
        pass  # defensive: Celery 任务边界清理 ContextVar 失败，不影响后续任务调度


@task_prerun.connect
def _clear_context_before_memory_task(sender=None, **kwargs):
    """防御：任何 multiagent memory 任务开始前清理 ContextVar，
    避免继承上一个任务残留的 user_id / space_id 等（P1-46）。"""
    task_name = getattr(sender, "name", "") or ""
    if task_name.startswith(_MEMORY_TASK_PREFIX):
        _safe_clear_context()


@task_postrun.connect
def _clear_context_after_memory_task(sender=None, **kwargs):
    """兜底：任何 multiagent memory 任务结束后清理 ContextVar，防止线程复用污染。"""
    task_name = getattr(sender, "name", "") or ""
    if task_name.startswith(_MEMORY_TASK_PREFIX):
        _safe_clear_context()



@shared_task(ignore_result=True)
def advance_memory_index_task(_result, thread_id: str, new_index: int):
    """回调任务：extract_memories_task 成功后前进 memory_extracted_index。

    通过 Celery link 机制调用，仅在父任务成功完成时触发。
    _result: 父任务的返回值（未使用，Celery link 协议要求）。
    """
    if not thread_id or new_index <= 0:
        return
    try:
        from apps.chat.conversation.models import ChatSession
        ChatSession.objects.filter(thread_id=thread_id).update(
            memory_extracted_index=new_index,
        )
        logger.info(
            "[MemoryExtract] Index advanced via callback: thread=%s new_index=%d",
            thread_id, new_index,
        )
    except Exception as exc:
        logger.error(
            "[MemoryExtract] advance_memory_index failed: thread=%s new_index=%d error=%s",
            thread_id, new_index, exc,
        )


@shared_task(
    bind=True,
    ignore_result=False,
    max_retries=2,
    default_retry_delay=30,
    time_limit=180,
    soft_time_limit=160,
    # P0: queue 由 CELERY_TASK_ROUTES → ai_background 控制，禁止 decorator 绑部署拓扑
)
def extract_memories_task(
    self,
    space_id: str,
    user_id: str,
    thread_id: str,
    messages: List[Dict[str, str]] = None,
    dedup_threshold: float = DEFAULT_DEDUP_THRESHOLD,
    capture_mode: str = "auto",
    new_index: int = 0,
    signals: str = "",
    override_detection: bool = True,
    agent_id: str = "",
    selected_model_id: str = "",
    capture_event_id: str = "",
):
    """从对话消息中提取记忆片段并写入 MemoService。

    索引前进为回调式：由 advance_memory_index_task 在本任务成功后通过
    Celery link 回调执行（需要 ignore_result=False 以确保 link 可靠触发）。
    任务失败时 link 不触发，index 不前进，消息可被后续提取重新处理。

    new_index: DEPRECATED — 不再在此处使用，index 前进由 link 回调处理。
    signals: JSON 序列化的 L1 信号列表（explicit_remember 等），供提取逻辑参考。
    override_detection: 是否启用覆盖检测。
    agent_id: 调用方按消息归属分组后的执行 Agent；空串时回退会话解析。
    """
    if messages is None:
        messages = []
    from apps.services.agent_engine.utils.memory_locks import session_memory_lock
    from apps.services.common.thread_context import clear_context

    clear_context()

    if signals:
        try:
            parsed = _parse_signals(signals)
            logger.info(
                "[MemoryExtract] Signals context: %d signals, override=%s, mode=%s, space=%s",
                len(parsed), override_detection, capture_mode, space_id,
            )
        except (json.JSONDecodeError, TypeError):
            parsed = []
    else:
        parsed = []

    lock_timeout = extract_memories_task.time_limit + 30
    try:
        with session_memory_lock(thread_id, timeout=lock_timeout, blocking_timeout=10) as acquired:
            if not acquired:
                logger.info("[MemoryExtract] Lock contention, skip thread=%s", thread_id)
                return

            success = _do_extract_memories(
                self, space_id, user_id, thread_id,
                messages, dedup_threshold, capture_mode,
                signals=parsed,
                override_detection=override_detection,
                agent_id=agent_id,
                selected_model_id=selected_model_id,
                capture_event_id=capture_event_id,
            )

            if not success:
                raise RuntimeError(
                    f"Memory extraction failed (non-retryable): space={space_id} "
                    f"thread={thread_id} — index NOT advanced",
                )
    finally:
        clear_context()


def _do_extract_memories(
    task_self,
    space_id: str,
    user_id: str,
    thread_id: str,
    messages: List[Dict[str, str]] = None,
    dedup_threshold: float = DEFAULT_DEDUP_THRESHOLD,
    capture_mode: str = "auto",
    signals: Optional[List[Dict[str, Any]]] = None,
    override_detection: bool = True,
    agent_id: str = "",
    selected_model_id: str = "",
    capture_event_id: str = "",
) -> bool:
    """核心提取逻辑 — 供 task 和直接调用共用。

    Returns True if extraction completed successfully (including "nothing to extract"),
    False on non-retryable failures. Raises on retryable failures.
    """
    if messages is None:
        messages = []
    from celery.exceptions import SoftTimeLimitExceeded

    organization_id = resolve_organization_id_from_space(space_id) or ""
    from apps.agent_memory.workspace_memory_execution import (
        resolve_workspace_memory_worker,
    )

    execution = resolve_workspace_memory_worker(
        scene_key="memory_capture",
        organization_id=organization_id,
        user_id=user_id,
        selected_model_id=selected_model_id,
    )
    if not execution.enabled:
        return True
    selected_model_id = execution.selected_model_id

    effective_mode = _resolve_effective_capture_mode(capture_mode, signals or [])
    signal_hints = _format_signal_hints(signals or [])
    effective_agent_id = _resolve_effective_agent_id(
        space_id, thread_id=thread_id, agent_id=agent_id,
    )

    provider_completed = False
    try:
        celery_task_id = str(
            getattr(getattr(task_self, "request", None), "id", "") or ""
        )
        fragments = _extract_with_llm(
            messages, capture_mode=effective_mode,
            user_id=user_id, space_id=space_id,
            signal_hints=signal_hints,
            override_detection=override_detection,
            selected_model_id=selected_model_id,
            thread_id=thread_id,
            task_id=celery_task_id,
            retry_source="celery" if celery_task_id else "",
            capture_event_id=capture_event_id,
        )
        provider_completed = True
        if not fragments:
            logger.info("[MemoryExtract] No memories extracted for space=%s", space_id)
            return True

        if dedup_threshold < 1.0:
            fragments = _deduplicate(
                fragments, space_id, user_id, dedup_threshold,
                thread_id=thread_id,
                agent_id=effective_agent_id,
            )

        if fragments:
            _write_to_table(
                fragments, space_id, user_id, thread_id,
                agent_id=effective_agent_id,
            )
            logger.info(
                "[MemoryExtract] Wrote %d fragments for space=%s thread=%s agent=%s",
                len(fragments), space_id, thread_id, effective_agent_id or "-",
            )
        return True
    except SoftTimeLimitExceeded:
        logger.error(
            "[MemoryExtract] SoftTimeLimitExceeded: space=%s thread=%s — not retrying",
            space_id, thread_id,
        )
        return False
    except (ValueError, json.JSONDecodeError) as exc:
        logger.error(
            "[MemoryExtract] Non-retryable error: space=%s thread=%s error=%s",
            space_id, thread_id, exc,
        )
        return False
    except Exception as exc:
        retries = getattr(task_self, "request", None)
        retry_num = retries.retries if retries else 0
        max_retries = getattr(task_self, "max_retries", 0) or 0

        if retry_num >= max_retries:
            logger.error(
                "[MemoryExtract] All retries exhausted — memory extraction FAILED, "
                "index NOT advanced: space=%s thread=%s messages_count=%d error=%s",
                space_id, thread_id, len(messages), exc,
                exc_info=True,
            )
        else:
            logger.error(
                "[MemoryExtract] Retryable error (retry %d/%d): space=%s error=%s",
                retry_num, max_retries, space_id, exc,
                exc_info=True,
            )

        from apps.services.llm.services._runtime.background_invocation import (
            is_retryable_background_error,
        )

        should_retry = provider_completed or is_retryable_background_error(exc)
        if task_self is not None and hasattr(task_self, "retry") and should_retry:
            raise task_self.retry(exc=exc, countdown=2 ** retry_num * 15)
        raise


def _parse_signals(signals: Any) -> List[Dict[str, Any]]:
    if not signals:
        return []
    if isinstance(signals, list):
        return [s for s in signals if isinstance(s, dict)]
    if isinstance(signals, str):
        parsed = json.loads(signals)
        if isinstance(parsed, list):
            return [s for s in parsed if isinstance(s, dict)]
    return []


def _resolve_effective_capture_mode(
    capture_mode: str,
    signals: List[Dict[str, Any]],
) -> str:
    """L1 信号驱动 capture 行为：remember/correction 强制 auto 全量提取。"""
    signal_types = {s.get("type") for s in signals}
    if signal_types & {"explicit_remember", "correction"}:
        return "auto"
    if "explicit_forget" in signal_types:
        logger.info(
            "[MemoryExtract] explicit_forget detected — memo deletion/supersede not implemented",
        )
    return capture_mode


def _format_signal_hints(signals: List[Dict[str, Any]]) -> str:
    if not signals:
        return ""
    lines = []
    for sig in signals:
        sig_type = sig.get("type", "unknown")
        snippet = (sig.get("snippet") or "")[:200]
        lines.append(f"- [{sig_type}] {snippet}")
    return "[L1 memory signals]\n" + "\n".join(lines)


def _extract_with_llm(
    messages: List[Dict[str, str]],
    capture_mode: str = "auto",
    user_id: str = "",
    space_id: str = "",
    signal_hints: str = "",
    override_detection: bool = True,
    selected_model_id: str = "",
    thread_id: str = "",
    task_id: str = "",
    retry_source: str = "",
    capture_event_id: str = "",
) -> List[Dict[str, Any]]:
    """调用 LLM 提取记忆片段。"""
    from apps.services.llm.services.chat import unified_llm_call
    from apps.services.agent_engine.utils.memory_utils import strip_code_fence

    MAX_INPUT_CHARS = 30000
    conversation_text = "\n".join(
        f"[{m['role']}]: {m['content']}" for m in messages
    )
    if signal_hints:
        conversation_text = f"{signal_hints}\n\n{conversation_text}"
    if override_detection:
        conversation_text = (
            "[override_detection enabled — prioritize correcting/superseding conflicting memories]\n"
            + conversation_text
        )
    if len(conversation_text) > MAX_INPUT_CHARS:
        conversation_text = conversation_text[:MAX_INPUT_CHARS] + "\n...(truncated)"

    organization_id = resolve_organization_id_from_space(space_id) or "" if space_id else ""
    if not organization_id:
        logger.warning("[MemoryExtract] organization_id 为空，跳过提取")
        return []

    # 用户级记录风格（per-(user, organization)）：关闭则跳过整次提取；否则渲染偏好注入 prompt
    # （TM-16：读配置 + 渲染收口到 resolve_record_preference，与 task_summary 共用同一接线）。
    from apps.tabmemo.services.record_style_service import resolve_record_preference

    enabled, record_pref = resolve_record_preference(user_id, organization_id)
    if not enabled:
        logger.info(
            "[MemoryExtract] record style disabled, skip: user=%s ws=%s",
            user_id, organization_id,
        )
        return []

    mode = "selective" if capture_mode == "selective" else "auto"

    from apps.services.llm.scenes.exceptions import SceneCallError

    invocation_context = None
    if capture_event_id:
        from apps.services.llm.services._runtime.background_invocation import (
            build_background_scene_invocation,
        )

        invocation_context = build_background_scene_invocation(
            scene_key="memory_capture",
            business_identity=capture_event_id,
            organization_id=organization_id,
            user_id=user_id or "",
            selected_model_id=selected_model_id,
            business_object_type="memory_capture_window",
            business_object_id=capture_event_id,
            task_id=task_id,
            retry_source=retry_source,
        )

    try:
        result = unified_llm_call(
            scene_key="memory_capture",
            variables={
                "conversation_text": conversation_text,
                "record_preference": record_pref,
            },
            mode=mode,
            user_id=user_id or "",
            organization_id=organization_id,
            selected_model_id=selected_model_id or None,
            result_validator=_validate_memory_capture_result,
            invocation_context=invocation_context,
        )
    except SceneCallError as exc:
        logger.warning("[MemoryExtract] unified_llm_call failed (retryable): %s", exc)
        raise
    except Exception as exc:
        logger.warning("[MemoryExtract] unified_llm_call failed (retryable): %s", exc)
        raise

    content = strip_code_fence(result.content)

    try:
        parsed = json.loads(content)
        if isinstance(parsed, list):
            items = [
                item for item in parsed
                if isinstance(item, dict) and item.get("content")
            ]
            if capture_mode == "selective":
                items = [
                    item for item in items
                    if _safe_importance(item) >= 4
                ]
            return items
    except json.JSONDecodeError:
        logger.warning("[MemoryExtract] Failed to parse LLM response: %s", content[:200])

    return []


def _validate_memory_capture_result(content: str) -> None:
    """Validate structured memory output before any official settlement."""
    from apps.services.agent_engine.utils.memory_utils import strip_code_fence

    parsed = json.loads(strip_code_fence(content))
    if not isinstance(parsed, list):
        raise ValueError("memory_capture 结果必须是数组")
    if any(not isinstance(item, dict) or not item.get("content") for item in parsed):
        raise ValueError("memory_capture 数组元素必须包含 content")


def _safe_importance(item: Dict[str, Any]) -> int:
    try:
        return int(item.get("importance", 0))
    except (TypeError, ValueError):
        return 0


def _resolve_effective_agent_id(
    space_id: str,
    *,
    thread_id: Optional[str] = None,
    agent_id: str = "",
) -> str:
    """显式 agent_id 优先；空串回退会话/现场解析（兼容旧调用）。"""
    explicit = (agent_id or "").strip()
    if explicit:
        return explicit
    from apps.services.agent_engine.utils.memory_constants import (
        resolve_space_execution_agent_id,
    )
    return resolve_space_execution_agent_id(space_id, thread_id=thread_id) or ""


def _deduplicate(
    fragments: List[Dict[str, Any]],
    space_id: str,
    user_id: str,
    threshold: float,
    thread_id: Optional[str] = None,
    agent_id: str = "",
) -> List[Dict[str, Any]]:
    """基于 AgentMemory 表的 Jaccard 文本去重（/#4098：按「实际写入
    agent × owner」比对）。

    去重的比对基准必须与 ``_write_to_table`` 的写入归属一致：显式
    ``agent_id`` 优先（Relay/L4 多 Agent 分账），否则回退
    ``resolve_space_execution_agent_id``；并叠加 ``owner_id`` 过滤——
    绝不跨 owner 误抑制他人的相似记忆。"""
    if not fragments:
        return fragments

    try:
        if not space_id:
            return fragments

        from apps.services.agent_engine.utils.memory_constants import (
            get_agent_memo_queryset,
        )

        resolved_agent_id = _resolve_effective_agent_id(
            space_id, thread_id=thread_id, agent_id=agent_id,
        )
        if not resolved_agent_id:
            # 解析不到写入 agent → 无可靠比对基准（写入侧也会跳过），保留全部。
            return fragments

        existing_texts = list(
            get_agent_memo_queryset(agent_id=resolved_agent_id)
            .filter(owner_id=user_id)
            .order_by("-created_at")
            .values_list("content_plaintext", flat=True)[:100]
        )

        if not existing_texts:
            return fragments

        existing_lower = {
            t.strip().lower() for t in existing_texts if t
        }

        unique = []
        for frag in fragments:
            frag_text = frag["content"].strip().lower()
            is_dup = any(
                _text_similarity(frag_text, et) > threshold
                for et in existing_lower
            )
            if not is_dup:
                unique.append(frag)
            else:
                logger.debug(
                    "[MemoryExtract] Dedup: skipping '%s'", frag["content"][:50],
                )
        return unique

    except Exception as exc:
        logger.warning("[MemoryExtract] Dedup failed, keeping all: %s", exc)
        return fragments


def _tokenize(text: str) -> set:
    """分词：中文用 bigram，其它语言按空格分词。"""
    has_cjk = any("\u4e00" <= c <= "\u9fff" for c in text[:100])
    if has_cjk:
        cleaned = "".join(c for c in text if not c.isspace())
        if len(cleaned) < 2:
            return {cleaned} if cleaned else set()
        return {cleaned[i : i + 2] for i in range(len(cleaned) - 1)}
    return set(text.split())


def _text_similarity(a: str, b: str) -> float:
    """基于 token 集合的快速文本相似度（Jaccard）。"""
    set_a = _tokenize(a)
    set_b = _tokenize(b)
    if not set_a or not set_b:
        return 0.0
    intersection = len(set_a & set_b)
    union = len(set_a | set_b)
    return intersection / union if union else 0.0


from apps.services.agent_engine.utils.memory_constants import (
    LEGACY_TYPE_MAP as _LEGACY_TYPE_MAP,
    normalize_agent_memo_type,
)
from apps.tabmemo.constants import TABMEMO_DB


def _write_to_table(
    fragments: List[Dict[str, Any]],
    space_id: str,
    user_id: str,
    thread_id: str,
    agent_id: str = "",
) -> None:
    """将记忆片段写入独立 AgentMemory 表（ M4.5/C5 分家）。

    直接接收 space_id，通过 Space 模型查询 organization_id。
    若 space_id 缺失则抛出 ValueError，不静默跳过。
    解析不到执行 agent 时跳过写入（记忆必须归属 Agent，无主行不落库）。
    """
    from apps.agent_memory.repository import AgentMemoryRepository

    if not space_id:
        raise ValueError(
            f"[MemoryExtract] cannot write memo: space_id missing, "
            f"thread={thread_id}, fragments={len(fragments)}"
        )

    organization_id = resolve_organization_id_from_space(space_id)
    if not organization_id:
        raise ValueError(
            f"[MemoryExtract] cannot resolve organization from space={space_id}, "
            f"thread={thread_id}"
        )

    source_url = f"thread://{thread_id}" if thread_id else ""

    # 记忆归属：调用方显式 agent_id（Relay/L4 按消息分组）优先；
    # 否则会话直挂分身 / 现场回退。#3266 终态：解析失败 = 无归属 → 跳过。
    resolved_agent_id = _resolve_effective_agent_id(
        space_id, thread_id=thread_id, agent_id=agent_id,
    )
    if not resolved_agent_id:
        logger.warning(
            "[MemoryExtract] no execution agent resolved, skip %d fragments: "
            "space=%s thread=%s",
            len(fragments), space_id, thread_id,
        )
        return

    VALID_EMOTIONS = {"neutral", "happy", "curious", "frustrated", "relieved", "surprised", "reflective"}

    written = 0
    failed = 0
    last_exc: Optional[Exception] = None
    for frag in fragments:
        content = _sanitize_text(frag.get("content", "").strip())
        if not content:
            continue

        diary = _sanitize_text(frag.get("diary", "").strip())
        markdown = diary if diary else content

        legacy_type = frag.get("type", "事实")
        memo_type = normalize_agent_memo_type(legacy_type)

        importance = _safe_importance(frag)
        if importance < 1:
            importance = 3

        raw_tags = frag.get("tags", [])
        safe_tags = [_sanitize_text(t) for t in raw_tags] if raw_tags else []

        emotion = frag.get("emotion", "neutral")
        if emotion not in VALID_EMOTIONS:
            emotion = "neutral"
        ai_tags = [f"emotion:{emotion}"]

        try:
            AgentMemoryRepository.create(
                agent_id=resolved_agent_id,
                organization_id=organization_id,
                owner_id=user_id or None,
                memo_type=memo_type,
                content_markdown=markdown,
                content_plaintext=content,
                tags=safe_tags,
                ai_tags=ai_tags,
                importance=importance,
                source_url=source_url,
            )
            written += 1
        except Exception as exc:
            failed += 1
            last_exc = exc
            logger.error(
                "[MemoryExtract] Failed to write memory fragment (%d/%d): "
                "space=%s thread=%s content=%.80s error=%s",
                failed, len(fragments), space_id, thread_id,
                content, exc,
                exc_info=True,
            )

    if written:
        logger.info(
            "[MemoryExtract] Wrote %d/%d memories for space=%s thread=%s",
            written, len(fragments), space_id, thread_id,
        )

    if failed:
        raise RuntimeError(
            f"[MemoryExtract] {failed}/{len(fragments)} memory fragments failed to write: "
            f"space={space_id} thread={thread_id} last_error={last_exc}"
        )
