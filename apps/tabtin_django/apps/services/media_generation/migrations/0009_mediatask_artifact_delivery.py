from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('media_generation', '0008_mediatask_storage_delivery'),
    ]

    operations = [
        migrations.AddField(
            model_name='mediatask',
            name='source_session_id',
            field=models.CharField(blank=True, db_index=True, default='', max_length=255, verbose_name='来源会话ID'),
        ),
        migrations.AddField(
            model_name='mediatask',
            name='source_tool_use_id',
            field=models.CharField(blank=True, default='', max_length=255, verbose_name='来源工具调用ID'),
        ),
        migrations.AddField(
            model_name='mediatask',
            name='source_agent_run_id',
            field=models.CharField(blank=True, default='', max_length=128, verbose_name='来源Agent运行ID'),
        ),
        migrations.AddField(
            model_name='mediatask',
            name='artifact_delivery_status',
            field=models.CharField(choices=[('not_required', '无需投递'), ('pending', '待投递'), ('delivered', '已投递'), ('failed', '投递失败')], db_index=True, default='not_required', max_length=20, verbose_name='正式产物消息投递状态'),
        ),
        migrations.AddField(
            model_name='mediatask',
            name='artifact_delivery_error',
            field=models.TextField(blank=True, default='', verbose_name='正式产物消息投递错误'),
        ),
        migrations.AddField(
            model_name='mediatask',
            name='artifact_delivered_at',
            field=models.DateTimeField(blank=True, null=True, verbose_name='正式产物消息投递时间'),
        ),
    ]
