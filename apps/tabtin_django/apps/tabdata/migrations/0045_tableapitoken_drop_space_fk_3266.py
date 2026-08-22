#  终态 · TableApiToken.space FK Drop
#
# Space 表进入 DROP 窗口，TableApiToken 侧的 space 归属彻底走 JSON 的
# ``space_ids`` scope 列表（scope 逻辑已全部消费 space_ids）；冗余的单值
# FK ``space`` 与其复合索引一起摘掉，_ensure_space_in_scope 也随之下线。
#
# 反向不重建 FK 列：0044 之前的历史行 space_id 值已在 0105 团队壳消解时
# 由 SET_NULL cascade 归零，无恢复价值。

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('tabdata', '0044_rename_tabdata_api_worktea_1e337f_idx_tabdata_api_organiz_1f949b_idx_and_more'),
    ]

    operations = [
        migrations.RemoveIndex(
            model_name='tableapitoken',
            name='tabdata_api_space_i_e3e530_idx',
        ),
        migrations.RemoveField(
            model_name='tableapitoken',
            name='space',
        ),
    ]
