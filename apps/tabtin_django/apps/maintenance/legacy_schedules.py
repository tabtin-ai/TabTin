"""Celery Beat Schedule 历史命名迁移的单一来源。

Wave 11 迁移 ``apps.orchestration.*`` 任务路径 → ``apps.services.agent_engine.*``；
Wave 12 归一 schedule key 命名：废弃 ``orchestration-*`` 前缀，
同时放弃过渡态的 ``agent-engine-*`` 前缀（因其与 agent_engine 下 15 条无前缀 key
形成孤岛），统一为无前缀命名风格（如 ``check-monitor-heartbeats``）。

运行时有两个消费者共享这些常量：

- ``tabtin/celery.py::_soft_disable_legacy_duplicates`` 在 Worker 启动时自动软
  禁用被新 key 替代的 legacy 记录；
- ``apps/capabilities/management/commands/check_orchestration_beat_tasks.py``
  提供运维侧的只读检查、修复、删除操作。

**为什么抽到这里**：
- 两处逻辑必须同步（同一个 Wave 的归一/恢复），常量分散两文件时极易漏改；
- ``apps/maintenance`` 是已有的基建维护目录，天然是"部署前后清理"类常量的家；
- 抽出后仍只是纯数据 / 无副作用，import 成本可忽略。

**演进规则**：
- 未来新增一类前缀迁移，在此文件追加元组成员即可，不改消费者代码；
- 字符串迁移映射（``task`` 字段路径变更）同样集中维护，消费者通过常量名表达意图。

**与 @shared_task(name="orchestration.xxx") 的边界**：
这些"短名 task name"（如 ``orchestration.sweep_stale_runs``）是产品级标识符，
写入的是 ``PeriodicTask.task`` 字段且含点号，**不会**被这里的 ``orchestration-``
前缀误匹配，也不会被 ``apps.orchestration.`` 前缀匹配。显式保留。
"""

from __future__ import annotations

from typing import Final, Mapping


LEGACY_SCHEDULE_KEY_PREFIXES: Final[tuple[str, ...]] = (
    "orchestration-",
    "agent-engine-",
)
"""以下前缀的 PeriodicTask.name 视为历史遗留的 schedule key。

- ``orchestration-``：Wave 11 之前的历史命名
- ``agent-engine-``：Wave 12 过渡阶段短暂使用的前缀，已与同目录 15 条无前缀
  key 风格不一致，连同 ``orchestration-`` 一并视为 legacy

Wave 12 归一后，代码里不应再出现这些前缀的 key 定义；若 DB 里仍有，
由 ``_soft_disable_legacy_duplicates`` 自动软禁用、``--purge-legacy-keys``
手动彻底删除。
"""


TASK_PATH_MIGRATIONS: Final[Mapping[str, str]] = {
    "apps.orchestration.": "apps.services.agent_engine.",
}
"""PeriodicTask.task 字段的模块路径迁移对照表（W11 遗留）。

``--fix`` 参数在迁移时对每条匹配记录只做**第一次**出现的前缀替换，
避免在罕见的嵌套引用下破坏后续路径段。
"""


def legacy_task_path_prefixes() -> tuple[str, ...]:
    """返回所有历史 task 路径前缀，用于 ORM filter 的 startswith 族查询。"""
    return tuple(TASK_PATH_MIGRATIONS.keys())


def resolve_new_task_path(old_path: str) -> str | None:
    """将旧 task 路径映射到新路径；若无匹配返回 None。

    调用方：``check_orchestration_beat_tasks --fix`` 逐条转换。
    语义保证：``old_path`` 必须先由 ``task__startswith=<key>`` 过滤，
    此函数不做边界校验（不是用户输入 sanitizer）。
    """
    for old_prefix, new_prefix in TASK_PATH_MIGRATIONS.items():
        if old_path.startswith(old_prefix):
            return old_path.replace(old_prefix, new_prefix, 1)
    return None
