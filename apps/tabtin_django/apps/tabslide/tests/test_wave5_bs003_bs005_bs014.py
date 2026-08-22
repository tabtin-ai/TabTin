"""
Wave 5 回归测试：BS-003 / BS-005 / BS-014

BS-003: 专用异常类替代中文字符串匹配 404/400 判断
BS-005: export_project 仅支持 pptx 格式
BS-014: 版本历史 TTL 根据会员等级分级
"""

from __future__ import annotations

import uuid
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase
from django.utils import timezone

from apps.tabslide.models import (
    HISTORY_TTL_FREE,
    HISTORY_TTL_PRO,
    HISTORY_TTL_TEAM,
    SlidePage,
    SlideProject,
)
from apps.tabslide.services.slide_service import (
    ConflictError,
    ElementNotFoundError,
    HistoryNotFoundError,
    PageNotFoundError,
    SlideNotFoundError,
    SlideService,
)
from apps.tabslide.tasks import _resolve_history_ttl
from apps.tabtinspace.models import Space, Organization

User = get_user_model()


# ═══════════════════════════════════════════════════════════════════
# BS-003: 专用异常类继承关系 + Service 层抛出正确异常
# ═══════════════════════════════════════════════════════════════════


class BS003ExceptionHierarchyTests(TestCase):
    """BS-003: 异常类继承自 ValueError，确保向后兼容。"""

    def test_slide_not_found_is_value_error(self):
        self.assertTrue(issubclass(SlideNotFoundError, ValueError))

    def test_history_not_found_is_value_error(self):
        self.assertTrue(issubclass(HistoryNotFoundError, ValueError))

    def test_page_not_found_is_value_error(self):
        self.assertTrue(issubclass(PageNotFoundError, ValueError))

    def test_element_not_found_is_value_error(self):
        self.assertTrue(issubclass(ElementNotFoundError, ValueError))

    def test_exceptions_are_catchable_individually(self):
        """确保新异常类可以被单独 catch，不会落入通用 ValueError 分支。"""
        with self.assertRaises(SlideNotFoundError):
            raise SlideNotFoundError("project missing")

        with self.assertRaises(HistoryNotFoundError):
            raise HistoryNotFoundError("history missing")

        with self.assertRaises(PageNotFoundError):
            raise PageNotFoundError("page missing")

        with self.assertRaises(ElementNotFoundError):
            raise ElementNotFoundError("element missing")


class BS003ServiceRaisesCorrectExceptionTests(TestCase):
    """BS-003: Service 层方法在资源不存在时抛出专用异常。"""

    databases = {"default", "postgresql"}

    def setUp(self):
        self.user = User.objects.create_user(
            username="bs003_user", email="bs003@test.com", password="pass123",
        )
        self.organization = Organization.objects.create(name="ws-bs003", owner=self.user)
        self.space = Space.objects.create(
            organization=self.organization, name="sp-bs003", type=Space.SpaceType.TEAM,
        )
        self.project = SlideProject.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            name="BS003 演示",
            preset="ppt",
            page_count=1,
            latest_version=1,
            status="active",
            created_by=self.user,
        )
        SlidePage.objects.using("postgresql").create(
            project=self.project, page_id="page-1",
            elements_data=[{"id": "el-1", "type": "text", "content": "hello"}],
            order=0, version=1,
        )

    def _build_service(self) -> SlideService:
        svc = SlideService(user=self.user)
        svc.check_space_permission = MagicMock(return_value=True)
        return svc

    def test_get_project_detail_raises_slide_not_found(self):
        svc = self._build_service()
        fake_id = str(uuid.uuid4())
        with self.assertRaises(SlideNotFoundError):
            svc.get_project_detail(fake_id)

    def test_get_page_detail_raises_page_not_found(self):
        svc = self._build_service()
        with self.assertRaises(PageNotFoundError):
            svc.get_page_detail(str(self.project.id), "nonexistent-page")

    def test_restore_history_raises_history_not_found(self):
        svc = self._build_service()
        with self.assertRaises(HistoryNotFoundError):
            svc.restore_history(str(self.project.id), str(uuid.uuid4()))

    def test_update_element_by_page_id_raises_page_not_found(self):
        svc = self._build_service()
        with self.assertRaises(PageNotFoundError):
            svc.update_element_by_page_id(
                str(self.project.id),
                page_id="nonexistent-page",
                element_id="el-1",
                patch={"content": "new"},
                base_version=1,
            )

    def test_update_element_by_page_id_raises_element_not_found(self):
        svc = self._build_service()
        with self.assertRaises(ElementNotFoundError):
            svc.update_element_by_page_id(
                str(self.project.id),
                page_id="page-1",
                element_id="nonexistent-el",
                patch={"content": "new"},
                base_version=1,
            )


# ═══════════════════════════════════════════════════════════════════
# BS-005: 导出格式只允许 pptx
# ═══════════════════════════════════════════════════════════════════


class BS005ExportFormatTests(TestCase):
    """BS-005: ExportRequest schema 和 api 校验只允许 pptx。"""

    def test_schema_default_is_pptx(self):
        from apps.tabslide.schemas import ExportRequest
        req = ExportRequest()
        self.assertEqual(req.format, "pptx")

    def test_schema_no_page_index_field(self):
        """移除 png/jpg/pdf 后，page_index 字段也应移除。"""
        from apps.tabslide.schemas import ExportRequest
        self.assertFalse(hasattr(ExportRequest(), "page_index"))


class PPTXExportNormalizationTests(SimpleTestCase):
    """导出前必须把 SlidePage 中的 flat/mixed elements 转成 pptx_io 写出契约。"""

    @patch("apps.tabslide.services.pptx_cache.get_cached_or_generate_pptx")
    @patch.object(SlideService, "_read_pages_from_slide_pages")
    def test_get_export_pptx_path_normalizes_elements_before_cache(
        self,
        mock_read_pages,
        mock_cache,
    ):
        project = SimpleNamespace(
            id="project-export-normalized",
            pptx_dirty=True,
            pptx_oss_url="",
            refresh_from_db=MagicMock(),
        )
        mock_read_pages.return_value = [
            {
                "id": "page-export-1",
                "remark": "speaker notes",
                "elements": [
                    {
                        "id": "flat-text",
                        "type": "text",
                        "x": 10,
                        "y": 20,
                        "width": 300,
                        "height": 80,
                        "content": "Flat text should export",
                        "defaultFontSize": "24px",
                    },
                    {
                        "id": "wrapped-text",
                        "type": "text",
                        "x": 20,
                        "y": 120,
                        "width": 300,
                        "height": 80,
                        "props": {"content": "Wrapped text should still export"},
                    },
                    {
                        "id": "mixed-text",
                        "type": "text",
                        "x": 30,
                        "y": 220,
                        "width": 300,
                        "height": 80,
                        "content": "Top-level content must not override props",
                        "props": {"content": "Props content wins"},
                    },
                    {
                        "id": "flat-image",
                        "type": "image",
                        "x": 40,
                        "y": 320,
                        "width": 160,
                        "height": 90,
                        "src": "https://example.com/image.png",
                    },
                ],
            },
        ]
        mock_cache.return_value = ("oss://export-normalized.pptx", True)
        svc = SlideService(user=None)
        svc._get_project = MagicMock(return_value=project)

        result_project, path_or_url = svc.get_export_pptx_path("project-export-normalized")

        self.assertEqual(result_project, project)
        self.assertEqual(path_or_url, "oss://export-normalized.pptx")
        exported_pages = mock_cache.call_args.args[1]
        self.assertEqual(exported_pages[0]["notes"], "speaker notes")

        elements = {
            element["id"]: element
            for element in exported_pages[0]["elements"]
        }
        self.assertEqual(
            elements["flat-text"]["props"]["content"],
            "Flat text should export",
        )
        self.assertEqual(elements["flat-text"]["props"]["defaultFontSize"], "24px")
        self.assertNotIn("content", elements["flat-text"])

        self.assertEqual(
            elements["wrapped-text"]["props"]["content"],
            "Wrapped text should still export",
        )

        self.assertEqual(elements["mixed-text"]["props"]["content"], "Props content wins")
        self.assertNotIn("content", elements["mixed-text"])

        self.assertEqual(elements["flat-image"]["props"]["src"], "https://example.com/image.png")
        self.assertNotIn("src", elements["flat-image"])

    def test_props_empty_dict_still_absorbs_flat_fields(self):
        normalized = SlideService._normalize_pages_for_pptx_export([
            {
                "id": "page-export-2",
                "elements": [
                    {
                        "id": "empty-props-text",
                        "type": "text",
                        "props": {},
                        "content": "Empty props should not create props.props",
                    },
                ],
            },
        ])

        element = normalized[0]["elements"][0]
        self.assertEqual(
            element["props"]["content"],
            "Empty props should not create props.props",
        )
        self.assertNotIn("props", element["props"])

    def test_existing_notes_take_precedence_over_remark(self):
        normalized = SlideService._normalize_pages_for_pptx_export([
            {
                "id": "page-export-3",
                "notes": "existing notes",
                "remark": "legacy remark",
                "elements": [],
            },
        ])

        self.assertEqual(normalized[0]["notes"], "existing notes")

    @patch("apps.tabslide.services.pptx_cache.generate_and_cache_pptx")
    def test_clean_project_still_enters_cache_validation(self, mock_generate):
        from apps.tabslide.services.pptx_cache import get_cached_or_generate_pptx

        project = SimpleNamespace(
            id="project-clean-old-cache",
            pptx_dirty=False,
            pptx_oss_url="oss://old-broken-cache.pptx",
        )
        mock_generate.return_value = "oss://regenerated-cache.pptx"

        path_or_url, is_oss = get_cached_or_generate_pptx(
            project,
            [{"id": "page-clean", "elements": []}],
        )

        self.assertEqual(path_or_url, "oss://regenerated-cache.pptx")
        self.assertTrue(is_oss)
        mock_generate.assert_called_once()

    def test_generate_and_cache_pptx_normalizes_direct_callers(self):
        from apps.tabslide.services.pptx_cache import generate_and_cache_pptx

        project = SimpleNamespace(
            id="project-cache-normalized",
            canvas_width=1920,
            canvas_height=1080,
            theme=None,
            pptx_oss_url="oss://old-broken-cache.pptx",
            pptx_dirty=False,
            font_meta=None,
            name="cache normalized",
            dirty_page_ids=["page-cache-1"],
            created_by_id="user-cache-normalized",
        )
        pages = [
            {
                "id": "page-cache-1",
                "elements": [
                    {
                        "id": "cache-flat-text",
                        "type": "text",
                        "content": "Cache path should export",
                    },
                ],
            },
        ]

        with patch("apps.tabslide.services.pptx_cache.update_page_hashes", return_value={"page-cache-1"}), \
             patch("apps.tabslide.services.pptx_io.write") as mock_write, \
             patch("apps.tabslide.services.slide_service.SlideService._upload_pptx_to_oss", return_value="oss://cache.pptx"), \
             patch("apps.tabslide.services.pptx_cache.SlideProject.objects") as mock_objects:
            mock_objects.using.return_value.filter.return_value.update.return_value = 1

            result = generate_and_cache_pptx(project, pages)

        self.assertEqual(result, "oss://cache.pptx")
        written_pages = mock_write.call_args.kwargs["pages"]
        written_element = written_pages[0]["elements"][0]
        self.assertEqual(written_element["props"]["content"], "Cache path should export")
        self.assertNotIn("content", written_element)

    def test_generation_failure_does_not_persist_new_hash(self):
        from apps.tabslide.services.pptx_cache import generate_and_cache_pptx

        project = SimpleNamespace(
            id="project-cache-failure",
            canvas_width=1920,
            canvas_height=1080,
            theme=None,
            pptx_oss_url="oss://old-broken-cache.pptx",
            pptx_dirty=False,
            font_meta=None,
            name="cache failure",
            dirty_page_ids=[],
            created_by_id="user-cache-failure",
        )
        pages = [{"id": "page-cache-failure", "elements": []}]

        with patch("apps.tabslide.services.pptx_cache.update_page_hashes", return_value={"page-cache-failure"}) as mock_hashes, \
             patch("apps.tabslide.services.pptx_io.write", side_effect=RuntimeError("write failed")):
            with self.assertRaises(RuntimeError):
                generate_and_cache_pptx(project, pages)

        self.assertEqual(mock_hashes.call_count, 1)
        self.assertFalse(mock_hashes.call_args.kwargs["persist"])

    def test_page_hash_includes_export_context(self):
        from apps.tabslide.services.pptx_cache import compute_page_content_hash

        page = {"id": "page-context", "elements": []}
        hash_16x9 = compute_page_content_hash(
            page,
            export_context={"canvas_width": 1920, "canvas_height": 1080},
        )
        hash_4x3 = compute_page_content_hash(
            page,
            export_context={"canvas_width": 1024, "canvas_height": 768},
        )

        self.assertNotEqual(hash_16x9, hash_4x3)

    def test_export_context_includes_page_order_and_page_set(self):
        from apps.tabslide.services.pptx_cache import _build_export_hash_context

        project = SimpleNamespace(
            canvas_width=1920,
            canvas_height=1080,
            theme=None,
            font_meta=None,
        )
        original = _build_export_hash_context(
            project,
            [{"id": "page-a"}, {"id": "page-b"}, {"id": "page-c"}],
        )
        reordered = _build_export_hash_context(
            project,
            [{"id": "page-b"}, {"id": "page-a"}, {"id": "page-c"}],
        )
        deleted = _build_export_hash_context(
            project,
            [{"id": "page-a"}, {"id": "page-b"}],
        )

        self.assertNotEqual(original["page_ids"], reordered["page_ids"])
        self.assertNotEqual(original["page_ids"], deleted["page_ids"])


# ═══════════════════════════════════════════════════════════════════
# BS-014: 版本历史 TTL 分级
# ═══════════════════════════════════════════════════════════════════


class BS014HistoryTTLTieringTests(TestCase):
    """BS-014: _resolve_history_ttl 根据会员等级返回不同 TTL。"""

    def test_empty_organization_returns_free_ttl(self):
        self.assertEqual(_resolve_history_ttl(""), HISTORY_TTL_FREE)

    @patch("apps.tabslide.tasks.timezone")
    def test_no_membership_returns_free_ttl(self, mock_tz):
        mock_tz.now.return_value = timezone.now()
        with patch(
            "apps.users.membership.models.OrganizationMembership.objects"
        ) as mock_qs:
            mock_manager = MagicMock()
            mock_qs.select_related.return_value = mock_manager
            mock_manager.filter.return_value = mock_manager
            mock_manager.order_by.return_value = mock_manager
            mock_manager.first.return_value = None
            result = _resolve_history_ttl(str(uuid.uuid4()))
        self.assertEqual(result, HISTORY_TTL_FREE)

    def test_pro_tier_returns_pro_ttl(self):
        mock_tier = MagicMock()
        mock_tier.tier_type = "pro"
        mock_membership = MagicMock()
        mock_membership.tier = mock_tier

        with patch(
            "apps.users.membership.models.OrganizationMembership.objects"
        ) as mock_qs:
            mock_chain = MagicMock()
            mock_qs.select_related.return_value = mock_chain
            mock_chain.filter.return_value = mock_chain
            mock_chain.order_by.return_value = mock_chain
            mock_chain.first.return_value = mock_membership
            result = _resolve_history_ttl(str(uuid.uuid4()))
        self.assertEqual(result, HISTORY_TTL_PRO)

    def test_team_tier_returns_team_ttl(self):
        mock_tier = MagicMock()
        mock_tier.tier_type = "team"
        mock_membership = MagicMock()
        mock_membership.tier = mock_tier

        with patch(
            "apps.users.membership.models.OrganizationMembership.objects"
        ) as mock_qs:
            mock_chain = MagicMock()
            mock_qs.select_related.return_value = mock_chain
            mock_chain.filter.return_value = mock_chain
            mock_chain.order_by.return_value = mock_chain
            mock_chain.first.return_value = mock_membership
            result = _resolve_history_ttl(str(uuid.uuid4()))
        self.assertEqual(result, HISTORY_TTL_TEAM)

    def test_enterprise_tier_returns_team_ttl(self):
        mock_tier = MagicMock()
        mock_tier.tier_type = "enterprise"
        mock_membership = MagicMock()
        mock_membership.tier = mock_tier

        with patch(
            "apps.users.membership.models.OrganizationMembership.objects"
        ) as mock_qs:
            mock_chain = MagicMock()
            mock_qs.select_related.return_value = mock_chain
            mock_chain.filter.return_value = mock_chain
            mock_chain.order_by.return_value = mock_chain
            mock_chain.first.return_value = mock_membership
            result = _resolve_history_ttl(str(uuid.uuid4()))
        self.assertEqual(result, HISTORY_TTL_TEAM)

    def test_free_tier_returns_free_ttl(self):
        mock_tier = MagicMock()
        mock_tier.tier_type = "free"
        mock_membership = MagicMock()
        mock_membership.tier = mock_tier

        with patch(
            "apps.users.membership.models.OrganizationMembership.objects"
        ) as mock_qs:
            mock_chain = MagicMock()
            mock_qs.select_related.return_value = mock_chain
            mock_chain.filter.return_value = mock_chain
            mock_chain.order_by.return_value = mock_chain
            mock_chain.first.return_value = mock_membership
            result = _resolve_history_ttl(str(uuid.uuid4()))
        self.assertEqual(result, HISTORY_TTL_FREE)

    def test_db_exception_returns_free_ttl(self):
        """数据库异常不应中断任务，降级为 FREE TTL。"""
        with patch(
            "apps.users.membership.models.OrganizationMembership.objects"
        ) as mock_qs:
            mock_qs.select_related.side_effect = Exception("DB down")
            result = _resolve_history_ttl(str(uuid.uuid4()))
        self.assertEqual(result, HISTORY_TTL_FREE)
