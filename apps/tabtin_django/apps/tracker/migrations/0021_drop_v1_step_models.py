# Wave 2 (charter v1.8 §6.4 / §8 拒绝清单): drop V1 多步骤 model
#
# 业务背景：
# charter v1.8 §6.4 「执行模型单一」——Tracker 通过单 Skill 执行，不再支持多步骤
# DAG。V2 已完成路径切换到 ``skill_executor``，本 migration 是 DB 层的最终清理。
#
# 不可逆性：
# - 表 drop 是不可逆操作。本 migration 提供归档保护：
#   1. forward 之前先把表数据复制到 ``_archived_*`` 表（通过 RunSQL pre-step），
#      数据保留 12 个月。
#   2. backward 仅 reverse 字段移除——不会重建已 drop 的表（charter v1.8 不再
#      支持 V1，回滚不是产品演进方向，仅为 hotfix 兜底）。
#
# Backup 表 schema：
# - ``_archived_goalstep`` ：与 ``goal_step`` 同 schema，**无外键约束，无索引**
#   （PostgreSQL ``CREATE TABLE AS TABLE`` 语义只复制列与数据，不复制约束）。
# - ``_archived_steprun``  ：与 ``step_run`` 同 schema，无外键约束，无索引。
#
# Backup 表保留期：
# - 12 个月（plan v2.1 §Phase 2 风险控制）。
# - 满 12 个月后由用户/管理员手工 drop，本 migration 不写自动清理 task。
# - 如需恢复：先 ``CREATE INDEX`` 然后 ``INSERT INTO goal_step SELECT * FROM _archived_goalstep``，
#   再 reverse migration 0021（reverse 不会自动重建表，需要先把表 INSERT 回去）。
#
# 验证流程：
# 1. forward:   ``python manage.py migrate scheduler --database=postgresql``
#    成功后 ``\dt _archived_goalstep`` 与 ``\dt _archived_steprun`` 都应存在。
# 2. backward:  ``python manage.py migrate scheduler 0020 --database=postgresql``
#    会移除 model state，DB 实际表已 drop（forward 不可逆）。
#
# 与 Wave 1 0020 的关系：
# 0020 加 charter v1.8 §7.1 新字段；0021 删除 §6.4 旧多步骤 model；0022 (1.3c)
# drop 5 个旧字段。三步分离，每步独立 PR / 独立观察期。

from django.db import migrations


_BACKUP_GOALSTEP_SQL = """
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'goal_step') THEN
        IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = '_archived_goalstep') THEN
            EXECUTE 'CREATE TABLE _archived_goalstep AS TABLE goal_step';
        ELSE
            EXECUTE 'INSERT INTO _archived_goalstep SELECT * FROM goal_step';
        END IF;
    END IF;
END $$;
"""

_BACKUP_STEPRUN_SQL = """
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'step_run') THEN
        IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = '_archived_steprun') THEN
            EXECUTE 'CREATE TABLE _archived_steprun AS TABLE step_run';
        ELSE
            EXECUTE 'INSERT INTO _archived_steprun SELECT * FROM step_run';
        END IF;
    END IF;
END $$;
"""


class Migration(migrations.Migration):

    dependencies = [
        ('tracker', '0020_tracker_charter_v18_field_alignment'),
    ]

    operations = [
        # ─── Step 1: 备份历史数据到 _archived_* ───
        # noop reverse：备份是 forward-only 安全网，回滚不需要再次备份。
        migrations.RunSQL(
            sql=_BACKUP_GOALSTEP_SQL,
            reverse_sql=migrations.RunSQL.noop,
            hints={"target_db": "postgresql"},
        ),
        migrations.RunSQL(
            sql=_BACKUP_STEPRUN_SQL,
            reverse_sql=migrations.RunSQL.noop,
            hints={"target_db": "postgresql"},
        ),

        # ─── Step 2: 删除 V1 step model ───
        # Django 会按依赖顺序自动处理（StepRun → GoalStep）。
        # 注意：DeleteModel reverse 不会重建表数据；如需 hotfix 回滚，
        # 从 _archived_* 手工 INSERT INTO goal_step / step_run 再 reverse migration。
        migrations.DeleteModel(name='StepRun'),
        migrations.DeleteModel(name='GoalStep'),
    ]
