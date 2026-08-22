"""
auto_tag_memo Celery 任务单元测试

tasks.py 中 Memo 和 get_llm_service 均为函数内局部 import，
patch 目标为原始模块路径。
"""

import json
from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.test import SimpleTestCase

from apps.tabmemo.constants import TABMEMO_DB

_MEMO_PATCH = "apps.tabmemo.models.Memo"
_LLM_PATCH = "apps.services.llm.services.factory.get_llm_service"


def _make_memo(**kwargs):
    memo = MagicMock()
    memo.id = kwargs.get("id", uuid4())
    memo.content_plaintext = kwargs.get("content_plaintext", "这是一段足够长的测试内容，用于触发 AI 打标功能。")
    memo.content_markdown = kwargs.get("content_markdown", "")
    memo.ai_tags = kwargs.get("ai_tags", [])
    memo.save = MagicMock()
    return memo


class AutoTagMemoTests(SimpleTestCase):

    @patch(_MEMO_PATCH)
    def test_memo_not_found_skips(self, MockMemo):
        MockMemo.DoesNotExist = Exception
        MockMemo.objects.using.return_value.get.side_effect = MockMemo.DoesNotExist

        from apps.tabmemo.tasks import auto_tag_memo

        result = auto_tag_memo(str(uuid4()))
        self.assertTrue(result.get("skipped"))
        self.assertEqual(result["reason"], "not_found")

    @patch(_MEMO_PATCH)
    def test_content_too_short_skips(self, MockMemo):
        memo = _make_memo(content_plaintext="短")
        MockMemo.objects.using.return_value.get.return_value = memo

        from apps.tabmemo.tasks import auto_tag_memo

        result = auto_tag_memo(str(memo.id))
        self.assertTrue(result.get("skipped"))
        self.assertEqual(result["reason"], "too_short")

    @patch(_LLM_PATCH, side_effect=RuntimeError("qwen not configured"))
    @patch(_MEMO_PATCH)
    def test_provider_unavailable_skips_no_retry(self, MockMemo, _):
        memo = _make_memo()
        MockMemo.objects.using.return_value.get.return_value = memo

        from apps.tabmemo.tasks import auto_tag_memo

        result = auto_tag_memo(str(memo.id))
        self.assertTrue(result.get("skipped"))
        self.assertEqual(result["reason"], "provider_unavailable")
        memo.save.assert_not_called()

    @patch(_LLM_PATCH)
    @patch(_MEMO_PATCH)
    def test_llm_call_failure_retries(self, MockMemo, mock_get_svc):
        memo = _make_memo()
        MockMemo.objects.using.return_value.get.return_value = memo
        mock_svc = MagicMock()
        mock_svc.chat.return_value = {"success": False, "error": "timeout"}
        mock_get_svc.return_value = mock_svc

        from apps.tabmemo.tasks import auto_tag_memo

        with patch.object(auto_tag_memo, "retry", side_effect=RuntimeError("retry")) as mock_retry:
            with self.assertRaises(RuntimeError):
                auto_tag_memo(str(memo.id))
            mock_retry.assert_called_once()

    @patch(_LLM_PATCH)
    @patch(_MEMO_PATCH)
    def test_json_parse_error_no_retry(self, MockMemo, mock_get_svc):
        memo = _make_memo()
        MockMemo.objects.using.return_value.get.return_value = memo
        mock_svc = MagicMock()
        mock_svc.chat.return_value = {"success": True, "content": "not valid json"}
        mock_get_svc.return_value = mock_svc

        from apps.tabmemo.tasks import auto_tag_memo

        result = auto_tag_memo(str(memo.id))
        self.assertFalse(result.get("success", True))
        self.assertEqual(result["error"], "json_parse_error")
        memo.save.assert_not_called()

    @patch(_LLM_PATCH)
    @patch(_MEMO_PATCH)
    def test_success_writes_ai_tags(self, MockMemo, mock_get_svc):
        memo = _make_memo()
        MockMemo.objects.using.return_value.get.return_value = memo
        mock_svc = MagicMock()
        mock_svc.chat.return_value = {
            "success": True,
            "content": json.dumps(["标签一", "标签二"]),
        }
        mock_get_svc.return_value = mock_svc

        from apps.tabmemo.tasks import auto_tag_memo

        result = auto_tag_memo(str(memo.id))
        self.assertTrue(result["success"])
        self.assertEqual(result["ai_tags"], ["标签一", "标签二"])
        self.assertEqual(memo.ai_tags, ["标签一", "标签二"])
        memo.save.assert_called_once_with(
            using=TABMEMO_DB, update_fields=["ai_tags", "updated_at"]
        )

    @patch(_LLM_PATCH)
    @patch(_MEMO_PATCH)
    def test_strips_markdown_code_fence(self, MockMemo, mock_get_svc):
        memo = _make_memo()
        MockMemo.objects.using.return_value.get.return_value = memo
        mock_svc = MagicMock()
        mock_svc.chat.return_value = {
            "success": True,
            "content": '```json\n["代码块", "标签"]\n```',
        }
        mock_get_svc.return_value = mock_svc

        from apps.tabmemo.tasks import auto_tag_memo

        result = auto_tag_memo(str(memo.id))
        self.assertTrue(result["success"])
        self.assertEqual(result["ai_tags"], ["代码块", "标签"])

    @patch(_LLM_PATCH)
    @patch(_MEMO_PATCH)
    def test_empty_tags_returns_success_no_save(self, MockMemo, mock_get_svc):
        memo = _make_memo()
        MockMemo.objects.using.return_value.get.return_value = memo
        mock_svc = MagicMock()
        mock_svc.chat.return_value = {"success": True, "content": "[]"}
        mock_get_svc.return_value = mock_svc

        from apps.tabmemo.tasks import auto_tag_memo

        result = auto_tag_memo(str(memo.id))
        self.assertTrue(result["success"])
        self.assertEqual(result["ai_tags"], [])
        memo.save.assert_not_called()

    @patch(_LLM_PATCH)
    @patch(_MEMO_PATCH)
    def test_filters_long_tags(self, MockMemo, mock_get_svc):
        memo = _make_memo()
        MockMemo.objects.using.return_value.get.return_value = memo
        long_tag = "这个标签的长度超过了二十个字符的限制所以应该被过滤掉"
        mock_svc = MagicMock()
        mock_svc.chat.return_value = {
            "success": True,
            "content": json.dumps(["有效标签", long_tag]),
        }
        mock_get_svc.return_value = mock_svc

        from apps.tabmemo.tasks import auto_tag_memo

        result = auto_tag_memo(str(memo.id))
        self.assertTrue(result["success"])
        self.assertEqual(result["ai_tags"], ["有效标签"])
        self.assertNotIn(long_tag, result["ai_tags"])


# /#2678：auto_tag 合并去重而非整包覆盖，保留 capture 写的 emotion:* 标签。
# 独立测试类——用正确的 unified_llm_call mock 路径 + 完整 fixture（content ≥30 字、
# 带 organization_id/created_by_id），走到真正的写标签分支（旧 AutoTagMemoTests 的
# get_llm_service mock 路径与实现不符、fixture 也过短，是预存失效问题，另行跟踪）。
_UNIFIED_LLM_PATCH = "apps.services.llm.services.chat.unified_llm_call"
_REFRESH_SV_PATCH = "apps.tabmemo.search.refresh_search_vector"


def _make_full_memo(ai_tags=None):
    memo = MagicMock()
    memo.id = uuid4()
    memo.content_plaintext = "这是一段足够长的碎片笔记内容，用于触发 AI 自动打标签的完整链路验证。"
    memo.content_markdown = ""
    memo.ai_tags = list(ai_tags or [])
    memo.created_by_id = uuid4()
    memo.organization_id = uuid4()
    memo.save = MagicMock()
    return memo


class AutoTagMergeTests(SimpleTestCase):
    """#2674/#2678：新标签与已有 ai_tags 合并去重保序，不冲掉 emotion:*。"""

    @patch(_REFRESH_SV_PATCH)
    @patch(_UNIFIED_LLM_PATCH)
    @patch(_MEMO_PATCH)
    def test_merges_with_existing_emotion_tags(self, MockMemo, mock_unified, _mock_sv):
        from django.core.cache import cache
        cache.clear()
        memo = _make_full_memo(ai_tags=["emotion:happy"])
        MockMemo.objects.using.return_value.get.return_value = memo
        mock_unified.return_value = MagicMock(content=json.dumps(["工作", "学习"]))

        from apps.tabmemo.tasks import auto_tag_memo

        result = auto_tag_memo(str(memo.id))
        self.assertTrue(result["success"])
        # capture 写的 emotion:happy 保留在前，LLM 新标签追加在后
        self.assertEqual(memo.ai_tags, ["emotion:happy", "工作", "学习"])

    @patch(_REFRESH_SV_PATCH)
    @patch(_UNIFIED_LLM_PATCH)
    @patch(_MEMO_PATCH)
    def test_dedupes_preserving_order(self, MockMemo, mock_unified, _mock_sv):
        from django.core.cache import cache
        cache.clear()
        memo = _make_full_memo(ai_tags=["emotion:curious", "工作"])
        MockMemo.objects.using.return_value.get.return_value = memo
        mock_unified.return_value = MagicMock(content=json.dumps(["工作", "生活"]))

        from apps.tabmemo.tasks import auto_tag_memo

        result = auto_tag_memo(str(memo.id))
        self.assertTrue(result["success"])
        # 重复的「工作」不堆积，去重保序
        self.assertEqual(memo.ai_tags, ["emotion:curious", "工作", "生活"])

    @patch(_REFRESH_SV_PATCH)
    @patch(_UNIFIED_LLM_PATCH)
    @patch(_MEMO_PATCH)
    def test_empty_existing_behaves_like_before(self, MockMemo, mock_unified, _mock_sv):
        from django.core.cache import cache
        cache.clear()
        memo = _make_full_memo(ai_tags=[])
        MockMemo.objects.using.return_value.get.return_value = memo
        mock_unified.return_value = MagicMock(content=json.dumps(["标签一", "标签二"]))

        from apps.tabmemo.tasks import auto_tag_memo

        result = auto_tag_memo(str(memo.id))
        self.assertTrue(result["success"])
        # 空 existing 时与旧的整包覆盖行为一致
        self.assertEqual(memo.ai_tags, ["标签一", "标签二"])
