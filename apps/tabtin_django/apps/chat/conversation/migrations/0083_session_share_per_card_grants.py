from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("conversation", "0082_alter_session_workspace_file_choices"),
        ("tabchat", "0020_resource_access_request_message_ref"),
    ]

    operations = [
        migrations.RemoveConstraint(
            model_name="sessionshare",
            name="uq_session_share_grantee",
        ),
    ]
