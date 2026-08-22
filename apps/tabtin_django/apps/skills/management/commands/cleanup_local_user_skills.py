"""
清空本地 Docker 库中的 user / Marketplace Skills 云端数据（不改 schema）。

用途：清掉 Mine Skills 脏版本（v6 / vv1.0 等）与 Marketplace 发布残留后重新验收。
仅影响本机 PostgreSQL；不会动同事环境。

用法：
  cd apps/tabtin_django && source venv/bin/activate
  python manage.py cleanup_local_user_skills              # 只统计
  python manage.py cleanup_local_user_skills --execute    # 真正删除
  python manage.py cleanup_local_user_skills --execute --owner-user-id <uuid>
  python manage.py cleanup_local_user_skills --execute --skip-packages
"""

from __future__ import annotations

import uuid
from typing import Set

from django.core.management.base import BaseCommand
from django.db import transaction
from apps.services.common.db_router import postgres_app_db_alias


def _skill_package_ids() -> Set[uuid.UUID]:
    """识别 Package Registry 中与 Skill 发布相关的包（Marketplace 产物）。"""
    from apps.services.package_registry.models import Package, PackageFile, PackageVersion

    ids: Set[uuid.UUID] = set(
        Package.objects.filter(metadata__type="skill").values_list("id", flat=True)
    )
    ids.update(
        PackageVersion.objects.filter(manifest__type="skill").values_list(
            "package_id", flat=True
        )
    )
    ids.update(
        PackageFile.objects.filter(path="SKILL.md").values_list(
            "version__package_id", flat=True
        )
    )
    return ids


class Command(BaseCommand):
    help = (
        "Delete local user Skill rows and Marketplace skill packages "
        "(dry-run by default)."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--execute",
            action="store_true",
            help="Apply deletes. Without this flag, only prints counts.",
        )
        parser.add_argument(
            "--owner-user-id",
            type=str,
            default="",
            help="Optional: only delete skills owned by this user UUID.",
        )
        parser.add_argument(
            "--skip-packages",
            action="store_true",
            help="Do not delete Package Registry skill bundles (Marketplace blobs).",
        )
        parser.add_argument(
            "--dedupe-versions",
            action="store_true",
            help="Dedupe duplicate published version labels (same display SemVer).",
        )

    def handle(self, *args, **options):
        from apps.rag.models import SkillEmbedding
        from apps.services.package_registry.models import Package, PackageVersion
        from apps.skills.models import AgentSkillLink, Skill, SkillEnablement, SkillPublishedVersion

        owner_raw = (options.get("owner_user_id") or "").strip()
        owner_filter = None
        if owner_raw:
            owner_filter = uuid.UUID(owner_raw)

        skills = Skill.objects.all()
        if owner_filter:
            skills = skills.filter(owner_user_id=owner_filter)

        skill_ids = list(skills.values_list("skill_id", flat=True))
        slugs = list(skills.values_list("slug", flat=True))
        linked_package_ids = {
            pid for pid in skills.exclude(package_id__isnull=True).values_list(
                "package_id", flat=True
            )
        }

        version_qs = SkillPublishedVersion.objects.filter(skill_id__in=skill_ids)
        enablement_by_id = SkillEnablement.objects.filter(skill_id__in=skill_ids)
        agent_links = AgentSkillLink.objects.filter(source="user")
        if owner_filter:
            agent_links = agent_links.filter(agent__owner_user_id=owner_filter)

        embedding_qs = SkillEmbedding.objects.filter(skill_key__startswith="user:")
        if owner_filter and slugs:
            keys = [f"user:{slug}" for slug in slugs]
            embedding_qs = SkillEmbedding.objects.filter(skill_key__in=keys)

        # Marketplace：DB 中的 public / 审核残留（与 Mine 同表）
        market_skills = Skill.objects.filter(visibility=Skill.VISIBILITY_PUBLIC)
        if owner_filter:
            market_skills = market_skills.filter(owner_user_id=owner_filter)
        market_pending = SkillPublishedVersion.objects.filter(
            review_status=SkillPublishedVersion.REVIEW_PENDING,
        )
        market_rejected = SkillPublishedVersion.objects.filter(
            review_status=SkillPublishedVersion.REVIEW_REJECTED,
        )
        if skill_ids:
            market_pending = market_pending.filter(skill_id__in=skill_ids)
            market_rejected = market_rejected.filter(skill_id__in=skill_ids)

        skill_package_ids = _skill_package_ids()
        orphan_package_ids = skill_package_ids - linked_package_ids
        skill_packages = Package.objects.filter(id__in=skill_package_ids)
        skill_package_versions = PackageVersion.objects.filter(
            package_id__in=skill_package_ids,
        )

        version_labels = list(
            version_qs.exclude(version_label="").values_list("version_label", flat=True)[:20],
        )

        self.stdout.write("━━━ cleanup_local_user_skills ━━━")
        self.stdout.write(f"  Skills (user table):       {len(skill_ids)}")
        self.stdout.write(
            f"    visibility=public:       {market_skills.count()}"
        )
        self.stdout.write(f"  Published versions:        {version_qs.count()}")
        self.stdout.write(
            f"    review pending:        {market_pending.count()}"
        )
        self.stdout.write(
            f"    review rejected:         {market_rejected.count()}"
        )
        self.stdout.write(f"  Enablements (by skill_id): {enablement_by_id.count()}")
        self.stdout.write(f"  Agent links (source=user): {agent_links.count()}")
        self.stdout.write(f"  SkillEmbeddings (user:*):  {embedding_qs.count()}")
        self.stdout.write(f"  Linked package_ids:        {len(linked_package_ids)}")
        self.stdout.write(f"  Skill PR packages:         {skill_packages.count()}")
        self.stdout.write(f"    orphan (no Skill row):   {len(orphan_package_ids)}")
        self.stdout.write(
            f"  Skill PR package versions: {skill_package_versions.count()}"
        )
        if version_labels:
            self.stdout.write(f"  Sample version_label:      {version_labels[:10]}")

        if options.get("dedupe_versions"):
            from apps.skills.services.published_version_cleanup import (
                dedupe_published_versions,
                find_duplicate_display_groups,
            )

            dup_groups = find_duplicate_display_groups()
            self.stdout.write(f"  Duplicate display SemVer groups: {len(dup_groups)}")
            for skill, display, group in dup_groups[:5]:
                seqs = [r.version_seq for r in group]
                self.stdout.write(
                    f"    - {skill.slug}: {display} -> version_seq {seqs}",
                )
            if options["execute"]:
                stats = dedupe_published_versions(execute=True)
                self.stdout.write(self.style.SUCCESS(
                    f"  Deduped: deleted={stats['rows_deleted']} "
                    f"backfilled={stats['labels_backfilled']} "
                    f"latest_fixed={stats['skills_latest_fixed']}",
                ))
            elif dup_groups:
                self.stdout.write(self.style.WARNING(
                    "  Re-run with --execute --dedupe-versions to apply dedupe.",
                ))

        if not options["execute"]:
            self.stdout.write(self.style.WARNING(
                "\nDry-run only. Re-run with --execute to delete."
            ))
            if skill_package_ids and not options["skip_packages"]:
                self.stdout.write(self.style.WARNING(
                    "With --execute, skill Package Registry rows will also be deleted "
                    "(unless --skip-packages)."
                ))
            return

        deleted_any = False
        pkg_deleted = 0
        pkg_detail: dict = {}

        with transaction.atomic(using=postgres_app_db_alias()):
            if skill_ids or agent_links.exists() or embedding_qs.exists():
                enablement_by_id.delete()
                agent_links.delete()
                embedding_qs.delete()
                skill_deleted, skill_detail = skills.delete()
                deleted_any = True
                self.stdout.write(self.style.SUCCESS(
                    f"\nSkills table: enablements(by skill_id) cleared, "
                    f"agent links(user) cleared, embeddings cleared, "
                    f"skills cascade={skill_deleted} {skill_detail}"
                ))

            if not options["skip_packages"] and skill_package_ids:
                pkg_deleted, pkg_detail = skill_packages.delete()
                deleted_any = True
                self.stdout.write(self.style.SUCCESS(
                    f"Package Registry: deleted {pkg_deleted} rows {pkg_detail}"
                ))

        if not deleted_any:
            self.stdout.write(self.style.SUCCESS("Nothing to delete."))
