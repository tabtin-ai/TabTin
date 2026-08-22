"""撤销 ``0005`` 加的 ``version_label`` 部分唯一约束，与当前 model 对齐。

``0005`` 在数据去重后加了 ``(skill, version_label) WHERE version_label <> ''`` 约束；
后续发布链路改由 ``SkillService._validate_publish_version_policy`` 做 SemVer 归一化 +
去重（含空 label 回填、同 display key 合并），库级条件唯一与业务规则不一致，
故 model 已移除该 constraint，本 migration 同步 PG DDL。

跨库：``skills`` 路由 PostgreSQL；MySQL(default) 仅影子记录。走 ``safe_migrate``。
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('skills', '0006_skillenablement_enabled'),
    ]

    operations = [
        migrations.RemoveConstraint(
            model_name='skillpublishedversion',
            name='uq_published_skill_version_label_nonempty',
        ),
    ]
