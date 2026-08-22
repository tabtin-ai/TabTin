"""
TabMemo Agent 工具元数据与格式测试

使用 SimpleTestCase，不依赖数据库。
"""

from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.services.tools.domains.tabmemo.memo_tools import (
    TabmemoCreateMemoTool,
    TabmemoSearchMemosTool,
    TabmemoGetMemoTool,
    TabmemoUpdateMemoTool,
    TabmemoArchiveMemoTool,
    TabmemoRestoreMemoTool,
    TabmemoListCollectionsTool,
    TabmemoCreateCollectionTool,
    TabmemoUpdateCollectionTool,
    TabmemoDeleteCollectionTool,
    TabmemoAddToCollectionTool,
    TabmemoRemoveFromCollectionTool,
    TabmemoBatchOperateTool,
    TabmemoListAttachmentsTool,
    TabmemoListGrantsTool,
    TabmemoManageGrantTool,
    get_tabmemo_tools,
)


ALL_TOOL_NAMES = {
    "tabmemo_create_memo",
    "tabmemo_search_memos",
    "tabmemo_get_memo",
    "tabmemo_update_memo",
    "tabmemo_archive_memo",
    "tabmemo_restore_memo",
    "tabmemo_list_collections",
    "tabmemo_create_collection",
    "tabmemo_update_collection",
    "tabmemo_delete_collection",
    "tabmemo_add_to_collection",
    "tabmemo_remove_from_collection",
    "tabmemo_batch_operate",
    "tabmemo_list_attachments",
    "tabmemo_list_grants",
    "tabmemo_manage_grant",
}

WRITE_TOOLS = (
    TabmemoCreateMemoTool,
    TabmemoUpdateMemoTool,
    TabmemoArchiveMemoTool,
    TabmemoRestoreMemoTool,
    TabmemoCreateCollectionTool,
    TabmemoUpdateCollectionTool,
    TabmemoDeleteCollectionTool,
    TabmemoAddToCollectionTool,
    TabmemoRemoveFromCollectionTool,
    TabmemoBatchOperateTool,
    TabmemoManageGrantTool,
)

READ_TOOLS = (
    TabmemoSearchMemosTool,
    TabmemoGetMemoTool,
    TabmemoListCollectionsTool,
    TabmemoListAttachmentsTool,
    TabmemoListGrantsTool,
)


class TabmemoToolMetadataTests(SimpleTestCase):
    """验证 Agent 工具的元数据配置正确"""

    def test_write_tools_should_have_review_risk_level(self):
        for cls in WRITE_TOOLS:
            tool = cls()
            self.assertEqual(tool.risk_level, "review", f"{tool.name}")

    def test_read_tools_should_have_safe_risk_level(self):
        for cls in READ_TOOLS:
            tool = cls()
            self.assertEqual(tool.risk_level, "safe", f"{tool.name}")

    def test_all_tools_should_have_tabmemo_app_id(self):
        for tool in get_tabmemo_tools():
            self.assertEqual(tool.app_id, "tabmemo", f"{tool.name} missing app_id")

    def test_all_tools_should_have_required_permissions(self):
        for tool in get_tabmemo_tools():
            self.assertIn("tabmemo", tool.required_permissions, f"{tool.name} missing permission")

    def test_get_tabmemo_tools_should_return_all_tools(self):
        tools = get_tabmemo_tools()
        self.assertEqual(len(tools), 16)
        names = {t.name for t in tools}
        self.assertEqual(names, ALL_TOOL_NAMES)


class TabmemoToolNoUserTests(SimpleTestCase):
    """user_id=None 时应返回 {success: False}"""

    def test_create_memo_no_user(self):
        result = TabmemoCreateMemoTool().run(content="test", user_id=None)
        self.assertIsInstance(result, dict)
        self.assertFalse(result["success"])

    def test_update_memo_no_user(self):
        result = TabmemoUpdateMemoTool().run(memo_id="fake", user_id=None)
        self.assertFalse(result["success"])

    def test_archive_memo_no_user(self):
        result = TabmemoArchiveMemoTool().run(memo_id="fake", user_id=None)
        self.assertFalse(result["success"])

    def test_restore_memo_no_user(self):
        result = TabmemoRestoreMemoTool().run(memo_id="fake", user_id=None)
        self.assertFalse(result["success"])

    def test_search_memos_no_user(self):
        result = TabmemoSearchMemosTool().run(user_id=None)
        self.assertFalse(result["success"])

    def test_get_memo_no_user(self):
        result = TabmemoGetMemoTool().run(memo_id="fake", user_id=None)
        self.assertFalse(result["success"])

    def test_list_collections_no_user(self):
        result = TabmemoListCollectionsTool().run(user_id=None)
        self.assertFalse(result["success"])

    def test_add_to_collection_no_user(self):
        result = TabmemoAddToCollectionTool().run(collection_id="fake", memo_ids=["a"], user_id=None)
        self.assertFalse(result["success"])

    def test_remove_from_collection_no_user(self):
        result = TabmemoRemoveFromCollectionTool().run(collection_id="fake", memo_id="m", user_id=None)
        self.assertFalse(result["success"])

    def test_create_collection_no_user(self):
        result = TabmemoCreateCollectionTool().run(title="test", user_id=None)
        self.assertFalse(result["success"])

    def test_update_collection_no_user(self):
        result = TabmemoUpdateCollectionTool().run(collection_id="fake", user_id=None)
        self.assertFalse(result["success"])

    def test_delete_collection_no_user(self):
        result = TabmemoDeleteCollectionTool().run(collection_id="fake", user_id=None)
        self.assertFalse(result["success"])

    def test_batch_operate_no_user(self):
        result = TabmemoBatchOperateTool().run(memo_ids=["fake"], action="archive", user_id=None)
        self.assertFalse(result["success"])

    def test_list_attachments_no_user(self):
        result = TabmemoListAttachmentsTool().run(memo_id="fake", user_id=None)
        self.assertFalse(result["success"])


class TabmemoToolMissingContextTests(SimpleTestCase):
    """有 user 但缺少必要 context 时应返回错误"""

    @patch("apps.services.tools.domains.tabmemo.memo_tools._load_user")
    def test_create_memo_missing_organization(self, mock_load_user):
        mock_load_user.return_value = MagicMock()
        result = TabmemoCreateMemoTool().run(content="test", user_id="u")
        self.assertFalse(result["success"])

    @patch("apps.services.tools.domains.tabmemo.memo_tools._load_user")
    def test_search_memos_missing_organization(self, mock_load_user):
        mock_load_user.return_value = MagicMock()
        result = TabmemoSearchMemosTool().run(user_id="u")
        self.assertFalse(result["success"])

    @patch("apps.services.tools.domains.tabmemo.memo_tools._load_user")
    def test_list_collections_missing_organization(self, mock_load_user):
        mock_load_user.return_value = MagicMock()
        result = TabmemoListCollectionsTool().run(user_id="u")
        self.assertFalse(result["success"])

    @patch("apps.services.tools.domains.tabmemo.memo_tools._load_user")
    def test_add_to_collection_empty_memo_ids(self, mock_load_user):
        mock_load_user.return_value = MagicMock()
        result = TabmemoAddToCollectionTool().run(collection_id="c", memo_ids=[], user_id="u")
        self.assertFalse(result["success"])

    @patch("apps.services.tools.domains.tabmemo.memo_tools._load_user")
    def test_create_collection_missing_organization(self, mock_load_user):
        mock_load_user.return_value = MagicMock()
        result = TabmemoCreateCollectionTool().run(title="test", user_id="u")
        self.assertFalse(result["success"])

    @patch("apps.services.tools.domains.tabmemo.memo_tools._load_user")
    def test_batch_operate_missing_organization(self, mock_load_user):
        mock_load_user.return_value = MagicMock()
        result = TabmemoBatchOperateTool().run(memo_ids=["fake"], action="archive", user_id="u")
        self.assertFalse(result["success"])

    @patch("apps.services.tools.domains.tabmemo.memo_tools._load_user")
    def test_batch_operate_empty_memo_ids(self, mock_load_user):
        mock_load_user.return_value = MagicMock()
        result = TabmemoBatchOperateTool().run(
            memo_ids=[], action="archive", user_id="u",
            organization_id="w", space_id="a",
        )
        self.assertFalse(result["success"])
