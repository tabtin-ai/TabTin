"""#3266 M4.5/C4：SkillEnablement 分阶段换锚设备安装登记表。

终态分层（audit §12.2 / 脑暴板①）：
- ``AgentSkillLink`` = 引用/启用/配置的唯一 SSoT（跟 agent 走）；
- ``SkillEnablement`` = 设备安装登记（device × skill × 版本 × 内容指纹），
  由客户端安装后上报维护。

数据分流：
1. **兜底回填 AgentSkillLink**：存量 (user, space) 行若能解析到 workspace
   agent 且携带集缺该行，upsert 补齐（0013 已回填过 + 双写期保持同步，
   这里只兜偶发漏网；enabled / config_json 原值搬运）。
2. **换锚拍平**：按 space 的绑定设备（control_device 优先、bound_device
   兜底）把安装记录拍到 device 维度；同 (device, skill) 多行只给 updated_at
   最新行写 device，其他旧行保留为空，确保迁移可逆且不丢历史。
3. user_id / space_id / enabled / config_json 作为回滚快照暂留 nullable；
   新代码只读写 device 维度，后续确认稳定后再单独删旧列。
"""
import django.db.models.deletion
from django.db import migrations, models


def split_enablement_to_device_anchor(apps, schema_editor):
    db_alias = schema_editor.connection.alias
    SkillEnablement = apps.get_model("skills", "SkillEnablement")
    AgentSkillLink = apps.get_model("skills", "AgentSkillLink")
    Space = apps.get_model("tabtinspace", "Space")

    # space → (agent_id, device_id) 一次性查表
    space_ids = set(
        SkillEnablement.objects.using(db_alias)
        .values_list("space_id", flat=True)
        .distinct()
    )
    space_map = {}
    if space_ids:
        for row in Space.objects.using(db_alias).filter(id__in=space_ids).values(
            "id",
            "agent_id",
            "agent__owner_user_id",
            "control_device_id",
            "bound_device_id",
            "type",
        ):
            space_map[row["id"]] = row

    # ── 1. 兜底回填 AgentSkillLink ──
    existing_links = {
        (link_agent_id, key)
        for link_agent_id, key in AgentSkillLink.objects.using(db_alias)
        .values_list("agent_id", "skill_canonical_key")
    }
    for row in (
        SkillEnablement.objects.using(db_alias)
        .order_by("updated_at")
        .iterator(chunk_size=500)
    ):
        info = space_map.get(row.space_id)
        agent_id = info["agent_id"] if info and info.get("type") == "workspace" else None
        if not agent_id:
            continue
        agent_owner_user_id = info["agent__owner_user_id"]
        if (
            agent_owner_user_id is None
            or str(row.user_id) != str(agent_owner_user_id)
        ):
            continue
        if (agent_id, row.skill_canonical_key) in existing_links:
            continue
        AgentSkillLink.objects.using(db_alias).create(
            agent_id=agent_id,
            skill_canonical_key=row.skill_canonical_key,
            source=row.source,
            skill_id=row.skill_id,
            enabled=row.enabled,
            config_json=row.config_json or {},
        )
        existing_links.add((agent_id, row.skill_canonical_key))

    # ── 2. 换锚拍平（device 维度，取 updated_at 最新）──
    # 只给每组 winner 写 device；旧行不删，保证 reverse 能恢复原表。
    winners = {}
    for row in (
        SkillEnablement.objects.using(db_alias)
        .order_by("updated_at")
        .iterator(chunk_size=500)
    ):
        info = space_map.get(row.space_id)
        device_id = None
        if info:
            device_id = info.get("control_device_id") or info.get("bound_device_id")
        if not device_id:
            continue
        winners[(device_id, row.skill_canonical_key)] = row.id

    for (device_id, _key), row_id in winners.items():
        SkillEnablement.objects.using(db_alias).filter(id=row_id).update(
            device_id=device_id,
        )


def reverse_device_anchor(apps, schema_editor):
    """删除新模型下新增、旧模型无法表达的行；存量旧行始终完整保留。"""
    db_alias = schema_editor.connection.alias
    SkillEnablement = apps.get_model("skills", "SkillEnablement")
    SkillEnablement.objects.using(db_alias).filter(
        user_id__isnull=True,
        space_id__isnull=True,
    ).delete()


class Migration(migrations.Migration):

    dependencies = [
        ("skills", "0013_backfill_agent_skill_link"),
        ("tabtinspace", "0097_workspace_backfill_from_space_3266"),
    ]

    operations = [
        # 先加真实 Device FK（nullable 过渡）；旧行未必能解析出执行设备。
        migrations.AddField(
            model_name="skillenablement",
            name="device",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="skill_installations",
                to="tabtinspace.device",
                help_text="安装所在设备。",
            ),
        ),
        # 删旧唯一约束（含 user/space 字段，须先于 RemoveField）
        migrations.RemoveConstraint(
            model_name="skillenablement",
            name="uq_enablement_user_space_skill",
        ),
        migrations.RemoveIndex(
            model_name="skillenablement",
            name="skills_enab_user_id_f0b806_idx",
        ),
        # 新模型创建的设备安装行不再带旧 user/space 锚，先放开可空。
        migrations.AlterField(
            model_name="skillenablement",
            name="user_id",
            field=models.UUIDField(null=True, blank=True, db_index=True),
        ),
        migrations.AlterField(
            model_name="skillenablement",
            name="space_id",
            field=models.UUIDField(null=True, blank=True, db_index=True),
        ),
        migrations.RunPython(
            split_enablement_to_device_anchor,
            reverse_device_anchor,
        ),
        migrations.AlterField(
            model_name="skillenablement",
            name="installed_version_seq",
            field=models.PositiveIntegerField(
                blank=True, null=True,
                help_text=(
                    "设备本地装的版本；NULL 表示本地可编辑 Skill 尚未绑定已发布版本。"
                    "platform / app / device 来源 = NULL（跟代码走，无云端版本）。"
                ),
            ),
        ),
        migrations.AlterField(
            model_name="skillenablement",
            name="install_content_hash",
            field=models.CharField(
                blank=True, default="", max_length=64,
                help_text=(
                    "设备安装时记录的内容 hash（D11 算法）。本地当前 hash 与此值"
                    "不一致 = 本地已修改。只由客户端上报更新——服务端发布新版**不**"
                    "刷此值（ has_local_changes 恒真 bug 的根因修复）。"
                ),
            ),
        ),
        migrations.AddConstraint(
            model_name="skillenablement",
            constraint=models.UniqueConstraint(
                fields=["device", "skill_canonical_key"],
                name="uq_enablement_device_skill",
            ),
        ),
        migrations.AlterModelOptions(
            name="skillenablement",
            options={
                "verbose_name": "Device Skill Install",
                "verbose_name_plural": "Device Skill Installs",
            },
        ),
    ]
