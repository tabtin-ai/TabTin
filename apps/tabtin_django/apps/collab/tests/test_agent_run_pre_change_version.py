import uuid
from datetime import timedelta

import pytest
from django.utils import timezone


@pytest.mark.django_db
def test_unlinked_post_run_persist_cannot_be_selected_as_baseline():
    """A collab persist after an Agent write must not become its rollback base."""
    from apps.collab.api import _find_agent_run_pre_change_version
    from apps.collab.models import ChangeLog, VersionHistory

    resource_id = uuid.uuid4()
    organization_id = uuid.uuid4()
    run_id = str(uuid.uuid4())
    started_at = timezone.now()

    def create_version(created_at):
        return VersionHistory.objects.create(
            resource_type="table",
            resource_id=resource_id,
            organization_id=organization_id,
            blob=b"snapshot",
            blob_size=8,
            created_at=created_at,
        )

    expected_baseline = create_version(started_at)
    run_version = create_version(started_at + timedelta(seconds=1))
    ChangeLog.objects.create(
        resource_type="table",
        resource_id=resource_id,
        change_type="create_record",
        agent_run_id=run_id,
        version_history=run_version,
    )

    # This is the problematic shape from the live report: it contains the
    # Agent result, but onStore attributed it to a user and left run_id empty.
    create_version(started_at + timedelta(seconds=2))

    selected, run_vh_ids = _find_agent_run_pre_change_version(
        all_run_ids=[run_id],
        resource_type="table",
        resource_id=str(resource_id),
        organization_id=organization_id,
    )

    assert selected.id == expected_baseline.id
    assert run_vh_ids == [run_version.id]
