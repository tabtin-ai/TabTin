"""#3266：个人 Space → Workspace id-reuse 供给（迁移与修复共用）。

0097 只迁「有 device + 非空目录」的 Space；未绑定占位 Space 会被跳过，
后续若直接删壳会丢 Membership / 软 space_id 资产。本模块在 DROP Space 前
把剩余个人 Space 补建成 Workspace，或在 Space 已 DROP 后按孤儿宿主 ID
重建同 id Workspace，使软引用自动归位。
"""

from __future__ import annotations

import logging
import uuid
from typing import Iterable

from django.utils import timezone

logger = logging.getLogger(__name__)

MIGRATED_DIR_PREFIX = '/tabtin/migrated-spaces/'
PLACEHOLDER_DEVICE_PREFIX = 'migration-placeholder-'


def _resolve_created_by_id(space, SpaceMembership, organization_owner_id):
    agent = getattr(space, 'agent', None)
    if agent is not None and getattr(agent, 'owner_user_id', None):
        return agent.owner_user_id
    owner_m = (
        SpaceMembership.objects.filter(
            workspace_id=space.id,
            role='owner',
            is_active=True,
            user_id__isnull=False,
        )
        .values_list('user_id', flat=True)
        .first()
    )
    if owner_m:
        return owner_m
    return organization_owner_id


def _resolve_device_user_id(apps, organization) -> object | None:
    if organization is not None and getattr(organization, 'owner_id', None):
        return organization.owner_id
    OrganizationMember = apps.get_model('tabtinspace', 'OrganizationMember')
    return (
        OrganizationMember.objects.filter(organization_id=organization.id)
        .values_list('user_id', flat=True)
        .first()
        if organization is not None
        else None
    )


def _ensure_org_device(apps, organization_id):
    Device = apps.get_model('tabtinspace', 'Device')
    Organization = apps.get_model('tabtinspace', 'Organization')

    device = (
        Device.objects.filter(organization_id=organization_id)
        .order_by('created_at')
        .first()
    )
    if device is not None:
        return device

    org = Organization.objects.filter(id=organization_id).only('id', 'owner_id').first()
    if org is None:
        return None

    user_id = _resolve_device_user_id(apps, org)
    if user_id is None:
        return None

    fingerprint = f'{PLACEHOLDER_DEVICE_PREFIX}{organization_id}'
    existing = Device.objects.filter(fingerprint=fingerprint).first()
    if existing is not None:
        return existing

    return Device.objects.create(
        id=uuid.uuid4(),
        organization_id=organization_id,
        user_id=user_id,
        name='Migration Placeholder Device',
        device_type='electron',
        role='control',
        fingerprint=fingerprint,
        machine_key='',
        os_info={'source': 'space_to_workspace_migration'},
        capabilities=[],
        status='offline',
        control_status='active',
        metadata_json={'purpose': 'space_retire_3266_placeholder'},
    )


def _unique_normalized_dir(Workspace, device_id, preferred: str, space_id) -> str:
    norm = (preferred or '').strip() or f'{MIGRATED_DIR_PREFIX}{space_id}'
    if not Workspace.objects.filter(
        device_id=device_id,
        normalized_working_dir=norm,
    ).exclude(id=space_id).exists():
        return norm
    return f'{MIGRATED_DIR_PREFIX}{space_id}'


def ensure_workspace_from_personal_space(apps, space) -> bool:
    """从历史 Space(type=workspace) 建同 id Workspace。已存在则 False。"""
    Workspace = apps.get_model('tabtinspace', 'Workspace')
    Organization = apps.get_model('tabtinspace', 'Organization')
    SpaceMembership = apps.get_model('tabtinspace', 'SpaceMembership')

    if Workspace.objects.filter(id=space.id).exists():
        return False

    device_id = getattr(space, 'control_device_id', None) or getattr(
        space, 'bound_device_id', None,
    )
    if device_id is None:
        device = _ensure_org_device(apps, space.organization_id)
        if device is None:
            raise RuntimeError(
                f'#3266: 个人 Space {space.id} 无 device，且组织 '
                f'{space.organization_id} 无法解析设备，无法迁成 Workspace'
            )
        device_id = device.id

    org = Organization.objects.filter(id=space.organization_id).only('owner_id').first()
    owner_id = org.owner_id if org else None
    created_by_id = _resolve_created_by_id(space, SpaceMembership, owner_id)
    norm = _unique_normalized_dir(
        Workspace,
        device_id,
        getattr(space, 'normalized_working_dir', '') or '',
        space.id,
    )
    working_dir = (getattr(space, 'working_dir', None) or '').strip() or norm
    now = timezone.now()

    Workspace.objects.create(
        id=space.id,
        organization_id=space.organization_id,
        device_id=device_id,
        name=(getattr(space, 'name', None) or '') or 'Migrated Workspace',
        working_dir=working_dir,
        normalized_working_dir=norm,
        working_dir_type=getattr(space, 'working_dir_type', None) or '',
        kind='standard',
        trust_status='trusted',
        trust_source='user_confirmed',
        trusted_at=now,
        git_status={},
        approval_grant='always_ask',
        approval_memo={'version': 1, 'entries': {}, 'generation': 0},
        created_by_id=created_by_id,
        # ：不再把 Space.agent 写入 Workspace
    )
    return True


def ensure_workspaces_from_all_personal_spaces(apps) -> int:
    """为所有尚无 Workspace 的个人 Space 建同 id 行。返回新建数。

    Space 表已 DROP（ / migration 0110）时直接返回 0；
    孤儿宿主请改用 :func:`ensure_workspace_for_orphan_host`。
    """
    from django.db import connection

    table_names = set(connection.introspection.table_names())
    if 'tabtinspace_space' not in table_names:
        logger.info(
            '#3266: tabtinspace_space 已不存在，跳过 ensure_workspaces_from_all_personal_spaces'
        )
        return 0

    Space = apps.get_model('tabtinspace', 'Space')
    Workspace = apps.get_model('tabtinspace', 'Workspace')

    # 历史模型仍可能暴露 manager；表已删时上面已 return
    if not hasattr(Space, 'objects'):
        return 0

    existing = set(Workspace.objects.values_list('id', flat=True))
    created = 0
    for space in (
        Space.objects.filter(type='workspace')
        .exclude(id__in=existing)
        .select_related('organization')
        .iterator()
    ):
        if ensure_workspace_from_personal_space(apps, space):
            created += 1
    return created


def ensure_workspace_for_orphan_host(
    apps,
    *,
    host_id,
    organization_id,
    name: str = '',
) -> bool:
    """Space 表已 DROP 后：按孤儿宿主 ID 建同 id Workspace。

    组织已不存在时返回 False（跳过；多为历史测试残留），不抛错。
    """
    Workspace = apps.get_model('tabtinspace', 'Workspace')
    Organization = apps.get_model('tabtinspace', 'Organization')

    if Workspace.objects.filter(id=host_id).exists():
        return False

    org = Organization.objects.filter(id=organization_id).only('id', 'owner_id').first()
    if org is None:
        logger.warning(
            '#3266: skip orphan host %s — organization %s missing',
            host_id,
            organization_id,
        )
        return False

    device = _ensure_org_device(apps, organization_id)
    if device is None:
        logger.warning(
            '#3266: skip orphan host %s — organization %s has no device/user',
            host_id,
            organization_id,
        )
        return False

    norm = _unique_normalized_dir(Workspace, device.id, '', host_id)
    now = timezone.now()
    created_by_id = org.owner_id or _resolve_device_user_id(apps, org)
    Workspace.objects.create(
        id=host_id,
        organization_id=organization_id,
        device_id=device.id,
        name=(name or '').strip() or 'Migrated Workspace',
        working_dir=norm,
        normalized_working_dir=norm,
        working_dir_type='',
        kind='standard',
        trust_status='trusted',
        trust_source='user_confirmed',
        trusted_at=now,
        git_status={},
        approval_grant='always_ask',
        approval_memo={'version': 1, 'entries': {}, 'generation': 0},
        created_by_id=created_by_id,
    )
    return True


def iter_orphan_table_hosts(connection) -> Iterable[tuple]:
    """Yield (space_id, organization_id, sample_name, table_count)."""
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT t.space_id, t.organization_id,
                   MIN(t.name) AS sample_name,
                   COUNT(*) AS n
            FROM tabdata_table t
            WHERE t.space_id IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1 FROM tabtinspace_workspace w WHERE w.id = t.space_id
              )
              AND NOT EXISTS (
                  SELECT 1 FROM tabtinspace_project p WHERE p.id = t.space_id
              )
            GROUP BY t.space_id, t.organization_id
            ORDER BY n DESC
            """
        )
        yield from cursor.fetchall()
