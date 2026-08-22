"""记录共享测试库先行恢复的 TabDoc 批注 migration 历史。"""

from django.db import migrations


class Migration(migrations.Migration):
    reconciles = [
        ("tabdoc", "0038_restore_comment_threads"),
        ("tabdoc", "0039_restore_comment_thread_projection"),
    ]

    dependencies = [
        ("tabdoc", "0037_remove_comment_threads"),
    ]

    operations = []
