from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion
import uuid


class Migration(migrations.Migration):

    dependencies = [
        ("users_auth", "0012_user_avatar_file_ref"),
    ]

    operations = [
        migrations.CreateModel(
            name="RegistrationInviteCode",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("code", models.CharField(db_index=True, max_length=64, unique=True, verbose_name="邀请码")),
                ("description", models.CharField(blank=True, default="", max_length=255, verbose_name="描述")),
                ("channel", models.CharField(blank=True, db_index=True, default="", max_length=64, verbose_name="渠道")),
                ("campaign", models.CharField(blank=True, db_index=True, default="", max_length=64, verbose_name="活动/批次")),
                ("is_active", models.BooleanField(db_index=True, default=True, verbose_name="是否启用")),
                ("starts_at", models.DateTimeField(blank=True, null=True, verbose_name="生效时间")),
                ("expires_at", models.DateTimeField(blank=True, db_index=True, null=True, verbose_name="过期时间")),
                ("usage_limit", models.PositiveIntegerField(blank=True, null=True, verbose_name="使用次数上限")),
                ("used_count", models.PositiveIntegerField(default=0, verbose_name="已使用次数")),
                ("disabled_at", models.DateTimeField(blank=True, null=True, verbose_name="停用时间")),
                ("created_at", models.DateTimeField(auto_now_add=True, verbose_name="创建时间")),
                ("updated_at", models.DateTimeField(auto_now=True, verbose_name="更新时间")),
                (
                    "created_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="created_registration_invite_codes",
                        to=settings.AUTH_USER_MODEL,
                        verbose_name="创建人",
                    ),
                ),
                (
                    "disabled_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="disabled_registration_invite_codes",
                        to=settings.AUTH_USER_MODEL,
                        verbose_name="停用人",
                    ),
                ),
            ],
            options={
                "verbose_name": "注册邀请码",
                "verbose_name_plural": "注册邀请码",
                "db_table": "users_auth_registration_invite_code",
                "ordering": ["-created_at"],
            },
        ),
        migrations.CreateModel(
            name="RegistrationInviteRedemption",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("identifier_hash", models.CharField(blank=True, db_index=True, default="", max_length=64, verbose_name="注册标识哈希")),
                ("entrypoint", models.CharField(blank=True, db_index=True, default="", max_length=32, verbose_name="注册入口")),
                ("ip_address", models.GenericIPAddressField(blank=True, null=True, verbose_name="IP 地址")),
                ("user_agent", models.TextField(blank=True, default="", verbose_name="User-Agent")),
                ("consumed_at", models.DateTimeField(auto_now_add=True, db_index=True, verbose_name="使用时间")),
                (
                    "invite_code",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="redemptions",
                        to="users_auth.registrationinvitecode",
                        verbose_name="邀请码",
                    ),
                ),
                (
                    "user",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="registration_invite_redemptions",
                        to=settings.AUTH_USER_MODEL,
                        verbose_name="注册用户",
                    ),
                ),
            ],
            options={
                "verbose_name": "注册邀请码使用记录",
                "verbose_name_plural": "注册邀请码使用记录",
                "db_table": "users_auth_registration_invite_redemption",
                "ordering": ["-consumed_at"],
            },
        ),
        migrations.AddIndex(
            model_name="registrationinvitecode",
            index=models.Index(fields=["is_active", "expires_at"], name="reg_invite_active_exp"),
        ),
        migrations.AddIndex(
            model_name="registrationinvitecode",
            index=models.Index(fields=["channel", "campaign"], name="reg_invite_channel_campaign"),
        ),
        migrations.AddIndex(
            model_name="registrationinvitecode",
            index=models.Index(fields=["created_at"], name="reg_invite_created_at"),
        ),
        migrations.AddConstraint(
            model_name="registrationinviteredemption",
            constraint=models.UniqueConstraint(fields=("invite_code", "user"), name="uniq_registration_invite_user"),
        ),
        migrations.AddIndex(
            model_name="registrationinviteredemption",
            index=models.Index(fields=["entrypoint", "consumed_at"], name="reg_invite_red_entry_time"),
        ),
        migrations.AddIndex(
            model_name="registrationinviteredemption",
            index=models.Index(fields=["invite_code", "consumed_at"], name="reg_invite_red_code_time"),
        ),
    ]
