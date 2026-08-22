"""
Migration: One active bot Space per Agent unique constraint.

Before adding the constraint, clean up any existing duplicate
bot Spaces for the same Agent (keep the newest, archive the rest).
"""

from django.db import migrations, models


def cleanup_duplicate_bot_spaces(apps, schema_editor):
    """Archive duplicate active bot Spaces for the same Agent, keeping only the newest.

    Space.id is UUID v4 (random), so Max('id') does NOT correspond to the newest record.
    Use Max('created_at') instead to reliably keep the most recently created Space.
    """
    Space = apps.get_model('tabtinspace', 'Space')
    from django.db.models import Count, Max

    duplicates = (
        Space.objects.filter(type='bot', is_archived=False, trashed_at__isnull=True)
        .exclude(agent__isnull=True)
        .values('agent_id')
        .annotate(cnt=Count('id'), latest_created=Max('created_at'))
        .filter(cnt__gt=1)
    )
    archived_count = 0
    for dup in duplicates:
        updated = (
            Space.objects.filter(
                agent_id=dup['agent_id'],
                type='bot',
                is_archived=False,
                trashed_at__isnull=True,
            )
            .exclude(created_at=dup['latest_created'])
            .update(is_archived=True)
        )
        archived_count += updated

    if archived_count:
        print(f"\n  [cleanup] Archived {archived_count} duplicate bot Space(s).")


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0034_cleanup_tabgoal_app_references'),
    ]

    operations = [
        migrations.RunPython(
            cleanup_duplicate_bot_spaces,
            reverse_code=migrations.RunPython.noop,
        ),
        migrations.AddConstraint(
            model_name='space',
            constraint=models.UniqueConstraint(
                condition=models.Q(
                    ('is_archived', False),
                    ('trashed_at__isnull', True),
                    ('type', 'bot'),
                ),
                fields=('agent',),
                name='ctx_one_active_bot_space_per_agent',
            ),
        ),
    ]
