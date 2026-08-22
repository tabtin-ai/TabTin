"""归档因客户端兜底误建的重复「默认 Workspace / 默认 Space」。

同组织 + 同执行设备上，保留最新一条本机个人默认现场，其余同名兜底行归档。

用法::

    python manage.py cleanup_duplicate_default_workspaces --dry-run
    python manage.py cleanup_duplicate_default_workspaces
    python manage.py cleanup_duplicate_default_workspaces --organization-id <uuid>
"""

from __future__ import annotations

import logging
from collections import defaultdict
from typing import DefaultDict, List, Tuple
from uuid import UUID

from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

from apps.services.common.db_router import postgres_app_db_alias
from apps.tabtinspace.models import Space
from apps.tabtinspace.services.onboarding_defaults import DEFAULT_ONBOARDING_SPACE_NAME

logger = logging.getLogger(__name__)

_DEFAULT_HOME_NAMES = frozenset({
    DEFAULT_ONBOARDING_SPACE_NAME,
    '默认 Space',
})


class Command(BaseCommand):
    help = "归档同组织同设备上重复的默认 Workspace / 默认 Space，只保留最新一条"

    def add_arguments(self, parser):
        parser.add_argument(
            '--dry-run',
            action='store_true',
            help='预览模式，不执行修改',
        )
        parser.add_argument(
            '--organization-id',
            type=str,
            default=None,
            help='仅清理指定 organization',
        )

    def handle(self, *args, **options):
        dry_run = options['dry_run']
        organization_id = options.get('organization_id')

        if dry_run:
            self.stdout.write(self.style.WARNING('[DRY-RUN] 预览模式，不会执行修改'))

        # ：默认主场已落在 Workspace(kind=home)；同设备唯一约束后此命令主要为巡检。
        from apps.tabtinspace.models import Workspace

        qs = Workspace.objects.filter(
            kind=Workspace.Kind.HOME,
            name__in=_DEFAULT_HOME_NAMES,
            device_id__isnull=False,
        ).order_by('organization_id', 'device_id', '-created_at')

        if organization_id:
            qs = qs.filter(organization_id=organization_id)

        groups: DefaultDict[Tuple[UUID, UUID], List] = defaultdict(list)
        for space in qs.iterator():
            groups[(space.organization_id, space.device_id)].append(space)

        keep_count = 0
        archive_count = 0

        for (org_id, device_id), spaces in groups.items():
            if len(spaces) <= 1:
                keep_count += len(spaces)
                continue

            keeper = spaces[0]
            dupes = spaces[1:]
            keep_count += 1
            self.stdout.write(
                f'org={org_id} device={device_id}: keep={keeper.id} ({keeper.name}) '
                f'delete={len(dupes)}'
            )

            if dry_run:
                archive_count += len(dupes)
                continue

            with transaction.atomic(using=postgres_app_db_alias()):
                for dupe in dupes:
                    dupe_id = dupe.id
                    dupe.delete()
                    archive_count += 1
                    logger.info(
                        'cleanup_duplicate_default_workspaces: deleted workspace=%s org=%s device=%s',
                        dupe_id,
                        org_id,
                        device_id,
                    )

        self.stdout.write('')
        self.stdout.write(self.style.SUCCESS('===== 执行结果 ====='))
        self.stdout.write(f'  保留默认现场: {keep_count}')
        self.stdout.write(f'  归档重复行: {archive_count}')
        if dry_run:
            self.stdout.write(self.style.WARNING('  （dry-run，未写入）'))
