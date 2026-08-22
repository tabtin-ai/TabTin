import uuid

from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ("tabtinspace", "0031_soul_preset"),
    ]

    operations = [
        migrations.CreateModel(
            name="PrimaryAgentBinding",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("created_at", models.DateTimeField(auto_now_add=True, verbose_name="创建时间")),
                ("updated_at", models.DateTimeField(auto_now=True, verbose_name="更新时间")),
                (
                    "on_duty_agent",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="on_duty_identity_bindings",
                        to="tabtinspace.agent",
                        verbose_name="值班 Agent",
                    ),
                ),
                (
                    "primary_agent",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="primary_identity_bindings",
                        to="tabtinspace.agent",
                        verbose_name="主 Agent",
                    ),
                ),
                (
                    "user",
                    models.ForeignKey(
                        db_constraint=False,
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="primary_agent_bindings",
                        to=settings.AUTH_USER_MODEL,
                        verbose_name="identity 用户",
                    ),
                ),
                (
                    "workteam",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="primary_agent_bindings",
                        to="tabtinspace.workteam",
                        verbose_name="所属工作团队",
                    ),
                ),
            ],
            options={
                "verbose_name": "主 Agent 绑定",
                "verbose_name_plural": "主 Agent 绑定",
                "db_table": "tabtinspace_primary_agent_binding",
            },
        ),
        migrations.AddIndex(
            model_name="primaryagentbinding",
            index=models.Index(fields=["workteam", "user"], name="ctx_pab_ws_user_idx"),
        ),
        migrations.AddIndex(
            model_name="primaryagentbinding",
            index=models.Index(fields=["workteam", "primary_agent"], name="ctx_pab_ws_primary_idx"),
        ),
        migrations.AddConstraint(
            model_name="primaryagentbinding",
            constraint=models.UniqueConstraint(fields=("workteam", "user"), name="ctx_pab_ws_user_unique"),
        ),
    ]
