"""Tracker (Tracker / TrackerRun) 字段 deprecation telemetry 基础设施。

Wave 1 引入：为 charter v1.8 §7.1 列出的「禁止字段」打 telemetry 钩子，
便于 Wave 2 末尾通过 ``grep "tracker_deprecated_field_access" logs/`` 确认
  0 调用后再 drop 字段。

Wave 2 收尾 (charter v1.8 §7.1 / §7.2 + plan v2.1 §1.3c)：
  原 7 个被监控字段已全部 drop（migration 0023 + Wave 2 续作的
  total_steps / completed_steps drop 推到 Wave 3 启动前——charter §6.4
  确认无活路径）。监控清单 ``TRACKER_DEPRECATED_FIELDS`` /
  ``TRACKER_RUN_DEPRECATED_FIELDS`` 清空，但保留：
   - ``log_deprecated_field_access`` 函数（未来 Wave 复用）
   - ``TRACKER_*_DEPRECATED_FIELDS`` 元组定义（清单接口稳定）
   - ``Tracker.save() / TrackerRun.save()`` 不再需要钩子——保留是技术债，
     models.py 同步删除以保持代码干净。

设计选择（为什么是 save 时而非每次读写）：
- 频繁 read 路径会造成日志风暴。
- 「使用」此字段的真正信号是「有路径仍在写入非默认值」。一旦没有写入路径，
  字段就是死字段，可以 drop。
- 写入触发点收敛在 model.save() —— 单点上报，0 侵入业务代码。

P1-2 (Wave 2)：默认值通过 ``field.get_default()`` 反射 model 真实声明，
避免「字段定义和 telemetry 默认值脱钩」的双源真相问题。
"""

from __future__ import annotations

import logging
from typing import Any, Iterable

logger = logging.getLogger("scheduler.deprecation")

# Wave 2 收尾 (charter v1.8 §7.1 + plan v2.1 §1.3c)：4 个 Tracker 字段已 drop。
# 监控清单清空——未来若有新 deprecated 字段，按相同模式追加。
TRACKER_DEPRECATED_FIELDS: tuple[str, ...] = ()

# Wave 2 收尾 (charter v1.8 §7.2 + plan v2.1 §1.3c)：
#   - cycle_history: 已 drop (migration 0023)
#   - total_steps / completed_steps: model 字段保留（DB 列还在）；
#     Wave 2 续作已确认无活路径写入，Wave 3 启动前再独立 PR drop。
#     在此期间继续监控：deprecation_logger 仍上报这两个字段的非默认写入。
TRACKER_RUN_DEPRECATED_FIELDS: tuple[str, ...] = (
    "total_steps",
    "completed_steps",
)


def _resolve_field_default(instance: Any, field_name: str) -> Any:
    """通过 Django field meta 反射获取真实默认值。

    Wave 2 P1-2：避免 TRACKER_DEPRECATED_FIELDS 与 ``models.py`` 上的 ``default=...``
    脱钩。``Field.get_default()`` 是 Django 标准接口，对 callable default
    （如 ``default=dict`` / ``default=list``）会调用并返回新实例，与 model 实际行为
    一致。
    """
    try:
        field = instance._meta.get_field(field_name)
    except Exception:  # noqa: BLE001 — 字段已 drop / 重命名时返回 sentinel，跳过 telemetry
        return _MISSING_FIELD
    return field.get_default()


_MISSING_FIELD = object()  # sentinel：字段不存在（已 drop）


def _value_is_default(value: Any, default: Any) -> bool:
    """判断 value 是否等于该字段的默认值（写入默认值视为「未真正使用」）。"""
    if default is _MISSING_FIELD:
        # 字段已 drop，没法判断——跳过（不上报）
        return True
    # JSONField 的 default 可能 callable 也可能字面量；get_default() 已统一为实例值。
    if isinstance(default, (dict, list)):
        if value is None:
            return True
        try:
            return value == default
        except Exception:  # noqa: BLE001 — 任何比较异常都视为非默认（安全侧）
            return False
    if value is None and default is None:
        return True
    return value == default


def log_deprecated_field_access(
    model_name: str,
    field_names: Iterable[str],
    instance: Any,
    context: str = "save",
) -> None:
    """在 model.save() 时检查 deprecated 字段是否被写入非默认值，若是则打 telemetry。

    Wave 2 P1-2：``field_names`` 是字符串元组——默认值通过 model 反射获取。

    空 ``field_names`` 时直接返回（避免空循环开销），便于 Wave 2 收尾后保留
    ``Tracker.save() / TrackerRun.save()`` 钩子代码不报错。

    Args:
        model_name: "Tracker" 或 "TrackerRun"（用于日志查询过滤）
        field_names: 字段名序列
        instance: model 实例
        context: 上报上下文（默认 "save"，保留扩展位）
    """
    if not field_names:
        return
    for field_name in field_names:
        if not hasattr(instance, field_name):
            continue
        default = _resolve_field_default(instance, field_name)
        value = getattr(instance, field_name, None)
        if _value_is_default(value, default):
            continue
        # 单 instance 单字段每次 save 上报一次。logger key 固定 "tracker_deprecated_field_access"
        # 便于 grep。warning 级别，避免被 INFO 噪音覆盖。
        logger.warning(
            "tracker_deprecated_field_access model=%s field=%s context=%s instance_id=%s",
            model_name,
            field_name,
            context,
            getattr(instance, "id", None),
        )
