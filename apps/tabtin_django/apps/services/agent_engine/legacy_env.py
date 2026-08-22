"""Agent Engine 环境变量 / Django settings 命名过渡层。

Wave 11 之前 Agent 引擎命名为 `orchestration`，所有配置契约以 `ORCHESTRATION_*`
前缀暴露（环境变量、Django settings 属性）。W11 将模块重命名为 `agent_engine`
后，统一改用 `AGENT_ENGINE_*` 前缀。

为避免部署侧（.env、启动脚本、Helm values 等）一次性切换带来的停机风险，本模块
提供带 legacy fallback 的统一读取入口：

- ``agent_engine_env(name, default)`` 读取环境变量，优先新名，legacy fallback
- ``agent_engine_setting(attr, default)`` 读取 Django settings 属性，同上
- ``alias_legacy_setting_names(globals, pairs=...)`` 供 settings.py 在显式定义
  新名后为 legacy 建立反向赋值；若 legacy 被显式覆盖且值与新名不一致，打一条
  ``WARNING``（属"需要运维确认的临时态"）。

命名规则固定为 ``AGENT_ENGINE_`` → ``ORCHESTRATION_``；其它不含此前缀的名称不会
自动推导 legacy，调用方可在必要处显式指定 ``legacy_name=``。

**哨兵**：``MISSING`` 是公开 sentinel（identity 语义），供调用方区分"未设置"与
"显式设置为 None"；所有内部 `is`/`is not` 判断都基于它。

**废弃时间窗口**：legacy 名称保留至 Wave 13（预计 2026-06），期间任何 legacy
读取都会打出 WARNING 日志 + 发 ``DeprecationWarning``，每个 key 每进程只提醒一次。
日志 message 中包含 caller 信息（``filename:lineno#function``），便于生产环境
直接定位到读取点所在代码位置。

**日志位置**：本模块 logger 为 ``apps.services.agent_engine.legacy_env``，在
``tabtin/settings.py`` 的 ``LOGGING`` 配置中由 ``apps.services.agent_engine``
父 logger 统一接管（``RotatingFileHandler`` + ``propagate=False``），因此
deprecation 日志 **只会** 出现在 ``apps/tabtin_django/logs/agent_engine.log``，
**不会** 出现在 ``django-dev.log`` / ``celery-worker.log``。过渡期观测命令与
Wave 13 下线判据见迁移文档 §6 Phase B 与 §8.5。

**迁移指南**：完整旧→新名映射表、过渡阶段、运维迁移路径见
``docs/agent-runtime/agent-engine-env-rename-migration.md``（IDE 可按此相对路径
跳转，便于从业务代码快速找到上下文）。

**进程 fork 行为**：模块内维护了去重集合 ``_warned_keys``。在 Celery prefork
worker 这种"父进程 fork 后可能已命中告警"的场景下，子进程继承父进程的去重状态；
若子进程首次处理相同 legacy key 时不再告警属于预期行为。通过
``os.register_at_fork(after_in_child=...)`` 注册了子进程清空 hook，确保每个子
进程独立经历一次告警，便于聚合日志去重。
"""

from __future__ import annotations

import logging
import os
import sys
import threading
import warnings
from typing import Any, Final, Optional, TypeVar

logger = logging.getLogger(__name__)

NEW_PREFIX: Final[str] = "AGENT_ENGINE_"
LEGACY_PREFIX: Final[str] = "ORCHESTRATION_"

_T = TypeVar("_T")


class _Missing:
    """MISSING sentinel 的单例类，便于 repr / type-check 可读。"""

    __slots__ = ()

    def __repr__(self) -> str:
        return "<MISSING>"

    def __bool__(self) -> bool:
        return False


MISSING: Final[_Missing] = _Missing()
"""公开 sentinel：区分 "未设置" 与 "显式设置为 None"。"""


_warned_keys: set[str] = set()
_warn_lock = threading.Lock()


def _derive_legacy_name(new_name: str) -> Optional[str]:
    """若 ``new_name`` 以 AGENT_ENGINE_ 开头则返回对应 ORCHESTRATION_ 名；否则 None。"""
    if new_name.startswith(NEW_PREFIX):
        return LEGACY_PREFIX + new_name[len(NEW_PREFIX):]
    return None


def _describe_caller(skip_frames: int) -> str:
    """抽取调用栈上第 skip_frames 帧的 filename:lineno#function。

    仅在 legacy 命中首次告警时调用，O(1)/key 成本；命中去重后就不再计算。
    ``skip_frames`` 以本函数为 0 计数：`_describe_caller → _emit_deprecation →
    agent_engine_* → caller`，业务 caller 对应 skip_frames=3。

    用 ``sys._getframe(skip_frames)`` 而非 ``inspect.stack()``：后者会构建整个
    栈帧列表（O(stack depth)），即便只取一帧；前者是 CPython 内置直达，
    O(1) 成本更合理（仅 CPython 保证；PyPy 也支持）。
    """
    try:
        frame = sys._getframe(skip_frames)
    except ValueError:
        return "<unknown caller>"
    return f"{frame.f_code.co_filename}:{frame.f_lineno}#{frame.f_code.co_name}"


def _emit_deprecation(new_name: str, legacy_name: str, *, source: str) -> None:
    """对每个 legacy key 进程内首次命中时发出一次告警。

    ``source`` 区分来源（"env" / "setting"），方便运维根据日志定位改哪一层。
    日志附带 caller 信息，便于后端工程师直接跳转到业务读取点。
    """
    key = f"{source}:{legacy_name}"
    with _warn_lock:
        if key in _warned_keys:
            return
        _warned_keys.add(key)

    caller = _describe_caller(skip_frames=3)
    message = (
        f"[agent_engine] Deprecated {source} name '{legacy_name}' detected "
        f"(caller={caller}); please rename to '{new_name}'. Legacy alias will "
        f"be removed in a future release "
        f"(tracked in docs/agent-runtime/agent-engine-env-rename-migration.md)."
    )
    logger.warning(message)
    warnings.warn(message, DeprecationWarning, stacklevel=3)


def _reset_deprecation_cache() -> None:
    """清空 legacy key 告警缓存，**仅供测试/诊断使用**。

    不纳入 `__all__`，生产代码请勿调用——否则会破坏"每 key 只告警一次"契约。
    """
    with _warn_lock:
        _warned_keys.clear()


# 生产告警兼容别名（保留一轮，Wave 12 删除）
reset_deprecation_cache = _reset_deprecation_cache


def list_reported_legacy_keys() -> frozenset[str]:
    """返回当前进程已告警过的 legacy key 集合（source:name 形式），用于健康检查。

    返回 frozenset 以避免外部修改内部状态。
    """
    with _warn_lock:
        return frozenset(_warned_keys)


def _clear_after_fork() -> None:
    """Celery / gunicorn prefork 后清空去重集合，保障每个子进程独立计数一次。

    若父进程已 lock 被 fork，子进程中 lock 会继承"被持有"状态；这里直接重建 lock
    以规避潜在死锁。"""
    global _warn_lock
    _warn_lock = threading.Lock()
    _warned_keys.clear()


# 仅在支持的平台注册（Python 3.7+ on POSIX）
if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_clear_after_fork)


def agent_engine_env(
    new_name: str,
    default: Optional[str] = None,
    *,
    legacy_name: Optional[str] = None,
) -> Optional[str]:
    """读取环境变量，优先新名，legacy 名兜底。

    >>> agent_engine_env("AGENT_ENGINE_SUBAGENT_RECOVER_ON_STARTUP", "1")

    参数：
        new_name: 完整新名称（含 AGENT_ENGINE_ 前缀）
        default: 两个名称都未设置时返回的默认值
        legacy_name: 可选显式指定 legacy 名（不沿用默认 ORCHESTRATION_ 前缀推导）
    """
    value = os.environ.get(new_name)
    if value is not None:
        return value

    lname = legacy_name or _derive_legacy_name(new_name)
    if lname:
        legacy_value = os.environ.get(lname)
        if legacy_value is not None:
            _emit_deprecation(new_name, lname, source="env")
            return legacy_value
    return default


def agent_engine_setting(
    new_attr: str,
    default: _T = None,  # type: ignore[assignment]
    *,
    legacy_attr: Optional[str] = None,
) -> _T:
    """读取 Django settings 属性，优先新名，legacy 名兜底。

    和 ``agent_engine_env`` 对称，但面向已由 settings 框架解析过的值（可能是
    任意 Python 类型，而非仅 str）。
    """
    from django.conf import settings

    value = getattr(settings, new_attr, MISSING)
    if value is not MISSING:
        return value  # type: ignore[return-value]

    lattr = legacy_attr or _derive_legacy_name(new_attr)
    if lattr:
        legacy_value = getattr(settings, lattr, MISSING)
        if legacy_value is not MISSING:
            _emit_deprecation(new_attr, lattr, source="setting")
            return legacy_value  # type: ignore[return-value]
    return default


def alias_legacy_setting_names(
    module_globals: dict[str, Any],
    *,
    pairs: "list[tuple[str, str]]",
) -> None:
    """在 settings.py 中调用：为每对 (new_attr, legacy_attr) 建立双向别名。

    约定：new_attr 必须先赋值；本函数做三件事：
    1. 若 legacy_attr 在 module_globals 中不存在 → 直接指向 new_attr 的值
    2. 若 legacy_attr 已存在且值相同 → 无操作
    3. 若 legacy_attr 已存在且值不同 → 视为"运维显式 override"：保留 legacy
       值的同时 **打 WARNING**（需要运维确认的临时态，不应长期存在）

    这样无论下游是按新名还是旧名读取 ``django.conf.settings``，都能拿到一致值，
    且 legacy 显式赋值仍具有更高优先级，便于运维在过渡期临时回退。
    """
    seen_pairs: set[tuple[str, str]] = set()
    for new_attr, legacy_attr in pairs:
        if (new_attr, legacy_attr) in seen_pairs:
            logger.warning(
                "[agent_engine] alias_legacy_setting_names: duplicate pair (%s,%s)",
                new_attr, legacy_attr,
            )
            continue
        seen_pairs.add((new_attr, legacy_attr))

        if new_attr not in module_globals:
            logger.warning(
                "[agent_engine] alias_legacy_setting_names skipped: %s missing",
                new_attr,
            )
            continue
        new_value = module_globals[new_attr]
        if legacy_attr in module_globals:
            legacy_value = module_globals[legacy_attr]
            if legacy_value != new_value:
                logger.warning(
                    "[agent_engine] Legacy setting %s explicitly set to %r while "
                    "%s=%r — BOTH values observed, legacy takes precedence "
                    "for backward compatibility. This is a transitional state; "
                    "please align the two values or remove the legacy one.",
                    legacy_attr, legacy_value, new_attr, new_value,
                )
            continue
        module_globals[legacy_attr] = new_value


__all__ = [
    "NEW_PREFIX",
    "LEGACY_PREFIX",
    "MISSING",
    "agent_engine_env",
    "agent_engine_setting",
    "alias_legacy_setting_names",
    "list_reported_legacy_keys",
]
