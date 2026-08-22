"""回填 Workspace.created_by 缺失的 owner SpaceMembership。

历史 ``create_workspace`` / ``ensure_home_workspace`` 只写 ``created_by``，
未写 ``SpaceMembership``，导致列表可见但 ``check_space_permission`` 全拒
（定时任务 / TabDoc / Skills 等）。

用法::

    python manage.py backfill_workspace_owner_membership --dry-run
    python manage.py backfill_workspace_owner_membership
    python manage.py backfill_workspace_owner_membership --organization-id <uuid>
"""

from __future__ import annotations

import logging

from django.core.management.base import BaseCommand
from django.db import transaction
from django.db.models import Exists, OuterRef

from apps.services.common.db_router import postgres_app_db_alias
from apps.tabtinspace.models import SpaceMembership, Workspace
from apps.tabtinspace.services.membership_utils import ensure_user_membership

logger = logging.getLogger(__name__)


class Command(BaseCommand):
    help = "回填 Workspace.created_by 缺失的 owner SpaceMembership"

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="预览模式，不执行写入",
        )
        parser.add_argument(
            "--organization-id",
            type=str,
            default=None,
            help="仅处理指定 organization",
        )

    def handle(self, *args, **options):
        dry_run = options["dry_run"]
        organization_id = options.get("organization_id")

        if dry_run:
            self.stdout.write(self.style.WARNING("[DRY-RUN] 预览模式，不会执行修改"))

        owner_ms = SpaceMembership.objects.filter(
            workspace_id=OuterRef("pk"),
            user_id=OuterRef("created_by_id"),
            role="owner",
            is_active=True,
        )
        qs = (
            Workspace.objects.filter(created_by_id__isnull=False)
            .annotate(has_owner_ms=Exists(owner_ms))
            .filter(has_owner_ms=False)
            .select_related("created_by")
            .order_by("created_at")
        )
        if organization_id:
            qs = qs.filter(organization_id=organization_id)

        total = qs.count()
        fixed = 0
        errors = 0
        self.stdout.write(f"扫描缺 owner membership 的 Workspace: {total}")

        for workspace in qs.iterator():
            try:
                if dry_run:
                    self.stdout.write(
                        f"  would fix workspace={workspace.id} "
                        f"created_by={workspace.created_by_id} name={workspace.name!r}"
                    )
                    fixed += 1
                    continue
                with transaction.atomic(using=postgres_app_db_alias()):
                    ensure_user_membership(
                        workspace,
                        workspace.created_by_id,
                        "owner",
                    )
                fixed += 1
                self.stdout.write(
                    f"  fixed workspace={workspace.id} created_by={workspace.created_by_id}"
                )
            except Exception as exc:
                errors += 1
                logger.exception(
                    "backfill_workspace_owner_membership failed workspace=%s",
                    workspace.id,
                )
                self.stdout.write(
                    self.style.ERROR(f"  workspace {workspace.id} 失败: {exc}")
                )

        self.stdout.write("")
        self.stdout.write(self.style.SUCCESS("===== 执行结果 ====="))
        self.stdout.write(f"  待处理 / 已处理: {fixed}/{total}")
        self.stdout.write(f"  错误: {errors}")
        if dry_run:
            self.stdout.write(self.style.WARNING("DRY-RUN 未写入数据库"))
