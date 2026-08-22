"""
修复 organization 数据完整性

扫描所有 organization，补建缺失的 OrganizationMember（owner），
并按 Workspace + Project 口径修正 member_count / space_count。

使用方法:
    python manage.py fix_organization_integrity --dry-run
    python manage.py fix_organization_integrity
    python manage.py fix_organization_integrity --organization-id <uuid>
"""

import logging

from django.core.management.base import BaseCommand
from django.db import transaction

from apps.tabtinspace.models import (
    Organization,
    OrganizationMember,
)
from apps.services.common.db_router import postgres_app_db_alias

logger = logging.getLogger(__name__)


class Command(BaseCommand):
    help = "修复 organization 数据完整性：补建缺失 owner 成员并修正 Workspace+Project 计数"

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="预览模式，不执行修改",
        )
        parser.add_argument(
            "--organization-id",
            type=str,
            default=None,
            help="仅修复指定 organization",
        )

    def handle(self, *args, **options):
        dry_run = options["dry_run"]
        organization_id = options.get("organization_id")

        if dry_run:
            self.stdout.write(self.style.WARNING("[DRY-RUN] 预览模式，不会执行修改"))

        qs = Organization.objects.all()
        if organization_id:
            qs = qs.filter(id=organization_id)

        total = qs.count()
        fixed_member = 0
        fixed_space = 0
        fixed_counts = 0
        errors = 0

        self.stdout.write(f"扫描 {total} 个 organization ...")

        for organization in qs.iterator():
            try:
                m_fix, a_fix, c_fix = self._check_and_fix(organization, dry_run)
                fixed_member += m_fix
                fixed_space += a_fix
                fixed_counts += c_fix
            except Exception as exc:
                errors += 1
                self.stdout.write(
                    self.style.ERROR(f"  organization {organization.id} 修复失败: {exc}")
                )
                logger.error("fix_organization_integrity: %s failed: %s", organization.id, exc, exc_info=True)

        self.stdout.write("")
        self.stdout.write(self.style.SUCCESS("===== 执行结果 ====="))
        self.stdout.write(f"  扫描 organization 数: {total}")
        self.stdout.write(f"  补建 OrganizationMember: {fixed_member}")
        self.stdout.write(f"  其它补建: {fixed_space}")
        self.stdout.write(f"  修正统计计数: {fixed_counts}")
        self.stdout.write(f"  失败: {errors}")

    def _check_and_fix(self, organization: Organization, dry_run: bool) -> tuple[int, int, int]:
        """返回 (补建member数, 补建space数, 修正计数数)"""
        fixed_member = 0
        fixed_space = 0
        fixed_counts = 0

        owner_id = organization.owner_id
        has_owner_member = OrganizationMember.objects.filter(
            organization=organization, user_id=owner_id
        ).exists()
        actual_member_count = OrganizationMember.objects.filter(organization=organization).count()
        from apps.tabtinspace.models import Project, Workspace
        actual_as_count = (
            Workspace.objects.filter(organization=organization).count()
            + Project.objects.filter(organization=organization).count()
        )
        counts_stale = (
            organization.member_count != (actual_member_count or 1)
            or organization.space_count != actual_as_count
        )

        if has_owner_member and not counts_stale:
            return 0, 0, 0

        label = f"  organization {organization.id} ({organization.name})"

        if not has_owner_member:
            self.stdout.write(f"{label}: 缺少 owner OrganizationMember")
            fixed_member = 1

        if counts_stale:
            self.stdout.write(
                f"{label}: 计数不一致 member_count={organization.member_count} "
                f"(实际 {actual_member_count}), space_count={organization.space_count} "
                f"(实际 {actual_as_count})"
            )
            fixed_counts = 1

        if dry_run:
            return fixed_member, fixed_space, fixed_counts

        with transaction.atomic(using=postgres_app_db_alias()):
            if not has_owner_member:
                from django.contrib.auth import get_user_model
                User = get_user_model()
                owner = User.objects.filter(id=owner_id).first()
                if not owner and postgres_app_db_alias() != "default":
                    owner = User.objects.using(postgres_app_db_alias()).filter(id=owner_id).first()
                if not owner:
                    self.stdout.write(self.style.WARNING(f"{label}: owner 用户不存在，跳过"))
                    return 0, 0, 0

            if not has_owner_member:
                OrganizationMember.objects.create(
                    organization=organization, user_id=owner_id, role="owner"
                )

            new_member_count = OrganizationMember.objects.filter(organization=organization).count() or 1
            new_as_count = (
                Workspace.objects.filter(organization=organization).count()
                + Project.objects.filter(organization=organization).count()
            )
            Organization.objects.filter(id=organization.id).update(
                member_count=new_member_count,
                space_count=new_as_count,
            )

        return fixed_member, fixed_space, max(fixed_counts, int(not has_owner_member))
