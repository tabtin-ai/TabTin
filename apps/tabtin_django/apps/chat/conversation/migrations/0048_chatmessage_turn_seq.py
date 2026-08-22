from django.db import migrations, models


class Migration(migrations.Migration):
    """重建已被删除但仍记录为 applied 的历史迁移。

    背景:turn_seq 实验迁移当时已 apply 到数据库(建出 turn_seq 列 + 两个索引),
    随后实验回退时误删了本迁移文件,导致「迁移历史记录 applied 但磁盘无文件」
    的漂移——迁移图与真实 schema 不一致。本文件忠实重建当时 applied 的操作,
    让 Django state 与 DB 对齐(本机已 applied,不会重跑);turn_seq 的彻底移除
    见后续 0049。字段声明为 null=True 仅为在全新库重放时可无损建列,随即被 0049
    删除,与本机 NOT NULL 列的差异不影响结果(0049 直接 DROP COLUMN)。
    """

    dependencies = [
        ('conversation', '0047_chatmessage_updated_at'),
    ]

    operations = [
        migrations.AddField(
            model_name='chatmessage',
            name='turn_seq',
            field=models.BigIntegerField(db_index=True, null=True),
        ),
        migrations.AddIndex(
            model_name='chatmessage',
            index=models.Index(
                fields=['session', 'turn_seq', 'id'],
                name='chat_msg_sess_turn_idx',
            ),
        ),
    ]
