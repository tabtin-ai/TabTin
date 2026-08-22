# Merge release  (0122_workspace_custom_rules…) with feat/project
# /#6846 chain (0122 assignment language → 0123a provisioning backfill).

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0122_workspace_custom_rules_execution_limits_6903'),
        ('tabtinspace', '0123a_workspace_provisioning_source_backfill_6846'),
    ]

    operations = []
