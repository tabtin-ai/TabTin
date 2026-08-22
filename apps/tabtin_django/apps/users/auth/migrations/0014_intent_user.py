import uuid

import django.core.validators
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("users_auth", "0013_registration_invite_codes"),
    ]

    operations = [
        migrations.CreateModel(
            name="IntentUser",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                (
                    "phone",
                    models.CharField(
                        max_length=20,
                        unique=True,
                        validators=[
                            django.core.validators.RegexValidator(
                                message="请输入有效的手机号码",
                                regex="^\\+?[1-9]\\d{6,14}$",
                            )
                        ],
                        verbose_name="手机号",
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True, verbose_name="预约时间")),
            ],
            options={
                "verbose_name": "意向用户",
                "verbose_name_plural": "意向用户",
                "db_table": "users_auth_intent_user",
                "ordering": ["-created_at"],
                "indexes": [
                    models.Index(fields=["created_at"], name="intent_user_created_at"),
                ],
            },
        ),
    ]
