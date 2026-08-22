"""本地/运维：去重 SkillPublishedVersion 重复展示版本号。"""

from __future__ import annotations

from collections import defaultdict
from typing import Dict, List, Tuple

from apps.skills.services.semver_utils import display_semver_for_published_version


def find_duplicate_display_groups(skill_id=None) -> List[Tuple[object, str, list]]:
    from apps.skills.models import Skill, SkillPublishedVersion

    groups_out: List[Tuple[object, str, list]] = []
    skills = Skill.objects.all()
    if skill_id:
        skills = skills.filter(skill_id=skill_id)

    for skill in skills:
        rows = list(
            SkillPublishedVersion.objects.filter(skill=skill).order_by("version_seq"),
        )
        by_display: Dict[str, list] = defaultdict(list)
        for row in rows:
            try:
                key = display_semver_for_published_version(
                    row.version_label, row.version_seq,
                )
            except ValueError:
                continue
            by_display[key].append(row)
        for display, group in by_display.items():
            if len(group) > 1:
                groups_out.append((skill, display, group))
    return groups_out


def dedupe_published_versions(*, execute: bool = False) -> dict:
    """清理重复展示版本，但不改写设备实际安装的版本登记。"""
    from apps.skills.models import Skill, SkillEnablement, SkillPublishedVersion

    stats = {
        "duplicate_groups": 0,
        "rows_deleted": 0,
        "rows_skipped_installed": 0,
        "labels_backfilled": 0,
        "skills_latest_fixed": 0,
    }

    for skill, display, group in find_duplicate_display_groups():
        stats["duplicate_groups"] += 1
        keep = max(group, key=lambda r: r.version_seq)
        to_delete = [r for r in group if r.pk != keep.pk]
        installed_seqs = set(
            SkillEnablement.objects.filter(skill_id=skill.skill_id)
            .values_list("installed_version_seq", flat=True)
        )
        protected = [
            row for row in to_delete if row.version_seq in installed_seqs
        ]
        to_delete = [
            row for row in to_delete if row.version_seq not in installed_seqs
        ]
        stats["rows_skipped_installed"] += len(protected)

        if not execute:
            stats["rows_deleted"] += len(to_delete)
            continue

        for row in to_delete:
            row.delete()
            stats["rows_deleted"] += 1

        if not (keep.version_label or "").strip():
            keep.version_label = display
            keep.save(update_fields=["version_label"])
            stats["labels_backfilled"] += 1

        if skill.latest_version_seq in {r.version_seq for r in to_delete}:
            skill.latest_version_seq = keep.version_seq
            skill.save(update_fields=["latest_version_seq", "updated_at"])
            stats["skills_latest_fixed"] += 1

    if execute:
        for skill in Skill.objects.exclude(latest_version_seq__isnull=True):
            for row in SkillPublishedVersion.objects.filter(skill=skill):
                if (row.version_label or "").strip():
                    continue
                try:
                    row.version_label = display_semver_for_published_version(
                        "", row.version_seq,
                    )
                    row.save(update_fields=["version_label"])
                    stats["labels_backfilled"] += 1
                except ValueError:
                    pass

    return stats
