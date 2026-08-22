# Wave 2 收尾 (charter v1.8 §7.1 / §7.2 + plan v2.1 §1.3c):
# drop 5 个 [DEPRECATED] 字段，回归 charter 终局数据模型。
#
# 不可逆性 / 数据保护：
# ─────────────────────────────────
# 本 migration 是**强不可逆操作**，drop 字段后历史数据彻底丢失。
# 提供 12 个月备份保护：
#   - ``_archived_goal_deprecated_fields_v18``：Goal 表 4 个 drop 字段全量快照
#     （含 id 主键 + 4 deprecated 字段 + drop 时间戳）
#   - ``_archived_goalrun_cycle_history``：GoalRun.cycle_history 全量快照
#     （含 id + cycle_history + drop 时间戳）
# 满 12 个月后由用户/管理员手工 drop _archived_* 表，本 migration 不写自动清理。
#
# 如需 hotfix 回滚（charter v1.8 不再支持 V1 字段，此路径仅作紧急兜底）：
#   1. 手工 ALTER TABLE 重建字段（Django reverse 不会自动重建）
#   2. ``UPDATE goal SET execution_config = a.execution_config FROM
#       _archived_goal_deprecated_fields_v18 a WHERE goal.id = a.id``
#   3. 类似处理 cycle_history
#
# 数据迁移：execution_config → skill_params
# ─────────────────────────────────
# Wave 2 收尾发现 TabData skill_field 路径仍写入 execution_config（活路径，非死字段）。
# 本 migration drop 字段前先把活数据搬到 skill_params——业务连续性硬要求。
# 详见 ``_MIGRATE_EXECUTION_CONFIG_TO_SKILL_PARAMS_SQL``。
#
# 已 applied 但未含此数据迁移的环境（如本地开发库）：
# - execution_config 已被 drop，活数据在 _archived_goal_deprecated_fields_v18 中。
# - 手工运维：``UPDATE goal SET skill_params = a.execution_config FROM
#   _archived_goal_deprecated_fields_v18 a WHERE goal.id = a.id
#   AND a.execution_config != '{}'::jsonb AND (goal.skill_params IS NULL
#   OR goal.skill_params = '{}'::jsonb);``
#
# 生产部署：本 migration 一次跑完即可（数据迁移在 drop 之前完成，零业务中断）。
#
# 5 个被 drop 字段 (charter v1.8 §7.1 / §7.2 拒绝清单)：
#   Goal:
#     - execution_config       — 仅死代码用，活路径已迁移到 skill_params
#     - project_mode           — 30% 实现，无 UI；Project 是禁用名词（charter §3.4）
#     - token_budget           — 无 Step 级粒度，无意义
#     - max_concurrent_runs    — 与 Redis 信号量重叠（已切换为 active_runs >= 1 限制）
#   GoalRun:
#     - cycle_history          — 写入但无读取
#
# 同时附带 P1-4 修正：``skill_key`` help_text 改为 charter v1.8 §6.4 描述
# （原文案"空值表示旧版多步骤 Goal"已矛盾——多步骤 Goal 已废弃）。
#
# Telemetry 观察期：
#   Wave 1 (0020) 在 model.save() 加 deprecation_logger 钩子，截至 Wave 2 收尾
#   2 周观察期间 grep "tracker_deprecated_field_access" logs/ 应为 0
#   （活路径已在本 Wave 全部清理）。
#
# 与 1.3a / 1.3b / 1.3c 的关系：
#   - 1.3a (0020): nullable add 新字段 + 标 deprecated
#   - 1.3b (deprecation_logger): 2 周 telemetry 观察期
#   - 1.3c (本 migration 0023): drop 字段
#
# 验证：
#   ``python manage.py migrate scheduler --database=postgresql``
#   migrate 后 ``\d goal`` / ``\d goal_run`` 不应再有 5 字段。
#   备份表通过 ``\dt _archived_*`` 验证存在。

from django.db import migrations, models


_BACKUP_GOAL_DEPRECATED_SQL = """
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = '_archived_goal_deprecated_fields_v18'
    ) THEN
        CREATE TABLE _archived_goal_deprecated_fields_v18 (
            id uuid,
            execution_config jsonb,
            project_mode boolean,
            token_budget integer,
            max_concurrent_runs smallint,
            archived_at timestamptz DEFAULT now()
        );
    END IF;
    -- 全量快照写入；CASCADE 不需要因为没有外键约束
    INSERT INTO _archived_goal_deprecated_fields_v18
        (id, execution_config, project_mode, token_budget, max_concurrent_runs)
    SELECT id, execution_config, project_mode, token_budget, max_concurrent_runs
    FROM goal;
END $$;
"""


# Wave 2 收尾数据迁移：把 execution_config 中的 skill_field 路径数据
# 迁移到 skill_params。charter §7.1 要求 execution_config drop，
# 但 TabData skill_field 路径仍是活业务，必须把数据搬到 skill_params。
#
# 仅当：
#   - 旧 execution_config 非空且非默认值
#   - 当前 skill_params 是空（避免覆盖已写入的新值）
# 时才迁移。COALESCE 双层保护：execution_config 是 dict、skill_params 是
# {} 或 NULL 都视为「无新值」。
_MIGRATE_EXECUTION_CONFIG_TO_SKILL_PARAMS_SQL = """
UPDATE goal g
SET skill_params = g.execution_config
WHERE g.execution_config IS NOT NULL
  AND g.execution_config != '{}'::jsonb
  AND (g.skill_params IS NULL OR g.skill_params = '{}'::jsonb);
"""

_BACKUP_GOALRUN_CYCLE_HISTORY_SQL = """
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = '_archived_goalrun_cycle_history'
    ) THEN
        CREATE TABLE _archived_goalrun_cycle_history (
            id uuid,
            cycle_history jsonb,
            archived_at timestamptz DEFAULT now()
        );
    END IF;
    INSERT INTO _archived_goalrun_cycle_history (id, cycle_history)
    SELECT id, cycle_history FROM goal_run;
END $$;
"""


class Migration(migrations.Migration):

    dependencies = [
        ('tracker', '0022_tracker_v18_goalrun_status_v2'),
    ]

    operations = [
        # ─── Step 1: 备份历史数据到 _archived_* ───
        # noop reverse：备份是 forward-only 安全网，回滚不需要再次备份。
        migrations.RunSQL(
            sql=_BACKUP_GOAL_DEPRECATED_SQL,
            reverse_sql=migrations.RunSQL.noop,
            hints={"target_db": "postgresql"},
        ),
        migrations.RunSQL(
            sql=_BACKUP_GOALRUN_CYCLE_HISTORY_SQL,
            reverse_sql=migrations.RunSQL.noop,
            hints={"target_db": "postgresql"},
        ),

        # ─── Step 1.5: 数据迁移 execution_config → skill_params ───
        # 把 skill_field 路径的活数据从 execution_config 搬到 skill_params。
        # noop reverse：drop 后 execution_config 字段不存在，回滚通过
        # _archived_goal_deprecated_fields_v18 + 手工 SQL 恢复。
        migrations.RunSQL(
            sql=_MIGRATE_EXECUTION_CONFIG_TO_SKILL_PARAMS_SQL,
            reverse_sql=migrations.RunSQL.noop,
            hints={"target_db": "postgresql"},
        ),

        # ─── Step 2: drop 5 个 [DEPRECATED] 字段 ───
        # Django RemoveField reverse 不会自动恢复字段定义；hotfix 回滚需手工 ALTER。
        migrations.RemoveField(
            model_name='goal',
            name='execution_config',
        ),
        migrations.RemoveField(
            model_name='goal',
            name='project_mode',
        ),
        migrations.RemoveField(
            model_name='goal',
            name='token_budget',
        ),
        migrations.RemoveField(
            model_name='goal',
            name='max_concurrent_runs',
        ),
        migrations.RemoveField(
            model_name='goalrun',
            name='cycle_history',
        ),

        # ─── Step 3: P1-4 — skill_key help_text 修正（charter v1.8 §6.4） ───
        # 原文案"空值表示旧版多步骤 Goal 或纯 Agent 触发"含矛盾：多步骤 Goal
        # 已废弃（charter §6.4），不应再作为合法语义出现在 help_text。
        migrations.AlterField(
            model_name='goal',
            name='skill_key',
            field=models.CharField(
                blank=True,
                db_index=True,
                default='',
                help_text='指向要执行的 Skill（charter v1.8 §6.4 单 Skill 执行模型）。空值表示纯 Agent 触发模式。应用层 GoalService.create_goal 在创建时强制非空——历史 Goal 行可能为空，为兼容存量数据保留 blank=True / default=""。',
                max_length=128,
                verbose_name='关联 Skill',
            ),
        ),

        # ─── Step 4: 同步 Wave 2 续作 deprecation 标记到 migration 状态 ───
        # Wave 2 续作把 GoalRun.total_steps / completed_steps 加了 [DEPRECATED]
        # verbose_name + help_text，但当时未生成 migration（model 改动未入状态机）。
        # 本次一并对齐，与 0023 一起作为 Wave 2 收尾的整体 PR。
        migrations.AlterField(
            model_name='goalrun',
            name='total_steps',
            field=models.PositiveSmallIntegerField(
                default=0,
                help_text='[DEPRECATED Wave 2 续作] 计划 Wave 3 启动前 drop。单 Skill 执行模型不再有步骤。',
                verbose_name='[DEPRECATED] 总步骤数',
            ),
        ),
        migrations.AlterField(
            model_name='goalrun',
            name='completed_steps',
            field=models.PositiveSmallIntegerField(
                default=0,
                help_text='[DEPRECATED Wave 2 续作] 计划 Wave 3 启动前 drop。',
                verbose_name='[DEPRECATED] 已完成步骤数',
            ),
        ),
    ]
