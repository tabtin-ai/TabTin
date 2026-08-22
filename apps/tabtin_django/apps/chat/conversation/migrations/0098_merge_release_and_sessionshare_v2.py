from django.db import migrations


class Migration(migrations.Migration):
    """收拢 release 现有迁移与 SessionShare v2 迁移分支。"""

    dependencies = [
        ("conversation", "0094_chatsession_pin_state"),
        ("conversation", "0095_merge_20260810_2130"),
        ("conversation", "0096_sessionshare_v2_contract"),
        ("conversation", "0097_reconcile_test_260812_history"),
    ]

    operations = []
