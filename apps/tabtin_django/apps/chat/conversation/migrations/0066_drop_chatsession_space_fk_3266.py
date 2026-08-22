#  终态 · Drop ChatSession.space FK（真删除，禁止 softref）
#
# 事实源已是 ``ChatSession.workspace``（0060/0062 回填，id-reuse）。
# 本迁移：移除 space FK 与依赖它的旧索引，改挂 workspace 索引。
# 不做 UUIDField softref——Space 表即将 DROP，软引用会留下死列。

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('conversation', '0065_chatsession_is_paused'),
        ('tabtinspace', '0108b_personal_shell_schema_cutover_3266'),
    ]

    operations = [
        migrations.RemoveIndex(
            model_name='chatsession',
            name='chat_sess_space_updated_idx',
        ),
        migrations.RemoveIndex(
            model_name='chatsession',
            name='idx_session_memory_settle',
        ),
        migrations.RemoveIndex(
            model_name='chatsession',
            name='idx_session_quick_settle',
        ),
        migrations.RemoveField(
            model_name='chatsession',
            name='space',
        ),
        migrations.AddIndex(
            model_name='chatsession',
            index=models.Index(
                fields=['workspace', '-updated_at'],
                name='chat_sess_ws_updated_idx',
            ),
        ),
        migrations.AddIndex(
            model_name='chatsession',
            index=models.Index(
                fields=['workspace', 'memory_settled', '-updated_at'],
                name='idx_session_memory_settle_ws',
            ),
        ),
        migrations.AddIndex(
            model_name='chatsession',
            index=models.Index(
                fields=['workspace', 'memory_quick_settled', '-updated_at'],
                name='idx_session_quick_settle_ws',
            ),
        ),
    ]
