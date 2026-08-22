"""W3.3 / TD-6: CheckpointRollbackSaga 状态表。

Charter §4.3: saga 状态表落 tabdata PG 侧。
checkpoint-saga-statemachine.md §3: 完整 schema。

⚠️ 必须带 --database=postgresql::

    python manage.py migrate tabdata --database=postgresql
"""
import uuid
import django.utils.timezone
from django.db import migrations, models


SAGA_TABLE_DDL = """
CREATE INDEX IF NOT EXISTS idx_saga_overall_step
    ON tabdata_checkpoint_rollback_saga (overall_status, current_step, step_started_at);
CREATE INDEX IF NOT EXISTS idx_saga_space_created
    ON tabdata_checkpoint_rollback_saga (space_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_saga_workteam_overall
    ON tabdata_checkpoint_rollback_saga (workteam_id, overall_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_saga_reconcile
    ON tabdata_checkpoint_rollback_saga (current_step, step_started_at)
    WHERE overall_status = 'in_progress'
      AND current_step = 'mark_collab'
      AND mark_collab_at IS NULL;
"""

SAGA_TABLE_DDL_REVERSE = """
DROP INDEX IF EXISTS idx_saga_reconcile;
DROP INDEX IF EXISTS idx_saga_workteam_overall;
DROP INDEX IF EXISTS idx_saga_space_created;
DROP INDEX IF EXISTS idx_saga_overall_step;
"""


class Migration(migrations.Migration):

    dependencies = [
        ('tabdata', '0027_computed_outbox'),
    ]

    operations = [
        migrations.CreateModel(
            name='CheckpointRollbackSaga',
            fields=[
                ('id', models.UUIDField(
                    default=uuid.uuid4, editable=False,
                    primary_key=True, serialize=False,
                )),
                ('space_checkpoint_id', models.UUIDField(db_index=True)),
                ('workteam_id', models.UUIDField()),
                ('space_id', models.UUIDField()),
                ('initiator_user_id', models.CharField(
                    max_length=64, blank=True, default='',
                )),
                ('initiator_editor_type', models.CharField(
                    max_length=16, default='user',
                )),
                ('overall_status', models.CharField(
                    max_length=24, default='in_progress',
                    choices=[
                        ('in_progress', '进行中'),
                        ('succeeded', '成功'),
                        ('failed', '失败'),
                        ('manual_intervention', '需人工'),
                        ('aborted', '已中止'),
                    ],
                )),
                ('current_step', models.CharField(
                    max_length=24, default='prepare',
                    choices=[
                        ('prepare', 'prepare'),
                        ('pause_outbox', 'pause_outbox'),
                        ('restore_data', 'restore_data'),
                        ('mark_collab', 'mark_collab'),
                        ('cleanup', 'cleanup'),
                    ],
                )),
                ('step_status', models.CharField(
                    max_length=16, default='running',
                    choices=[
                        ('running', 'running'),
                        ('succeeded', 'succeeded'),
                        ('failed', 'failed'),
                        ('waiting', 'waiting'),
                    ],
                )),
                ('step_started_at', models.DateTimeField(
                    default=django.utils.timezone.now,
                )),
                ('step_finished_at', models.DateTimeField(
                    null=True, blank=True,
                )),
                ('step_payload', models.JSONField(default=dict)),
                ('retry_count', models.IntegerField(default=0)),
                ('last_error', models.TextField(blank=True, default='')),
                ('next_retry_at', models.DateTimeField(
                    null=True, blank=True, db_index=True,
                )),
                ('pause_outbox_at', models.DateTimeField(
                    null=True, blank=True,
                )),
                ('restore_data_at', models.DateTimeField(
                    null=True, blank=True,
                )),
                ('mark_collab_at', models.DateTimeField(
                    null=True, blank=True,
                )),
                ('cleanup_at', models.DateTimeField(
                    null=True, blank=True,
                )),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={
                'db_table': 'tabdata_checkpoint_rollback_saga',
                'ordering': ['-created_at'],
                'app_label': 'tabdata',
            },
        ),
        migrations.RunSQL(
            sql=SAGA_TABLE_DDL,
            reverse_sql=SAGA_TABLE_DDL_REVERSE,
        ),
    ]
