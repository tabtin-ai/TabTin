from django.db import migrations, models
from django.db.models import F, Q


def _backfill_execution_agent_id(apps, schema_editor):
    ChannelBinding = apps.get_model("channel_gateway", "ChannelBinding")
    ChannelAccount = apps.get_model("channel_gateway", "ChannelAccount")

    ChannelBinding.objects.filter(
        Q(execution_agent_id__isnull=True) | Q(execution_agent_id="")
    ).exclude(
        Q(agent_id__isnull=True) | Q(agent_id="")
    ).update(execution_agent_id=F("agent_id"))

    for account in ChannelAccount.objects.all().iterator():
        config = dict(getattr(account, "config", None) or {})
        legacy_execution_agent_id = str(config.get("primary_agent_id") or "").strip()
        current_execution_agent_id = str(config.get("execution_agent_id") or "").strip()
        if not legacy_execution_agent_id or current_execution_agent_id:
            continue
        config["execution_agent_id"] = legacy_execution_agent_id
        config.pop("primary_agent_id", None)
        account.config = config
        account.save(update_fields=["config", "updated_at"])


class Migration(migrations.Migration):

    dependencies = [
        ("channel_gateway", "0007_binding_identity_context"),
    ]

    operations = [
        migrations.RenameField(
            model_name="channelbinding",
            old_name="primary_agent_id",
            new_name="execution_agent_id",
        ),
        migrations.RenameIndex(
            model_name="channelbinding",
            old_name="cg_bind_primary_agent_idx",
            new_name="cg_bind_execution_agent_idx",
        ),
        migrations.AlterField(
            model_name="channelbinding",
            name="execution_agent_id",
            field=models.CharField(
                blank=True,
                max_length=100,
                null=True,
                verbose_name="执行 Agent ID",
            ),
        ),
        migrations.RunPython(
            _backfill_execution_agent_id,
            reverse_code=migrations.RunPython.noop,
        ),
        migrations.RemoveField(
            model_name="channelbinding",
            name="agent_id",
        ),
    ]
