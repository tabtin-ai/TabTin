from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("tabchat", "0011_alter_conversation_space_id_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="conversation",
            name="archived_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="conversation",
            name="archived_by",
            field=models.CharField(blank=True, default="", max_length=100),
        ),
        migrations.AddField(
            model_name="conversation",
            name="is_archived",
            field=models.BooleanField(db_index=True, default=False),
        ),
        migrations.AddIndex(
            model_name="conversation",
            index=models.Index(
                fields=["workteam_id", "space_id", "is_archived", "name"],
                name="tabchat_conv_space_channel_idx",
            ),
        ),
        migrations.AddConstraint(
            model_name="conversation",
            constraint=models.UniqueConstraint(
                condition=models.Q(is_archived=False, space_id__isnull=False),
                fields=("space_id", "name"),
                name="tabchat_conv_space_active_name_uniq",
            ),
        ),
    ]
