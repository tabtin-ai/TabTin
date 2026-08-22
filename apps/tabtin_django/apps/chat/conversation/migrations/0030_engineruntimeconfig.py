"""
AI 能力统一宪法 v0.1 — EngineRuntimeConfig 单例表

从 ChatGlobalConfig 提取 28 个运行时参数字段。
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('conversation', '0029_remove_chatsession_external_session_id'),
    ]

    operations = [
        migrations.CreateModel(
            name='EngineRuntimeConfig',
            fields=[
                ('id', models.IntegerField(default=1, primary_key=True, serialize=False)),

                ('engine_max_iterations', models.IntegerField(default=25)),
                ('engine_task_max_iterations', models.IntegerField(default=15)),
                ('engine_max_tool_calls', models.IntegerField(default=10)),
                ('engine_task_timeout', models.IntegerField(default=300)),
                ('engine_subagent_timeout', models.IntegerField(default=120)),
                ('engine_max_plan_steps', models.IntegerField(default=5)),
                ('engine_allow_clarification', models.BooleanField(default=True)),

                ('ctx_default_window_tokens', models.IntegerField(default=200000)),
                ('ctx_pressure_medium', models.FloatField(default=0.5)),
                ('ctx_pressure_high', models.FloatField(default=0.75)),
                ('ctx_pressure_critical', models.FloatField(default=0.9)),
                ('ctx_summary_trigger_fraction', models.FloatField(default=0.85)),
                ('ctx_summary_keep_messages', models.IntegerField(default=6)),
                ('ctx_emergency_keep_messages', models.IntegerField(default=8)),

                ('guard_doom_loop_warn', models.IntegerField(default=3)),
                ('guard_doom_loop_break', models.IntegerField(default=5)),
                ('guard_tool_output_max_chars', models.IntegerField(default=50000)),
                ('guard_max_compaction_attempts', models.IntegerField(default=2)),
                ('guard_default_permission_policy', models.CharField(default='allow', max_length=20)),

                ('feat_parallel_tool_execution', models.BooleanField(default=False)),
                ('feat_tool_cache_enabled', models.BooleanField(default=True)),
                ('feat_tool_cache_max_entries', models.IntegerField(default=64)),

                ('subagent_max_active', models.IntegerField(default=2)),
                ('subagent_queue_limit', models.IntegerField(default=20)),
                ('subagent_global_queue_limit', models.IntegerField(default=200)),

                ('cleanup_trace_retention_days', models.IntegerField(default=14)),
                ('cleanup_stale_subagent_minutes', models.IntegerField(default=5)),
                ('cleanup_blocks_retention_hours', models.IntegerField(default=24)),

                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={
                'verbose_name': 'Engine 运行时配置',
                'verbose_name_plural': 'Engine 运行时配置',
                # 注意：0030 的 db_table 写为 v0.1 之前的旧名 conversation_engine_runtime_config，
                # 0032 通过 AlterModelTable 重命名为 chat_engine_runtime_config（与 model.Meta 一致）。
                # 这样 fresh deploy 与已跑过 0030 的 dev 库都收敛到同一最终状态。
                'db_table': 'conversation_engine_runtime_config',
            },
        ),
    ]
