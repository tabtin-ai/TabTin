"""LLMModel 软引用 attach helper（v0.1 宪法 §5.1 收尾）。

本模块从「自包含实现」改为「``apps.services.common.cross_db_softref`` 通用 helper
的实例化」——v0.1 跨库治理打通后，``GoalRun.chat_session`` / ``ChatSession.space`` /
``Attachment.file`` 等其他跨库 FK 都用同一套 factory，避免每次 copy-paste 一份
fetch + attach 实现。

== 公共接口（保持向后兼容） ==

调用方代码不需要改：
- ``attach_llm_models_to_sessions(sessions)``
- ``attach_llm_models_to_messages(messages)``
- ``LLM_MODEL_CACHE_MISSING``（重新指向通用 ``SOFTREF_CACHE_MISSING``）

== 调用约定 ==

- 列表场景必须显式调（否则 property 触发 fallback warning，N+1 隐式发生）
- 单点接口可不调——单条 fallback fetch 是可接受成本
- ``TABTIN_SOFTREF_STRICT=1`` env 让 fallback 直接 raise，CI 模式逼出未走预加载
"""

from __future__ import annotations

from typing import Iterable, TYPE_CHECKING

from apps.services.common.cross_db_softref import (
    SOFTREF_CACHE_MISSING as LLM_MODEL_CACHE_MISSING,
    fetch_softref_targets_map,
)

if TYPE_CHECKING:
    from apps.chat.conversation.models import ChatMessage, ChatSession


__all__ = [
    "fetch_llm_models_map",
    "attach_llm_models_to_sessions",
    "attach_llm_models_to_messages",
    "resolve_soft_llm_ref",
    "set_cached_session_models",
    "set_cached_message_model",
    "LLM_MODEL_CACHE_MISSING",
]


# ════════════════════════════════════════════════════════════════════════════
#  对外 helper —— 单库治理后 current_model / default_model / model 已是物理 FK
# ════════════════════════════════════════════════════════════════════════════
#
# 这几个字段从跨库软引用恢复为同库 ForeignKey 后，批量预加载不再走
# ``_cached_*`` 属性（FK descriptor 只认 Django 自己的 ``_state.fields_cache``）。
# 这里把预加载实现成"批量 fetch + 填 FK 关系缓存"——等价于 select_related 的
# 效果，但保留 attach_* 的后置批量调用风格，调用方代码无需改动、不退化 N+1。

_TARGET_LLM_MODEL = "llm.LLMModel"
_LLM_SELECT_RELATED = ("provider",)


def _prime_fk_cache(instances: list, fk_field_names: tuple[str, ...]) -> None:
    """对一批实例，按 FK 字段名批量 fetch 目标并填入 FK 关系缓存（防 N+1）。

    - 收集各 FK 的 ``<field>_id`` 值，一次 ``filter(id__in=...)`` 查 LLMModel
      （select_related provider），按 id 映射。
    - 对每个实例 ``field.set_cached_value(instance, obj_or_None)``：命中填实例、
      id 为空或目标缺失填 None——之后 ``instance.<field>`` 读取不再触发查询。
    """
    if not instances:
        return
    sample = instances[0]
    wanted_ids: set[str] = set()
    for fname in fk_field_names:
        for inst in instances:
            raw = getattr(inst, f"{fname}_id", None)
            if raw:
                wanted_ids.add(str(raw))
    targets = fetch_llm_models_map(wanted_ids) if wanted_ids else {}
    for fname in fk_field_names:
        field = sample._meta.get_field(fname)
        for inst in instances:
            raw = getattr(inst, f"{fname}_id", None)
            obj = targets.get(str(raw)) if raw else None
            field.set_cached_value(inst, obj)


def attach_llm_models_to_sessions(sessions: Iterable["ChatSession"]) -> None:
    """批量预填 ``ChatSession.current_model`` / ``default_model`` 的 FK 缓存。"""
    _prime_fk_cache(list(sessions), ("current_model", "default_model"))


def attach_llm_models_to_messages(messages: Iterable["ChatMessage"]) -> None:
    """批量预填 ``ChatMessage.model`` 的 FK 缓存。"""
    _prime_fk_cache(list(messages), ("model",))


def fetch_llm_models_map(model_ids: Iterable) -> dict[str, object]:
    """按 ID 批量查 LLMModel，返回 ``{id_str: LLMModel}``，自动 select_related provider。"""
    return fetch_softref_targets_map(
        _TARGET_LLM_MODEL, model_ids, select_related=_LLM_SELECT_RELATED,
    )


def resolve_soft_llm_ref(instance, cache_attr: str, id_attr: str):
    """[兼容保留] 单点 LLMModel 解析。

    current_model/default_model/model 已是物理 FK，链式访问由 FK descriptor 原生
    懒加载承载；本函数仅为旧 import 兼容保留，按 id 直查返回。
    """
    raw = getattr(instance, id_attr, None)
    if not raw:
        return None
    return fetch_llm_models_map([raw]).get(str(raw))


def set_cached_session_models(session, *, current=None, default=None) -> None:
    """显式注入 ChatSession 的 LLMModel FK 缓存（创建 session 时复用已 fetch 的实例）。"""
    session._meta.get_field("current_model").set_cached_value(session, current)
    session._meta.get_field("default_model").set_cached_value(session, default)


def set_cached_message_model(message, model) -> None:
    """显式注入 ChatMessage 的 LLMModel FK 缓存。"""
    message._meta.get_field("model").set_cached_value(message, model)
