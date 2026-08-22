from django.db import migrations, models


def backfill_first_team_claims(apps, schema_editor):
    schema_editor.execute(
        """
        INSERT INTO tabtinspace_organization_first_team_claim (
            user_id,
            organization_id,
            eligible_campaign_ids,
            created_at
        )
        SELECT DISTINCT ON (owner_id)
            owner_id,
            id,
            '[]'::jsonb,
            created_at
        FROM tabtinspace_organization
        WHERE type = 'team'
        ORDER BY owner_id, created_at, id
        ON CONFLICT DO NOTHING
        """
    )


class Migration(migrations.Migration):
    dependencies = [
        ("tabtinspace", "0134_workspace_default_full_access_8004"),
    ]

    operations = [
        migrations.CreateModel(
            name="OrganizationFirstTeamClaim",
            fields=[
                (
                    "user_id",
                    models.CharField(
                        editable=False,
                        max_length=36,
                        primary_key=True,
                        serialize=False,
                        verbose_name="创建用户ID",
                    ),
                ),
                (
                    "organization_id",
                    models.UUIDField(
                        editable=False,
                        unique=True,
                        verbose_name="首个团队组织ID",
                    ),
                ),
                (
                    "eligible_campaign_ids",
                    models.JSONField(
                        blank=True,
                        default=list,
                        verbose_name="创建时适用的供应商额度活动ID",
                    ),
                ),
                (
                    "last_reconciled_at",
                    models.DateTimeField(
                        blank=True,
                        db_index=True,
                        null=True,
                        verbose_name="最近补偿扫描时间",
                    ),
                ),
                (
                    "created_at",
                    models.DateTimeField(
                        auto_now_add=True,
                        verbose_name="创建时间",
                    ),
                ),
            ],
            options={
                "verbose_name": "用户首个团队组织认领",
                "verbose_name_plural": "用户首个团队组织认领",
                "db_table": "tabtinspace_organization_first_team_claim",
            },
        ),
        migrations.RunPython(
            backfill_first_team_claims,
            migrations.RunPython.noop,
        ),
    ]
