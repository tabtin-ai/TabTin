import uuid

from django.conf import settings
from django.db import models
from django.utils import timezone

from apps.extensions.fields import EncryptedJSONField


RELAY_TTL_SECONDS = 300


class LoginRelayPackage(models.Model):
    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        CONSUMED = "consumed", "Consumed"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="login_relay_packages",
    )
    space = models.ForeignKey(
        "tabtinspace.Workspace",
        on_delete=models.CASCADE,
        related_name="login_relay_packages",
    )
    target_device = models.ForeignKey(
        "tabtinspace.Device",
        on_delete=models.CASCADE,
        related_name="login_relay_packages",
    )
    domain = models.CharField(max_length=253)
    encrypted_payload = EncryptedJSONField(
        default=list,
        help_text="Encrypted short-lived relay cookie payload",
    )
    status = models.CharField(
        max_length=16,
        choices=Status.choices,
        default=Status.PENDING,
    )
    created_at = models.DateTimeField(auto_now_add=True)
    consumed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "login_relay_package"
        indexes = [
            models.Index(
                fields=["user", "status", "created_at"],
                name="login_relay_user_state_idx",
            ),
        ]
        constraints = [
            models.CheckConstraint(
                check=(
                    models.Q(status="pending", consumed_at__isnull=True)
                    | models.Q(status="consumed", consumed_at__isnull=False)
                ),
                name="login_relay_status_time_ck",
            ),
        ]

    def is_expired(self) -> bool:
        return (timezone.now() - self.created_at).total_seconds() >= RELAY_TTL_SECONDS
