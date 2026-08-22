from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("channel_gateway", "0006_remove_channelaccount_cg_account_workteam_idx_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="channelbinding",
            name="handling_space_id",
            field=models.CharField(blank=True, max_length=100, null=True, verbose_name="处理 Space ID"),
        ),
        migrations.AddField(
            model_name="channelbinding",
            name="identity_user_id",
            field=models.CharField(blank=True, max_length=100, null=True, verbose_name="Identity 用户ID"),
        ),
        migrations.AddField(
            model_name="channelbinding",
            name="primary_agent_id",
            field=models.CharField(blank=True, max_length=100, null=True, verbose_name="主 Agent ID"),
        ),
        migrations.AddIndex(
            model_name="channelbinding",
            index=models.Index(fields=["identity_user_id"], name="cg_bind_identity_user_idx"),
        ),
        migrations.AddIndex(
            model_name="channelbinding",
            index=models.Index(fields=["primary_agent_id"], name="cg_bind_primary_agent_idx"),
        ),
        migrations.AddIndex(
            model_name="channelbinding",
            index=models.Index(fields=["handling_space_id"], name="cg_bind_handling_space_idx"),
        ),
    ]
