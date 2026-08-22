"""记录已由正式迁移覆盖的临时自动补充迁移。"""

from django.db import migrations


class Migration(migrations.Migration):
    reconciles = [("billing", "0036_llm_quota_only_auto_topup")]

    dependencies = [("billing", "0044_backfill_provider_credit_grant_trigger_type")]

    operations = []
