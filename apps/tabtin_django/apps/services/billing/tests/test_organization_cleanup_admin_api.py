from datetime import timedelta
import json
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import Client, TestCase
from django.utils import timezone

from apps.services.billing.models import OrganizationLifecycleCleanupJob
from apps.users.auth.utils import generate_jwt_token
from apps.services.billing.tests.org_test_utils import org_id_for

User = get_user_model()

BASE = "/api/services/billing"


def _auth(token: str) -> dict:
    return {"HTTP_AUTHORIZATION": f"Bearer {token}"}


class OrganizationCleanupJobAdminApiTests(TestCase):
    databases = {"default"}

    def setUp(self):
        self.client = Client()
        self.admin = User.objects.create_superuser(
            username="cleanup_admin",
            email="cleanup_admin@test.com",
            password="admin123",
        )
        self.token = generate_jwt_token(self.admin)

    def test_list_organization_cleanup_jobs(self):
        OrganizationLifecycleCleanupJob.objects.create(
            organization_id=org_id_for("ws_cleanup_api_001", status="deleting"),
            trigger_source="organization_delete",
            status="failed",
            attempt_count=2,
            max_attempts=6,
            last_error="db timeout",
            next_retry_at=timezone.now(),
        )

        resp = self.client.get(f"{BASE}/admin/billing/organization-cleanup-jobs", **_auth(self.token))

        self.assertEqual(resp.status_code, 200)
        data = resp.json()["data"]
        self.assertEqual(data["total"], 1)
        self.assertEqual(data["jobs"][0]["organization_id"], org_id_for("ws_cleanup_api_001"))
        self.assertEqual(data["jobs"][0]["status"], "failed")
        self.assertEqual(data["summary"]["counts"]["total"], 1)
        self.assertEqual(data["summary"]["counts"]["failed"], 1)
        self.assertEqual(data["summary"]["organization_count"], 1)
        self.assertEqual(data["summary"]["trigger_sources"]["organization_delete"], 1)

    def test_list_organization_cleanup_jobs_should_support_filters_and_summary(self):
        now = timezone.now()
        OrganizationLifecycleCleanupJob.objects.create(
            organization_id=org_id_for("ws_cleanup_filter_alpha_due", status="deleting"),
            trigger_source="organization_delete",
            status="pending",
            next_retry_at=now - timedelta(minutes=5),
        )
        OrganizationLifecycleCleanupJob.objects.create(
            organization_id=org_id_for("ws_cleanup_filter_alpha_running", status="deleting"),
            trigger_source="manual_retry",
            status="running",
            started_at=now - timedelta(minutes=45),
        )
        OrganizationLifecycleCleanupJob.objects.create(
            organization_id=org_id_for("ws_cleanup_filter_beta", status="deleting"),
            trigger_source="organization_delete",
            status="failed",
            last_error="timeout while deleting organization",
            next_retry_at=now + timedelta(minutes=5),
        )

        resp = self.client.get(
            (
                f"{BASE}/admin/billing/organization-cleanup-jobs"
                "?organization_id=filter_alpha&trigger_source=organization_delete&due_only=true"
            ),
            **_auth(self.token),
        )

        self.assertEqual(resp.status_code, 200)
        data = resp.json()["data"]
        self.assertEqual(data["total"], 1)
        self.assertEqual(data["jobs"][0]["organization_id"], org_id_for("ws_cleanup_filter_alpha_due"))
        self.assertEqual(data["jobs"][0]["status"], "pending")
        self.assertEqual(data["summary"]["counts"]["total"], 1)
        self.assertEqual(data["summary"]["counts"]["pending"], 1)
        self.assertEqual(data["summary"]["counts"]["due_retry_jobs"], 1)
        self.assertEqual(data["summary"]["organization_count"], 1)
        self.assertEqual(data["summary"]["trigger_sources"]["organization_delete"], 1)

        stuck_resp = self.client.get(
            f"{BASE}/admin/billing/organization-cleanup-jobs?stuck_only=true&keyword=filter_alpha",
            **_auth(self.token),
        )
        self.assertEqual(stuck_resp.status_code, 200)
        stuck_data = stuck_resp.json()["data"]
        self.assertEqual(stuck_data["total"], 1)
        self.assertEqual(stuck_data["jobs"][0]["organization_id"], org_id_for("ws_cleanup_filter_alpha_running"))
        self.assertEqual(stuck_data["jobs"][0]["status"], "running")
        self.assertEqual(stuck_data["summary"]["counts"]["stuck_running_jobs"], 1)

    def test_organization_cleanup_job_stats(self):
        now = timezone.now()
        OrganizationLifecycleCleanupJob.objects.create(
            organization_id=org_id_for("ws_cleanup_stats_pending", status="deleting"),
            trigger_source="organization_delete",
            status="pending",
            attempt_count=0,
            max_attempts=6,
            next_retry_at=now - timedelta(minutes=1),
        )
        OrganizationLifecycleCleanupJob.objects.create(
            organization_id=org_id_for("ws_cleanup_stats_running", status="deleting"),
            trigger_source="manual_retry",
            status="running",
            attempt_count=2,
            max_attempts=6,
            started_at=now - timedelta(minutes=45),
        )
        OrganizationLifecycleCleanupJob.objects.create(
            organization_id=org_id_for("ws_cleanup_stats_failed", status="deleting"),
            trigger_source="organization_delete",
            status="failed",
            attempt_count=3,
            max_attempts=6,
            last_error="db timeout",
            next_retry_at=now + timedelta(minutes=5),
        )
        OrganizationLifecycleCleanupJob.objects.create(
            organization_id=org_id_for("ws_cleanup_stats_permanent", status="deleting"),
            trigger_source="manual_retry",
            status="permanently_failed",
            attempt_count=6,
            max_attempts=6,
            last_error="still broken",
        )
        OrganizationLifecycleCleanupJob.objects.create(
            organization_id=org_id_for("ws_cleanup_stats_success", status="deleting"),
            trigger_source="organization_delete",
            status="succeeded",
            attempt_count=1,
            max_attempts=6,
            finished_at=now,
            last_success_summary={"total_deleted": 42},
        )

        resp = self.client.get(f"{BASE}/admin/billing/organization-cleanup-jobs/stats", **_auth(self.token))

        self.assertEqual(resp.status_code, 200)
        data = resp.json()["data"]
        self.assertEqual(data["counts"]["total"], 5)
        self.assertEqual(data["counts"]["pending"], 1)
        self.assertEqual(data["counts"]["running"], 1)
        self.assertEqual(data["counts"]["failed"], 1)
        self.assertEqual(data["counts"]["permanently_failed"], 1)
        self.assertEqual(data["counts"]["succeeded"], 1)
        self.assertEqual(data["counts"]["due_retry_jobs"], 1)
        self.assertEqual(data["counts"]["stuck_running_jobs"], 1)
        self.assertEqual(data["trigger_sources"]["organization_delete"], 3)
        self.assertEqual(data["trigger_sources"]["manual_retry"], 2)
        self.assertEqual(data["deleted_rows_last_7d"], 42)
        self.assertEqual(data["recent_failed_jobs"][0]["status"], "permanently_failed")
        self.assertEqual(data["recent_succeeded_jobs"][0]["organization_id"], org_id_for("ws_cleanup_stats_success"))

    def test_retry_organization_cleanup_job(self):
        job = OrganizationLifecycleCleanupJob.objects.create(
            organization_id=org_id_for("ws_cleanup_api_002", status="deleting"),
            trigger_source="organization_delete",
            status="failed",
            attempt_count=1,
            max_attempts=6,
            last_error="db timeout",
            next_retry_at=timezone.now(),
        )

        def _fake_retry(job_id: str, force: bool = False):
            self.assertEqual(job_id, str(job.id))
            self.assertTrue(force)
            job.status = "succeeded"
            job.attempt_count = 2
            job.last_error = ""
            job.last_success_summary = {"total_deleted": 20}
            job.next_retry_at = None
            job.finished_at = timezone.now()
            job.save(
                update_fields=[
                    "status",
                    "attempt_count",
                    "last_error",
                    "last_success_summary",
                    "next_retry_at",
                    "finished_at",
                    "updated_at",
                ]
            )
            job.refresh_from_db()
            return job

        with patch(
            "apps.services.billing.services.OrganizationLifecycleCleanupService.run_cleanup_job",
            side_effect=_fake_retry,
        ) as mock_retry:
            resp = self.client.post(
                f"{BASE}/admin/billing/organization-cleanup-jobs/{job.id}/retry",
                data=json.dumps({}),
                content_type="application/json",
                **_auth(self.token),
            )

        self.assertEqual(resp.status_code, 200)
        mock_retry.assert_called_once()
        job.refresh_from_db()
        self.assertEqual(job.status, "succeeded")
        self.assertEqual(resp.json()["data"]["status"], "succeeded")

    def test_retry_due_organization_cleanup_jobs(self):
        payload = {"limit": 20, "recover_stuck": True}

        with patch(
            "apps.services.billing.services.OrganizationLifecycleCleanupService.process_due_jobs",
            return_value={
                "processed": 2,
                "succeeded": 1,
                "failed": 1,
                "permanently_failed": 0,
                "recovered_stuck_jobs": 1,
                "stuck_jobs_marked_permanently_failed": 0,
                "pending_total": 3,
            },
        ) as mock_process:
            resp = self.client.post(
                f"{BASE}/admin/billing/organization-cleanup-jobs/retry-due",
                data=json.dumps(payload),
                content_type="application/json",
                **_auth(self.token),
            )

        self.assertEqual(resp.status_code, 200)
        mock_process.assert_called_once_with(limit=20, recover_stuck=True)
        data = resp.json()["data"]
        self.assertEqual(data["processed"], 2)
        self.assertEqual(data["recovered_stuck_jobs"], 1)
