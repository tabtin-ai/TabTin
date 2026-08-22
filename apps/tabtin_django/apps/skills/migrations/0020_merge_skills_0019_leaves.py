# Generated manually — merge duplicate skills 0019 leaves ( follow-up).
#
# 0019_merge_drop_enablement_legacy_and_preference_default  and
# 0019_merge_20260723_2053  both merge the same 0018 pair; keep both
# for environments that already applied either, then converge here.

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("skills", "0019_merge_20260723_2053"),
        ("skills", "0019_merge_drop_enablement_legacy_and_preference_default"),
    ]

    operations = []
