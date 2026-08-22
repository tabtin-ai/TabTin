"""
MemoService 单元测试

覆盖 CRUD、附件、集合三大业务领域。
使用 SimpleTestCase + mock，不依赖数据库连接。
"""

from unittest.mock import MagicMock, PropertyMock, patch, call
from uuid import uuid4

from django.test import SimpleTestCase

from apps.tabmemo.constants import (
    DEFAULT_SORT,
    MAX_ATTACHMENT_COUNT,
    MAX_PAGE_SIZE,
)
from apps.tabmemo.error_codes import ErrorCode


def _make_service(user=None):
    """构造 MemoService 实例并 mock 掉权限检查"""
    from apps.tabmemo.services.memo_service import MemoService

    svc = MemoService(user=user or MagicMock(id=uuid4()))
    svc.check_space_permission = MagicMock(return_value=True)
    svc.check_organization_permission = MagicMock(return_value=True)
    return svc


def _make_memo(**overrides):
    memo = MagicMock()
    memo.id = overrides.get("id", uuid4())
    memo.space_id = overrides.get("space_id", uuid4())
    memo.organization_id = overrides.get("organization_id", uuid4())
    memo.status = overrides.get("status", "active")
    memo.content_json = overrides.get("content_json", {})
    memo.content_plaintext = overrides.get("content_plaintext", "hello")
    memo.content_markdown = overrides.get("content_markdown", "")
    memo.tags = overrides.get("tags", [])
    memo.ai_tags = overrides.get("ai_tags", [])
    memo.color = overrides.get("color", "")
    memo.is_pinned = overrides.get("is_pinned", False)
    memo.bookmark_url = overrides.get("bookmark_url", "")
    memo.bookmark_title = overrides.get("bookmark_title", "")
    memo.bookmark_description = overrides.get("bookmark_description", "")
    memo.bookmark_image = overrides.get("bookmark_image", "")
    memo.source = overrides.get("source", "manual")
    memo.pk = memo.id
    memo.save = MagicMock()
    return memo


# ── Create ──


class CreateMemoTests(SimpleTestCase):
    databases = "__all__"

    @patch("apps.tabmemo.services.memo_service.MemoService._notify_bridge")
    @patch("apps.tabmemo.services.memo_service.MemoService._update_search_vector")
    @patch("apps.tabmemo.services.memo_service.Memo")
    @patch("apps.tabmemo.services.memo_service.transaction")
    def test_create_memo_with_markdown(self, mock_tx, MockMemo, mock_sv, mock_nb):
        mock_tx.atomic = MagicMock(return_value=MagicMock(__enter__=MagicMock(), __exit__=MagicMock()))
        mock_tx.on_commit = MagicMock()
        memo = _make_memo()
        mock_manager = MockMemo.objects.using.return_value
        mock_manager.create.return_value = memo

        svc = _make_service()
        result = svc.create_memo(
            organization_id="ws1",
            space_id="as1",
            content_markdown="# Hello",
        )

        self.assertEqual(result, memo)
        mock_manager.create.assert_called_once()
        create_kwargs = mock_manager.create.call_args[1]
        self.assertEqual(create_kwargs["content_markdown"], "# Hello")
        self.assertEqual(create_kwargs["content_plaintext"], "# Hello")
        mock_sv.assert_called_once_with(memo)

    @patch("apps.tabmemo.services.memo_service.MemoService._notify_bridge")
    @patch("apps.tabmemo.services.memo_service.MemoService._update_search_vector")
    @patch("apps.tabmemo.services.memo_service.Memo")
    @patch("apps.tabmemo.services.memo_service.transaction")
    def test_create_diary_persists_agent_id(self, mock_tx, MockMemo, mock_sv, mock_nb):
        mock_tx.atomic = MagicMock(return_value=MagicMock(__enter__=MagicMock(), __exit__=MagicMock()))
        mock_tx.on_commit = MagicMock()
        memo = _make_memo()
        mock_manager = MockMemo.objects.using.return_value
        mock_manager.create.return_value = memo

        agent_id = str(uuid4())
        svc = _make_service()
        svc.create_memo(
            organization_id=str(uuid4()),
            agent_id=agent_id,
            memo_type="diary",
            content_markdown="今天完成了记忆链路整理。",
            source="agent",
        )

        create_kwargs = mock_manager.create.call_args[1]
        self.assertEqual(create_kwargs["memo_type"], "diary")
        self.assertEqual(create_kwargs["agent_id"], agent_id)

    @patch("apps.tabmemo.services.memo_service.transaction")
    def test_create_diary_requires_agent_id(self, mock_tx):
        svc = _make_service()

        from apps.tabtinspace.services.base import ServiceError
        with self.assertRaises(ServiceError) as ctx:
            svc.create_memo(
                organization_id=str(uuid4()),
                memo_type="diary",
                content_markdown="缺少 Agent",
            )
        self.assertEqual(ctx.exception.code, ErrorCode.INVALID_INPUT)

    @patch("apps.tabmemo.services.memo_service.MemoService._notify_bridge")
    @patch("apps.tabmemo.services.memo_service.MemoService._update_search_vector")
    @patch("apps.tabmemo.services.memo_service.Memo")
    @patch("apps.tabmemo.services.memo_service.transaction")
    def test_create_memo_extracts_plaintext_from_json(self, mock_tx, MockMemo, mock_sv, mock_nb):
        mock_tx.atomic = MagicMock(return_value=MagicMock(__enter__=MagicMock(), __exit__=MagicMock()))
        mock_tx.on_commit = MagicMock()
        memo = _make_memo()
        mock_manager = MockMemo.objects.using.return_value
        mock_manager.create.return_value = memo

        svc = _make_service()
        content_json = {
            "type": "doc",
            "content": [{"type": "text", "text": "extracted text"}],
        }
        svc.create_memo(
            organization_id="ws1",
            space_id="as1",
            content_json=content_json,
        )

        create_kwargs = mock_manager.create.call_args[1]
        self.assertEqual(create_kwargs["content_plaintext"], "extracted text")

    @patch("apps.tabmemo.services.memo_service.logger")
    @patch("apps.tabmemo.services.memo_service.ResourceBridge")
    @patch("apps.tabmemo.services.memo_service.transaction")
    def test_notify_bridge_error_does_not_poison_create_response(self, mock_tx, MockBridge, mock_logger):
        """ResourceBridge 是 post-commit 副作用，失败不能把已提交的创建响应变成 500。"""
        mock_tx.on_commit.side_effect = lambda callback, using=None: callback()
        MockBridge.on_create.side_effect = RuntimeError("bridge down")
        memo = _make_memo()
        svc = _make_service()

        svc._notify_bridge("created", memo)

        MockBridge.on_create.assert_called_once_with(memo, user=svc.user)
        mock_logger.error.assert_called_once()

    @patch("apps.tabmemo.services.memo_service.transaction")
    def test_create_memo_permission_denied(self, mock_tx):
        svc = _make_service()
        svc.check_organization_permission = MagicMock(return_value=False)

        from apps.tabtinspace.services.base import ServiceError
        with self.assertRaises(ServiceError) as ctx:
            svc.create_memo(organization_id="ws1", space_id="as1")
        self.assertEqual(ctx.exception.code, ErrorCode.PERMISSION_DENIED)


# ── Update ──


class UpdateMemoTests(SimpleTestCase):
    databases = "__all__"

    @patch("apps.tabmemo.services.memo_service.MemoService._notify_bridge")
    @patch("apps.tabmemo.services.memo_service.MemoService._update_search_vector")
    @patch("apps.tabmemo.services.memo_service.Memo")
    @patch("apps.tabmemo.services.memo_service.transaction")
    def test_update_tags(self, mock_tx, MockMemo, mock_sv, mock_nb):
        mock_tx.atomic = MagicMock(return_value=MagicMock(__enter__=MagicMock(), __exit__=MagicMock()))
        mock_tx.on_commit = MagicMock()
        memo = _make_memo()
        MockMemo.objects.get.return_value = memo

        svc = _make_service()
        svc._get_memo = MagicMock(return_value=memo)
        result = svc.update_memo(str(memo.id), tags=["new", "tags"])

        self.assertEqual(memo.tags, ["new", "tags"])
        memo.save.assert_called_once()
        save_kwargs = memo.save.call_args[1]
        self.assertIn("tags", save_kwargs["update_fields"])
        self.assertIn("updated_at", save_kwargs["update_fields"])

    @patch("apps.tabmemo.services.memo_service.MemoService._notify_bridge")
    @patch("apps.tabmemo.services.memo_service.MemoService._update_search_vector")
    @patch("apps.tabmemo.services.memo_service.transaction")
    def test_update_content_markdown_triggers_search_update(self, mock_tx, mock_sv, mock_nb):
        mock_tx.atomic = MagicMock(return_value=MagicMock(__enter__=MagicMock(), __exit__=MagicMock()))
        mock_tx.on_commit = MagicMock()
        memo = _make_memo(content_plaintext="old")

        svc = _make_service()
        svc._get_memo = MagicMock(return_value=memo)
        svc.update_memo(str(memo.id), content_markdown="new content")

        self.assertEqual(memo.content_markdown, "new content")
        mock_sv.assert_called_once_with(memo)

    @patch("apps.tabmemo.services.memo_service.MemoService._notify_bridge")
    @patch("apps.tabmemo.services.memo_service.MemoService._update_search_vector")
    @patch("apps.tabmemo.services.memo_service.transaction")
    def test_update_simple_field_no_search_update(self, mock_tx, mock_sv, mock_nb):
        mock_tx.atomic = MagicMock(return_value=MagicMock(__enter__=MagicMock(), __exit__=MagicMock()))
        mock_tx.on_commit = MagicMock()
        memo = _make_memo()

        svc = _make_service()
        svc._get_memo = MagicMock(return_value=memo)
        svc.update_memo(str(memo.id), color="blue")

        self.assertEqual(memo.color, "blue")
        mock_sv.assert_not_called()


# ── Archive ──


class ArchiveMemoTests(SimpleTestCase):
    databases = "__all__"

    @patch("apps.tabmemo.services.memo_service.MemoService._notify_bridge")
    @patch("apps.tabmemo.services.memo_service.transaction")
    def test_archive_memo(self, mock_tx, mock_nb):
        mock_tx.atomic = MagicMock(return_value=MagicMock(__enter__=MagicMock(), __exit__=MagicMock()))
        mock_tx.on_commit = MagicMock()
        memo = _make_memo()

        svc = _make_service()
        svc._get_memo = MagicMock(return_value=memo)
        svc.archive_memo(str(memo.id))

        self.assertEqual(memo.status, "archived")
        memo.save.assert_called_once()
        save_kwargs = memo.save.call_args[1]
        self.assertIn("status", save_kwargs["update_fields"])

    def test_archive_memo_not_found(self):
        from apps.tabtinspace.services.base import ServiceError

        svc = _make_service()
        svc._get_memo = MagicMock(
            side_effect=ServiceError(ErrorCode.MEMO_NOT_FOUND, "碎片不存在", status=404)
        )
        with self.assertRaises(ServiceError) as ctx:
            svc.archive_memo(str(uuid4()))
        self.assertEqual(ctx.exception.code, ErrorCode.MEMO_NOT_FOUND)

    def test_archive_memo_permission_denied(self):
        from apps.tabtinspace.services.base import ServiceError

        svc = _make_service()
        svc._get_memo = MagicMock(
            side_effect=ServiceError(ErrorCode.PERMISSION_DENIED, "权限不足", status=403)
        )
        with self.assertRaises(ServiceError) as ctx:
            svc.archive_memo(str(uuid4()))
        self.assertEqual(ctx.exception.code, ErrorCode.PERMISSION_DENIED)


# ── Restore ──


class RestoreMemoTests(SimpleTestCase):
    databases = "__all__"

    @patch("apps.tabmemo.services.memo_service.MemoService._notify_bridge")
    @patch("apps.tabmemo.services.memo_service.Memo")
    @patch("apps.tabmemo.services.memo_service.transaction")
    def test_restore_archived_memo(self, mock_tx, MockMemo, mock_nb):
        mock_tx.atomic = MagicMock(return_value=MagicMock(__enter__=MagicMock(), __exit__=MagicMock()))
        mock_tx.on_commit = MagicMock()
        memo = _make_memo(status="archived")
        MockMemo.objects.get.return_value = memo
        MockMemo.Status.ARCHIVED = "archived"
        MockMemo.Status.ACTIVE = "active"

        svc = _make_service()
        result = svc.restore_memo(str(memo.id))

        self.assertEqual(memo.status, "active")
        self.assertEqual(memo.updated_by, svc.user)
        memo.save.assert_called_once()
        save_kwargs = memo.save.call_args[1]
        self.assertIn("status", save_kwargs["update_fields"])
        self.assertIn("updated_by", save_kwargs["update_fields"])

    @patch("apps.tabmemo.services.memo_service.Memo")
    @patch("apps.tabmemo.services.memo_service.transaction")
    def test_restore_not_found(self, mock_tx, MockMemo):
        mock_tx.atomic = MagicMock(return_value=MagicMock(__enter__=MagicMock(), __exit__=MagicMock()))
        mock_tx.on_commit = MagicMock()

        class _DoesNotExist(Exception):
            pass

        MockMemo.DoesNotExist = _DoesNotExist
        MockMemo.Status.ARCHIVED = "archived"
        MockMemo.objects.get.side_effect = _DoesNotExist

        from apps.tabtinspace.services.base import ServiceError

        svc = _make_service()
        with self.assertRaises(ServiceError) as ctx:
            svc.restore_memo(str(uuid4()))
        self.assertEqual(ctx.exception.code, ErrorCode.MEMO_NOT_FOUND)

    @patch("apps.tabmemo.services.memo_service.Memo")
    @patch("apps.tabmemo.services.memo_service.transaction")
    def test_restore_permission_denied(self, mock_tx, MockMemo):
        mock_tx.atomic = MagicMock(return_value=MagicMock(__enter__=MagicMock(), __exit__=MagicMock()))
        mock_tx.on_commit = MagicMock()
        memo = _make_memo(status="archived")
        # 确保 memo.owner_id 和 user.id 不同，使 owner 检查失败
        memo.owner_id = uuid4()
        MockMemo.objects.get.return_value = memo
        MockMemo.Status.ARCHIVED = "archived"

        from apps.tabtinspace.services.base import ServiceError

        svc = _make_service()
        svc.check_organization_permission = MagicMock(return_value=False)
        svc.check_space_permission = MagicMock(return_value=False)
        with self.assertRaises(ServiceError) as ctx:
            svc.restore_memo(str(memo.id))
        self.assertEqual(ctx.exception.code, ErrorCode.PERMISSION_DENIED)


# ── Pin ──


class PinMemoTests(SimpleTestCase):
    databases = "__all__"

    @patch("apps.tabmemo.services.memo_service.MemoService._notify_bridge")
    @patch("apps.tabmemo.services.memo_service.transaction")
    def test_pin_memo(self, mock_tx, mock_nb):
        mock_tx.atomic = MagicMock(return_value=MagicMock(__enter__=MagicMock(), __exit__=MagicMock()))
        mock_tx.on_commit = MagicMock()
        memo = _make_memo(is_pinned=False)

        svc = _make_service()
        svc._get_memo = MagicMock(return_value=memo)
        result = svc.pin_memo(str(memo.id), True)

        self.assertTrue(memo.is_pinned)
        memo.save.assert_called_once()

    @patch("apps.tabmemo.services.memo_service.MemoService._notify_bridge")
    @patch("apps.tabmemo.services.memo_service.transaction")
    def test_unpin_memo(self, mock_tx, mock_nb):
        mock_tx.atomic = MagicMock(return_value=MagicMock(__enter__=MagicMock(), __exit__=MagicMock()))
        mock_tx.on_commit = MagicMock()
        memo = _make_memo(is_pinned=True)

        svc = _make_service()
        svc._get_memo = MagicMock(return_value=memo)
        svc.pin_memo(str(memo.id), False)

        self.assertFalse(memo.is_pinned)


# ── List ──


class ListMemosTests(SimpleTestCase):
    databases = "__all__"

    @patch("apps.tabmemo.services.memo_service.MemoCollectionMembership")
    @patch("apps.tabmemo.services.memo_service.Memo")
    def test_list_memos_clamps_limit(self, MockMemo, MockMembership):
        qs_mock = MagicMock()
        MockMemo.objects.filter.return_value = qs_mock
        qs_mock.filter.return_value = qs_mock
        qs_mock.order_by.return_value = qs_mock
        qs_mock.annotate.return_value = qs_mock
        qs_mock.__getitem__ = MagicMock(return_value=[])

        svc = _make_service()
        svc._get_granted_memo_ids = MagicMock(return_value=[])
        result = svc.list_memos("ws1", "as1", limit=999)

        qs_mock.__getitem__.assert_called_once()
        slice_arg = qs_mock.__getitem__.call_args[0][0]
        self.assertLessEqual(slice_arg.stop, MAX_PAGE_SIZE + 1)

    @patch("apps.tabmemo.services.memo_service.MemoCollectionMembership")
    @patch("apps.tabmemo.services.memo_service.Memo")
    def test_list_memos_invalid_sort_falls_back(self, MockMemo, MockMembership):
        qs_mock = MagicMock()
        MockMemo.objects.filter.return_value = qs_mock
        qs_mock.filter.return_value = qs_mock
        qs_mock.order_by.return_value = qs_mock
        qs_mock.annotate.return_value = qs_mock
        qs_mock.__getitem__ = MagicMock(return_value=[])

        svc = _make_service()
        svc._get_granted_memo_ids = MagicMock(return_value=[])
        svc.list_memos("ws1", "as1", sort="invalid_field")

        qs_mock.order_by.assert_called_once_with("-is_pinned", DEFAULT_SORT, "-id")

    @patch("apps.tabmemo.services.memo_service.Memo")
    def test_list_memos_permission_denied(self, MockMemo):
        from apps.tabtinspace.services.base import ServiceError

        svc = _make_service()
        svc.check_organization_permission = MagicMock(return_value=False)

        with self.assertRaises(ServiceError) as ctx:
            svc.list_memos("ws1", "as1")
        self.assertEqual(ctx.exception.code, ErrorCode.PERMISSION_DENIED)

    @patch("apps.tabmemo.services.memo_service.Memo")
    def test_list_memos_invalid_cursor_raises(self, MockMemo):
        from apps.tabtinspace.services.base import ServiceError

        qs_mock = MagicMock()
        MockMemo.objects.filter.return_value = qs_mock
        qs_mock.filter.return_value = qs_mock
        qs_mock.order_by.return_value = qs_mock
        qs_mock.annotate.return_value = qs_mock

        svc = _make_service()
        svc._get_granted_memo_ids = MagicMock(return_value=[])
        with self.assertRaises(ServiceError) as ctx:
            svc.list_memos("ws1", "as1", cursor="not-a-uuid")
        self.assertEqual(ctx.exception.code, ErrorCode.INVALID_CURSOR)

    # ── W13c D7.1：source 过滤参数 ──
    #
    # 注意 mock 路径：服务层走 ``Memo.objects.using(TABMEMO_DB).filter(...)``，
    # 因此须把 ``MockMemo.objects.using.return_value.filter.return_value``
    # 替换为同一个 ``qs_mock``，所有后续链式调用才能落到我们能 assert 的 mock 上。
    # 这里硬编码 ``Memo.Source.AGENT`` 的真实字符串值 ``"agent"``：因为
    # ``MockMemo`` patch 掉了 ``Memo``，``Memo.Source.AGENT`` 在被测代码内部访问到
    # 的是真值（被测代码 import 自 ``apps.tabmemo.models`` 而非走 patch 入口），
    # 所以测试侧用真值 ``"agent"`` assert 才能对得上。

    def _make_list_qs_mock(self, MockMemo):
        """共享 mock 链：使 using/filter/exclude/order_by/annotate 都可断言。"""
        qs_mock = MagicMock()
        MockMemo.objects.using.return_value = qs_mock
        qs_mock.filter.return_value = qs_mock
        qs_mock.exclude.return_value = qs_mock
        qs_mock.order_by.return_value = qs_mock
        qs_mock.annotate.return_value = qs_mock
        qs_mock.__getitem__ = MagicMock(return_value=[])
        return qs_mock

    @patch("apps.tabmemo.services.memo_service.MemoCollectionMembership")
    @patch("apps.tabmemo.services.memo_service.Memo")
    def test_list_memos_source_agent_filters_to_agent_only(self, MockMemo, _MockMembership):
        """source='agent' 必须把 source='agent' 加入 filter 条件，
        让本地 Runtime 的 memory_search 只看到 Agent 写的 memo（D7.1 隐私隔离）。"""
        qs_mock = self._make_list_qs_mock(MockMemo)

        svc = _make_service()
        svc._get_granted_memo_ids = MagicMock(return_value=[])
        svc.list_memos("ws1", "as1", source="agent")

        filter_kwargs_seen = [c.kwargs for c in qs_mock.filter.call_args_list]
        self.assertIn({"source": "agent"}, filter_kwargs_seen)
        # exclude 不应被命中（agent 走 filter 路径，user 才走 exclude）
        for call_obj in qs_mock.exclude.call_args_list:
            self.assertNotIn("source", call_obj.kwargs)

    @patch("apps.tabmemo.services.memo_service.MemoCollectionMembership")
    @patch("apps.tabmemo.services.memo_service.Memo")
    def test_list_memos_source_user_excludes_agent(self, MockMemo, _MockMembership):
        """source='user' 排除 Agent memo——保证用户 TabMemo 浏览界面看不到 Agent 笔记。"""
        qs_mock = self._make_list_qs_mock(MockMemo)

        svc = _make_service()
        svc._get_granted_memo_ids = MagicMock(return_value=[])
        svc.list_memos("ws1", "as1", source="user")

        qs_mock.exclude.assert_any_call(source="agent")

    @patch("apps.tabmemo.services.memo_service.MemoCollectionMembership")
    @patch("apps.tabmemo.services.memo_service.Memo")
    def test_list_memos_source_unset_keeps_legacy_semantics(self, MockMemo, _MockMembership):
        """不传 source 时不应额外按 source 过滤，保持向后兼容（既有调用方不破坏）。"""
        qs_mock = self._make_list_qs_mock(MockMemo)

        svc = _make_service()
        svc._get_granted_memo_ids = MagicMock(return_value=[])
        svc.list_memos("ws1", "as1")

        for call_obj in qs_mock.filter.call_args_list:
            self.assertNotIn("source", call_obj.kwargs)
        for call_obj in qs_mock.exclude.call_args_list:
            self.assertNotIn("source", call_obj.kwargs)

    @patch("apps.tabmemo.services.memo_service.MemoCollectionMembership")
    @patch("apps.tabmemo.services.memo_service.Memo")
    def test_list_memos_source_specific_value(self, MockMemo, _MockMembership):
        """传 source='browser' 等具体来源时，按精确值过滤。"""
        qs_mock = self._make_list_qs_mock(MockMemo)

        svc = _make_service()
        svc._get_granted_memo_ids = MagicMock(return_value=[])
        svc.list_memos("ws1", "as1", source="browser")

        filter_kwargs_seen = [c.kwargs for c in qs_mock.filter.call_args_list]
        self.assertIn({"source": "browser"}, filter_kwargs_seen)


    @patch("apps.tabmemo.services.memo_service.MemoCollectionMembership")
    @patch("apps.tabmemo.services.memo_service.Memo")
    def test_list_memos_created_before_is_half_open(self, MockMemo, _MockMembership):
        """日期范围必须是半开区间 [after, before)：created_before 走 created_at__lt。"""
        qs_mock = self._make_list_qs_mock(MockMemo)

        svc = _make_service()
        svc._get_granted_memo_ids = MagicMock(return_value=[])
        svc.list_memos(
            "ws1",
            None,
            created_after="2026-07-31T00:00:00+08:00",
            created_before="2026-08-01T00:00:00+08:00",
        )

        filter_kwargs_seen = [c.kwargs for c in qs_mock.filter.call_args_list]
        self.assertIn({"created_at__gte": "2026-07-31T00:00:00+08:00"}, filter_kwargs_seen)
        self.assertIn({"created_at__lt": "2026-08-01T00:00:00+08:00"}, filter_kwargs_seen)
        for kwargs in filter_kwargs_seen:
            self.assertNotIn("created_at__lte", kwargs)



# ── Attachment ──


class AddAttachmentTests(SimpleTestCase):
    databases = "__all__"

    @patch("apps.tabmemo.services.memo_service.MemoService._notify_bridge")
    @patch("apps.tabmemo.services.memo_service.MemoAttachment")
    @patch("apps.tabmemo.services.memo_service.transaction")
    def test_add_attachment_success(self, mock_tx, MockAtt, mock_nb):
        mock_tx.atomic = MagicMock(return_value=MagicMock(__enter__=MagicMock(), __exit__=MagicMock()))
        mock_tx.on_commit = MagicMock()
        memo = _make_memo()
        att = MagicMock()
        MockAtt.objects.create.return_value = att
        MockAtt.objects.filter.return_value.count.return_value = 0

        file_record_id = str(uuid4())

        with patch("apps.tabmemo.services.memo_service.MemoService._get_memo", return_value=memo):
            with patch("apps.services.oss.models.FileRecord") as MockFR:
                fr = MagicMock()
                fr.status = "completed"
                fr.access_url = "https://oss.example.com/file.pdf"
                fr.file_name = "file.pdf"
                fr.file_size = 1024
                fr.mime_type = "application/pdf"
                MockFR.objects.using.return_value.get.return_value = fr

                svc = _make_service()
                svc._get_memo = MagicMock(return_value=memo)
                result = svc.add_attachment(str(memo.id), file_record_id)

        self.assertEqual(result, att)

    def test_add_attachment_invalid_uuid(self):
        from apps.tabtinspace.services.base import ServiceError

        svc = _make_service()
        with self.assertRaises(ServiceError):
            svc.add_attachment(str(uuid4()), "not-a-uuid")

    @patch("apps.tabmemo.services.memo_service.MemoAttachment")
    @patch("apps.tabmemo.services.memo_service.transaction")
    def test_add_attachment_limit_exceeded(self, mock_tx, MockAtt):
        mock_tx.atomic = MagicMock(return_value=MagicMock(__enter__=MagicMock(), __exit__=MagicMock()))
        mock_tx.on_commit = MagicMock()
        memo = _make_memo()
        MockAtt.objects.filter.return_value.count.return_value = MAX_ATTACHMENT_COUNT

        file_record_id = str(uuid4())

        with patch("apps.services.oss.models.FileRecord") as MockFR:
            fr = MagicMock()
            fr.status = "completed"
            fr.access_url = "https://oss.example.com/file.pdf"
            MockFR.objects.using.return_value.get.return_value = fr

            from apps.tabtinspace.services.base import ServiceError

            svc = _make_service()
            svc._get_memo = MagicMock(return_value=memo)
            with self.assertRaises(ServiceError) as ctx:
                svc.add_attachment(str(memo.id), file_record_id)
            self.assertEqual(ctx.exception.code, ErrorCode.ATTACHMENT_LIMIT_EXCEEDED)


class DeleteAttachmentTests(SimpleTestCase):
    databases = "__all__"

    @patch("apps.tabmemo.services.memo_service.MemoService._notify_bridge")
    @patch("apps.tabmemo.services.memo_service.MemoAttachment")
    @patch("apps.tabmemo.services.memo_service.transaction")
    def test_delete_attachment_success(self, mock_tx, MockAtt, mock_nb):
        mock_tx.atomic = MagicMock(return_value=MagicMock(__enter__=MagicMock(), __exit__=MagicMock()))
        mock_tx.on_commit = MagicMock()
        memo = _make_memo()
        att = MagicMock()
        MockAtt.objects.get.return_value = att

        svc = _make_service()
        svc._get_memo = MagicMock(return_value=memo)
        svc.delete_attachment(str(memo.id), str(uuid4()))

        att.delete.assert_called_once()

    @patch("apps.tabmemo.services.memo_service.MemoAttachment")
    @patch("apps.tabmemo.services.memo_service.transaction")
    def test_delete_attachment_not_found(self, mock_tx, MockAtt):
        mock_tx.atomic = MagicMock(return_value=MagicMock(__enter__=MagicMock(), __exit__=MagicMock()))
        mock_tx.on_commit = MagicMock()
        memo = _make_memo()

        class _DoesNotExist(Exception):
            pass

        MockAtt.DoesNotExist = _DoesNotExist
        MockAtt.objects.get.side_effect = _DoesNotExist

        from apps.tabtinspace.services.base import ServiceError

        svc = _make_service()
        svc._get_memo = MagicMock(return_value=memo)
        with self.assertRaises(ServiceError) as ctx:
            svc.delete_attachment(str(memo.id), str(uuid4()))
        self.assertEqual(ctx.exception.code, ErrorCode.RESOURCE_NOT_FOUND)


# ── Collection ──


class CollectionTests(SimpleTestCase):
    databases = "__all__"

    @patch("apps.tabmemo.services.memo_service.ResourceBridge")
    @patch("apps.tabmemo.services.memo_service.MemoCollection")
    @patch("apps.tabmemo.services.memo_service.transaction")
    def test_create_collection(self, mock_tx, MockColl, MockBridge):
        mock_tx.atomic = MagicMock(return_value=MagicMock(__enter__=MagicMock(), __exit__=MagicMock()))
        mock_tx.on_commit = MagicMock()
        coll = MagicMock()
        MockColl.objects.create.return_value = coll

        svc = _make_service()
        result = svc.create_collection("ws1", "as1", "My Collection", "desc")

        self.assertEqual(result, coll)
        MockColl.objects.create.assert_called_once()
        create_kwargs = MockColl.objects.create.call_args[1]
        self.assertEqual(create_kwargs["title"], "My Collection")
        self.assertEqual(create_kwargs["description"], "desc")

    @patch("apps.tabmemo.services.memo_service.transaction")
    def test_create_collection_permission_denied(self, mock_tx):
        from apps.tabtinspace.services.base import ServiceError

        svc = _make_service()
        svc.check_organization_permission = MagicMock(return_value=False)
        with self.assertRaises(ServiceError) as ctx:
            svc.create_collection("ws1", "as1", "Title")
        self.assertEqual(ctx.exception.code, ErrorCode.PERMISSION_DENIED)

    @patch("apps.tabmemo.services.memo_service.MemoCollectionMembership")
    @patch("apps.tabmemo.services.memo_service.Memo")
    @patch("apps.tabmemo.services.memo_service.transaction")
    def test_add_memos_to_collection_deduplicates(self, mock_tx, MockMemo, MockMembership):
        mock_tx.atomic = MagicMock(return_value=MagicMock(__enter__=MagicMock(), __exit__=MagicMock()))
        mock_tx.on_commit = MagicMock()
        coll = MagicMock()
        coll.space_id = uuid4()
        coll.is_smart = False
        memo_id = uuid4()

        MockMemo.objects.filter.return_value.values_list.return_value = {memo_id}
        MockMembership.objects.filter.return_value.values_list.return_value = {memo_id}

        svc = _make_service()
        svc._get_collection = MagicMock(return_value=coll)
        count = svc.add_memos_to_collection(str(coll.id), [str(memo_id)])

        self.assertEqual(count, 0)
        MockMembership.objects.bulk_create.assert_not_called()

    @patch("apps.tabmemo.services.memo_service.MemoCollectionMembership")
    @patch("apps.tabmemo.services.memo_service.transaction")
    def test_remove_memo_from_collection(self, mock_tx, MockMembership):
        mock_tx.atomic = MagicMock(return_value=MagicMock(__enter__=MagicMock(), __exit__=MagicMock()))
        mock_tx.on_commit = MagicMock()
        coll = MagicMock()
        coll.is_smart = False
        memo_id = str(uuid4())

        svc = _make_service()
        svc._get_collection = MagicMock(return_value=coll)
        svc.remove_memo_from_collection(str(coll.id), memo_id)

        MockMembership.objects.filter.assert_called_once_with(
            collection=coll, memo_id=memo_id
        )
        MockMembership.objects.filter.return_value.delete.assert_called_once()


# ── Internal Helpers ──


class ExtractPlaintextTests(SimpleTestCase):

    def test_empty_json(self):
        svc = _make_service()
        self.assertEqual(svc._extract_plaintext({}), "")

    def test_none_json(self):
        svc = _make_service()
        self.assertEqual(svc._extract_plaintext(None), "")

    def test_nested_text_nodes(self):
        svc = _make_service()
        doc = {
            "type": "doc",
            "content": [
                {"type": "paragraph", "content": [
                    {"type": "text", "text": "Hello"},
                    {"type": "text", "text": " World"},
                ]},
                {"type": "paragraph", "content": [
                    {"type": "text", "text": "Second line"},
                ]},
            ],
        }
        result = svc._extract_plaintext(doc)
        self.assertIn("Hello", result)
        self.assertIn("World", result)
        self.assertIn("Second line", result)


class InferFileTypeTests(SimpleTestCase):

    def test_image(self):
        from apps.tabmemo.services.memo_service import MemoService
        self.assertEqual(MemoService._infer_file_type("image/png"), "image")

    def test_video(self):
        from apps.tabmemo.services.memo_service import MemoService
        self.assertEqual(MemoService._infer_file_type("video/mp4"), "video")

    def test_audio(self):
        from apps.tabmemo.services.memo_service import MemoService
        self.assertEqual(MemoService._infer_file_type("audio/mpeg"), "audio")

    def test_fallback(self):
        from apps.tabmemo.services.memo_service import MemoService
        self.assertEqual(MemoService._infer_file_type("application/pdf"), "file")
        self.assertEqual(MemoService._infer_file_type(""), "file")


# ── Smart Filter Query Builder ──


class SmartFilterQTests(SimpleTestCase):
    """_build_smart_filter_q 的纯单元测试（只验证 Q 对象生成逻辑）"""

    def _build(self, smart_filter):
        from apps.tabmemo.services.memo_service import MemoService
        return MemoService._build_smart_filter_q(smart_filter)

    def test_empty_filter_returns_impossible_q(self):
        q = self._build({})
        self.assertIn("pk__isnull", str(q))

    def test_tags_overlap(self):
        q = self._build({"tags": ["python", "ai"]})
        self.assertIn("tags__overlap", str(q))

    def test_keywords_generates_icontains(self):
        q = self._build({"keywords": ["hello"]})
        self.assertIn("content_plaintext__icontains", str(q))

    def test_color_exact_match(self):
        q = self._build({"color": "blue"})
        self.assertIn("color", str(q))

    def test_source_in_list(self):
        q = self._build({"source": ["manual", "agent"]})
        self.assertIn("source__in", str(q))

    def test_match_mode_any_uses_or(self):
        q = self._build({
            "match_mode": "any",
            "tags": ["a"],
            "color": "yellow",
        })
        q_str = str(q)
        self.assertIn("tags__overlap", q_str)
        self.assertIn("color", q_str)

    def test_match_mode_all_uses_and(self):
        q = self._build({
            "match_mode": "all",
            "tags": ["a"],
            "color": "yellow",
        })
        q_str = str(q)
        self.assertIn("tags__overlap", q_str)
        self.assertIn("color", q_str)

    def test_ignores_empty_tags_list(self):
        q = self._build({"tags": []})
        self.assertIn("pk__isnull", str(q))

    def test_ignores_empty_string_color(self):
        q = self._build({"color": ""})
        self.assertIn("pk__isnull", str(q))


# ── Smart Collection Manual Operation Blocking ──


class SmartCollectionBlockingTests(SimpleTestCase):
    databases = "__all__"

    def _make_smart_collection(self):
        coll = MagicMock()
        coll.id = uuid4()
        coll.space_id = uuid4()
        coll.is_smart = True
        coll.smart_filter = {"tags": ["test"]}
        return coll

    @patch("apps.tabmemo.services.memo_service.transaction")
    def test_add_memos_to_smart_collection_raises(self, mock_tx):
        mock_tx.atomic = MagicMock(return_value=MagicMock(__enter__=MagicMock(), __exit__=MagicMock()))
        from apps.tabtinspace.services.base import ServiceError

        svc = _make_service()
        svc._get_collection = MagicMock(return_value=self._make_smart_collection())
        with self.assertRaises(ServiceError) as ctx:
            svc.add_memos_to_collection(str(uuid4()), [str(uuid4())])
        self.assertEqual(ctx.exception.code, ErrorCode.SMART_COLLECTION_NO_MANUAL)

    @patch("apps.tabmemo.services.memo_service.transaction")
    def test_remove_memo_from_smart_collection_raises(self, mock_tx):
        mock_tx.atomic = MagicMock(return_value=MagicMock(__enter__=MagicMock(), __exit__=MagicMock()))
        from apps.tabtinspace.services.base import ServiceError

        svc = _make_service()
        svc._get_collection = MagicMock(return_value=self._make_smart_collection())
        with self.assertRaises(ServiceError) as ctx:
            svc.remove_memo_from_collection(str(uuid4()), str(uuid4()))
        self.assertEqual(ctx.exception.code, ErrorCode.SMART_COLLECTION_NO_MANUAL)


# ── Collection Update / Delete ──


class UpdateCollectionTests(SimpleTestCase):
    databases = "__all__"

    @patch("apps.tabmemo.services.memo_service.ResourceBridge")
    @patch("apps.tabmemo.services.memo_service.transaction")
    def test_update_collection_title(self, mock_tx, MockBridge):
        mock_tx.atomic = MagicMock(return_value=MagicMock(__enter__=MagicMock(), __exit__=MagicMock()))
        mock_tx.on_commit = MagicMock()
        coll = MagicMock()
        coll.title = "Old"

        svc = _make_service()
        svc._get_collection = MagicMock(return_value=coll)
        result = svc.update_collection(str(uuid4()), title="New Title")

        self.assertEqual(coll.title, "New Title")
        coll.save.assert_called_once()
        save_kwargs = coll.save.call_args[1]
        self.assertIn("title", save_kwargs["update_fields"])
        self.assertIn("updated_at", save_kwargs["update_fields"])

    @patch("apps.tabmemo.services.memo_service.ResourceBridge")
    @patch("apps.tabmemo.services.memo_service.transaction")
    def test_update_collection_smart_filter(self, mock_tx, MockBridge):
        mock_tx.atomic = MagicMock(return_value=MagicMock(__enter__=MagicMock(), __exit__=MagicMock()))
        mock_tx.on_commit = MagicMock()
        coll = MagicMock()

        svc = _make_service()
        svc._get_collection = MagicMock(return_value=coll)
        new_filter = {"tags": ["python"], "match_mode": "all"}
        svc.update_collection(str(uuid4()), is_smart=True, smart_filter=new_filter)

        self.assertTrue(coll.is_smart)
        self.assertEqual(coll.smart_filter, new_filter)


class DeleteCollectionTests(SimpleTestCase):
    databases = "__all__"

    @patch("apps.tabmemo.services.memo_service.ResourceBridge")
    @patch("apps.tabmemo.services.memo_service.MemoCollectionMembership")
    @patch("apps.tabmemo.services.memo_service.transaction")
    def test_delete_normal_collection_removes_memberships(self, mock_tx, MockMembership, MockBridge):
        mock_tx.atomic = MagicMock(return_value=MagicMock(__enter__=MagicMock(), __exit__=MagicMock()))
        mock_tx.on_commit = MagicMock()
        coll = MagicMock()
        coll.is_smart = False

        svc = _make_service()
        svc._get_collection = MagicMock(return_value=coll)
        svc.delete_collection(str(uuid4()))

        MockMembership.objects.filter.assert_called_once_with(collection=coll)
        MockMembership.objects.filter.return_value.delete.assert_called_once()
        coll.delete.assert_called_once()

    @patch("apps.tabmemo.services.memo_service.ResourceBridge")
    @patch("apps.tabmemo.services.memo_service.MemoCollectionMembership")
    @patch("apps.tabmemo.services.memo_service.transaction")
    def test_delete_smart_collection_skips_memberships(self, mock_tx, MockMembership, MockBridge):
        mock_tx.atomic = MagicMock(return_value=MagicMock(__enter__=MagicMock(), __exit__=MagicMock()))
        mock_tx.on_commit = MagicMock()
        coll = MagicMock()
        coll.is_smart = True

        svc = _make_service()
        svc._get_collection = MagicMock(return_value=coll)
        svc.delete_collection(str(uuid4()))

        MockMembership.objects.filter.assert_not_called()
        coll.delete.assert_called_once()


# ── Batch Operations ──


class BatchOperateMemosTests(SimpleTestCase):
    databases = "__all__"

    @patch("apps.tabmemo.services.memo_service.MemoService._notify_bridge")
    @patch("apps.tabmemo.services.memo_service.Memo")
    @patch("apps.tabmemo.services.memo_service.transaction")
    def test_batch_archive(self, mock_tx, MockMemo, mock_nb):
        mock_tx.atomic = MagicMock(return_value=MagicMock(__enter__=MagicMock(), __exit__=MagicMock()))
        mock_tx.on_commit = MagicMock()
        m1 = _make_memo()
        m2 = _make_memo()
        MockMemo.objects.filter.return_value = [m1, m2]
        MockMemo.Status.ACTIVE = "active"
        MockMemo.Status.ARCHIVED = "archived"

        svc = _make_service()
        result = svc.batch_operate_memos("ws", None, [str(m1.id), str(m2.id)], "archive")

        self.assertEqual(result["action"], "archive")
        self.assertEqual(result["affected"], 2)
        self.assertEqual(m1.status, "archived")
        self.assertEqual(m2.status, "archived")
        self.assertEqual(mock_nb.call_count, 2)

    @patch("apps.tabmemo.services.memo_service.MemoService._notify_bridge")
    @patch("apps.tabmemo.services.memo_service.MemoService._update_search_vector")
    @patch("apps.tabmemo.services.memo_service.Memo")
    @patch("apps.tabmemo.services.memo_service.transaction")
    def test_batch_tag_merges(self, mock_tx, MockMemo, mock_sv, mock_nb):
        mock_tx.atomic = MagicMock(return_value=MagicMock(__enter__=MagicMock(), __exit__=MagicMock()))
        mock_tx.on_commit = MagicMock()
        m1 = _make_memo(tags=["existing"])
        MockMemo.objects.filter.return_value = [m1]
        MockMemo.Status.ACTIVE = "active"

        svc = _make_service()
        result = svc.batch_operate_memos("ws", None, [str(m1.id)], "tag", tags=["new"])

        self.assertEqual(result["action"], "tag")
        self.assertEqual(result["affected"], 1)
        self.assertIn("new", m1.tags)
        self.assertIn("existing", m1.tags)

    @patch("apps.tabmemo.services.memo_service.MemoService._notify_bridge")
    @patch("apps.tabmemo.services.memo_service.MemoService._update_search_vector")
    @patch("apps.tabmemo.services.memo_service.Memo")
    @patch("apps.tabmemo.services.memo_service.transaction")
    def test_batch_tag_skips_existing(self, mock_tx, MockMemo, mock_sv, mock_nb):
        mock_tx.atomic = MagicMock(return_value=MagicMock(__enter__=MagicMock(), __exit__=MagicMock()))
        mock_tx.on_commit = MagicMock()
        m1 = _make_memo(tags=["already"])
        MockMemo.objects.filter.return_value = [m1]
        MockMemo.Status.ACTIVE = "active"

        svc = _make_service()
        result = svc.batch_operate_memos("ws", None, [str(m1.id)], "tag", tags=["already"])

        self.assertEqual(result["affected"], 0)
        mock_nb.assert_not_called()
        mock_sv.assert_not_called()

    @patch("apps.tabmemo.services.memo_service.Memo")
    @patch("apps.tabmemo.services.memo_service.transaction")
    def test_batch_tag_requires_tags(self, mock_tx, MockMemo):
        mock_tx.atomic = MagicMock(return_value=MagicMock(__enter__=MagicMock(), __exit__=MagicMock()))
        MockMemo.objects.filter.return_value = [_make_memo()]
        MockMemo.Status.ACTIVE = "active"
        from apps.tabtinspace.services.base import ServiceError

        svc = _make_service()
        with self.assertRaises(ServiceError) as ctx:
            svc.batch_operate_memos("ws", None, [str(uuid4())], "tag")
        self.assertEqual(ctx.exception.code, ErrorCode.INVALID_INPUT)

    @patch("apps.tabmemo.services.memo_service.Memo")
    @patch("apps.tabmemo.services.memo_service.transaction")
    def test_batch_invalid_action(self, mock_tx, MockMemo):
        mock_tx.atomic = MagicMock(return_value=MagicMock(__enter__=MagicMock(), __exit__=MagicMock()))
        MockMemo.objects.filter.return_value = []
        MockMemo.Status.ACTIVE = "active"
        from apps.tabtinspace.services.base import ServiceError

        svc = _make_service()
        with self.assertRaises(ServiceError) as ctx:
            svc.batch_operate_memos("ws", None, [str(uuid4())], "bad_action")
        self.assertEqual(ctx.exception.code, ErrorCode.INVALID_INPUT)

    @patch("apps.tabmemo.services.memo_service.MemoCollectionMembership")
    @patch("apps.tabmemo.services.memo_service.Memo")
    @patch("apps.tabmemo.services.memo_service.transaction")
    def test_batch_move_to_smart_collection_raises(self, mock_tx, MockMemo, MockMembership):
        mock_tx.atomic = MagicMock(return_value=MagicMock(__enter__=MagicMock(), __exit__=MagicMock()))
        mock_tx.on_commit = MagicMock()
        MockMemo.objects.filter.return_value = [_make_memo()]
        MockMemo.Status.ACTIVE = "active"
        coll = MagicMock()
        coll.is_smart = True
        from apps.tabtinspace.services.base import ServiceError

        svc = _make_service()
        svc._get_collection = MagicMock(return_value=coll)
        coll_id = str(uuid4())
        with self.assertRaises(ServiceError) as ctx:
            svc.batch_operate_memos("ws", None, [str(uuid4())], "move_to_collection", collection_id=coll_id)
        self.assertEqual(ctx.exception.code, ErrorCode.SMART_COLLECTION_NO_MANUAL)
