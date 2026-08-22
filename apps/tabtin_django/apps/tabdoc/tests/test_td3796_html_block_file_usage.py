"""#3796 回归：CLI 上传的 TabDoc HTML 块文件必须能被文档归档/删除的 FileUsage 清理路径回收。

因果锁定
--------
CLI 的 `doc insert-html` / `doc update-html` 走 cli-server `POST /oss/upload` 上传 HTML 文件，
并把 FileUsage 登记的 context_type 声明为 `document`（修复前固定为 `present`）。

TabDoc 的清理入口 `DocumentService._deactivate_document_file_usages` 只 deactivate
`context_type in ['document','document_cover']` 的 usage。因此：

- `context_type='document'`（修复后 CLI 的登记值）→ 被清理 → ref_count 归零 → 孤儿文件可回收。
- `context_type='present'`（修复前的登记值）→ 永远不被清理 → ref_count 永不归零 → 文件永不回收。

这两条测试正向 + 反向锁住"为什么 CLI 必须把 context_type 改成 document"的因果。

实现说明
--------
`_deactivate_document_file_usages` 在 archive/trash/permanent_delete 里通过
`transaction.on_commit(..., using="postgresql")` 触发。既有集成测试（test_tabdoc_integration_flow）
在测 trash 时直接 patch 掉它，说明它是独立可测的静态方法。这里直接调用静态方法本体——
它就是本 issue 的争议点（context_type 过滤），直调最短、最稳，避开 on_commit / 权限 /
ResourceBridge 等与本因果无关的复杂度。
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import patch

from django.test import TestCase

from apps.services.oss.models import FileRecord, FileUsage
from apps.tabdoc.services.document_service import DocumentService


class Td3796HtmlBlockFileUsageCleanupTests(TestCase):
    """锁 CLI HTML 块上传登记的 FileUsage 能否被 TabDoc 归档/删除清理路径回收。"""

    def _make_file_record(self) -> FileRecord:
        # organization_id 留空：跳过存储计量与 analytics_cache on_commit 失效，保持用例自包含。
        return FileRecord.objects.create(
            file_name="block.html",
            file_key=f"tabdoc/html/{uuid.uuid4().hex}.html",
            file_path="/tabdoc/html/",
            file_size=1024,
            file_type="document",
            mime_type="text/html",
            file_extension="html",
            file_hash=uuid.uuid4().hex,
            bucket_name="test-bucket",
            status="completed",
            organization_id="",
        )

    def _mock_document(self, doc_id: str) -> SimpleNamespace:
        # _deactivate_document_file_usages 只读 document.id / organization_id / created_by_id。
        return SimpleNamespace(id=doc_id, organization_id="", created_by_id=None)

    def test_document_usage_deactivated_by_tabdoc_cleanup(self):
        """context_type='document'（修复后 CLI 的登记值）应被清理：is_active=False + ref_count 递减。"""
        doc_id = str(uuid.uuid4())
        record = self._make_file_record()
        # 模拟 CLI HTML 块上传登记（FileRegistryService.register_uploaded_file 内部同款调用）。
        usage = FileUsage.add_usage(
            record, uuid.uuid4(), module="tabdoc",
            context_type="document", context_id=doc_id,
        )
        record.refresh_from_db()
        self.assertTrue(usage.is_active)
        self.assertEqual(record.ref_count, 1)

        DocumentService._deactivate_document_file_usages(self._mock_document(doc_id))

        usage.refresh_from_db()
        record.refresh_from_db()
        self.assertFalse(usage.is_active, "document usage 应被 TabDoc 清理路径 deactivate")
        self.assertEqual(record.ref_count, 0, "ref_count 应递减到 0，孤儿回收才能生效")

    def test_present_usage_not_touched_by_tabdoc_cleanup(self):
        """反向对照：context_type='present'（修复前的登记值）不被清理——这正是  的病根。"""
        doc_id = str(uuid.uuid4())
        record = self._make_file_record()
        usage = FileUsage.add_usage(
            record, uuid.uuid4(), module="tabdoc",
            context_type="present", context_id=doc_id,
        )
        record.refresh_from_db()
        self.assertTrue(usage.is_active)
        self.assertEqual(record.ref_count, 1)

        DocumentService._deactivate_document_file_usages(self._mock_document(doc_id))

        usage.refresh_from_db()
        record.refresh_from_db()
        self.assertTrue(
            usage.is_active,
            "present usage 不在 ['document','document_cover'] 白名单内，故永不被清理（ 病根）",
        )
        self.assertEqual(record.ref_count, 1, "present usage 未释放 → 文件永不回收")

    def test_billing_failure_schedules_storage_snapshot_reconciliation(self):
        """文档引用已停用但计量失败时，应立即安排组织额度重算。"""
        doc_id = str(uuid.uuid4())
        organization_id = str(uuid.uuid4())
        record = self._make_file_record()
        record.organization_id = organization_id
        record.save(update_fields=["organization_id"])
        usage = FileUsage.add_usage(
            record,
            uuid.uuid4(),
            module="tabdoc",
            context_type="document",
            context_id=doc_id,
        )
        document = SimpleNamespace(
            id=doc_id,
            organization_id=organization_id,
            created_by_id=None,
        )

        with (
            patch(
                "apps.services.billing.services.storage_service."
                "OrganizationStorageBillingService.apply_storage_delta",
                side_effect=RuntimeError("meter unavailable"),
            ),
            patch(
                "apps.services.billing.tasks.schedule_storage_snapshot_reconciliation"
            ) as schedule_reconciliation,
        ):
            DocumentService._deactivate_document_file_usages(document)

        usage.refresh_from_db()
        self.assertFalse(usage.is_active)
        schedule_reconciliation.assert_called_once_with(
            organization_id,
            reason="tabdoc_archive_release",
        )
