"""
SDI-007 / SDI-008 回归测试

SDI-007: get_import_pptx_status 必须校验请求者对项目所属 space 的访问权限
SDI-008: upload_image 必须校验请求者对 slide_project 所属 space 的访问权限

纯 mock 测试，不依赖数据库。
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, patch

import django
from django.conf import settings
if not settings.configured:
    settings.DJANGO_SETTINGS_MODULE = "tabtin.settings"
    django.setup()

from apps.tabslide import api as slide_api


def _unwrap(resp):
    if isinstance(resp, tuple):
        return resp[0], resp[1]
    return 200, resp


def _fake_user(uid=None):
    user = MagicMock()
    user.id = uid or uuid.uuid4()
    user.username = f"user_{user.id}"
    return user


def _fake_project(space_id=None, organization_id=None):
    project = MagicMock()
    project.id = uuid.uuid4()
    project.space_id = space_id or uuid.uuid4()
    project.organization_id = organization_id or uuid.uuid4()
    project.name = "test-project"
    project.preset = "16:9"
    project.canvas_width = 1920
    project.canvas_height = 1080
    project.page_count = 1
    project.thumbnail = ""
    project.theme = None
    project.latest_version = 1
    project.last_editor_type = "user"
    project.last_editor_id = ""
    project.created_by_id = None
    project.updated_by_id = None
    project.created_at = None
    project.updated_at = None
    return project


# ─────────────────────────────────────────────────────────────────────
# SDI-007: get_import_pptx_status Space 权限校验
# ─────────────────────────────────────────────────────────────────────


class SDI007ImportPptxStatusSpacePermissionTests(TestCase):
    """SDI-007: get_import_pptx_status 在任务完成时必须校验 Space 权限。"""

    def setUp(self):
        self.owner = _fake_user()
        self.outsider = _fake_user()
        self.project = _fake_project()
        self.task_id = f"test-task-{uuid.uuid4().hex[:8]}"

    @patch("apps.tabslide.api.SlideService")
    @patch("apps.tabslide.api.SlideProject")
    @patch("apps.tabslide.api.cache", create=True)
    def test_outsider_cannot_read_completed_import_result(
        self, mock_cache_module, mock_project_cls, mock_svc_cls
    ):
        """无 space 权限的用户不应获取已完成的 PPTX 导入结果。"""
        from django.core.cache import cache
        from apps.tabslide.tasks import IMPORT_PPTX_CACHE_PREFIX

        cache_key = f"{IMPORT_PPTX_CACHE_PREFIX}{self.task_id}"
        cache.set(cache_key, {
            "status": "completed",
            "project_id": str(self.project.id),
        })

        mock_project_cls.objects.using.return_value.get.return_value = self.project

        mock_svc = MagicMock()
        mock_svc.check_space_permission.return_value = False
        mock_svc_cls.return_value = mock_svc

        request = SimpleNamespace(auth=self.outsider)

        with patch("apps.tabslide.api._build_service", return_value=mock_svc):
            status, body = _unwrap(
                slide_api.get_import_pptx_status(request, self.task_id)
            )

        self.assertEqual(status, 403, f"应返回 403，实际返回 {status}: {body}")

    @patch("apps.tabslide.api.SlideService")
    @patch("apps.tabslide.api.SlideProject")
    @patch("apps.tabslide.api.cache", create=True)
    def test_owner_can_read_completed_import_result(
        self, mock_cache_module, mock_project_cls, mock_svc_cls
    ):
        """有 space 权限的用户可以获取已完成的 PPTX 导入结果。"""
        from django.core.cache import cache
        from apps.tabslide.tasks import IMPORT_PPTX_CACHE_PREFIX

        cache_key = f"{IMPORT_PPTX_CACHE_PREFIX}{self.task_id}"
        cache.set(cache_key, {
            "status": "completed",
            "project_id": str(self.project.id),
        })

        mock_project_cls.objects.using.return_value.get.return_value = self.project

        mock_svc = MagicMock()
        mock_svc.check_space_permission.return_value = True
        mock_svc._read_pages_from_slide_pages.return_value = []
        mock_svc_cls.return_value = mock_svc

        request = SimpleNamespace(auth=self.owner)

        with patch("apps.tabslide.api._build_service", return_value=mock_svc):
            status, body = _unwrap(
                slide_api.get_import_pptx_status(request, self.task_id)
            )

        self.assertEqual(status, 200, f"应返回 200，实际返回 {status}: {body}")

    def test_processing_status_still_returned_without_project_check(self):
        """任务未完成时无需 project 校验，直接返回状态。"""
        from django.core.cache import cache
        from apps.tabslide.tasks import IMPORT_PPTX_CACHE_PREFIX

        cache_key = f"{IMPORT_PPTX_CACHE_PREFIX}{self.task_id}"
        cache.set(cache_key, {
            "status": "processing",
            "stage": "parsing",
        })

        request = SimpleNamespace(auth=self.outsider)
        status, body = _unwrap(
            slide_api.get_import_pptx_status(request, self.task_id)
        )

        self.assertEqual(status, 200)


# ─────────────────────────────────────────────────────────────────────
# SDI-008: upload_image Space 权限校验
# ─────────────────────────────────────────────────────────────────────


PNG_1X1 = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01"
    b"\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00"
    b"\x00\x00\x0cIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00"
    b"\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82"
)


def _make_uploaded_file(content=PNG_1X1, name="test.png", content_type="image/png"):
    f = MagicMock()
    f.name = name
    f.content_type = content_type
    f.size = len(content)
    f.read.return_value = content
    f.chunks.return_value = iter([content])
    return f


class SDI008UploadImageSpacePermissionTests(TestCase):
    """SDI-008: upload_image 必须校验 slide_project 所属 space 的权限。"""

    def setUp(self):
        self.owner = _fake_user()
        self.outsider = _fake_user()
        self.project = _fake_project()

    @patch("apps.tabslide.api._build_service")
    @patch("apps.tabslide.api.SlideProject")
    def test_outsider_cannot_upload_image_to_others_project(
        self, mock_project_cls, mock_build_svc
    ):
        """无 space 权限的用户不应能上传图片到他人项目。"""
        mock_project_cls.objects.using.return_value.get.return_value = self.project

        mock_svc = MagicMock()
        mock_svc.check_space_permission.return_value = False
        mock_build_svc.return_value = mock_svc

        request = SimpleNamespace(auth=self.outsider)
        status, body = _unwrap(
            slide_api.upload_image(
                request,
                organization_id=str(self.project.organization_id),
                slide_project_id=str(self.project.id),
                file=_make_uploaded_file(),
            )
        )

        self.assertEqual(status, 403, f"应返回 403，实际返回 {status}: {body}")
        mock_svc.check_space_permission.assert_called_once_with(
            str(self.project.space_id), required_role="editor"
        )

    @patch("apps.tabslide.services.slide_service.build_oss_image_handler")
    @patch("apps.tabslide.api._build_service")
    @patch("apps.tabslide.api.SlideProject")
    def test_owner_can_upload_image_to_own_project(
        self, mock_project_cls, mock_build_svc, mock_oss_build
    ):
        """有 space 权限的用户可以上传图片。"""
        mock_project_cls.objects.using.return_value.get.return_value = self.project

        mock_svc = MagicMock()
        mock_svc.check_space_permission.return_value = True
        mock_build_svc.return_value = mock_svc

        mock_handler = MagicMock(return_value="https://cdn.example.com/test.png")
        mock_oss_build.return_value = mock_handler

        request = SimpleNamespace(auth=self.owner)
        status, body = _unwrap(
            slide_api.upload_image(
                request,
                organization_id=str(self.project.organization_id),
                slide_project_id=str(self.project.id),
                file=_make_uploaded_file(),
            )
        )

        self.assertEqual(status, 200, f"应返回 200，实际返回 {status}: {body}")

    @patch("apps.tabslide.models.SlideProject.objects")
    def test_upload_image_nonexistent_project_returns_404(self, mock_objects):
        """slide_project_id 不存在时返回 404。"""
        from apps.tabslide.models import SlideProject as RealSlideProject
        mock_objects.using.return_value.get.side_effect = RealSlideProject.DoesNotExist

        request = SimpleNamespace(auth=self.owner)
        status, body = _unwrap(
            slide_api.upload_image(
                request,
                organization_id="ws-1",
                slide_project_id=str(uuid.uuid4()),
                file=_make_uploaded_file(),
            )
        )

        self.assertEqual(status, 404, f"应返回 404，实际返回 {status}: {body}")

    def test_upload_image_empty_project_id_still_rejected(self):
        """空 slide_project_id 仍然被拒绝（原有 XC-34 校验保持不变）。"""
        request = SimpleNamespace(auth=self.owner)
        status, body = _unwrap(
            slide_api.upload_image(
                request,
                organization_id="ws-1",
                slide_project_id="",
                file=_make_uploaded_file(),
            )
        )

        self.assertEqual(status, 400, f"应返回 400，实际返回 {status}: {body}")
