"""为 ChatSession 增加 title_generation_status / title_generation_failed_at 字段。

背景：原来标题生成走 ``spawn_title_thread`` 的 daemon thread + fire-and-forget，
进程退出 / LLM 抖动 / SceneBinding 未配置都会让标题生成静默失败，
没有 retry、没有 dead-letter、没有任何观测口子。dogfood 现场实测过 23 个会话里
4+ 个长期卡在"新对话"标题。

新方案：

- ``spawn_title_thread`` 改成入队 Celery task ``conversation.generate_session_title``
  （瞬时错指数退避 retry + 最终失败 mark）
- 本 migration 新增的两个字段用于追踪标题生成状态、驱动周期 backfill task
  ``conversation.backfill_session_titles`` 重试历史 / 兜底失败的会话

字段语义：

- ``title_generation_status``：``pending`` / ``in_progress`` / ``done`` / ``failed``
- ``title_generation_failed_at``：最近一次失败时间，``done`` 后清空

历史数据初始化：已有真实标题（title 不在各语言"新对话"默认值集合里）的 session
直接 mark ``done``，避免首次 backfill 把它们全部入队后才在 task 里判断（浪费 task slot）。
其余历史 session 默认 ``pending``，由 backfill 周期任务按需重新生成。

复合索引 (status, title_generation_status, -last_message_at) 配 backfill 扫描——
没有索引每 30 分钟一次全表 filesort 在生产规模下会非常贵。
"""

from django.db import migrations, models


def initial_title_generation_status(apps, schema_editor):
    """
    历史数据初始化：title 已是真实值的 session 直接 mark done。

    避免首次 backfill 跑时把这些 session 也入队后再在 task 里 should_generate_title 校验 → mark done（浪费 task slot）。
    剩下的（title 是默认值 / 空串）按 default 保持 'pending'，下一次 backfill 周期任务
    跑时按需重新生成。
    """
    ChatSession = apps.get_model('conversation', 'ChatSession')
    # 这里的字面值列表跟后端 TitleGeneratorService._build_default_titles() 同步收敛。
    # 写硬编码而非动态收集是因为 data migration 阶段 i18n_manager 不一定可用。
    DEFAULT_TITLES = ['', '新对话', 'New Conversation', 'New chat']
    ChatSession.objects.exclude(title__in=DEFAULT_TITLES).update(
        title_generation_status='done',
    )


class Migration(migrations.Migration):

    dependencies = [
        ('conversation', '0038_chatmessage_v3_anthropic_content_blocks'),
    ]

    operations = [
        migrations.AddField(
            model_name='chatsession',
            name='title_generation_status',
            field=models.CharField(
                choices=[
                    ('pending', '待生成'),
                    ('in_progress', '生成中'),
                    ('done', '已完成'),
                    ('failed', '生成失败'),
                ],
                default='pending',
                help_text='驱动 conversation.backfill_session_titles 周期补偿，避免 daemon thread 时代的"无标题对话"问题',
                max_length=16,
                verbose_name='标题生成状态',
            ),
        ),
        migrations.AddField(
            model_name='chatsession',
            name='title_generation_failed_at',
            field=models.DateTimeField(
                blank=True,
                help_text='最近一次失败的时间戳；done 后清空',
                null=True,
                verbose_name='标题生成失败时间',
            ),
        ),
        # backfill 周期任务的扫描查询命中索引——避免 status / title_generation_status /
        # last_message_at 全表 filesort（每 30 分钟一次）。
        migrations.AddIndex(
            model_name='chatsession',
            index=models.Index(
                fields=['status', 'title_generation_status', '-last_message_at'],
                name='chat_sess_title_backfill_idx',
            ),
        ),
        # 数据迁移：已有真实标题的 session 直接标 done。
        # reverse=noop（schema 反向时不需要回滚数据状态）。
        migrations.RunPython(
            initial_title_generation_status,
            reverse_code=migrations.RunPython.noop,
        ),
    ]
