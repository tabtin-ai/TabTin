"""
manifest_opens —— 后端读 `packages/apps/*/app.json` 的 `opens` 字段聚合器。

业务目标（专题"Agent 产物在 Space 内的打开" PRD §4 D1 + W0 调研 N1-6 + 总控 §6.2 L08）：
    后端任何"是不是支持这种 resource_type / scheme"的判断必须查 manifest
    `opens.types[].type` / `opens.schemes[].scheme` 聚合，**不允许硬编码**类型集合。

W6 之前：`present_to_user.py:43` 写死 `frozenset({"table","doc","slide","video","site"})`
仅 5 种，导致 Agent 想 emit `memo` / `whiteboard` / `code_file` 等 11+ 种
manifest 已声明的 type 时被后端 validator 拒绝——D1 manifest 驱动决策被
反例硬编码拖空。

W6 之后：本模块在 module 加载时一次性扫描 manifest，提供
`get_supported_resource_types()`，与 `packages/resource-router/src/registry.ts:knownTypes()`
对应。

设计取向：
    * 读同一份 manifest 文件（`packages/apps/*/app.json`）—— TS 端启动时
      用 `import.meta.glob` 聚合，Python 端用 `Path.glob`，两端永不漂移
    * lazy-loaded + cache：首次调用时扫，后续直接返回缓存（与 app_registry 同款 lru_cache 风格）
    * 不依赖 AppDefinition / Django settings —— 只读 manifest JSON 文件本身，
      让任何 import 路径（pure unittest / pytest / Django runtime）都能用
    * 缺失或损坏的 manifest 安静跳过（warning + 不阻断），与 app_registry 一致
"""

from __future__ import annotations

import json
import logging
from functools import lru_cache
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# 专属告警 logger（运维 ELK / Sentry 按 logger name 维度做 grouping + alert）。
# 与 ``scheduler.cache_failure`` 同模式（``apps/scheduler/services/goal_service.py:32``）。
# 当 manifest 全坏 → ``get_supported_resource_types`` 返回空集 → present_to_user
# 拒绝所有 Agent emit 的 resource_ref → 用户视角"看不到任何 Agent 产物"——必须告警。
_alert_logger = logging.getLogger("manifest_opens.fallback_alert")

# 项目根：集中到 apps.services.repo_root（env 锚点 + marker 向上找），不再写死 parents[N]
from apps.services.repo_root import get_repo_root

_PROJECT_ROOT = get_repo_root()
_APPS_DIR = _PROJECT_ROOT / "packages" / "apps"


def _iter_manifest_paths() -> list[Path]:
    if not _APPS_DIR.is_dir():
        logger.warning(
            "[manifest_opens] manifest 目录不存在: %s——返回空索引", _APPS_DIR
        )
        return []
    return sorted(_APPS_DIR.glob("*/app.json"))


def _read_manifest_safely(path: Path) -> dict[str, Any] | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        logger.warning("[manifest_opens] manifest 解析失败，跳过: %s", path, exc_info=True)
        return None


def _extract_opens(manifest: dict[str, Any]) -> dict[str, Any]:
    opens = manifest.get("opens")
    return opens if isinstance(opens, dict) else {}


@lru_cache(maxsize=1)
def get_supported_resource_types() -> frozenset[str]:
    """后端可被 Agent 引用的 ContextRefType 集合。

    聚合所有 `packages/apps/*/app.json` 的 `opens.types[].type` 字段。
    任何 type 至少有一个 App 声明能打开它即视为合法——这是 D1 manifest
    驱动哲学的实现：support 与否由 manifest 自然决定，不在 Python 代码里
    维护并行清单。

    W6 北极星：返回集合长度 ≥ 11（与 RFC §5.4 列出的 11 个 builtin App
    最小集声明的总 type 数对齐）。
    """
    types: set[str] = set()
    for path in _iter_manifest_paths():
        manifest = _read_manifest_safely(path)
        if manifest is None:
            continue
        opens = _extract_opens(manifest)
        entries = opens.get("types")
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            t = entry.get("type")
            if isinstance(t, str) and t:
                types.add(t)
    if not types:
        # 极端情况：manifest 全坏。logger.error 而不是抛——避免让整个后端启动挂掉，
        # 调用方 (present_to_user._validate_item) 会自然把 resource_ref 全部拒掉。
        logger.error(
            "[manifest_opens] get_supported_resource_types 返回空集——manifest 是否全部缺失或损坏？"
        )
        _emit_fallback_alert(
            metric="manifest_opens.types_empty",
            kind="types",
            apps_dir=str(_APPS_DIR),
            paths_count=len(_iter_manifest_paths()),
        )
    return frozenset(types)


def reload_for_tests() -> None:
    """测试场景下清缓存重新扫描（如 monkeypatch manifest 后）。"""
    get_supported_resource_types.cache_clear()


def _emit_fallback_alert(*, metric: str, kind: str, **tags: Any) -> None:
    """manifest 聚合失败的告警上报（W7 跨 Wave 收敛 §6.2 W6 review §9 #1）。

    业务背景：``get_supported_resource_types`` 返回空集 = present_to_user 把 Agent
    emit 的所有 resource_ref 全拒 = 用户看不到任何 Agent 产物。这是 PRD §6 标准 1
    "可见率 ≥ 80%" 的灾难场景，不能仅写 ``logger.error`` 被淹在普通日志流里。

    双管齐下（参照 ``apps/scheduler/services/goal_service.py:_record_storm_guard_cache_delete_failure``
    同款模式）：
      1) 命名 logger ``manifest_opens.fallback_alert`` (CRITICAL) ——
         ELK / Sentry / Honeybadger 按 logger name grouping + alert
      2) sentry_sdk.capture_message 直送 Sentry (若已配置)，附 tags 便于聚合

    设计决策：
      - 不抛异常：caller 在加载期，fail-safe（返回空集让上层 fail-closed 拒绝即可）
      - 不阻塞首屏：本函数自身故障 silent 吞
      - 即便 sentry_sdk 未安装也能正常工作（命名 logger 已上报）
      - **不引入** 新 telemetry 表：本告警是运维 ops 通道，与 W7 ResourceOpenEvent
        业务埋点正交，复用现有 logger / sentry 即可（用户 prompt 红线"不许新建 telemetry 表"）
    """
    try:
        _alert_logger.critical(
            "[manifest_opens] fallback alert: %s kind=%s tags=%s",
            metric, kind, tags,
            extra={"metric": metric, "tags": {"kind": kind, **tags}},
        )
    except Exception:
        # 告警 logger 自身故障：吞（不能影响业务路径）
        pass

    try:
        import sentry_sdk
        sentry_sdk.capture_message(
            f"manifest_opens fallback alert: {metric}",
            level="error",
            extras={"metric": metric, "kind": kind, **tags},
        )
    except Exception:
        # sentry_sdk 未安装 / 未初始化 / capture 失败 → 静默吞
        pass


# W6 视角 C P1-3 物理删除：曾在此处加 `get_supported_open_schemes()` 聚合
# scheme 集合，但本期 0 调用方——违反 AGENTS.md "抽象只在第二个使用场景出现
# 时再加" 红线。daemon 模式 / marketplace 真要消费时再加，不留预测性接口。

__all__ = [
    "get_supported_resource_types",
    "reload_for_tests",
]
