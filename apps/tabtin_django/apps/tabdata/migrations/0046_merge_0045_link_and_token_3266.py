# ：合并 tabdata 双 0045 分叉。
#
# - 0045_tableapitoken_drop_space_fk_3266（本 PR Drop Token.space）
# - 0045_link_relation_and_link_edge（release 侧 Link 模型）
# 二者同挂 0044，无 merge 时 safe_migrate 会报 CONFLICTING。

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('tabdata', '0045_link_relation_and_link_edge'),
        ('tabdata', '0045_tableapitoken_drop_space_fk_3266'),
    ]

    operations = []
