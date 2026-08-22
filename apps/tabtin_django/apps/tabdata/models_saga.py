"""TD-6 / W3.3: CheckpointRollbackSaga 状态模型。

设计来源:checkpoint-saga-statemachine.md §3 Schema。
Charter §4.3:saga 状态表落 tabdata PG 侧。

5 步状态机:prepare → pause_outbox → restore_data → mark_collab → cleanup
"""
from __future__ import annotations

import uuid

from django.db import models
from django.utils import timezone


SAGA_OVERALL_IN_PROGRESS = 'in_progress'
SAGA_OVERALL_SUCCEEDED = 'succeeded'
SAGA_OVERALL_FAILED = 'failed'
SAGA_OVERALL_MANUAL = 'manual_intervention'
SAGA_OVERALL_ABORTED = 'aborted'

SAGA_STEP_PREPARE = 'prepare'
SAGA_STEP_PAUSE_OUTBOX = 'pause_outbox'
SAGA_STEP_RESTORE_DATA = 'restore_data'
SAGA_STEP_MARK_COLLAB = 'mark_collab'
SAGA_STEP_CLEANUP = 'cleanup'

SAGA_STEP_STATUS_RUNNING = 'running'
SAGA_STEP_STATUS_SUCCEEDED = 'succeeded'
SAGA_STEP_STATUS_FAILED = 'failed'
SAGA_STEP_STATUS_WAITING = 'waiting'

SAGA_STEP_ORDER = [
    SAGA_STEP_PREPARE,
    SAGA_STEP_PAUSE_OUTBOX,
    SAGA_STEP_RESTORE_DATA,
    SAGA_STEP_MARK_COLLAB,
    SAGA_STEP_CLEANUP,
]

SAGA_TERMINAL_STATUSES = frozenset({
    SAGA_OVERALL_SUCCEEDED,
    SAGA_OVERALL_FAILED,
    SAGA_OVERALL_MANUAL,
    SAGA_OVERALL_ABORTED,
})


def get_next_step(current_step: str) -> str | None:
    """返回当前 step 的下一个 step,若已在 cleanup 则返回 None。"""
    try:
        idx = SAGA_STEP_ORDER.index(current_step)
        if idx + 1 < len(SAGA_STEP_ORDER):
            return SAGA_STEP_ORDER[idx + 1]
    except ValueError:
        pass
    return None


class CheckpointRollbackSaga(models.Model):
    """Checkpoint 回滚 saga 状态。

    详见 docs/planning/tabdata/checkpoint-saga-statemachine.md。
    """

    OVERALL_CHOICES = [
        (SAGA_OVERALL_IN_PROGRESS, '进行中'),
        (SAGA_OVERALL_SUCCEEDED, '成功'),
        (SAGA_OVERALL_FAILED, '失败'),
        (SAGA_OVERALL_MANUAL, '需人工'),
        (SAGA_OVERALL_ABORTED, '已中止'),
    ]
    STEP_CHOICES = [
        (SAGA_STEP_PREPARE, 'prepare'),
        (SAGA_STEP_PAUSE_OUTBOX, 'pause_outbox'),
        (SAGA_STEP_RESTORE_DATA, 'restore_data'),
        (SAGA_STEP_MARK_COLLAB, 'mark_collab'),
        (SAGA_STEP_CLEANUP, 'cleanup'),
    ]
    STEP_STATUS_CHOICES = [
        (SAGA_STEP_STATUS_RUNNING, 'running'),
        (SAGA_STEP_STATUS_SUCCEEDED, 'succeeded'),
        (SAGA_STEP_STATUS_FAILED, 'failed'),
        (SAGA_STEP_STATUS_WAITING, 'waiting'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    space_checkpoint_id = models.UUIDField(db_index=True)
    organization_id = models.UUIDField()
    space_id = models.UUIDField()
    initiator_user_id = models.CharField(max_length=64, blank=True, default='')
    initiator_editor_type = models.CharField(max_length=16, default='user')

    overall_status = models.CharField(
        max_length=24, choices=OVERALL_CHOICES, default=SAGA_OVERALL_IN_PROGRESS,
    )
    current_step = models.CharField(
        max_length=24, choices=STEP_CHOICES, default=SAGA_STEP_PREPARE,
    )
    step_status = models.CharField(
        max_length=16, choices=STEP_STATUS_CHOICES, default=SAGA_STEP_STATUS_RUNNING,
    )

    step_started_at = models.DateTimeField(default=timezone.now)
    step_finished_at = models.DateTimeField(null=True, blank=True)
    step_payload = models.JSONField(default=dict)

    retry_count = models.IntegerField(default=0)
    last_error = models.TextField(blank=True, default='')
    next_retry_at = models.DateTimeField(null=True, blank=True, db_index=True)

    pause_outbox_at = models.DateTimeField(null=True, blank=True)
    restore_data_at = models.DateTimeField(null=True, blank=True)
    mark_collab_at = models.DateTimeField(null=True, blank=True)
    cleanup_at = models.DateTimeField(null=True, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        app_label = 'tabdata'
        db_table = 'tabdata_checkpoint_rollback_saga'
        ordering = ['-created_at']

    def __str__(self) -> str:
        return (
            f'<Saga {self.id} cp={self.space_checkpoint_id} '
            f'{self.overall_status}/{self.current_step}>'
        )

    def advance_to_step(self, step: str) -> None:
        """推进到指定 step,重置 step 级状态。"""
        self.current_step = step
        self.step_status = SAGA_STEP_STATUS_RUNNING
        self.step_started_at = timezone.now()
        self.step_finished_at = None
        self.retry_count = 0
        self.last_error = ''
        self.next_retry_at = None

    def mark_step_succeeded(self, payload: dict | None = None) -> None:
        self.step_status = SAGA_STEP_STATUS_SUCCEEDED
        self.step_finished_at = timezone.now()
        if payload:
            self.step_payload.update(payload)

    def mark_step_failed(self, error: str, *, promote_to_manual: bool = False) -> None:
        self.step_status = SAGA_STEP_STATUS_FAILED
        self.last_error = (error or '')[:8000]
        if promote_to_manual:
            self.overall_status = SAGA_OVERALL_MANUAL

    @property
    def is_terminal(self) -> bool:
        return self.overall_status in SAGA_TERMINAL_STATUSES
