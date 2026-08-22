"""Preserve migration history written by the retired Django IM branch.

The branch that originally owned this migration reached the shared test
database before it was merged.  Current Tencent IM code does not use those
model fields, so this compatibility node intentionally has no schema work.
"""

from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [("tabchat", "0022_resource_access_request_editor_optional_source")]

    operations = []

