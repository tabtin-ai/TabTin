from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion
import uuid


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ('schema_discovery', '0001_initial'),
    ]

    operations = [
        migrations.CreateModel(
            name='MarketTemplate',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, help_text='模板 ID', primary_key=True, serialize=False)),
                ('name', models.CharField(help_text='模板名称（展示给用户）', max_length=100)),
                ('slug', models.SlugField(help_text='模板唯一标识，作为 API 访问路径', unique=True)),
                ('icon', models.CharField(default='📄', help_text='Emoji 或 Icon 名称', max_length=16)),
                ('summary', models.CharField(help_text='一句话描述', max_length=200)),
                ('description', models.TextField(blank=True, help_text='详细描述')),
                ('category', models.CharField(choices=[('product_manager', '产品经理'), ('operations', '运营'), ('developer', '开发者'), ('investor', '投资人'), ('creator', '内容创作者'), ('ecommerce', '电商'), ('researcher', '研究'), ('general', '通用')], default='general', help_text='模板主要面向的用户角色', max_length=32)),
                ('tags', models.JSONField(blank=True, default=list, help_text='标签列表，便于筛选')),
                ('schema_json', models.JSONField(help_text='默认 Schema JSON（遵循 Schema Discovery 规范）')),
                ('variables_schema', models.JSONField(default=dict, help_text='变量定义，描述可配置字段及校验规则')),
                ('url_template', models.CharField(help_text='基础 URL 模板，可包含 {variable} 占位符', max_length=500)),
                ('preview_schema', models.JSONField(blank=True, default=dict, help_text='Schema 预览（用于前端展示）')),
                ('preview_data', models.JSONField(blank=True, default=dict, help_text='样例数据（用于前端展示）')),
                ('refresh_config', models.JSONField(blank=True, default=dict, help_text='可选：推荐的刷新配置（Cron、策略等）')),
                ('documentation_url', models.URLField(blank=True, help_text='外部文档链接（如 PRD、使用指南）')),
                ('is_official', models.BooleanField(default=True, help_text='是否为官方模板')),
                ('is_active', models.BooleanField(default=True, help_text='是否对外可见')),
                ('display_order', models.IntegerField(default=0, help_text='展示排序，越大越靠前')),
                ('usage_count', models.IntegerField(default=0, help_text='使用次数')),
                ('last_used_at', models.DateTimeField(blank=True, help_text='最后一次被使用的时间', null=True)),
                ('extra_metadata', models.JSONField(blank=True, default=dict, help_text='扩展信息（如数据源、采集说明）')),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('schema_source', models.ForeignKey(blank=True, help_text='可选：关联已有的 GeneratedSchema，作为 Schema 数据源', null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='market_templates', to='schema_discovery.generatedschema')),
            ],
            options={
                'verbose_name': 'Schema 市场模板',
                'verbose_name_plural': 'Schema 市场模板',
                'db_table': 'schema_market_templates',
                'ordering': ['-is_official', '-display_order', 'name'],
            },
        ),
        migrations.CreateModel(
            name='TemplateUsage',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, help_text='使用记录 ID', primary_key=True, serialize=False)),
                ('workspace_id', models.UUIDField(blank=True, help_text='关联的 workspace ID（可选）', null=True)),
                ('project_id', models.UUIDField(blank=True, help_text='关联的 project ID（可选）', null=True)),
                ('rendered_url', models.CharField(help_text='渲染后的 URL', max_length=500)),
                ('variables_filled', models.JSONField(default=dict, help_text='用户填写的变量值')),
                ('rendered_schema', models.JSONField(help_text='渲染后的 Schema JSON')),
                ('status', models.CharField(choices=[('pending', '处理中'), ('success', '成功'), ('failed', '失败')], default='pending', help_text='状态', max_length=16)),
                ('message', models.TextField(blank=True, help_text='附加信息或错误描述')),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('generated_schema', models.ForeignKey(blank=True, help_text='保存到 Schema Discovery 的 Schema（如有）', null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='template_usages', to='schema_discovery.generatedschema')),
                ('template', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='usages', to='schema_market.markettemplate')),
                ('user', models.ForeignKey(db_constraint=False, on_delete=django.db.models.deletion.CASCADE, related_name='schema_market_usages', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'verbose_name': 'Schema 模板使用记录',
                'verbose_name_plural': 'Schema 模板使用记录',
                'db_table': 'schema_market_template_usage',
                'ordering': ['-created_at'],
            },
        ),
        migrations.AddIndex(
            model_name='markettemplate',
            index=models.Index(fields=['category'], name='idx_schema_market_category'),
        ),
        migrations.AddIndex(
            model_name='markettemplate',
            index=models.Index(fields=['is_active'], name='idx_schema_market_active'),
        ),
        migrations.AddIndex(
            model_name='templateusage',
            index=models.Index(fields=['user', 'created_at'], name='idx_schema_usage_user_created'),
        ),
        migrations.AddIndex(
            model_name='templateusage',
            index=models.Index(fields=['status'], name='idx_schema_usage_status'),
        ),
    ]
