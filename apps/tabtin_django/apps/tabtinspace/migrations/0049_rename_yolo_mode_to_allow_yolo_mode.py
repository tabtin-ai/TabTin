"""Rename ``Agent.agent_config.security.yolo_mode`` → ``security.allow_yolo_mode``.

PRD v3 (2026-05-19) §5.1.2: 字段改名 + 语义改造。``yolo_mode`` 旧字段是 Agent 级
单层自动放行；``allow_yolo_mode`` 是 Agent 级两步授权 gate（必须配合消息体
``agent_mode=='yolo'`` 才生效）。schema_version 保持 v2 不升级。

DR-2：唯一用户=作者本人，不留兼容层；backward 主动抛错，避免误用。
"""

from __future__ import annotations

from django.db import migrations


def forward(apps, schema_editor):
    Agent = apps.get_model("tabtinspace", "Agent")
    for agent in Agent.objects.iterator():
        cfg = agent.agent_config or {}
        sec = cfg.get("security") or {}
        if not isinstance(sec, dict):
            continue
        if "yolo_mode" in sec:
            sec["allow_yolo_mode"] = bool(sec.pop("yolo_mode"))
            cfg["security"] = sec
            agent.agent_config = cfg
            agent.save(update_fields=["agent_config"])


def backward(apps, schema_editor):  # pragma: no cover - intentional
    raise NotImplementedError("唯一用户=作者本人；不留兼容层")


class Migration(migrations.Migration):

    dependencies = [
        ("tabtinspace", "0048_agent_working_dir"),
    ]

    operations = [
        migrations.RunPython(forward, backward),
    ]
