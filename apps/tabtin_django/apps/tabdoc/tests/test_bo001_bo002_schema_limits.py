"""
BO-001 回归测试：tabdoc Schema 层大小限制

- BO-001: DocumentImportMarkdownRequest.markdown 的 max_length 约束

注：原 BO-002（HocuspocusStoreRequest.update_blob_b64 上限）随 onStore 经路收敛到
collab `/persist` 后，`/documents/{id}/store` 端点与 HocuspocusStoreRequest schema 一并移除，
对应用例同步删除。
"""

import unittest

from pydantic import ValidationError


class TestDocumentImportMarkdownRequestLimits(unittest.TestCase):
    """BO-001: markdown 字段应有 5MB 上限"""

    def _get_schema(self):
        from apps.tabdoc.schemas import DocumentImportMarkdownRequest, _MAX_MARKDOWN_IMPORT_SIZE
        return DocumentImportMarkdownRequest, _MAX_MARKDOWN_IMPORT_SIZE

    def test_constant_matches_internal_limit(self):
        _, limit = self._get_schema()
        self.assertEqual(limit, 5 * 1024 * 1024)

    def test_accepts_valid_markdown(self):
        cls, _ = self._get_schema()
        req = cls(organization_id="ws-1", space_id="sp-1", markdown="# Hello")
        self.assertEqual(req.markdown, "# Hello")

    def test_accepts_empty_markdown(self):
        cls, _ = self._get_schema()
        req = cls(organization_id="ws-1", space_id="sp-1")
        self.assertEqual(req.markdown, "")

    def test_accepts_at_limit(self):
        cls, limit = self._get_schema()
        req = cls(organization_id="ws-1", space_id="sp-1", markdown="a" * limit)
        self.assertEqual(len(req.markdown), limit)

    def test_rejects_over_limit(self):
        cls, limit = self._get_schema()
        with self.assertRaises(ValidationError):
            cls(organization_id="ws-1", space_id="sp-1", markdown="a" * (limit + 1))


if __name__ == "__main__":
    unittest.main()
