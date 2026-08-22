"""记录已由正式日记迁移覆盖的临时 memo_type 迁移。"""

from django.db import migrations


class Migration(migrations.Migration):
    reconciles = [("tabmemo", "0021_memo_type_diary")]

    dependencies = [("tabmemo", "0025_migrate_agent_memory_to_domain")]

    operations = []
