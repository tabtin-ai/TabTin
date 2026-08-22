"""
回填 SkillEmbedding 的 organization_id 字段。

存量数据中 source='user' 的 SkillEmbedding 可能 organization_id=NULL，
通过 space_id 反查 Space.organization_id 补全。
"""

from django.core.management.base import BaseCommand
import logging

logger = logging.getLogger(__name__)


class Command(BaseCommand):
    help = "Backfill organization_id for SkillEmbedding records that have space_id but NULL organization_id"

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Only report how many records would be updated",
        )

    def handle(self, *args, **options):
        from apps.rag.models import SkillEmbedding
        from apps.tabtinspace.models import Space

        dry_run = options["dry_run"]

        candidates = SkillEmbedding.objects.filter(
            organization_id__isnull=True,
            space_id__isnull=False,
        )
        total = candidates.count()
        self.stdout.write(f"Found {total} SkillEmbedding records with NULL organization_id and non-NULL space_id")

        if total == 0:
            self.stdout.write(self.style.SUCCESS("Nothing to backfill."))
            return

        if dry_run:
            self.stdout.write(self.style.WARNING("Dry run — no changes made."))
            return

        space_ids = set(candidates.values_list("space_id", flat=True))
        from apps.tabtinspace.models import Project, Workspace
        space_organization_map = dict(
            Workspace.objects.filter(id__in=space_ids).values_list("id", "organization_id")
        )
        space_organization_map.update(
            dict(Project.objects.filter(id__in=space_ids).values_list("id", "organization_id"))
        )

        updated = 0
        skipped = 0
        for record in candidates.iterator(chunk_size=500):
            wt_id = space_organization_map.get(record.space_id)
            if wt_id:
                record.organization_id = wt_id
                record.save(update_fields=["organization_id", "updated_at"])
                updated += 1
            else:
                skipped += 1

        self.stdout.write(self.style.SUCCESS(
            f"Done: updated={updated}, skipped={skipped} (space not found)"
        ))
