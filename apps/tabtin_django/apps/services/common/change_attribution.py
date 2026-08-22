"""
Unified Change Attribution System

Every change across all TabTin modules records:
  - Who made the change (human user or AI agent)
  - When the change was made
  - What module and resource was affected
  - The semantic type of change

This enables:
  - Timeline replay
  - Agent operation audit logs
  - Activity feeds in the space sidebar
"""

import uuid
from datetime import datetime
from typing import Optional

from django.db import models
from django.utils import timezone


class ChangeAttribution(models.Model):
    """
    Unified change attribution record across all modules.

    Stores metadata about who/what/when for every significant change,
    enabling cross-module audit trails and activity feeds.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    # ── Who ──
    editor_type = models.CharField(
        max_length=16,
        choices=[("user", "User"), ("human", "Human (legacy)"), ("agent", "Agent"), ("system", "System")],
        default="user",
    )
    editor_id = models.CharField(
        max_length=64,
        blank=True,
        default="",
        help_text="User UUID or Agent ID",
    )
    editor_name = models.CharField(
        max_length=255,
        blank=True,
        default="",
        help_text="Display name at time of change",
    )

    # ── What ──
    module = models.CharField(
        max_length=32,
        choices=[
            ("tabdoc", "TabDoc"),
            ("tabdata", "TabData"),
            ("tabslide", "TabSlide"),
            ("tabdesign", "TabDesign"),
        ],
    )
    resource_type = models.CharField(
        max_length=32,
        help_text="document, table, slide_project",
    )
    resource_id = models.UUIDField(help_text="ID of the affected resource")
    resource_name = models.CharField(
        max_length=255,
        blank=True,
        default="",
        help_text="Resource name at time of change",
    )

    # ── Change details ──
    change_type = models.CharField(
        max_length=64,
        help_text="Semantic change type (e.g., edit_content, add_page, create_shape)",
    )
    change_summary = models.TextField(
        blank=True,
        default="",
        help_text="Human-readable summary",
    )
    change_count = models.IntegerField(
        default=1,
        help_text="Number of atomic changes in this batch",
    )

    # ── Context ──
    organization_id = models.UUIDField(null=True, blank=True)
    space_id = models.UUIDField(null=True, blank=True)
    session_id = models.CharField(
        max_length=128,
        blank=True,
        default="",
        help_text="Collaboration session ID",
    )

    # ── Version reference ──
    version = models.BigIntegerField(
        null=True,
        blank=True,
        help_text="Version number after this change",
    )

    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "common_change_attribution"
        ordering = ["-created_at"]
        indexes = [
            models.Index(
                fields=["organization_id", "-created_at"],
                name="attribution_ws_time_idx",
            ),
            models.Index(
                fields=["space_id", "-created_at"],
                name="attribution_space_time_idx",
            ),
            models.Index(
                fields=["resource_id", "-created_at"],
                name="attribution_resource_time_idx",
            ),
            models.Index(
                fields=["editor_type", "editor_id", "-created_at"],
                name="attribution_editor_time_idx",
            ),
            models.Index(
                fields=["module", "-created_at"],
                name="attribution_module_time_idx",
            ),
        ]

    def __str__(self):
        return (
            f"[{self.module}] {self.editor_type}:{self.editor_id} "
            f"{self.change_type} on {self.resource_type}:{self.resource_id}"
        )


def record_attribution(
    *,
    module: str,
    resource_type: str,
    resource_id: str,
    change_type: str,
    editor_type: str = "user",
    editor_id: str = "",
    editor_name: str = "",
    resource_name: str = "",
    change_summary: str = "",
    change_count: int = 1,
    organization_id: Optional[str] = None,
    space_id: Optional[str] = None,
    session_id: str = "",
    version: Optional[int] = None,
    using: str = "default",
) -> ChangeAttribution:
    """
    Record a change attribution entry.

    Convenience function for creating ChangeAttribution records.
    """
    return ChangeAttribution.objects.using(using).create(
        module=module,
        resource_type=resource_type,
        resource_id=resource_id,
        change_type=change_type,
        editor_type=editor_type,
        editor_id=editor_id,
        editor_name=editor_name,
        resource_name=resource_name,
        change_summary=change_summary,
        change_count=change_count,
        organization_id=organization_id,
        space_id=space_id,
        session_id=session_id,
        version=version,
    )


def get_space_activity_feed(
    space_id: str,
    limit: int = 50,
    offset: int = 0,
    module: Optional[str] = None,
    editor_type: Optional[str] = None,
    using: str = "default",
) -> list[dict]:
    """
    Get activity feed for a space (cross-module).

    Returns a list of attribution entries suitable for rendering
    in the space sidebar activity feed.
    """
    qs = ChangeAttribution.objects.using(using).filter(
        space_id=space_id,
    )

    if module:
        qs = qs.filter(module=module)
    if editor_type:
        qs = qs.filter(editor_type=editor_type)

    qs = qs.order_by("-created_at")

    results = []
    for attr in qs[offset:offset + limit]:
        results.append({
            "id": str(attr.id),
            "module": attr.module,
            "resource_type": attr.resource_type,
            "resource_id": str(attr.resource_id),
            "resource_name": attr.resource_name,
            "change_type": attr.change_type,
            "change_summary": attr.change_summary,
            "change_count": attr.change_count,
            "editor_type": attr.editor_type if attr.editor_type != "human" else "user",
            "editor_id": attr.editor_id,
            "editor_name": attr.editor_name,
            "version": attr.version,
            "created_at": attr.created_at.isoformat(),
        })

    return results
