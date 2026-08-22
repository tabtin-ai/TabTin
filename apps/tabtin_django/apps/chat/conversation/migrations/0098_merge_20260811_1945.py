from django.db import migrations


class Migration(migrations.Migration):
    """Merge release/260812 conversation migration leaves."""

    dependencies = [
        ("conversation", "0099_alter_sessionshare_status"),
    ]

    operations = []
