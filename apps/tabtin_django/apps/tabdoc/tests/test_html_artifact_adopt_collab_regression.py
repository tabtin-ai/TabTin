"""#7790 / ：稳定 blockId 经协作旧快照回写不得冲掉；块删除 fail-closed。

独立 HtmlArtifactShare 已废弃；本文件只覆盖 preserve_stable_html_block_ids
与 load_for_browser_open 的协作回归。
"""

from __future__ import annotations

import base64
import uuid
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import TestCase

from apps.services.oss.models import FileRecord, FileUsage
from apps.tabdoc.models import Document
from apps.tabdoc.services.html_artifact_service import (
    HtmlArtifactAccessError,
    HtmlArtifactService,
)
from apps.tabtinspace.models import Organization, OrganizationMember, Project

User = get_user_model()


class HtmlArtifactAdoptCollabRegressionTests(TestCase):
    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from apps.tabtinspace.signals import create_default_organization

        try:
            post_save.disconnect(create_default_organization, sender=User)
        except Exception:
            pass

    def setUp(self):
        suffix = uuid.uuid4().hex[:8]
        self.owner = User.objects.create_user(
            username=f"adopt_owner_{suffix}",
            email=f"adopt_owner_{suffix}@example.com",
            password="x",
        )
        self.organization = Organization.objects.create(
            name="Adopt Collab Org",
            owner=self.owner,
            type="team",
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.owner,
            role="owner",
        )
        self.space = Project.objects.create(
            organization=self.organization,
            name="Adopt Space",
        )
        self.file_record = FileRecord.objects.create(
            file_name="orphan.html",
            file_key=f"tabdoc/html/{uuid.uuid4().hex}.html",
            file_path="/tabdoc/html/",
            file_size=32,
            file_type="document",
            mime_type="text/html",
            file_extension="html",
            file_hash=uuid.uuid4().hex,
            bucket_name="test-bucket",
            status="completed",
            organization_id=str(self.organization.id),
            is_public=False,
            access_url="https://cdn.example.com/orphan.html",
        )
        self.client_block_id = str(uuid.uuid4())
        self.doc = Document.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            owner_id=self.owner.id,
            title="adopt collab doc",
            latest_version=1,
            description_json={
                "type": "doc",
                "content": [
                    {
                        "type": "htmlBlock",
                        "attrs": {
                            "blockId": self.client_block_id,
                            "fileId": str(self.file_record.id),
                            "src": "",
                            "title": "orphan",
                            "height": 360,
                        },
                    }
                ],
            },
            description_binary=b"v1-binary",
        )
        FileUsage.add_usage(
            self.file_record,
            self.owner.id,
            module="tabdoc",
            context_type="document",
            context_id=str(self.doc.id),
        )

    def _patch_download(self, content: bytes = b"<html>orphan</html>"):
        return patch(
            "apps.tabdoc.services.html_artifact_service.get_oss_service",
            return_value=type(
                "OSS",
                (),
                {
                    "download_file": staticmethod(
                        lambda _key: {
                            "success": True,
                            "data": {
                                "content": content,
                                "content_type": "text/html",
                            },
                        }
                    )
                },
            )(),
        )

    def _persist_collab_json(self, description_json: dict, *, blob: bytes = b"v2-binary"):
        from apps.collab.adapters.docs import DocsCollabAdapter

        adapter = DocsCollabAdapter()
        with patch(
            "apps.tabdoc.services.document_service._schedule_doc_merge_debounce",
            return_value=None,
        ), patch(
            "apps.tabdoc.services.document_service.ResourceBridge.on_update",
            return_value=None,
        ), patch(
            "apps.collab.api._consume_version_synced_marker",
            return_value=False,
        ):
            return adapter.persist_changes(
                self.doc,
                {
                    "update_blob_b64": base64.b64encode(blob).decode("ascii"),
                    "description_json": description_json,
                },
                {"editor_type": "user", "editor_id": str(self.owner.id)},
            )

    def test_collab_stale_snapshot_preserves_stable_block_id(self):
        # Stale collab snapshot: same fileId, missing blockId.
        stale = {
            "type": "doc",
            "content": [
                {
                    "type": "htmlBlock",
                    "attrs": {
                        "fileId": str(self.file_record.id),
                        "src": "",
                        "title": "orphan",
                        "height": 360,
                    },
                }
            ],
        }
        result = self._persist_collab_json(stale)
        self.assertFalse(result.get("skipped"))

        self.doc.refresh_from_db()
        attrs = self.doc.description_json["content"][0]["attrs"]
        self.assertEqual(attrs["blockId"], self.client_block_id)

        with self._patch_download(b"<html>still-live</html>"):
            payload = HtmlArtifactService.load_for_browser_open(
                document_id=self.doc.id,
                block_id=self.client_block_id,
                user=self.owner,
            )
        self.assertEqual(payload.content, b"<html>still-live</html>")
        self.assertEqual(payload.file_id, str(self.file_record.id))

    def test_collab_delete_block_fail_closes_browser_open(self):
        deleted = {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "attrs": {"blockId": "para-1"},
                    "content": [{"type": "text", "text": "gone"}],
                }
            ],
        }
        self._persist_collab_json(deleted, blob=b"v3-deleted")

        with self._patch_download(), self.assertRaises(HtmlArtifactAccessError) as ctx:
            HtmlArtifactService.load_for_browser_open(
                document_id=self.doc.id,
                block_id=self.client_block_id,
                user=self.owner,
            )
        self.assertEqual(ctx.exception.reason, "block_missing")

    def test_collab_duplicate_file_id_does_not_guess_block_id(self):
        # Existing DB: two blocks share the same fileId — ambiguous; must not claim.
        self.doc.description_json = {
            "type": "doc",
            "content": [
                {
                    "type": "htmlBlock",
                    "attrs": {
                        "blockId": self.client_block_id,
                        "fileId": str(self.file_record.id),
                        "title": "a",
                    },
                },
                {
                    "type": "htmlBlock",
                    "attrs": {
                        "blockId": str(uuid.uuid4()),
                        "fileId": str(self.file_record.id),
                        "title": "b",
                    },
                },
            ],
        }
        self.doc.description_binary = b"dup-v1"
        self.doc.latest_version = 2
        self.doc.save(
            update_fields=["description_json", "description_binary", "latest_version"]
        )

        incoming = {
            "type": "doc",
            "content": [
                {
                    "type": "htmlBlock",
                    "attrs": {
                        "fileId": str(self.file_record.id),
                        "title": "a",
                    },
                },
                {
                    "type": "htmlBlock",
                    "attrs": {
                        "fileId": str(self.file_record.id),
                        "title": "b",
                    },
                },
            ],
        }
        self._persist_collab_json(incoming, blob=b"dup-v2")
        self.doc.refresh_from_db()
        for node in self.doc.description_json["content"]:
            attrs = node.get("attrs") or {}
            self.assertFalse(
                str(attrs.get("blockId") or "").strip(),
                "ambiguous fileId must not receive a guessed stable blockId",
            )
