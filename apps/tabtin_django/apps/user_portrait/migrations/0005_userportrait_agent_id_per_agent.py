"""#4090/#4118 画像 per-Agent 化：UserPortrait 增加 agent_id 维度。

纯加列（可空、无回填）+ 唯一约束由 (user, organization) 扩为
(user, organization, agent)：

  - agent_id 可空——历史 per-(user, organization) 行保留为 agent_id=NULL，
    per-Agent GET 一律不召回（fail-closed），留待兼容清偿时物理清除。
  - PG 下 NULL 互不相等：旧约束每 (user, org) 至多一行 → 至多一条 NULL 行，
    换新约束不会撞唯一键；新写入路径永远带非空 agent_id。

makemigrations --check 应无待生成迁移。
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("user_portrait", "0004_alter_userportrait_organization_id"),
    ]

    operations = [
        migrations.AddField(
            model_name="userportrait",
            name="agent_id",
            field=models.UUIDField(
                blank=True,
                db_index=True,
                help_text="per-Agent 画像隔离维度；NULL 为历史 per-organization 画像（兼容清偿留待后续）",
                null=True,
                verbose_name="所属 Agent",
            ),
        ),
        # help_text-only 变更（复合唯一维度由 (user, org) 扩为 (user, org, agent)）——
        # 纯元数据、无 DB DDL 影响，但 Django 把 help_text 纳入 field 状态，必须落迁移
        # 才能让 makemigrations --check 干净。
        migrations.AlterField(
            model_name="userportrait",
            name="organization_id",
            field=models.UUIDField(
                db_index=True,
                help_text="(user, organization_id, agent_id) 复合唯一——画像按 Agent 完全隔离",
                verbose_name="所属 Organization",
            ),
        ),
        migrations.RemoveConstraint(
            model_name="userportrait",
            name="up_user_organization_unique",
        ),
        migrations.AddConstraint(
            model_name="userportrait",
            constraint=models.UniqueConstraint(
                fields=["user", "organization_id", "agent_id"],
                name="up_user_org_agent_unique",
            ),
        ),
        migrations.AddIndex(
            model_name="userportrait",
            index=models.Index(
                fields=["organization_id", "agent_id"],
                name="up_org_agent_idx",
            ),
        ),
    ]
