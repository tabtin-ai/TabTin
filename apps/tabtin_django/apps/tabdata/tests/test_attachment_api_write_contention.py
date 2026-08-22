"""Attachment upload-task API write-contention contracts."""
from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from django.db.utils import OperationalError
from django.test import SimpleTestCase


def _make_user_namespace():
    user_id = "11111111-1111-1111-1111-111111111111"
    return SimpleNamespace(
        id=user_id,
        pk=user_id,
        is_authenticated=True,
        is_active=True,
    )


class TestAttachmentUploadTaskWriteContention(SimpleTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._auth_patcher = patch(
            "apps.users.auth.permissions.JWTAuth.authenticate",
            return_value=_make_user_namespace(),
        )
        cls._auth_patcher.start()
        cls._invite_patcher = patch(
            "apps.users.auth.invite_gate_middleware._has_redeemed_invite",
            return_value=True,
        )
        cls._invite_patcher.start()

    @classmethod
    def tearDownClass(cls):
        cls._invite_patcher.stop()
        cls._auth_patcher.stop()
        super().tearDownClass()

    def _create_upload_task(self):
        return self.client.post(
            "/api/tabdata/attachments/upload-task",
            data=json.dumps(
                {
                    "table_id": str(uuid4()),
                    "field_id": str(uuid4()),
                    "record_id": str(uuid4()),
                    "files": [
                        {
                            "file_name": "evidence.png",
                            "file_size": 8,
                            "mime_type": "image/png",
                        }
                    ],
                }
            ),
            content_type="application/json",
            HTTP_AUTHORIZATION="Bearer fake-test-token",
        )

    def test_lock_contention_returns_retryable_503(self):
        db_cause = RuntimeError("canceling statement due to lock timeout")
        db_cause.pgcode = "55P03"
        lock_error = OperationalError("attachment upload task allocation failed")
        lock_error.__cause__ = db_cause

        with patch("apps.tabdata.api_attachment.AttachmentService") as service_cls:
            service_cls.return_value.create_upload_task.side_effect = lock_error
            response = self._create_upload_task()

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["code"], "SAVE_BUSY")
        self.assertEqual(
            response.json()["data"],
            {"retryable": True, "retry_after_ms": 500},
        )

    def test_non_contention_database_error_stays_500(self):
        db_cause = RuntimeError("connection failed")
        db_cause.pgcode = "08006"
        db_error = OperationalError("database write failed")
        db_error.__cause__ = db_cause

        with patch("apps.tabdata.api_attachment.AttachmentService") as service_cls:
            service_cls.return_value.create_upload_task.side_effect = db_error
            response = self._create_upload_task()

        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json()["code"], "INTERNAL_ERROR")
