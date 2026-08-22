"""``resolve_resource_label`` — 把 typed resource id 解析为人类可读 label
（PRD-v3 §5.1 第 1 项 + A1-L9 — Wave A 启动包 A4）。

HITL UI 显示 ``CliInvocationSpec.resource = "<kind>:<id>"`` 这种裸 id 时用户体验差，
本模块尝试把裸 id 翻译成可读 label。

策略：

1. **dispatch by prefix** — ``<kind>:`` 前缀决定调哪个 App resolver。
   未知前缀直接返回 ``None``，上层 UI 灰显原 id 并提示"无法解析"（PRD §13.2 决议）。

2. **resolver 由 marketplace App 注册**：通过 ``register_resolver(prefix, callable)``
   注入；本仓默认 dispatch table 为空，由具体 App 在自身启动期注册。
   resolver 内部具体怎么取标签（fork CLI、调 HTTP、查本地缓存）由 App 自己决定，
   本模块只规定 ``ResolverFn`` 协议。

3. **失败 silent return None**（消化 PRD §13.2 + 题目要求）：resolver 抛任何异常
   或返回非 ``str`` 都被视为"无法解析"，silent log + 返回 None，上层 UI 自动 fallback
   到 raw id。

4. **本模块绝不阻塞 HITL UI 主路径** — resolver 自身应保证 fail-safe 与超时控制；
   调用方（HITL build_interrupt_payload 等）也应在异步路径或低优先级后台任务里
   调用，避免拖慢 review 弹出。
"""

from __future__ import annotations

import logging
import threading
from typing import Any, Callable, Dict, Optional, Tuple

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────
# 常量
# ─────────────────────────────────────────────────────────────────────


_REGISTRY_LOCK = threading.Lock()
"""保护 ``_RESOLVER_REGISTRY`` 的写入。

虽然产品约定 resolver 注册"仅在启动期"完成（H2 接入新 marketplace App 时
启动期一次性 register），加锁让"理论上多线程并发注册"不至于产生 dict
竞态导致 KeyError。读路径不加锁（dict 单点 get 是线程安全的 atomic 操作）。
"""


# ─────────────────────────────────────────────────────────────────────
# Resource id 解析
# ─────────────────────────────────────────────────────────────────────


def _parse_typed_resource(resource: str) -> Optional[Tuple[str, str]]:
    """``"<kind>:<id>"`` → ``("<kind>", "<id>")``；非法格式返回 None。

    typed resource 形如 ``<kind>:<id>``，``kind`` 由 ``cli/parser.py`` 写入
    （由具体 App 的 manifest cliGrammar 定义）。
    """
    if not isinstance(resource, str):
        return None
    if ":" not in resource:
        return None
    kind, _, raw_id = resource.partition(":")
    kind = kind.strip()
    raw_id = raw_id.strip()
    if not kind or not raw_id:
        return None
    # 简单防御：raw_id 不应包含空白 / shell 特殊字符
    # （resolver 通常会做 subprocess + list 调用，本模块只做基础格式校验）
    if any(ch.isspace() for ch in raw_id):
        return None
    return kind, raw_id


# ─────────────────────────────────────────────────────────────────────
# Dispatch table
# ─────────────────────────────────────────────────────────────────────


ResolverFn = Callable[[str, Dict[str, Any]], Optional[str]]


# 默认 dispatch table 为空：具体 App 在启动期通过 ``register_resolver`` 注入。
_RESOLVER_REGISTRY: Dict[str, ResolverFn] = {}


def register_resolver(prefix: str, resolver: ResolverFn) -> None:
    """注册 / 覆盖某个 prefix 的 resolver（线程安全）。

    产品约定 resolver "仅在启动期注册"，``_REGISTRY_LOCK`` 仅做防御性保护
    （多 worker 启动期重入或测试 patch 都不会出现 dict 写入竞态）。
    """
    if not prefix or not callable(resolver):
        raise ValueError("register_resolver requires non-empty prefix and callable")
    with _REGISTRY_LOCK:
        _RESOLVER_REGISTRY[prefix] = resolver


def reset_resolvers() -> None:
    """测试 helper：清空所有 resolver 注册。"""
    with _REGISTRY_LOCK:
        _RESOLVER_REGISTRY.clear()


def list_registered_prefixes() -> Tuple[str, ...]:
    """暴露当前注册的 prefix 列表，便于测试 / 诊断。"""
    with _REGISTRY_LOCK:
        return tuple(sorted(_RESOLVER_REGISTRY.keys()))


# ─────────────────────────────────────────────────────────────────────
# 主入口
# ─────────────────────────────────────────────────────────────────────


def resolve_resource_label(
    resource: Optional[str],
    context: Optional[Dict[str, Any]] = None,
) -> Optional[str]:
    """把 typed resource id 翻译成人类可读 label。失败统一返回 None（fail-safe）。

    Args:
        resource: ``"<kind>:<id>"`` 形式的 ``CliInvocationSpec.resource`` 字段值。
                  ``None`` / 空 / 无 ``:`` 直接返回 None。
        context: 调用方上下文（``organization_id`` / ``user_id`` / ``thread_id`` 等），
                 由具体 resolver 决定是否使用。

    Returns:
        可读 label 或 ``None``（解析失败 / 无 resolver）。
    """
    if not resource:
        return None
    parsed = _parse_typed_resource(resource)
    if parsed is None:
        logger.debug("[resource_label] resource 不是 typed 格式，跳过解析: %r", resource)
        return None
    kind, raw_id = parsed

    # 读路径无锁：dict.get 在 CPython 是 atomic 的；最坏情况读到陈旧 resolver
    # 也不会崩，符合 "register 仅在启动期" 的产品约定。
    resolver = _RESOLVER_REGISTRY.get(kind)
    if resolver is None:
        logger.debug(
            "[resource_label] 无 resolver 处理 prefix=%r（已注册 %s）",
            kind,
            list_registered_prefixes(),
        )
        return None

    try:
        label = resolver(raw_id, dict(context or {}))
    except Exception:  # noqa: BLE001 — resolver 永远 fail-safe，绝不影响 HITL 主路径
        logger.warning(
            "[resource_label] resolver 抛异常 prefix=%s raw_id_len=%d",
            kind,
            len(raw_id),
            exc_info=True,
        )
        return None

    if label is None:
        return None
    if not isinstance(label, str):
        logger.warning(
            "[resource_label] resolver 返回非 str prefix=%s type=%s",
            kind,
            type(label).__name__,
        )
        return None
    label = label.strip()
    return label or None


__all__ = [
    "ResolverFn",
    "register_resolver",
    "reset_resolvers",
    "list_registered_prefixes",
    "resolve_resource_label",
]
