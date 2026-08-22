import uuid

from django.db import migrations, models
from django.db.models import OuterRef, Q, Subquery


def migrate_provider_credit_claims(apps, schema_editor):
    Organization = apps.get_model("tabtinspace", "Organization")
    OrganizationMember = apps.get_model("tabtinspace", "OrganizationMember")
    OldClaim = apps.get_model("tabtinspace", "OrganizationFirstTeamClaim")
    NewClaim = apps.get_model("tabtinspace", "OrganizationProviderCreditClaim")

    pending_claims = []

    def queue_claim(claim):
        pending_claims.append(claim)
        if len(pending_claims) >= 1000:
            NewClaim.objects.bulk_create(pending_claims, batch_size=1000)
            pending_claims.clear()

    for organization in Organization.objects.filter(type="personal").iterator(
        chunk_size=1000
    ):
        queue_claim(
            NewClaim(
                id=uuid.uuid4(),
                user_id=str(organization.owner_id),
                organization_id=organization.id,
                eligibility_order=1,
                eligible_campaign_ids=[],
                created_at=organization.created_at,
            )
        )

    next_team_order_by_user = {}
    for old_claim in OldClaim.objects.all().iterator(chunk_size=1000):
        owner_id = str(old_claim.user_id)
        next_team_order_by_user[owner_id] = 3
        queue_claim(
            NewClaim(
                id=uuid.uuid4(),
                user_id=owner_id,
                organization_id=old_claim.organization_id,
                eligibility_order=2,
                eligible_campaign_ids=old_claim.eligible_campaign_ids,
                last_reconciled_at=old_claim.last_reconciled_at,
                created_at=old_claim.created_at,
            )
        )

    earliest_creator = (
        OrganizationMember.objects.filter(organization_id=OuterRef("pk"))
        .order_by("joined_at", "id")
        .values("user_id")[:1]
    )
    unclaimed_teams = (
        Organization.objects.filter(type="team")
        .exclude(
            id__in=OldClaim.objects.values_list("organization_id", flat=True)
        )
        .annotate(inferred_creator_id=Subquery(earliest_creator))
        .order_by("created_at", "id")
    )
    for organization in unclaimed_teams.iterator(chunk_size=1000):
        creator_id = str(
            organization.inferred_creator_id or organization.owner_id
        )
        next_order = next_team_order_by_user.get(creator_id, 2)
        if next_order > 4:
            continue
        queue_claim(
            NewClaim(
                id=uuid.uuid4(),
                user_id=creator_id,
                organization_id=organization.id,
                eligibility_order=next_order,
                eligible_campaign_ids=[],
                created_at=organization.created_at,
            )
        )
        next_team_order_by_user[creator_id] = next_order + 1

    if pending_claims:
        NewClaim.objects.bulk_create(pending_claims, batch_size=1000)


class Migration(migrations.Migration):
    dependencies = [
        ("tabtinspace", "0135_organization_first_team_claim"),
    ]

    operations = [
        migrations.CreateModel(
            name="OrganizationProviderCreditClaim",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                (
                    "user_id",
                    models.CharField(
                        editable=False,
                        max_length=36,
                        verbose_name="创建用户ID",
                    ),
                ),
                (
                    "organization_id",
                    models.UUIDField(
                        editable=False,
                        unique=True,
                        verbose_name="资格组织ID",
                    ),
                ),
                (
                    "eligibility_order",
                    models.PositiveSmallIntegerField(
                        editable=False,
                        verbose_name="资格顺序",
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
                "verbose_name": "用户自有组织专享券资格",
                "verbose_name_plural": "用户自有组织专享券资格",
                "db_table": "tabtinspace_organization_provider_credit_claim",
            },
        ),
        migrations.AddConstraint(
            model_name="organizationprovidercreditclaim",
            constraint=models.CheckConstraint(
                check=Q(
                    eligibility_order__gte=1,
                    eligibility_order__lte=4,
                ),
                name="ctx_org_credit_claim_order_1_4",
            ),
        ),
        migrations.AddConstraint(
            model_name="organizationprovidercreditclaim",
            constraint=models.UniqueConstraint(
                fields=("user_id", "eligibility_order"),
                name="ctx_org_credit_claim_user_order_unique",
            ),
        ),
        migrations.RunPython(
            migrate_provider_credit_claims,
            migrations.RunPython.noop,
        ),
        migrations.SeparateDatabaseAndState(
            # 保留旧物理表作为发布回滚兜底；运行时状态只暴露新 claim 模型。
            database_operations=[],
            state_operations=[
                migrations.DeleteModel(name="OrganizationFirstTeamClaim"),
            ],
        ),
    ]
