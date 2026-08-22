from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("tabtinspace", "0136_first_four_organization_provider_credit_claims"),
    ]

    operations = [
        migrations.AddField(
            model_name="organizationinvitation",
            name="invite_phone",
            field=models.CharField(
                blank=True,
                default="",
                help_text="phone 类型邀请时保留管理员输入的手机号，供列表展示",
                max_length=32,
                verbose_name="邀请手机号",
            ),
        ),
        migrations.AlterField(
            model_name="organizationinvitation",
            name="invite_type",
            field=models.CharField(
                choices=[
                    ("email", "邮件邀请"),
                    ("link", "链接邀请"),
                    ("direct", "直接邀请"),
                    ("phone", "手机号邀请"),
                ],
                max_length=10,
                verbose_name="邀请类型",
            ),
        ),
        migrations.AlterField(
            model_name="organizationinvitation",
            name="invited_user_id",
            field=models.CharField(
                blank=True,
                default="",
                help_text="direct / phone 类型邀请时填写目标用户 ID",
                max_length=64,
                verbose_name="被邀请用户 ID",
            ),
        ),
    ]
