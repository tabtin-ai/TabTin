"""
W5-3: WorkteamBillingEntitlement 多维基础包额度字段
W5-4: BillingDispute 申诉工单模型
"""

import uuid
from decimal import Decimal

from django.core.validators import MinValueValidator
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('billing', '0025_billingruntimeconfig_fail_open_24h_block_threshold_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='workteambillingentitlement',
            name='included_media_monthly',
            field=models.IntegerField(
                default=0, validators=[MinValueValidator(0)],
                verbose_name='每月媒体生成张数',
            ),
        ),
        migrations.AddField(
            model_name='workteambillingentitlement',
            name='included_search_monthly',
            field=models.IntegerField(
                default=0, validators=[MinValueValidator(0)],
                verbose_name='每月联网搜索次数',
            ),
        ),
        migrations.AddField(
            model_name='workteambillingentitlement',
            name='included_tts_monthly',
            field=models.IntegerField(
                default=0, validators=[MinValueValidator(0)],
                verbose_name='每月TTS字符数',
            ),
        ),

        migrations.CreateModel(
            name='BillingDispute',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('transaction_id', models.CharField(blank=True, db_index=True, default='', max_length=36, verbose_name='关联流水ID')),
                ('workteam_id', models.CharField(db_index=True, max_length=100, verbose_name='工作团队ID')),
                ('user_id', models.CharField(db_index=True, max_length=36, verbose_name='申诉用户ID')),
                ('reason', models.TextField(verbose_name='申诉原因')),
                ('status', models.CharField(choices=[('open', '待处理'), ('investigating', '调查中'), ('resolved', '已解决'), ('rejected', '已驳回')], db_index=True, default='open', max_length=20, verbose_name='状态')),
                ('admin_notes', models.TextField(blank=True, default='', verbose_name='处理备注')),
                ('sla_deadline', models.DateTimeField(blank=True, help_text='默认创建后 2 个工作日', null=True, verbose_name='SLA 截止时间')),
                ('resolved_at', models.DateTimeField(blank=True, null=True, verbose_name='处理完成时间')),
                ('created_at', models.DateTimeField(auto_now_add=True, verbose_name='创建时间')),
                ('updated_at', models.DateTimeField(auto_now=True, verbose_name='更新时间')),
            ],
            options={
                'verbose_name': '计费申诉',
                'verbose_name_plural': '计费申诉',
                'db_table': 'services_billing_dispute',
                'ordering': ['-created_at'],
                'indexes': [
                    models.Index(fields=['status', 'created_at'], name='billing_dispute_status_idx'),
                    models.Index(fields=['workteam_id', 'created_at'], name='billing_dispute_wt_idx'),
                ],
            },
        ),
    ]
