# Generated manually — 去重重复 version_label 并加库级唯一约束

from django.db import migrations, models
from django.db.models import Q


def dedupe_duplicate_version_labels(apps, schema_editor):
    Skill = apps.get_model("skills", "Skill")
    SkillPublishedVersion = apps.get_model("skills", "SkillPublishedVersion")

    def display_key(version_label: str, version_seq: int) -> str:
        label = (version_label or "").strip()
        if label:
            core = label.lstrip("vV")
            return core
        return f"{version_seq}.0.0"

    for skill in Skill.objects.all().iterator():
        rows = list(
            SkillPublishedVersion.objects.filter(skill_id=skill.skill_id).order_by(
                "version_seq",
            ),
        )
        buckets: dict[str, list] = {}
        for row in rows:
            key = display_key(row.version_label, row.version_seq)
            buckets.setdefault(key, []).append(row)
        for key, group in buckets.items():
            if len(group) <= 1:
                if not (group[0].version_label or "").strip():
                    group[0].version_label = key
                    group[0].save(update_fields=["version_label"])
                continue
            keep = max(group, key=lambda r: r.version_seq)
            for row in group:
                if row.id == keep.id:
                    if not (row.version_label or "").strip():
                        row.version_label = key
                        row.save(update_fields=["version_label"])
                    continue
                SkillPublishedVersion.objects.filter(id=row.id).delete()
            if skill.latest_version_seq and skill.latest_version_seq not in {
                r.version_seq for r in buckets.get(key, [keep])
            }:
                skill.latest_version_seq = keep.version_seq
                skill.save(update_fields=["latest_version_seq"])


class Migration(migrations.Migration):

    dependencies = [
        ("skills", "0004_skill_category_db_defaults"),
    ]

    operations = [
        migrations.RunPython(dedupe_duplicate_version_labels, migrations.RunPython.noop),
        migrations.AddConstraint(
            model_name="skillpublishedversion",
            constraint=models.UniqueConstraint(
                fields=("skill", "version_label"),
                condition=Q(version_label__gt=""),
                name="uq_published_skill_version_label_nonempty",
            ),
        ),
    ]
