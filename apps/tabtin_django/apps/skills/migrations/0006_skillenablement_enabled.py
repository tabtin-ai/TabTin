"""SkillEnablement 加 ``enabled`` 字段（停用但保留安装记录）。

语义修正：行存在 = 已安装到本 Space；``enabled`` = 是否注入/启用。
停用置 ``enabled=False`` 但保留行（含 installed_version_seq / install_content_hash），
让前端能区分「已安装但停用」与「从没装过」。

现有行在旧语义下「行存在 = 启用」，故 ``AddField(default=True)`` 自动把存量行
backfill 为 ``enabled=True``，与历史行为一致。

跨库：``skills`` app_label 路由到 PostgreSQL（见 ``apps/skills/db_router.py``），
真实 DDL 在 PG 执行；MySQL(default) 仅记录影子迁移。统一走 ``safe_migrate``
（``bash scripts/backend/migrate-all.sh``）两库一起跑，避免漏跑 PG。
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("skills", "0005_skill_published_version_label_unique"),
    ]

    operations = [
        migrations.AddField(
            model_name="skillenablement",
            name="enabled",
            field=models.BooleanField(
                default=True,
                help_text=(
                    "是否注入/启用（行存在=已安装到本 Space）。停用置 False 但保留行，"
                    "保留 installed_version_seq / install_content_hash 等安装记录，便于原地重开；"
                    "真正卸载才删行。"
                ),
            ),
        ),
    ]
