from __future__ import annotations

import asyncio
import copy
import json
import os
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import TestCase

from apps.services.oss.models import FileRecord, FileUsage
from apps.services.docparse.models import DocumentImportJob
from apps.tabdoc.api import get_document_binary
from apps.tabdoc.models import Document, DocumentShare
from apps.tabdoc.services.document_service import DocumentService
from apps.tabdoc.services.image_asset_service import ImageAssetAccessError, ImageAssetService
from apps.tabtinspace.models import Organization, OrganizationMember, Project


User = get_user_model()


class ImageAssetAccessTests(TestCase):
    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from apps.tabtinspace.signals import create_default_organization

        post_save.disconnect(create_default_organization, sender=User)

    def setUp(self):
        suffix = uuid.uuid4().hex[:8]
        self.owner = User.objects.create_user(
            username=f"img_owner_{suffix}",
            email=f"img_owner_{suffix}@example.com",
        )
        self.outsider = User.objects.create_user(
            username=f"img_out_{suffix}",
            email=f"img_out_{suffix}@example.com",
        )
        self.organization = Organization.objects.create(
            name="Image Asset Org",
            owner=self.owner,
            type="team",
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.owner,
            role="owner",
        )
        self.project = Project.objects.create(
            organization=self.organization,
            name="Image Project",
        )
        self.document = Document.objects.create(
            organization_id=self.organization.id,
            space_id=self.project.id,
            owner_id=self.owner.id,
            title="private image doc",
        )
        self.file_record = FileRecord.objects.create(
            file_name="image.jpg",
            file_key=f"tabdoc/images/{uuid.uuid4().hex}.jpg",
            file_path="tabdoc/images",
            file_size=128,
            file_type="image",
            mime_type="image/jpeg",
            file_extension="jpg",
            file_hash=uuid.uuid4().hex,
            bucket_name="test-bucket",
            status="completed",
            organization_id=str(self.organization.id),
            is_public=False,
            access_url="https://oss.example.com/tabdoc/images/private.jpg",
        )
        FileUsage.add_usage(
            self.file_record,
            self.owner.id,
            module="tabdoc",
            context_type="document",
            context_id=str(self.document.id),
        )
        self.share = DocumentShare.objects.create(
            document=self.document,
            share_type="public",
            share_id=f"img{suffix}",
            permission="view",
            created_by=self.owner,
        )

    def _signed_oss(self):
        oss = MagicMock()
        oss.generate_presigned_url.return_value = (
            "https://oss.example.com/tabdoc/images/private.jpg?sig=short"
        )
        return oss

    @staticmethod
    def _document_json(
        *,
        table_text: str,
        image_file_id: uuid.UUID | None = None,
    ) -> dict:
        content = []
        if image_file_id is not None:
            content.append(
                {
                    "type": "image",
                    "attrs": {
                        "fileId": str(image_file_id),
                        "src": "",
                        "alt": "legacy image",
                    },
                }
            )
        content.append(
            {
                "type": "table",
                "content": [
                    {
                        "type": "tableRow",
                        "content": [
                            {
                                "type": "tableCell",
                                "content": [
                                    {
                                        "type": "paragraph",
                                        "content": [
                                            {"type": "text", "text": table_text}
                                        ],
                                    }
                                ],
                            }
                        ],
                    }
                ],
            }
        )
        return {"type": "doc", "content": content}

    @staticmethod
    def _table_text_node(pm_json: dict) -> dict:
        table = next(node for node in pm_json["content"] if node["type"] == "table")
        return table["content"][0]["content"][0]["content"][0]["content"][0]

    def _save_document_content(self, content_pm_json: dict) -> Document:
        service = DocumentService(user=self.owner)
        with patch.object(
            service,
            "check_document_permission",
            return_value=True,
        ), patch.object(
            service,
            "_update_search_vector",
        ), patch.object(
            service,
            "_create_fallback_version_history",
            return_value=None,
        ), patch.object(
            service,
            "_mark_version_synced_for_onstore",
        ), patch.object(
            service,
            "push_and_update_binary",
        ), patch(
            "apps.tabdoc.services.document_service.ResourceBridge.on_update",
        ), patch(
            "apps.collab.api._invalidate_or_force_close",
        ):
            return service.save_content(
                self.document,
                base_version=self.document.latest_version,
                content_pm_json=content_pm_json,
                content_markdown="",
                content_plaintext="updated table cell",
            )

    @patch("apps.services.oss.services.file_access.get_oss_service")
    def test_document_member_receives_short_lived_url(self, mock_get_oss):
        mock_get_oss.return_value = self._signed_oss()

        result = ImageAssetService.resolve_for_document_member(
            document_id=self.document.id,
            file_id=self.file_record.id,
            user=self.owner,
        )

        self.assertEqual(result.access_mode, "signed")
        self.assertEqual(result.expires_in, 3600)
        self.assertIn("sig=short", result.url)

    @patch("apps.services.oss.services.file_access.get_oss_service")
    def test_public_share_receives_short_lived_url(self, mock_get_oss):
        mock_get_oss.return_value = self._signed_oss()

        result = ImageAssetService.resolve_for_share(
            share_id=self.share.share_id,
            file_id=self.file_record.id,
            user=None,
        )

        self.assertEqual(result.access_mode, "signed")
        self.assertIn("sig=short", result.url)

    def test_binary_fallback_keeps_private_image_identity_stable(self):
        stale_signed_url = "https://oss.example.com/private.png?sig=expired"
        stable_json = {
            "type": "doc",
            "content": [{
                "type": "image",
                "attrs": {
                    "fileId": str(self.file_record.id),
                    "src": stale_signed_url,
                    "alt": "private",
                },
            }],
        }
        self.document.description_json = stable_json
        self.document.description_markdown = (
            f"![private](tabtin-file://asset/{self.file_record.id})"
        )
        self.document.description_binary = None

        async def run_inline(fn):
            return fn()

        request = SimpleNamespace(auth="collab-live-service", headers={})
        with patch.dict(os.environ, {"DJANGO_ALLOW_ASYNC_UNSAFE": "true"}), patch(
            "apps.tabdoc.api.run_in_agent_io_executor",
            side_effect=run_inline,
        ), patch.object(
            Document.objects,
            "get",
            return_value=self.document,
        ), patch(
            "apps.tabdoc.services.image_asset_service._load_bound_image",
            return_value=self.file_record,
        ):
            response = asyncio.run(get_document_binary(request, str(self.document.id)))

        data = response["data"]
        attrs = data["description_json"]["content"][0]["attrs"]
        self.assertEqual(attrs["fileId"], str(self.file_record.id))
        self.assertEqual(attrs["src"], "")
        self.assertNotIn("sig=", json.dumps(data["description_json"]))
        self.assertNotIn("image_asset_urls", data)

    def test_unbound_file_is_hidden(self):
        other = FileRecord.objects.create(
            file_name="other.jpg",
            file_key=f"tabdoc/images/{uuid.uuid4().hex}.jpg",
            file_path="tabdoc/images",
            file_size=16,
            file_type="image",
            mime_type="image/jpeg",
            file_extension="jpg",
            file_hash=uuid.uuid4().hex,
            bucket_name="test-bucket",
            status="completed",
            organization_id=str(self.organization.id),
            is_public=False,
        )

        with self.assertRaises(ImageAssetAccessError):
            ImageAssetService.resolve_for_share(
                share_id=self.share.share_id,
                file_id=other.id,
            )

    @patch("apps.services.oss.services.file_access.get_oss_service")
    def test_materialize_and_normalize_private_image_without_persisting_signed_url(self, mock_get_oss):
        mock_get_oss.return_value = self._signed_oss()
        stable = {
            "type": "doc",
            "content": [{
                "type": "paragraph",
                "content": [{
                    "type": "image",
                    "attrs": {
                        "fileId": str(self.file_record.id),
                        "src": "",
                        "alt": "private",
                    },
                }],
            }],
        }

        materialized = ImageAssetService.materialize_pm_json(self.document, stable)
        image_attrs = materialized["content"][0]["content"][0]["attrs"]
        self.assertIn("sig=short", image_attrs["src"])

        normalized = ImageAssetService.normalize_pm_json_for_storage(
            self.document,
            materialized,
        )
        stored_attrs = normalized["content"][0]["content"][0]["attrs"]
        self.assertEqual(stored_attrs["fileId"], str(self.file_record.id))
        self.assertEqual(stored_attrs["src"], "")

    def test_normalize_recovers_file_id_from_stable_markdown_marker(self):
        normalized = ImageAssetService.normalize_pm_json_for_storage(
            self.document,
            {
                "type": "doc",
                "content": [{
                    "type": "image",
                    "attrs": {
                        "src": f"tabtin-file://asset/{self.file_record.id}",
                        "alt": "private",
                    },
                }],
            },
        )
        attrs = normalized["content"][0]["attrs"]
        self.assertEqual(attrs["fileId"], str(self.file_record.id))
        self.assertEqual(attrs["src"], "")
        self.assertTrue(ImageAssetService.pm_json_contains_file_assets(normalized))

    def test_create_document_adopts_private_images_staged_by_completed_import_job(self):
        source = FileRecord.objects.create(
            file_name="source.docx",
            file_key=f"tabdoc/imports/{uuid.uuid4().hex}.docx",
            file_path="tabdoc/imports",
            file_size=256,
            file_type="document",
            mime_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            file_extension="docx",
            file_hash=uuid.uuid4().hex,
            bucket_name="test-bucket",
            status="completed",
            organization_id=str(self.organization.id),
            is_public=False,
        )
        staged = FileRecord.objects.create(
            file_name="embedded.png",
            file_key=f"tabdoc/import-jobs/{uuid.uuid4().hex}.png",
            file_path="tabdoc/import-jobs",
            file_size=128,
            file_type="image",
            mime_type="image/png",
            file_extension="png",
            file_hash=uuid.uuid4().hex,
            bucket_name="test-bucket",
            status="completed",
            organization_id=str(self.organization.id),
            is_public=False,
        )
        job = DocumentImportJob.objects.create(
            file_record=source,
            organization_id=str(self.organization.id),
            requested_by_id=str(self.owner.id),
            status=DocumentImportJob.Status.READY,
        )
        FileUsage.add_usage(
            staged,
            self.owner.id,
            module="tabdoc",
            context_type="document_import_job",
            context_id=str(job.id),
        )
        pm_json = {
            "type": "doc",
            "content": [{
                "type": "image",
                "attrs": {"fileId": str(staged.id), "src": "", "alt": "private"},
            }],
        }
        service = DocumentService(user=self.owner)
        with patch.object(
            service,
            "check_organization_permission",
            return_value=True,
        ), patch(
            "apps.services.billing.services.entitlement_limits_service.EntitlementLimitsService.check_document_limit",
        ), patch.object(
            service,
            "_update_search_vector",
        ), patch.object(
            DocumentService,
            "_init_description_binary",
        ):
            created = service.create_document(
                organization_id=str(self.organization.id),
                title="Imported private images",
                initial_content_pm_json=pm_json,
            )

        self.assertTrue(FileUsage.objects.filter(
            file_record=staged,
            module="tabdoc",
            context_type="document",
            context_id=str(created.id),
            is_active=True,
        ).exists())
        self.assertFalse(FileUsage.objects.filter(
            file_record=staged,
            module="tabdoc",
            context_type="document_import_job",
            context_id=str(job.id),
            is_active=True,
        ).exists())
        self.assertEqual(created.description_json["content"][0]["attrs"]["fileId"], str(staged.id))

    @patch("apps.services.oss.services.file_access.get_oss_service")
    def test_normalize_recovers_file_id_when_legacy_client_drops_it(self, mock_get_oss):
        mock_get_oss.return_value = self._signed_oss()
        materialized = ImageAssetService.materialize_pm_json(
            self.document,
            {
                "type": "doc",
                "content": [{
                    "type": "image",
                    "attrs": {
                        "fileId": str(self.file_record.id),
                        "src": "",
                        "alt": "private",
                    },
                }],
            },
        )
        del materialized["content"][0]["attrs"]["fileId"]

        normalized = ImageAssetService.normalize_pm_json_for_storage(
            self.document,
            materialized,
        )

        attrs = normalized["content"][0]["attrs"]
        self.assertEqual(attrs["fileId"], str(self.file_record.id))
        self.assertEqual(attrs["src"], "")

    def test_save_allows_unchanged_historical_unbound_image_when_editing_table(self):
        historical_file_id = uuid.uuid4()
        original = self._document_json(
            table_text="before",
            image_file_id=historical_file_id,
        )
        original["content"][0]["attrs"]["src"] = (
            "https://oss.example.com/private.jpg?sig=historical"
        )
        self.document.description_json = original
        self.document.description_markdown = "before"
        self.document.description_plaintext = "before"
        self.document.save(update_fields=[
            "description_json",
            "description_markdown",
            "description_plaintext",
        ])

        edited = copy.deepcopy(original)
        edited["content"][0]["attrs"]["fileId"] = (
            f"  {str(historical_file_id).upper()}  "
        )
        edited["content"][0]["attrs"]["src"] = (
            "https://attacker.example/replaced.jpg"
        )
        self._table_text_node(edited)["text"] = "after"

        saved = self._save_document_content(edited)

        saved.refresh_from_db()
        self.assertEqual(
            saved.description_json["content"][0]["attrs"]["fileId"],
            str(historical_file_id),
        )
        self.assertEqual(saved.description_json["content"][0]["attrs"]["src"], "")
        self.assertEqual(
            self._table_text_node(saved.description_json)["text"],
            "after",
        )

    def test_historical_unbound_image_is_canonicalized_and_src_is_scrubbed(self):
        historical_file_id = uuid.uuid4()
        original = self._document_json(
            table_text="before",
            image_file_id=historical_file_id,
        )
        original_attrs = original["content"][0]["attrs"]
        original_attrs["src"] = "https://oss.example.com/private.jpg?sig=historical"

        for submitted_file_id, submitted_src in [
            (
                f"  {str(historical_file_id).upper()}  ",
                "https://oss.example.com/private.jpg?sig=historical",
            ),
            (
                f"  {historical_file_id}  ",
                "https://attacker.example/replaced.jpg",
            ),
        ]:
            with self.subTest(
                submitted_file_id=submitted_file_id,
                submitted_src=submitted_src,
            ):
                submitted = copy.deepcopy(original)
                submitted_attrs = submitted["content"][0]["attrs"]
                submitted_attrs["fileId"] = submitted_file_id
                submitted_attrs["src"] = submitted_src

                normalized = ImageAssetService.normalize_pm_json_for_storage(
                    self.document,
                    submitted,
                    existing_pm_json=original,
                )

                stored_attrs = normalized["content"][0]["attrs"]
                self.assertEqual(stored_attrs["fileId"], str(historical_file_id))
                self.assertEqual(stored_attrs["src"], "")

    def test_save_still_rejects_new_unbound_image(self):
        original = self._document_json(table_text="before")
        self.document.description_json = original
        self.document.description_markdown = "before"
        self.document.description_plaintext = "before"
        self.document.save(update_fields=[
            "description_json",
            "description_markdown",
            "description_plaintext",
        ])
        submitted = self._document_json(
            table_text="after",
            image_file_id=uuid.uuid4(),
        )

        with self.assertRaisesMessage(ValueError, "图片资产未绑定当前文档"):
            self._save_document_content(submitted)

    def test_save_still_rejects_duplicate_of_historical_unbound_image(self):
        historical_file_id = uuid.uuid4()
        original = self._document_json(
            table_text="before",
            image_file_id=historical_file_id,
        )
        self.document.description_json = original
        self.document.save(update_fields=["description_json"])
        submitted = copy.deepcopy(original)
        submitted["content"].insert(0, copy.deepcopy(original["content"][0]))

        with self.assertRaisesMessage(ValueError, "图片资产未绑定当前文档"):
            self._save_document_content(submitted)
