"""将 Agent 从 tabtinspace 迁入 apps.agent，并改表名为 agent_agent。

状态：CreateModel(agent.Agent)；库：RenameTable(tabtinspace_agent → agent_agent)。
配套 tabtinspace.0099 从旧 app 删除模型状态并改写 FK 指向。
"""

import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        ('tabtinspace', '0098_strip_agent_approval_config'),
        # 这两条迁移仍会在数据库层创建指向 tabtinspace_agent 的 FK。
        # 必须先完成，再重命名物理表；后续 0064/0041 才改 Django 状态到 agent.Agent。
        ('conversation', '0063_align_agent_workspace_models'),
        ('tracker', '0040_tracker_workspace_binding'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.CreateModel(
                    name='Agent',
                    fields=[
                        (
                            'id',
                            models.UUIDField(
                                default=uuid.uuid4,
                                editable=False,
                                primary_key=True,
                                serialize=False,
                            ),
                        ),
                        ('name', models.CharField(max_length=255, verbose_name='Agent 名称')),
                        (
                            'type',
                            models.CharField(
                                choices=[('bot', 'AI 助手')],
                                default='bot',
                                max_length=20,
                                verbose_name='Agent 类型',
                            ),
                        ),
                        ('is_active', models.BooleanField(default=True, verbose_name='是否启用')),
                        (
                            'custom_rules',
                            models.TextField(blank=True, default='', verbose_name='自定义规则'),
                        ),
                        (
                            'settings',
                            models.JSONField(
                                blank=True,
                                default=dict,
                                help_text='模板冻结的欢迎语、图标与默认模式；不承载执行环境配置。',
                                verbose_name='Agent 展示配置',
                            ),
                        ),
                        (
                            'goal',
                            models.TextField(blank=True, default='', verbose_name='Agent 目标'),
                        ),
                        (
                            'agent_config',
                            models.JSONField(default=dict, verbose_name='Agent 安全配置'),
                        ),
                        (
                            'suggested_prompts',
                            models.JSONField(
                                blank=True,
                                default=list,
                                help_text='对话空状态展示的推荐问题，用户可覆写',
                                verbose_name='推荐问题',
                            ),
                        ),
                        (
                            'preferred_model_id',
                            models.CharField(
                                blank=True,
                                default='',
                                help_text='用户最后一次在对话中选择的模型 ID，新对话时优先使用。',
                                max_length=255,
                                verbose_name='偏好模型 ID',
                            ),
                        ),
                        (
                            'created_at',
                            models.DateTimeField(auto_now_add=True, verbose_name='创建时间'),
                        ),
                        (
                            'updated_at',
                            models.DateTimeField(auto_now=True, verbose_name='更新时间'),
                        ),
                        (
                            'organization',
                            models.ForeignKey(
                                on_delete=django.db.models.deletion.CASCADE,
                                related_name='agents',
                                to='tabtinspace.organization',
                                verbose_name='所属组织',
                            ),
                        ),
                        (
                            'owner_user',
                            models.ForeignKey(
                                blank=True,
                                help_text='所有 Agent 都是用户私有资源；bot Agent 用该字段记录创建者/归属用户。',
                                null=True,
                                on_delete=django.db.models.deletion.SET_NULL,
                                related_name='owned_agents',
                                to=settings.AUTH_USER_MODEL,
                                verbose_name='Agent 归属用户',
                            ),
                        ),
                    ],
                    options={
                        'verbose_name': 'Agent',
                        'verbose_name_plural': 'Agents',
                        # 先挂旧表名；随后 AlterModelTable 改成 agent_agent。
                        # 索引名与旧模型冲突，等 tabtinspace.0099 DeleteModel 后再由 0002 挂回。
                        'db_table': 'tabtinspace_agent',
                    },
                ),
            ],
            database_operations=[],
        ),
        migrations.AlterModelTable(
            name='agent',
            table='agent_agent',
        ),
    ]
