"""TD-6 / W3.3: RollbackSagaService — 5 步状态机编排。

Charter §4.3: 5 步状态机 prepare → pause_outbox → restore_data → mark_collab → cleanup。
checkpoint-saga-statemachine.md §6: 调度方式与入口骨架。

灰度安全:TABDATA_SAGA_ENABLED=False 时 trigger() 抛 SagaDisabledError,
restore_space_checkpoint 走 legacy 路径。
"""
from __future__ import annotations

import logging
from datetime import timedelta
from uuid import UUID

from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models_saga import (
    CheckpointRollbackSaga,
    SAGA_OVERALL_FAILED,
    SAGA_OVERALL_IN_PROGRESS,
    SAGA_OVERALL_MANUAL,
    SAGA_OVERALL_SUCCEEDED,
    SAGA_STEP_CLEANUP,
    SAGA_STEP_MARK_COLLAB,
    SAGA_STEP_PAUSE_OUTBOX,
    SAGA_STEP_PREPARE,
    SAGA_STEP_RESTORE_DATA,
    SAGA_STEP_STATUS_FAILED,
    SAGA_STEP_STATUS_RUNNING,
    SAGA_STEP_STATUS_SUCCEEDED,
    SAGA_STEP_STATUS_WAITING,
    get_next_step,
)

logger = logging.getLogger(__name__)


class RollbackInProgressError(Exception):
    def __init__(self, saga_id=None):
        self.saga_id = saga_id
        super().__init__(f'Rollback already in progress: saga={saga_id}')


class RollbackPrepareFailed(Exception):
    def __init__(self, saga_id, error):
        self.saga_id = saga_id
        self.error = error
        super().__init__(f'Rollback prepare failed: saga={saga_id} error={error}')


class SagaDisabledError(Exception):
    pass


def _is_saga_enabled_for(organization_id: UUID | str | None = None) -> bool:
    if getattr(settings, 'TABDATA_SAGA_ENABLED', False):
        return True
    allowlist = getattr(settings, 'TABDATA_SAGA_ORGANIZATION_ALLOWLIST', [])
    if organization_id and str(organization_id) in allowlist:
        return True
    return False


class RollbackSagaService:
    """Checkpoint 回滚 saga 编排服务。"""

    def trigger(
        self,
        *,
        space_checkpoint_id: UUID,
        organization_id: UUID,
        space_id: UUID,
        initiator_user_id: str = '',
        initiator_editor_type: str = 'user',
    ) -> CheckpointRollbackSaga:
        """同步执行 prepare,异步触发后续 step。"""
        if not _is_saga_enabled_for(organization_id):
            raise SagaDisabledError('TABDATA_SAGA_ENABLED is False')

        try:
            with transaction.atomic(using=TABDATA_DB_ALIAS):
                saga = CheckpointRollbackSaga.objects.using(TABDATA_DB_ALIAS).create(
                    space_checkpoint_id=space_checkpoint_id,
                    organization_id=organization_id,
                    space_id=space_id,
                    initiator_user_id=str(initiator_user_id),
                    initiator_editor_type=initiator_editor_type,
                )
        except IntegrityError:
            existing = (
                CheckpointRollbackSaga.objects.using(TABDATA_DB_ALIAS)
                .filter(
                    space_checkpoint_id=space_checkpoint_id,
                    overall_status=SAGA_OVERALL_IN_PROGRESS,
                )
                .first()
            )
            raise RollbackInProgressError(
                saga_id=existing.id if existing else None,
            )

        prepare_result = step_prepare(saga)
        if prepare_result.get('failed'):
            saga.overall_status = SAGA_OVERALL_FAILED
            saga.mark_step_failed(prepare_result.get('error', 'unknown'))
            saga.save(using=TABDATA_DB_ALIAS)
            raise RollbackPrepareFailed(saga.id, prepare_result.get('error'))

        if prepare_result.get('skip_to') == SAGA_STEP_CLEANUP:
            saga.mark_step_succeeded(prepare_result.get('payload'))
            saga.advance_to_step(SAGA_STEP_CLEANUP)
            saga.save(using=TABDATA_DB_ALIAS)
            from apps.tabdata.tasks.saga_tasks import saga_cleanup_task
            saga_cleanup_task.apply_async(args=[str(saga.id)])
            return saga

        saga.mark_step_succeeded(prepare_result.get('payload'))
        saga.advance_to_step(SAGA_STEP_PAUSE_OUTBOX)
        saga.save(using=TABDATA_DB_ALIAS)

        from apps.tabdata.tasks.saga_tasks import saga_pause_outbox_task
        saga_pause_outbox_task.apply_async(args=[str(saga.id)])

        return saga


# ── Step 实现 ──────────────────────────────────────


def step_prepare(saga: CheckpointRollbackSaga) -> dict:
    """Step 1: prepare — 校验 Checkpoint 并列出受影响资源。"""
    try:
        from apps.collab.models import SpaceCheckpoint
    except ImportError:
        return {'failed': True, 'error': 'collab.models not available'}

    cp = (
        SpaceCheckpoint.objects
        .using(TABDATA_DB_ALIAS)
        .filter(id=saga.space_checkpoint_id)
        .first()
    )
    if not cp:
        return {'failed': True, 'error': 'space_checkpoint_not_found'}

    version_refs = cp.version_refs or {}
    affected_resources = []
    for ref_key, vh_id in version_refs.items():
        parts = ref_key.split(':', 1)
        if len(parts) == 2:
            affected_resources.append({
                'type': parts[0],
                'id': parts[1],
                'version_history_id': str(vh_id),
            })

    if not affected_resources:
        return {
            'skip_to': SAGA_STEP_CLEANUP,
            'payload': {'reason': 'empty_checkpoint', 'resource_count': 0},
        }

    try:
        from django.db import connections
        with connections[TABDATA_DB_ALIAS].cursor() as cursor:
            cursor.execute("""
                UPDATE collab_space_checkpoint
                SET metadata = jsonb_set(
                    jsonb_set(
                        COALESCE(metadata, '{}'::jsonb),
                        '{rollback_in_progress}', 'true'::jsonb, true
                    ),
                    '{rollback_saga_id}', to_jsonb(%s::text), true
                )
                WHERE id = %s
            """, [str(saga.id), str(saga.space_checkpoint_id)])
    except Exception as e:
        logger.warning('[saga] prepare: metadata update failed: %s', e)

    return {
        'payload': {
            'resource_count': len(affected_resources),
            'affected_resources': affected_resources,
            'table_ids': [
                r['id'] for r in affected_resources if r['type'] == 'table'
            ],
        },
    }


def step_pause_outbox(saga: CheckpointRollbackSaga) -> dict:
    """兼容既有 saga 步骤；计算 Outbox 下线后无需暂停任务。"""
    saga.pause_outbox_at = timezone.now()
    saga.save(using=TABDATA_DB_ALIAS, update_fields=['pause_outbox_at', 'updated_at'])
    return {'payload': {'skipped': True, 'reason': 'computed_outbox_retired'}}


def step_restore_data(saga: CheckpointRollbackSaga) -> dict:
    """Step 3: restore_data — 遍历 version_refs 调 adapter.restore。"""
    affected_resources = saga.step_payload.get('affected_resources', [])
    if not affected_resources:
        return {'payload': {'restored_resources': [], 'reason': 'no_resources'}}

    try:
        from apps.collab.service import restore_to_version_with_lock_held
    except ImportError:
        restore_to_version_with_lock_held = None

    restored = []
    for res in affected_resources:
        resource_type = res.get('type', '')
        resource_id = res.get('id', '')
        vh_id = res.get('version_history_id', '')

        if resource_type != 'table':
            logger.info(
                '[saga] skip non-table resource %s:%s in saga %s',
                resource_type, resource_id, saga.id,
            )
            continue

        try:
            if restore_to_version_with_lock_held:
                restore_to_version_with_lock_held(
                    resource_type=resource_type,
                    resource_id=resource_id,
                    target_version_id=vh_id,
                    editor_info={
                        'user_id': saga.initiator_user_id,
                        'editor_type': saga.initiator_editor_type,
                        'saga_id': str(saga.id),
                    },
                )
            restored.append({
                'type': resource_type,
                'id': resource_id,
                'version_history_id': vh_id,
            })
        except Exception as e:
            logger.error(
                '[saga] restore failed resource=%s:%s saga=%s: %s',
                resource_type, resource_id, saga.id, e,
                exc_info=True,
            )
            return {
                'failed': True,
                'error': f'adapter_restore_failed:{resource_type}:{resource_id}:{e}',
                'promote_to_manual': True,
                'payload': {
                    'failed_resource': {'type': resource_type, 'id': resource_id},
                    'error': str(e)[:500],
                    'partially_restored': restored,
                },
            }

    saga.restore_data_at = timezone.now()
    saga.save(using=TABDATA_DB_ALIAS, update_fields=['restore_data_at', 'updated_at'])

    return {
        'payload': {
            'restored_resources': restored,
        },
    }


def step_mark_collab(saga: CheckpointRollbackSaga) -> dict:
    """Step 4: mark_collab — 标记 SpaceCheckpoint 为已回滚。"""
    try:
        from apps.collab.models import SpaceCheckpoint
    except ImportError:
        return {'failed': True, 'error': 'collab.models not available'}

    try:
        from django.db import connections
        with connections[TABDATA_DB_ALIAS].cursor() as cursor:
            cursor.execute("""
                UPDATE collab_space_checkpoint
                SET metadata = jsonb_set(
                    jsonb_set(
                        jsonb_set(
                            COALESCE(metadata, '{}'::jsonb),
                            '{rolled_back}', 'true'::jsonb, true
                        ),
                        '{rolled_back_at}', to_jsonb(%s::text), true
                    ),
                    '{rollback_saga_id}', to_jsonb(%s::text), true
                )
                WHERE id = %s
            """, [
                timezone.now().isoformat(),
                str(saga.id),
                str(saga.space_checkpoint_id),
            ])
            if cursor.rowcount == 0:
                return {
                    'failed': True,
                    'error': f'space_checkpoint {saga.space_checkpoint_id} not found',
                }

        saga.mark_collab_at = timezone.now()
        saga.save(using=TABDATA_DB_ALIAS, update_fields=['mark_collab_at', 'updated_at'])
        return {'payload': {'marked': True}}

    except Exception as e:
        logger.warning(
            '[saga] mark_collab failed saga=%s: %s',
            saga.id, e, exc_info=True,
        )
        return {'failed': True, 'error': str(e)[:500]}


def step_cleanup(saga: CheckpointRollbackSaga) -> dict:
    """Step 5: cleanup — 清理 metadata 并将 saga 置为终态。"""
    table_ids = saga.step_payload.get('table_ids', [])

    try:
        from django.db import connections
        with connections[TABDATA_DB_ALIAS].cursor() as cursor:
            cursor.execute("""
                UPDATE collab_space_checkpoint
                SET metadata = jsonb_set(
                    jsonb_set(
                        COALESCE(metadata, '{}'::jsonb),
                        '{rollback_in_progress}', 'false'::jsonb, true
                    ),
                    '{rollback_completed_at}', to_jsonb(%s::text), true
                )
                WHERE id = %s
            """, [timezone.now().isoformat(), str(saga.space_checkpoint_id)])
    except Exception as e:
        logger.warning('[saga] cleanup metadata update failed: %s', e)

    saga.cleanup_at = timezone.now()
    saga.overall_status = SAGA_OVERALL_SUCCEEDED
    saga.step_status = SAGA_STEP_STATUS_SUCCEEDED
    saga.save(using=TABDATA_DB_ALIAS, update_fields=[
        'cleanup_at', 'overall_status', 'step_status', 'updated_at',
    ])

    return {'payload': {'resumed': True, 'table_count': len(table_ids)}}
