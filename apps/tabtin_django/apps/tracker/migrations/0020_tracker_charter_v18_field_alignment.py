# Wave 1 (Tracker charter v1.8 §7.1 / §7.2): Goal / GoalRun 字段对齐宪法终局形态
# 详见 docs/planning/tracker-charter-v1.md v1.8 §7.x 与 docs/planning/tracker-execution-plan-v2.md §Phase 1
#
# 本 migration（1.3a）仅【add 新字段 + 改 nullable】，不 drop 任何字段。
# 旧字段（execution_config / project_mode / token_budget / max_concurrent_runs / cycle_history）
# 在 1.3b 通过 Goal/GoalRun.save() 钩子打 telemetry log，Wave 2 末尾 grep 0 调用后单独 PR drop。
#
# 双向可跑：所有 add/alter 均显式 reversible（add 在 backward 时变 remove；nullable 化在
# backward 时改回 not-null —— 注意：backward 后若已有 NULL 数据会因 NOT NULL 约束失败，
# 这是宪法终局向 nullable 演进的合理代价。Wave 1 范围内本 migration 在 dev 库经过
# forward → backward → forward 三步实测通过（无 NULL 数据场景）；带 NULL 数据的
# backward 测试由 Wave 2 实施 Agent 接力时按需要补充（charter §7.1 终局是 nullable，
# backward 路径不是产品演进方向，仅作为 hotfix 兜底，故不强制本期写真实数据 backward
# 测试用例）。
#
# Database：scheduler app 走 PostgreSQL，必须 `migrate scheduler --database=postgresql` 跑。

from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('conversation', '0029_remove_chatsession_external_session_id'),
        ('tabtinspace', '0043_add_device_app_install_snapshot'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ('tracker', '0019_remove_external_agent_capability'),
    ]

    operations = [
        # ─── Goal: 新增 charter v1.8 §7.1 终局字段 ───
        migrations.AddField(
            model_name='goal',
            name='agent',
            field=models.ForeignKey(
                blank=True,
                help_text='执行该 Tracker 的 Agent。本期 nullable，应用层校验「创建时必填」。',
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='goals',
                to='tabtinspace.agent',
                verbose_name='执行 Agent',
            ),
        ),
        migrations.AddField(
            model_name='goal',
            name='intent_snapshot',
            field=models.JSONField(
                blank=True,
                default=None,
                help_text='对话路径下创建 Tracker 时的意图留痕；表单/CLI 路径为 NULL。',
                null=True,
                verbose_name='创建意图快照',
            ),
        ),
        migrations.AddField(
            model_name='goal',
            name='skill_params',
            field=models.JSONField(
                blank=True,
                default=None,
                help_text='启动 Skill 时的初始参数（charter v1.8 §7.1）。schema 由各 Skill 自定义，Service 层校验；空值表示无显式参数。',
                null=True,
                verbose_name='Skill 启动参数',
            ),
        ),

        # ─── GoalRun: 新增 charter v1.8 §7.2 / §6.7 终局字段（跨库 FK，db_constraint=False）───
        migrations.AddField(
            model_name='goalrun',
            name='chat_session',
            field=models.ForeignKey(
                blank=True,
                db_constraint=False,
                help_text='本次 Run 的 react 循环 transcript 所在 ChatSession（charter v1.8 §6.7）。',
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='goal_runs',
                to='conversation.chatsession',
                verbose_name='关联 ChatSession',
            ),
        ),

        # ─── Goal: nullable 化（charter v1.8 §7.1）───
        migrations.AlterField(
            model_name='goal',
            name='space',
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='goals',
                to='tabtinspace.space',
                verbose_name='所属空间',
            ),
        ),
        migrations.AlterField(
            model_name='goal',
            name='created_by',
            field=models.ForeignKey(
                blank=True,
                db_constraint=False,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='created_goals',
                to=settings.AUTH_USER_MODEL,
                verbose_name='创建者',
            ),
        ),

        # ─── Goal: 旧字段 [DEPRECATED] 标记（仅元数据，verbose_name + help_text）───
        # save() 钩子打 telemetry，详见 services/deprecation_logger.py
        migrations.AlterField(
            model_name='goal',
            name='execution_config',
            field=models.JSONField(
                default=dict,
                help_text='[DEPRECATED Wave 1] 计划 Wave 2 末尾 drop。新代码不要写入此字段，改用 skill_params + trigger_config。',
                verbose_name='[DEPRECATED] 执行配置',
            ),
        ),
        migrations.AlterField(
            model_name='goal',
            name='max_concurrent_runs',
            field=models.PositiveSmallIntegerField(
                default=1,
                help_text='[DEPRECATED Wave 1] 计划 Wave 2 末尾 drop。并发由 Redis 信号量控制。',
                verbose_name='[DEPRECATED] 最大并发执行数',
            ),
        ),
        migrations.AlterField(
            model_name='goal',
            name='token_budget',
            field=models.PositiveIntegerField(
                default=0,
                help_text='[DEPRECATED Wave 1] 计划 Wave 2 末尾 drop。无 Step 级粒度，无意义。',
                verbose_name='[DEPRECATED] Token 预算',
            ),
        ),
        migrations.AlterField(
            model_name='goal',
            name='project_mode',
            field=models.BooleanField(
                default=False,
                help_text='[DEPRECATED Wave 1] 计划 Wave 2 末尾 drop。禁用名词 Project，无 UI。',
                verbose_name='[DEPRECATED] 制片人模式',
            ),
        ),

        # ─── GoalRun: 旧字段 [DEPRECATED] 标记 ───
        migrations.AlterField(
            model_name='goalrun',
            name='cycle_history',
            field=models.JSONField(
                default=list,
                help_text='[DEPRECATED Wave 1] 计划 Wave 2 末尾 drop。写入但无读取路径。',
                verbose_name='[DEPRECATED] 回环历史',
            ),
        ),
    ]
