from django.db import migrations


class Migration(migrations.Migration):
    """Join the independent required-field and record-comment migration branches."""

    dependencies = [
        ("tabdata", "0050_disable_required_fields"),
        ("tabdata", "0052_recordcomment_thread_status"),
    ]

    operations = []
