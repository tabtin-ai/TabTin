"""Merge release history with the retired Django IM history branch."""

from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("tabchat", "0025_relax_retired_django_im_columns"),
        ("tabchat", "0026_reconcile_test_260812_history"),
    ]

    operations = []
