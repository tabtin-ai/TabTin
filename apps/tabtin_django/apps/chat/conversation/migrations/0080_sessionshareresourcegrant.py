from django.db import migrations, models
import uuid


class Migration(migrations.Migration):

    dependencies = [
        ("conversation", "0079_chatsession_primary_surface"),
    ]

    operations = [
        migrations.CreateModel(
            name="SessionShareResourceGrant",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("resource_type", models.CharField(choices=[("document", "TabDoc"), ("table", "TabData")], max_length=16)),
                ("resource_id", models.UUIDField()),
                ("grantee_user_id", models.CharField(db_index=True, max_length=100)),
                ("is_active", models.BooleanField(db_index=True, default=True)),
                ("manages_resource_permission", models.BooleanField(default=False, help_text="该来源创建/恢复了资源 ACL；最后一个此类来源撤销时才能失活 ACL。")),
                ("has_independent_access", models.BooleanField(default=False, help_text="共享前或共享后已由其他渠道确认的访问权，停止共享时必须保留。")),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("revoked_at", models.DateTimeField(blank=True, null=True)),
                ("share", models.ForeignKey(on_delete=models.deletion.CASCADE, related_name="resource_grants", to="conversation.sessionshare")),
            ],
            options={"db_table": "chat_session_share_resource_grant"},
        ),
        migrations.AddConstraint(
            model_name="sessionshareresourcegrant",
            constraint=models.UniqueConstraint(fields=("share", "resource_type", "resource_id"), name="uq_session_share_resource_grant"),
        ),
        migrations.AddIndex(
            model_name="sessionshareresourcegrant",
            index=models.Index(fields=["resource_type", "resource_id", "grantee_user_id", "is_active"], name="chat_ssrg_resource_user_idx"),
        ),
    ]
