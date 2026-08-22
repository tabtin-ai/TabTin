"""Skills Wave 1（PRD V3.3 §11.4，2026-05-02）：移除 SpaceAppSettings.skill_configs 字段。

原 JSONField 存 ``{"<skill_key>": {"enabled": bool, "credential_id": ..., "env": ...,
"config": ...}}``，所有这些信息已迁移到 ``apps.skills.SkillEnablement``：
- enabled = SkillEnablement 行存在
- credential_id / env / config = SkillEnablement.config_json

无兼容负担元原则：产品未上线，不做数据迁移；旧字段直接 RemoveField，新模型
fresh migrate（``apps/skills/migrations/0001_initial.py``）。
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("tabtinspace", "0044_agent_config_v2"),
    ]

    operations = [
        migrations.RemoveField(
            model_name="spaceappsettings",
            name="skill_configs",
        ),
    ]
