"""SC-001 回归测试：organization 删除时必须清理 RAG embedding 数据。

验证 delete_organization_resources() 在删除 Table/Document 之前
先清理 TableEmbedding, RecordEmbedding, DocumentEmbedding,
CodeChunkEmbedding, EmbeddingTask 五类 RAG 数据。
"""
import uuid
from unittest.mock import MagicMock, call, patch

from django.test import SimpleTestCase

from apps.tabtinspace.services.organization_service import OrganizationService


_WS_MOD = "apps.tabtinspace.services.organization_service"


class RagEmbeddingCleanupOnOrganizationDeleteTests(SimpleTestCase):
    """delete_organization_resources 必须在删除 Table 之前清理 RAG embedding。"""

    def setUp(self):
        self.organization_id = uuid.uuid4()
        self.space_ids = [uuid.uuid4()]
        self.table_ids = [uuid.uuid4(), uuid.uuid4()]

    @patch(f"{_WS_MOD}._get_organization_resource_models", return_value=[])
    @patch(f"{_WS_MOD}.OrganizationService.delete_space_resources")
    @patch(f"{_WS_MOD}.Table.objects")
    @patch("apps.rag.models.EmbeddingTask.objects")
    @patch("apps.rag.models.CodeChunkEmbedding.objects")
    @patch("apps.rag.models.DocumentEmbedding.objects")
    @patch("apps.rag.models.RecordEmbedding.objects")
    @patch("apps.rag.models.TableEmbedding.objects")
    def test_rag_embeddings_deleted_on_organization_delete(
        self,
        mock_te_objects,
        mock_re_objects,
        mock_de_objects,
        mock_ce_objects,
        mock_et_objects,
        mock_table_objects,
        mock_delete_space_resources,
        mock_get_resource_models,
    ):
        mock_table_objects.filter.return_value.values_list.return_value = self.table_ids

        for mock_obj in (mock_te_objects, mock_re_objects, mock_de_objects, mock_ce_objects, mock_et_objects):
            mock_obj.filter.return_value.delete.return_value = (3, {})

        OrganizationService.delete_organization_resources(self.organization_id, self.space_ids)

        mock_table_objects.filter.assert_called_with(organization_id=self.organization_id)

        mock_te_objects.filter.assert_called_once_with(table_id__in=self.table_ids)
        mock_te_objects.filter.return_value.delete.assert_called_once()

        mock_re_objects.filter.assert_called_once_with(table_id__in=self.table_ids)
        mock_re_objects.filter.return_value.delete.assert_called_once()

        mock_de_objects.filter.assert_called_once_with(organization_id=self.organization_id)
        mock_de_objects.filter.return_value.delete.assert_called_once()

        mock_ce_objects.filter.assert_called_once_with(organization_id=self.organization_id)
        mock_ce_objects.filter.return_value.delete.assert_called_once()

        mock_et_objects.filter.assert_called_once_with(organization_id=self.organization_id)
        mock_et_objects.filter.return_value.delete.assert_called_once()

    @patch(f"{_WS_MOD}._get_organization_resource_models", return_value=[])
    @patch(f"{_WS_MOD}.OrganizationService.delete_space_resources")
    @patch(f"{_WS_MOD}.Table.objects")
    @patch("apps.rag.models.EmbeddingTask.objects")
    @patch("apps.rag.models.CodeChunkEmbedding.objects")
    @patch("apps.rag.models.DocumentEmbedding.objects")
    @patch("apps.rag.models.RecordEmbedding.objects")
    @patch("apps.rag.models.TableEmbedding.objects")
    def test_no_tables_still_cleans_doc_code_task_embeddings(
        self,
        mock_te_objects,
        mock_re_objects,
        mock_de_objects,
        mock_ce_objects,
        mock_et_objects,
        mock_table_objects,
        mock_delete_space_resources,
        mock_get_resource_models,
    ):
        """即使 organization 下没有 Table，也应清理 DocumentEmbedding 等。"""
        mock_table_objects.filter.return_value.values_list.return_value = []

        for mock_obj in (mock_de_objects, mock_ce_objects, mock_et_objects):
            mock_obj.filter.return_value.delete.return_value = (1, {})

        OrganizationService.delete_organization_resources(self.organization_id, self.space_ids)

        mock_te_objects.filter.assert_not_called()
        mock_re_objects.filter.assert_not_called()

        mock_de_objects.filter.assert_called_once_with(organization_id=self.organization_id)
        mock_ce_objects.filter.assert_called_once_with(organization_id=self.organization_id)
        mock_et_objects.filter.assert_called_once_with(organization_id=self.organization_id)

    @patch(f"{_WS_MOD}._get_organization_resource_models", return_value=[])
    @patch(f"{_WS_MOD}.OrganizationService.delete_space_resources")
    @patch(f"{_WS_MOD}.Table.objects")
    def test_rag_cleanup_runs_before_space_resource_deletion(
        self,
        mock_table_objects,
        mock_delete_space_resources,
        mock_get_resource_models,
    ):
        """RAG 清理必须在 delete_space_resources 之前执行。"""
        order = []

        mock_table_objects.filter.return_value.values_list.return_value = []

        with patch("apps.rag.models.DocumentEmbedding.objects") as mock_de, \
             patch("apps.rag.models.CodeChunkEmbedding.objects") as mock_ce, \
             patch("apps.rag.models.EmbeddingTask.objects") as mock_et:

            for mock_obj in (mock_de, mock_ce, mock_et):
                mock_obj.filter.return_value.delete.side_effect = (
                    lambda: (order.append("rag_cleanup"), (0, {}))[1]
                )
            mock_delete_space_resources.side_effect = lambda ids: order.append("delete_space")

            OrganizationService.delete_organization_resources(self.organization_id, self.space_ids)

        self.assertTrue(len(order) > 0)
        rag_indices = [i for i, v in enumerate(order) if v == "rag_cleanup"]
        space_indices = [i for i, v in enumerate(order) if v == "delete_space"]
        if rag_indices and space_indices:
            self.assertLess(max(rag_indices), min(space_indices))

    @patch(f"{_WS_MOD}._get_organization_resource_models", return_value=[])
    @patch(f"{_WS_MOD}.OrganizationService.delete_space_resources")
    @patch(f"{_WS_MOD}.Table.objects")
    def test_rag_import_error_does_not_block_organization_deletion(
        self,
        mock_table_objects,
        mock_delete_space_resources,
        mock_get_resource_models,
    ):
        """RAG 模块 import 失败不应阻断 organization 删除。"""
        mock_table_objects.filter.return_value.values_list.return_value = []

        with patch.dict("sys.modules", {"apps.rag.models": None}):
            OrganizationService.delete_organization_resources(self.organization_id, self.space_ids)

        mock_delete_space_resources.assert_called_once_with(self.space_ids)
