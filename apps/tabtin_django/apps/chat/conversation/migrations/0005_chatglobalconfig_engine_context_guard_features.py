# Generated manually for ChatGlobalConfig engine/context/guard/feature fields

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('conversation', '0004_chatsession_external_session_id'),
    ]

    operations = [
        # ---- Agent 引擎参数 ----
        migrations.AddField(
            model_name='chatglobalconfig',
            name='engine_max_iterations',
            field=models.IntegerField(default=25, help_text='ReAct 循环最大迭代次数（对话模式），0 表示使用代码默认值', verbose_name='对话模式最大迭代次数'),
        ),
        migrations.AddField(
            model_name='chatglobalconfig',
            name='engine_task_max_iterations',
            field=models.IntegerField(default=15, help_text='任务驱动执行模式的最大迭代次数，0 表示使用代码默认值', verbose_name='任务模式最大迭代次数'),
        ),
        migrations.AddField(
            model_name='chatglobalconfig',
            name='engine_max_tool_calls',
            field=models.IntegerField(default=10, help_text='单轮对话中最多允许的工具调用次数，0 表示使用代码默认值', verbose_name='单轮最大工具调用'),
        ),
        migrations.AddField(
            model_name='chatglobalconfig',
            name='engine_task_timeout',
            field=models.IntegerField(default=300, help_text='任务执行超时时间（秒），0 表示使用代码默认值', verbose_name='任务模式超时(秒)'),
        ),
        migrations.AddField(
            model_name='chatglobalconfig',
            name='engine_subagent_timeout',
            field=models.IntegerField(default=120, help_text='子 Agent 等待超时时间（秒），0 表示使用代码默认值', verbose_name='子Agent超时(秒)'),
        ),
        migrations.AddField(
            model_name='chatglobalconfig',
            name='engine_max_plan_steps',
            field=models.IntegerField(default=5, help_text='规划阶段最多拆解步数，0 表示使用代码默认值', verbose_name='规划最大步数'),
        ),
        migrations.AddField(
            model_name='chatglobalconfig',
            name='engine_allow_clarification',
            field=models.BooleanField(default=True, help_text='允许 Agent 在不确定时向用户澄清需求', verbose_name='允许Agent澄清需求'),
        ),

        # ---- 上下文管理 ----
        migrations.AddField(
            model_name='chatglobalconfig',
            name='ctx_default_window_tokens',
            field=models.IntegerField(default=200000, help_text='默认上下文窗口大小（tokens），0 表示使用代码默认值', verbose_name='默认上下文窗口(tokens)'),
        ),
        migrations.AddField(
            model_name='chatglobalconfig',
            name='ctx_pressure_medium',
            field=models.FloatField(default=0.50, help_text='触发中等压力的 token 占比阈值（0~1）', verbose_name='上下文压力-中等阈值'),
        ),
        migrations.AddField(
            model_name='chatglobalconfig',
            name='ctx_pressure_high',
            field=models.FloatField(default=0.75, help_text='触发高压力的 token 占比阈值（0~1）', verbose_name='上下文压力-高阈值'),
        ),
        migrations.AddField(
            model_name='chatglobalconfig',
            name='ctx_pressure_critical',
            field=models.FloatField(default=0.90, help_text='触发危险压力的 token 占比阈值（0~1）', verbose_name='上下文压力-危险阈值'),
        ),
        migrations.AddField(
            model_name='chatglobalconfig',
            name='ctx_summary_trigger_fraction',
            field=models.FloatField(default=0.85, help_text='上下文占比超过此值时触发自动摘要（0~1）', verbose_name='摘要触发比例'),
        ),
        migrations.AddField(
            model_name='chatglobalconfig',
            name='ctx_summary_keep_messages',
            field=models.IntegerField(default=6, help_text='执行摘要后保留的最近消息数', verbose_name='摘要后保留消息数'),
        ),
        migrations.AddField(
            model_name='chatglobalconfig',
            name='ctx_summary_max_tokens',
            field=models.IntegerField(default=1024, help_text='摘要生成的最大 token 数', verbose_name='摘要最大tokens'),
        ),
        migrations.AddField(
            model_name='chatglobalconfig',
            name='ctx_emergency_keep_messages',
            field=models.IntegerField(default=8, help_text='紧急截断模式下保留的最近消息数', verbose_name='紧急截断保留消息数'),
        ),

        # ---- 安全护栏 ----
        migrations.AddField(
            model_name='chatglobalconfig',
            name='guard_doom_loop_warn',
            field=models.IntegerField(default=3, help_text='连续相同工具调用达到此次数时发出警告', verbose_name='Doom Loop 警告阈值'),
        ),
        migrations.AddField(
            model_name='chatglobalconfig',
            name='guard_doom_loop_break',
            field=models.IntegerField(default=5, help_text='连续相同工具调用达到此次数时强制终止', verbose_name='Doom Loop 终止阈值'),
        ),
        migrations.AddField(
            model_name='chatglobalconfig',
            name='guard_tool_output_max_chars',
            field=models.IntegerField(default=50000, help_text='工具输出超过此字符数时自动截断', verbose_name='工具输出最大字符数'),
        ),
        migrations.AddField(
            model_name='chatglobalconfig',
            name='guard_max_compaction_attempts',
            field=models.IntegerField(default=2, help_text='Context overflow 时最大 compaction 重试次数', verbose_name='上下文溢出最大重试'),
        ),
        migrations.AddField(
            model_name='chatglobalconfig',
            name='guard_default_permission_policy',
            field=models.CharField(default='allow', help_text='allow = 默认放行，ask = 默认需审批', max_length=20, verbose_name='默认权限策略'),
        ),

        # ---- 特性开关 ----
        migrations.AddField(
            model_name='chatglobalconfig',
            name='feat_debug_mode',
            field=models.BooleanField(default=False, help_text='开启后记录完整 prompt、完整 tool output、middleware 详细日志', verbose_name='调试模式'),
        ),
        migrations.AddField(
            model_name='chatglobalconfig',
            name='feat_parallel_tool_execution',
            field=models.BooleanField(default=False, help_text='同一轮返回多个 tool_calls 时并行执行', verbose_name='并行工具执行'),
        ),
        migrations.AddField(
            model_name='chatglobalconfig',
            name='feat_tool_cache_enabled',
            field=models.BooleanField(default=True, help_text='对标记 cacheable=True 的工具启用结果缓存', verbose_name='工具结果缓存'),
        ),
        migrations.AddField(
            model_name='chatglobalconfig',
            name='feat_tool_cache_max_entries',
            field=models.IntegerField(default=64, help_text='工具结果 LRU 缓存最大条目数', verbose_name='缓存最大条目数'),
        ),
        migrations.AddField(
            model_name='chatglobalconfig',
            name='feat_prompt_cache_enabled',
            field=models.BooleanField(default=False, help_text='启用 LLM prompt caching', verbose_name='Prompt缓存'),
        ),
        migrations.AddField(
            model_name='chatglobalconfig',
            name='feat_otel_trace_enabled',
            field=models.BooleanField(default=False, help_text='启用 OpenTelemetry span 发射', verbose_name='OpenTelemetry'),
        ),
        migrations.AddField(
            model_name='chatglobalconfig',
            name='feat_model_routing_enabled',
            field=models.BooleanField(default=False, help_text='根据任务复杂度自动选择模型', verbose_name='智能模型路由'),
        ),

        # ---- 子Agent配置 ----
        migrations.AddField(
            model_name='chatglobalconfig',
            name='subagent_max_active',
            field=models.IntegerField(default=2, help_text='单个父线程允许的最大并发子任务数', verbose_name='单线程最大并发子任务'),
        ),
        migrations.AddField(
            model_name='chatglobalconfig',
            name='subagent_queue_limit',
            field=models.IntegerField(default=20, help_text='单个父线程的子任务排队上限', verbose_name='单线程子任务排队上限'),
        ),
        migrations.AddField(
            model_name='chatglobalconfig',
            name='subagent_global_queue_limit',
            field=models.IntegerField(default=200, verbose_name='全局子任务排队上限'),
        ),

        # ---- 清理策略 ----
        migrations.AddField(
            model_name='chatglobalconfig',
            name='cleanup_trace_retention_days',
            field=models.IntegerField(default=14, help_text='超过此天数的 Trace 数据会被自动清理', verbose_name='Trace保留天数'),
        ),
        migrations.AddField(
            model_name='chatglobalconfig',
            name='cleanup_stale_subagent_minutes',
            field=models.IntegerField(default=5, help_text='子任务超过此时间未更新则判定为卡住并尝试恢复', verbose_name='卡住子任务判定(分钟)'),
        ),
    ]
