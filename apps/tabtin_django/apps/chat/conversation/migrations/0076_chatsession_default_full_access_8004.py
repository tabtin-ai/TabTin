from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ('conversation', '0075_alter_sessionshare_forked_session_id'),
    ]

    operations = [
        migrations.AlterField(
            model_name='chatsession',
            name='approval_mode',
            field=models.CharField(
                choices=[
                    ('always_ask', '每次询问'),
                    ('auto', '自动批准低风险操作'),
                    ('full_access', '完全访问'),
                ],
                default='always_ask',
                help_text='仅表达本会话请求档位，不能突破 Workspace 授权与 Organization 天花板。',
                max_length=16,
                verbose_name='会话审批请求档位',
            ),
        ),
    ]
