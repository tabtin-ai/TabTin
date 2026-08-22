"""W3.1a / Wave 3 D1：Computed Outbox 三表 schema + 自定义 PG 函数落地。

权威设计
--------

- TechSpec §3 数据模型（v0.3 W0-3 收尾，2026-04-17）
- TechSpec §3.4.1 ``jsonb_merge_uniq`` / ``jsonb_merge`` 自定义 PG 函数
  「D1 第一次 migration 必含」（W0-3 §3 v0.3 代码可实施性自检 §3 表）
- Charter §4 Outbox × Checkpoint 联动协议
- Harness 决策 D7（cascade B+D）/ D17（agent_run_id Char64）/ D29
  （Schema/Planner/Worker 与 W3.0c flag 修复并行启动）

落地范围
--------

✅ 主表 ``tabdata_computed_outbox`` + 全部索引（含部分索引 + GIN + 部分唯一）
✅ 溢出表 ``tabdata_computed_outbox_seed`` + 唯一约束
✅ DLQ ``tabdata_computed_outbox_dlq`` + 索引
✅ 自定义 PG 函数 ``jsonb_merge_uniq`` / ``jsonb_merge``（§3.4.1）

首版决策
--------

- **不分区**（W0-3 v0.3）：用部分索引 + ``next_run_at`` 索引覆盖
  Poller 与 Recovery 主查询；分区评估阈值见 ``models_outbox.py``。
- **不用 ``CREATE INDEX CONCURRENTLY``**：表新建无既有数据，普通
  ``CREATE INDEX`` 不锁等待；后续向已有数据表加索引必须 CONCURRENTLY
  + ``atomic = False``（TechSpec §3 v0.3 代码可实施性自检 §2）。

数据库
------

⚠️ tabdata 模块属 PostgreSQL（AGENTS.md 双库架构表），apply **必须**带
``--database=postgresql``：

::

   python manage.py migrate tabdata --database=postgresql

否则 router 会把记录写进 MySQL ``django_migrations`` 表但 PG 实际未执行
DDL，造成 schema 漂移。
"""
import apps.tabdata.models_outbox
import django.contrib.postgres.fields
import django.contrib.postgres.indexes
from django.db import migrations, models
import django.db.models.deletion
import django.utils.timezone


# ── TechSpec §3.4.1：合并两个 JSONB 数组，去重保序 ─────────────
JSONB_MERGE_UNIQ_UP = """
CREATE OR REPLACE FUNCTION jsonb_merge_uniq(a JSONB, b JSONB) RETURNS JSONB AS $$
  SELECT COALESCE(
    jsonb_agg(DISTINCT v ORDER BY v),
    '[]'::JSONB
  )
  FROM jsonb_array_elements(COALESCE(a, '[]'::JSONB) || COALESCE(b, '[]'::JSONB)) v
$$ LANGUAGE SQL IMMUTABLE PARALLEL SAFE;
"""

JSONB_MERGE_UNIQ_DOWN = "DROP FUNCTION IF EXISTS jsonb_merge_uniq(JSONB, JSONB);"

# ── TechSpec §3.4.1：浅合并两个 JSONB 对象，数值字段做加法 ─────
# 用于 dirty_stats 合并：
#   {inserted:1, updated:2} + {updated:3, deleted:1}
#   = {inserted:1, updated:5, deleted:1}
JSONB_MERGE_UP = """
CREATE OR REPLACE FUNCTION jsonb_merge(a JSONB, b JSONB) RETURNS JSONB AS $$
  SELECT jsonb_object_agg(
    key,
    CASE
      WHEN jsonb_typeof(va) = 'number' AND jsonb_typeof(vb) = 'number'
        THEN to_jsonb((va::TEXT)::NUMERIC + (vb::TEXT)::NUMERIC)
      ELSE COALESCE(vb, va)
    END
  )
  FROM (
    SELECT k AS key,
           a->k AS va,
           b->k AS vb
    FROM (
      SELECT DISTINCT k FROM (
        SELECT jsonb_object_keys(COALESCE(a, '{}'::JSONB)) AS k
        UNION
        SELECT jsonb_object_keys(COALESCE(b, '{}'::JSONB)) AS k
      ) keys
    ) all_keys
  ) merged
$$ LANGUAGE SQL IMMUTABLE PARALLEL SAFE;
"""

JSONB_MERGE_DOWN = "DROP FUNCTION IF EXISTS jsonb_merge(JSONB, JSONB);"


class Migration(migrations.Migration):

    dependencies = [
        ('tabdata', '0026_tablerecord_deleted_at_and_more'),
    ]

    operations = [
        migrations.CreateModel(
            name='ComputedOutbox',
            fields=[
                ('id', models.CharField(default=apps.tabdata.models_outbox.generate_outbox_id, editable=False, help_text='cuo_ + 16 字符 hex；W3.1b enqueue 时由 generate_outbox_id 生成', max_length=32, primary_key=True, serialize=False, verbose_name='任务 ID')),
                ('base_id', models.UUIDField(help_text='对应 TabTin Space ID（与 SpaceCheckpoint.space_id 同源）', verbose_name='所属 base/space')),
                ('seed_table_id', models.UUIDField(help_text='cascade 触发源表（Table.id）', verbose_name='种子表 ID')),
                ('workteam_id', models.UUIDField(help_text='多租户隔离主键，admin 过滤 / Pause Registry 必备', verbose_name='所属工作团队')),
                ('space_id', models.UUIDField(help_text='更细粒度过滤；与 ``base_id`` 在 TabTin 当前实现下等价，预留 space 与 base 分离的扩展余地', verbose_name='所属 Space')),
                ('checkpoint_id', models.UUIDField(blank=True, help_text='C5 联动：Agent 操作 SpaceCheckpoint.id；NULL 表示非 Agent 路径', null=True, verbose_name='关联 Checkpoint')),
                ('agent_run_id', models.CharField(blank=True, default='', help_text='对齐 ChangeLog.agent_run_id（D17 决策：CharField(64) 而非 UUID）', max_length=64, verbose_name='Agent Run ID')),
                ('seed_record_ids', models.JSONField(blank=True, help_text='JSONB 数组；> SEED_INLINE_LIMIT 时整批迁入 computed_outbox_seed 溢出表，本字段置 NULL（见 seed_should_overflow helper）', null=True, verbose_name='种子记录 ID 列表')),
                ('change_type', models.CharField(choices=[('insert', '新建'), ('update', '更新'), ('delete', '删除'), ('seed', '种子重算'), ('field-backfill', '字段回填')], max_length=32, verbose_name='变更类型')),
                ('steps', models.JSONField(default=list, help_text='[{step_index, level, table_id, field_ids, ...}, ...]，由 Planner 生成', verbose_name='执行步骤')),
                ('edges', models.JSONField(default=list, help_text='[{from, to}, ...]，用于失败恢复时部分重跑', verbose_name='依赖边')),
                ('plan_hash', models.CharField(help_text='sha256(base_id + seed_table_id + affected_field_ids_sorted + change_type)；pending 状态下唯一，用于 UPSERT 合并幂等', max_length=64, verbose_name='计划哈希')),
                ('status', models.CharField(choices=[('pending', '待执行'), ('processing', '执行中'), ('succeeded', '成功'), ('failed', '失败'), ('cancelled', '已取消'), ('succeeded_discarded', '已完成但被丢弃')], default='pending', max_length=24, verbose_name='任务状态')),
                ('attempts', models.PositiveIntegerField(default=0, verbose_name='已尝试次数')),
                ('max_attempts', models.PositiveIntegerField(default=8, help_text='超过则迁入 DLQ；TechSpec §3 默认 8', verbose_name='最大尝试次数')),
                ('next_run_at', models.DateTimeField(default=django.utils.timezone.now, help_text='Poller 主排序键；初始 = 入队时间，重试时按指数退避后推', verbose_name='下次执行时间')),
                ('sync_max_level', models.IntegerField(blank=True, help_text='Hybrid 策略：sync 阶段已完成到第 N 层，Worker 从 N+1 继续', null=True, verbose_name='同步已完成层级')),
                ('locked_at', models.DateTimeField(blank=True, null=True, verbose_name='加锁时间')),
                ('locked_by', models.CharField(blank=True, default='', help_text="格式 '{worker_id}:{claim_id}'，Recovery 用作释放判定", max_length=64, verbose_name='持锁 Worker')),
                ('lease_expires_at', models.DateTimeField(blank=True, help_text='locked_at + lock_ttl（默认 60s）；过期 Recovery 回收回 pending', null=True, verbose_name='租约过期时间')),
                ('last_error', models.TextField(blank=True, default='', verbose_name='最近一次失败描述')),
                ('last_error_class', models.CharField(blank=True, default='', help_text='便于指标 label 分类（tabdata_computed_outbox_fail_total{exc=...}）', max_length=128, verbose_name='最近一次失败异常类')),
                ('estimated_complexity', models.PositiveIntegerField(default=0, help_text='step 数 × 影响行数估算，用于 Hybrid Strategy 阈值判断', verbose_name='预估复杂度')),
                ('dirty_stats', models.JSONField(blank=True, help_text='{inserted, updated, deleted}，方便 admin 审计', null=True, verbose_name='变更统计')),
                ('affected_table_ids', django.contrib.postgres.fields.ArrayField(base_field=models.UUIDField(), blank=True, default=list, help_text='GIN 索引覆盖 PauseRegistry by table 维度查询', size=None, verbose_name='受影响表')),
                ('affected_field_ids', django.contrib.postgres.fields.ArrayField(base_field=models.UUIDField(), blank=True, default=list, size=None, verbose_name='受影响字段')),
                ('created_at', models.DateTimeField(default=django.utils.timezone.now, verbose_name='入队时间')),
                ('updated_at', models.DateTimeField(auto_now=True, verbose_name='更新时间')),
                ('completed_at', models.DateTimeField(blank=True, help_text='仅 status in (succeeded / succeeded_discarded / failed / cancelled) 时填', null=True, verbose_name='完成时间')),
            ],
            options={
                'verbose_name': 'Computed Outbox 任务',
                'verbose_name_plural': 'Computed Outbox 任务',
                'db_table': 'tabdata_computed_outbox',
                'ordering': ['next_run_at', 'id'],
                'abstract': False,
            },
        ),
        migrations.CreateModel(
            name='ComputedOutboxOverflow',
            fields=[
                ('id', models.CharField(default=apps.tabdata.models_outbox.generate_outbox_id, editable=False, max_length=32, primary_key=True, serialize=False, verbose_name='溢出行 ID')),
                ('table_id', models.UUIDField(verbose_name='种子记录所在表')),
                ('record_id', models.UUIDField(verbose_name='种子记录 ID')),
                ('created_at', models.DateTimeField(default=django.utils.timezone.now, verbose_name='入队时间')),
                ('task', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='overflow_seeds', to='tabdata.computedoutbox', verbose_name='所属 Outbox 任务')),
            ],
            options={
                'verbose_name': 'Computed Outbox 溢出种子',
                'verbose_name_plural': 'Computed Outbox 溢出种子',
                'db_table': 'tabdata_computed_outbox_seed',
                'ordering': ['task_id', 'id'],
            },
        ),
        migrations.CreateModel(
            name='ComputedOutboxDLQ',
            fields=[
                ('id', models.CharField(default=apps.tabdata.models_outbox.generate_outbox_id, editable=False, help_text='cuo_ + 16 字符 hex；W3.1b enqueue 时由 generate_outbox_id 生成', max_length=32, primary_key=True, serialize=False, verbose_name='任务 ID')),
                ('base_id', models.UUIDField(help_text='对应 TabTin Space ID（与 SpaceCheckpoint.space_id 同源）', verbose_name='所属 base/space')),
                ('seed_table_id', models.UUIDField(help_text='cascade 触发源表（Table.id）', verbose_name='种子表 ID')),
                ('workteam_id', models.UUIDField(help_text='多租户隔离主键，admin 过滤 / Pause Registry 必备', verbose_name='所属工作团队')),
                ('space_id', models.UUIDField(help_text='更细粒度过滤；与 ``base_id`` 在 TabTin 当前实现下等价，预留 space 与 base 分离的扩展余地', verbose_name='所属 Space')),
                ('checkpoint_id', models.UUIDField(blank=True, help_text='C5 联动：Agent 操作 SpaceCheckpoint.id；NULL 表示非 Agent 路径', null=True, verbose_name='关联 Checkpoint')),
                ('agent_run_id', models.CharField(blank=True, default='', help_text='对齐 ChangeLog.agent_run_id（D17 决策：CharField(64) 而非 UUID）', max_length=64, verbose_name='Agent Run ID')),
                ('seed_record_ids', models.JSONField(blank=True, help_text='JSONB 数组；> SEED_INLINE_LIMIT 时整批迁入 computed_outbox_seed 溢出表，本字段置 NULL（见 seed_should_overflow helper）', null=True, verbose_name='种子记录 ID 列表')),
                ('change_type', models.CharField(choices=[('insert', '新建'), ('update', '更新'), ('delete', '删除'), ('seed', '种子重算'), ('field-backfill', '字段回填')], max_length=32, verbose_name='变更类型')),
                ('steps', models.JSONField(default=list, help_text='[{step_index, level, table_id, field_ids, ...}, ...]，由 Planner 生成', verbose_name='执行步骤')),
                ('edges', models.JSONField(default=list, help_text='[{from, to}, ...]，用于失败恢复时部分重跑', verbose_name='依赖边')),
                ('plan_hash', models.CharField(help_text='sha256(base_id + seed_table_id + affected_field_ids_sorted + change_type)；pending 状态下唯一，用于 UPSERT 合并幂等', max_length=64, verbose_name='计划哈希')),
                ('status', models.CharField(choices=[('pending', '待执行'), ('processing', '执行中'), ('succeeded', '成功'), ('failed', '失败'), ('cancelled', '已取消'), ('succeeded_discarded', '已完成但被丢弃')], default='pending', max_length=24, verbose_name='任务状态')),
                ('attempts', models.PositiveIntegerField(default=0, verbose_name='已尝试次数')),
                ('max_attempts', models.PositiveIntegerField(default=8, help_text='超过则迁入 DLQ；TechSpec §3 默认 8', verbose_name='最大尝试次数')),
                ('next_run_at', models.DateTimeField(default=django.utils.timezone.now, help_text='Poller 主排序键；初始 = 入队时间，重试时按指数退避后推', verbose_name='下次执行时间')),
                ('sync_max_level', models.IntegerField(blank=True, help_text='Hybrid 策略：sync 阶段已完成到第 N 层，Worker 从 N+1 继续', null=True, verbose_name='同步已完成层级')),
                ('locked_at', models.DateTimeField(blank=True, null=True, verbose_name='加锁时间')),
                ('locked_by', models.CharField(blank=True, default='', help_text="格式 '{worker_id}:{claim_id}'，Recovery 用作释放判定", max_length=64, verbose_name='持锁 Worker')),
                ('lease_expires_at', models.DateTimeField(blank=True, help_text='locked_at + lock_ttl（默认 60s）；过期 Recovery 回收回 pending', null=True, verbose_name='租约过期时间')),
                ('last_error', models.TextField(blank=True, default='', verbose_name='最近一次失败描述')),
                ('last_error_class', models.CharField(blank=True, default='', help_text='便于指标 label 分类（tabdata_computed_outbox_fail_total{exc=...}）', max_length=128, verbose_name='最近一次失败异常类')),
                ('estimated_complexity', models.PositiveIntegerField(default=0, help_text='step 数 × 影响行数估算，用于 Hybrid Strategy 阈值判断', verbose_name='预估复杂度')),
                ('dirty_stats', models.JSONField(blank=True, help_text='{inserted, updated, deleted}，方便 admin 审计', null=True, verbose_name='变更统计')),
                ('affected_table_ids', django.contrib.postgres.fields.ArrayField(base_field=models.UUIDField(), blank=True, default=list, help_text='GIN 索引覆盖 PauseRegistry by table 维度查询', size=None, verbose_name='受影响表')),
                ('affected_field_ids', django.contrib.postgres.fields.ArrayField(base_field=models.UUIDField(), blank=True, default=list, size=None, verbose_name='受影响字段')),
                ('created_at', models.DateTimeField(default=django.utils.timezone.now, verbose_name='入队时间')),
                ('updated_at', models.DateTimeField(auto_now=True, verbose_name='更新时间')),
                ('completed_at', models.DateTimeField(blank=True, help_text='仅 status in (succeeded / succeeded_discarded / failed / cancelled) 时填', null=True, verbose_name='完成时间')),
                ('failed_at', models.DateTimeField(help_text='区别于 ``completed_at``：DLQ 写入瞬间，与主表 failed 时间一致', verbose_name='进入 DLQ 时间')),
                ('dlq_reason', models.CharField(choices=[('max_attempts', '重试已耗尽'), ('poison', '毒任务'), ('manual', '人工迁入')], max_length=64, verbose_name='进入 DLQ 原因')),
                ('dlq_trace', models.TextField(blank=True, default='', help_text='Worker 最后一次执行的完整 traceback；admin replay 前必读', verbose_name='失败完整 stacktrace')),
            ],
            options={
                'verbose_name': 'Computed Outbox 死信队列',
                'verbose_name_plural': 'Computed Outbox 死信队列',
                'db_table': 'tabdata_computed_outbox_dlq',
                'ordering': ['-failed_at'],
                'abstract': False,
                'indexes': [models.Index(fields=['workteam_id', '-failed_at'], name='idx_cdlq_workteam_failed'), models.Index(fields=['base_id', 'seed_table_id'], name='idx_cdlq_base_table'), models.Index(fields=['plan_hash'], name='idx_cdlq_plan_hash')],
            },
        ),
        migrations.AddIndex(
            model_name='computedoutbox',
            index=models.Index(condition=models.Q(('status', 'pending')), fields=['status', 'next_run_at'], name='idx_cob_status_nextrun'),
        ),
        migrations.AddIndex(
            model_name='computedoutbox',
            index=models.Index(condition=models.Q(('status', 'processing')), fields=['status', 'lease_expires_at'], name='idx_cob_status_lease'),
        ),
        migrations.AddIndex(
            model_name='computedoutbox',
            index=models.Index(condition=models.Q(('status__in', ['pending', 'processing'])), fields=['next_run_at'], name='idx_cob_nextrun'),
        ),
        migrations.AddIndex(
            model_name='computedoutbox',
            index=models.Index(fields=['workteam_id', 'status'], name='idx_cob_workteam_status'),
        ),
        migrations.AddIndex(
            model_name='computedoutbox',
            index=models.Index(fields=['seed_table_id', 'status'], name='idx_cob_seedtbl_status'),
        ),
        migrations.AddIndex(
            model_name='computedoutbox',
            index=models.Index(fields=['base_id', 'seed_table_id'], name='idx_cob_base_table'),
        ),
        migrations.AddIndex(
            model_name='computedoutbox',
            index=models.Index(fields=['plan_hash'], name='idx_cob_plan_hash'),
        ),
        migrations.AddIndex(
            model_name='computedoutbox',
            index=models.Index(condition=models.Q(('checkpoint_id__isnull', False)), fields=['checkpoint_id'], name='idx_cob_checkpoint'),
        ),
        migrations.AddIndex(
            model_name='computedoutbox',
            index=django.contrib.postgres.indexes.GinIndex(fields=['affected_table_ids'], name='idx_cob_affected_tables'),
        ),
        migrations.AddConstraint(
            model_name='computedoutbox',
            constraint=models.UniqueConstraint(condition=models.Q(('status', 'pending')), fields=('plan_hash',), name='uq_cob_pending_plan_hash'),
        ),
        migrations.AddIndex(
            model_name='computedoutboxoverflow',
            index=models.Index(fields=['task'], name='idx_cos_task'),
        ),
        migrations.AddConstraint(
            model_name='computedoutboxoverflow',
            constraint=models.UniqueConstraint(fields=('task', 'table_id', 'record_id'), name='uq_cos_task_record'),
        ),
        # ── 自定义 PG 函数（TechSpec §3.4.1，幂等合并 UPSERT 必需）──
        # 注：CREATE OR REPLACE 是幂等的，重复 apply 不会失败；reverse_sql
        # 提供 DROP，确保 migration 可回滚。
        migrations.RunSQL(
            sql=JSONB_MERGE_UNIQ_UP,
            reverse_sql=JSONB_MERGE_UNIQ_DOWN,
        ),
        migrations.RunSQL(
            sql=JSONB_MERGE_UP,
            reverse_sql=JSONB_MERGE_DOWN,
        ),
    ]
