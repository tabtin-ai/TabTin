import uuid

import apps.tabchat.models
import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("tabtinspace", "0145_shared_resource_placement_dismissed"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("tabchat", "0032_external_groups"),
    ]

    operations = [
        migrations.AddField(
            model_name="externalcontact",
            name="suspended_reason",
            field=models.CharField(blank=True, default="", max_length=100),
        ),
        migrations.CreateModel(
            name="ExternalContactInvitation",
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
                    "status",
                    models.CharField(
                        choices=[
                            ("pending", "Pending"),
                            ("accepted", "Accepted"),
                            ("rejected", "Rejected"),
                            ("cancelled", "Cancelled"),
                            ("expired", "Expired"),
                        ],
                        default="pending",
                        max_length=20,
                    ),
                ),
                ("note", models.CharField(blank=True, default="", max_length=500)),
                (
                    "expires_at",
                    models.DateTimeField(
                        default=apps.tabchat.models.external_contact_invitation_expiry,
                    ),
                ),
                ("resolved_at", models.DateTimeField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "recipient_organization",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="received_external_contact_invitations",
                        to="tabtinspace.organization",
                    ),
                ),
                (
                    "recipient_user",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="received_external_contact_invitations",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "sender_organization",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="sent_external_contact_invitations",
                        to="tabtinspace.organization",
                    ),
                ),
                (
                    "sender_user",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="sent_external_contact_invitations",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={"db_table": "tabchat_external_contact_invitation"},
        ),
        migrations.AddConstraint(
            model_name="conversation",
            constraint=models.UniqueConstraint(
                condition=models.Q(is_external=True, dm_hash__isnull=False),
                fields=("dm_hash",),
                name="tabchat_external_dmhash_uniq",
            ),
        ),
        migrations.AddConstraint(
            model_name="externalcontactinvitation",
            constraint=models.UniqueConstraint(
                condition=models.Q(status="pending"),
                fields=("sender_user", "recipient_user"),
                name="tabchat_external_invite_pending_uniq",
            ),
        ),
        migrations.AddConstraint(
            model_name="externalcontactinvitation",
            constraint=models.CheckConstraint(
                check=~models.Q(sender_user=models.F("recipient_user")),
                name="tabchat_external_invite_not_self",
            ),
        ),
        migrations.AddIndex(
            model_name="externalcontactinvitation",
            index=models.Index(
                fields=["recipient_user", "status", "-created_at"],
                name="tabchat_ext_invite_in_idx",
            ),
        ),
        migrations.AddIndex(
            model_name="externalcontactinvitation",
            index=models.Index(
                fields=["sender_user", "status", "-created_at"],
                name="tabchat_ext_invite_out_idx",
            ),
        ),
    ]
