"""删除已从 ORM 移除的 client error UserSeen 遗留表。

0011/0012 曾引入 ``ClientErrorGroupUserSeen`` 和
``ClientErrorReleaseUserSeen`` 作为 user_count 去重辅助表；当前 ingest 路径已回到
基于 ``ClientErrorEvent`` 查询去重，models.py 中也不再保留这两个 ORM 类。

保留表会让跨库 FK 体检持续报 stale_table warning。这里用正式 migration 删除，
让 migration state、当前 ORM、物理 schema 三者重新一致。
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("client_errors", "0012_user_seen_partial_unique"),
    ]

    operations = [
        migrations.RemoveField(
            model_name="clienterrorgroupuserseen",
            name="group",
        ),
        migrations.RemoveField(
            model_name="clienterrorreleaseuserseen",
            name="release",
        ),
        migrations.DeleteModel(
            name="ClientErrorGroupUserSeen",
        ),
        migrations.DeleteModel(
            name="ClientErrorReleaseUserSeen",
        ),
    ]
