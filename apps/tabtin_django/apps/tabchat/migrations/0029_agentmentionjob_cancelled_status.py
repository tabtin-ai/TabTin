from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("tabchat", "0028_reconcile_retired_im_model_state")]

    operations = [
        migrations.AddField(
            model_name="agentmentionjob",
            name="source_message_seq",
            field=models.PositiveBigIntegerField(blank=True, null=True),
        ),
        migrations.AlterField(
            model_name="agentmentionjob",
            name="status",
            field=models.CharField(
                choices=[
                    ("pending", "Pending"),
                    ("running", "Running"),
                    ("succeeded", "Succeeded"),
                    ("failed", "Failed"),
                    ("cancelled", "Cancelled"),
                ],
                default="pending",
                max_length=20,
            ),
        ),
    ]
