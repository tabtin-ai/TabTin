from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ('tabtinspace', '0133_collection_privacy_cleanup_7657'),
    ]

    operations = [
        migrations.AlterField(
            model_name='workspace',
            name='approval_grant',
            field=models.CharField(
                choices=[
                    ('always_ask', '每次询问'),
                    ('auto', '自动批准低风险操作'),
                    ('full_access', '完全访问'),
                ],
                default='full_access',
                help_text='进入该 Workspace 的所有自有 Agent 共用；仍受 Organization 天花板约束。',
                max_length=16,
                verbose_name='现场审批授权档位',
            ),
        ),
    ]
