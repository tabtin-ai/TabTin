"""
TabSlide 核心 API 集成测试 (TC-01 + TC-03)

覆盖端点：
  1. save-pages/ — CAS 乐观锁（含并发冲突 409 测试，核心）
  2. 项目 CRUD（创建 / 详情 / 列表 / 删除）
  3. import-pptx/ — 基本冒烟测试
  4. export/ — 基本冒烟测试

Ninja Router 函数调用约定：
  - 成功路径：返回 dict（来自 success_response），无 HTTP 封装
  - 错误路径：返回 tuple (status_code, dict)（来自 error_response_with_status 及其别名）
  - 测试直接调用 View 函数，通过 SimpleNamespace(auth=user) 注入认证
  - 重型外部依赖（PPTX 解析、OSS、Celery）通过 unittest.mock.patch 隔离
"""

from __future__ import annotations

import json
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.tabslide import api as slide_api
from apps.tabslide.models import SlideProject, SlidePage
from apps.tabslide.schemas import (
    ExportRequest,
    ProjectCreateRequest,
    ProjectUpdateRequest,
    SavePagesRequest,
)
from apps.tabslide.services.slide_service import ConflictError, SlideService
from apps.tabtinspace.models import Agent, Space, SpaceMembership, Organization

User = get_user_model()


# ─────────────────────────────────────────────────────────────────────────────
# 响应解析工具（兼容 dict 和 tuple 两种返回形式）
# ─────────────────────────────────────────────────────────────────────────────


def _status(resp) -> int:
    """从 Ninja View 函数返回值中提取 HTTP 状态码。"""
    if isinstance(resp, tuple):
        return resp[0]
    if hasattr(resp, "status_code"):
        return resp.status_code
    # 纯 dict → 200
    return 200


def _body(resp) -> dict:
    """从 Ninja View 函数返回值中提取响应体 dict。"""
    if isinstance(resp, tuple):
        return resp[1]
    if hasattr(resp, "content"):
        return json.loads(resp.content)
    return resp


# ─────────────────────────────────────────────────────────────────────────────
# 共用夹具工具
# ─────────────────────────────────────────────────────────────────────────────


def _make_user(suffix: str) -> User:
    return User.objects.create_user(
        username=f"slide_test_{suffix}",
        email=f"slide_test_{suffix}@test.com",
        password="pass123",
    )


def _ensure_space_membership(organization: Organization, space: Space, user: User, role: str = "editor"):
    """确保 user → Agent → SpaceMembership 链路完整（参照 test_permissions.py 模式）。"""
    agent, _ = Agent.objects.get_or_create(
        organization=organization,
        user=user,
        defaults={"name": user.username, "type": "human", "is_active": True},
    )
    if not agent.is_active:
        agent.is_active = True
        agent.save(update_fields=["is_active", "updated_at"])
    SpaceMembership.objects.update_or_create(
        workspace=space,
        agent=agent,
        defaults={"role": role, "is_active": True},
    )


def _make_request(user: User) -> SimpleNamespace:
    """构造最小化 request 对象，与 Ninja Router 函数的 request.auth 契约兼容。"""
    return SimpleNamespace(auth=user)


def _make_page(page_id: str | None = None) -> dict:
    """返回最小化合法页面 dict。"""
    return {
        "id": page_id or str(uuid.uuid4()),
        "elements": [],
        "background": "#ffffff",
    }


# ─────────────────────────────────────────────────────────────────────────────
# TC-03 — CAS 乐观锁并发冲突测试（P0 核心）
# ─────────────────────────────────────────────────────────────────────────────


class CASConflictTests(TestCase):
    """
    TC-03：验证 save-pages/ 的 CAS 乐观锁并发冲突保护。

    场景：两个客户端各自持有版本 V，后提交的请求必须被拒绝（409）。
    测试直接调用 SlideService 和 API 层两种路径，确保保护在两层均有效。
    """

    databases = {"default", "postgresql"}

    def setUp(self):
        self.owner = _make_user("cas_owner")
        self.organization = Organization.objects.create(
            name="CAS 测试组织",
            owner=self.owner,
        )
        self.space = Space.objects.create(
            organization=self.organization,
            name="CAS 测试空间",
        )
        _ensure_space_membership(self.organization, self.space, self.owner, "editor")

        # 直接创建项目行，跳过 OSS/ResourceBridge 副作用
        self.project = SlideProject.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            name="CAS 测试项目",
            preset="ppt",
            latest_version=5,
            status="active",
        )

    # ── Service 层 ──

    def test_service_cas_first_save_succeeds(self):
        """第一次以 base_version=5 保存应成功，版本递增为 6。"""
        svc = SlideService(user=self.owner)
        pages = [_make_page()]

        with patch("apps.tabslide.services.slide_service.SlideService._push_pages_to_ydoc"):
            svc.save_pages(str(self.project.id), pages=pages, base_version=5)

        self.project.refresh_from_db()
        self.assertEqual(self.project.latest_version, 6)

    def test_service_cas_stale_version_raises_conflict(self):
        """以过期版本号（base_version=5）重复提交应触发 ConflictError。"""
        svc = SlideService(user=self.owner)
        pages = [_make_page()]

        with patch("apps.tabslide.services.slide_service.SlideService._push_pages_to_ydoc"):
            # 第一次保存：版本 5 → 6
            svc.save_pages(str(self.project.id), pages=pages, base_version=5)

            # 第二次仍携带 base_version=5（模拟并发客户端的过期快照）
            with self.assertRaises(ConflictError):
                svc.save_pages(str(self.project.id), pages=pages, base_version=5)

    def test_service_cas_sequential_saves_increment_version(self):
        """连续两次顺序保存（base_version 同步递增）应使版本号递增两次。"""
        svc = SlideService(user=self.owner)
        pages = [_make_page()]

        with patch("apps.tabslide.services.slide_service.SlideService._push_pages_to_ydoc"):
            svc.save_pages(str(self.project.id), pages=pages, base_version=5)
            self.project.refresh_from_db()
            self.assertEqual(self.project.latest_version, 6)

            svc.save_pages(str(self.project.id), pages=pages, base_version=6)
            self.project.refresh_from_db()
            self.assertEqual(self.project.latest_version, 7)

    def test_service_cas_without_base_version_always_succeeds(self):
        """不传 base_version 时采用服务端当前版本（自读自写模式），连续两次均应成功。"""
        svc = SlideService(user=self.owner)
        pages = [_make_page()]

        with patch("apps.tabslide.services.slide_service.SlideService._push_pages_to_ydoc"):
            svc.save_pages(str(self.project.id), pages=pages)
            svc.save_pages(str(self.project.id), pages=pages)

        self.project.refresh_from_db()
        self.assertEqual(self.project.latest_version, 7)  # 5 + 2

    # ── API 层 ──

    def test_api_cas_conflict_returns_409(self):
        """
        核心验证：API 层 save-pages/ 在版本冲突时应返回 409 Conflict。

        模拟场景：
          客户端 A 与客户端 B 均拿到 version=5 的快照，
          A 提交成功（version → 6），B 再提交时必须被拒绝。
        """
        request = _make_request(self.owner)
        pages = [_make_page()]

        with patch("apps.tabslide.services.slide_service.SlideService._push_pages_to_ydoc"):
            # 客户端 A：成功
            body_a = SavePagesRequest(pages=pages, base_version=5)
            resp_a = slide_api.save_pages(request, str(self.project.id), body_a)
            self.assertEqual(_status(resp_a), 200)
            self.assertTrue(_body(resp_a)["data"]["saved"])
            self.assertEqual(_body(resp_a)["data"]["latest_version"], 6)

            # 客户端 B：提交过期版本，应返回 409
            body_b = SavePagesRequest(pages=pages, base_version=5)
            resp_b = slide_api.save_pages(request, str(self.project.id), body_b)
            self.assertEqual(_status(resp_b), 409)

    def test_api_cas_version_increments_on_success(self):
        """API 保存成功后响应体应包含递增后的 latest_version。"""
        request = _make_request(self.owner)
        pages = [_make_page()]

        with patch("apps.tabslide.services.slide_service.SlideService._push_pages_to_ydoc"):
            body = SavePagesRequest(pages=pages, base_version=5)
            resp = slide_api.save_pages(request, str(self.project.id), body)

        self.assertEqual(_status(resp), 200)
        data = _body(resp)["data"]
        self.assertEqual(data["latest_version"], 6)
        self.assertTrue(data["saved"])

    def test_api_save_pages_writes_slide_pages_to_db(self):
        """save-pages 应将页面数据持久化到 SlidePage 表。"""
        request = _make_request(self.owner)
        page_id = str(uuid.uuid4())
        pages = [{"id": page_id, "elements": [{"id": "el1", "type": "text"}], "background": "#000"}]

        with patch("apps.tabslide.services.slide_service.SlideService._push_pages_to_ydoc"):
            body = SavePagesRequest(pages=pages, base_version=5)
            resp = slide_api.save_pages(request, str(self.project.id), body)

        self.assertEqual(_status(resp), 200)
        self.assertTrue(
            SlidePage.objects.using("postgresql").filter(
                project=self.project, page_id=page_id
            ).exists()
        )

    def test_api_save_pages_unauthenticated_returns_403(self):
        """未认证请求应返回 403。"""
        request = SimpleNamespace(auth=None)
        body = SavePagesRequest(pages=[_make_page()], base_version=5)
        resp = slide_api.save_pages(request, str(self.project.id), body)
        self.assertEqual(_status(resp), 403)

    def test_api_save_pages_nonexistent_project_returns_error(self):
        """向不存在的项目保存页面应返回 4xx 错误。"""
        request = _make_request(self.owner)
        body = SavePagesRequest(pages=[_make_page()], base_version=0)
        resp = slide_api.save_pages(request, str(uuid.uuid4()), body)
        self.assertGreaterEqual(_status(resp), 400)
        self.assertLess(_status(resp), 500)


# ─────────────────────────────────────────────────────────────────────────────
# TC-01 — 项目 CRUD 集成测试
# ─────────────────────────────────────────────────────────────────────────────


class ProjectCRUDTests(TestCase):
    """
    TC-01（项目 CRUD）：验证创建 / 详情 / 列表 / 删除端点的基本契约。
    """

    databases = {"default", "postgresql"}

    def setUp(self):
        self.owner = _make_user("crud_owner")
        self.organization = Organization.objects.create(
            name="CRUD 测试组织",
            owner=self.owner,
        )
        self.space = Space.objects.create(
            organization=self.organization,
            name="CRUD 测试空间",
        )
        _ensure_space_membership(self.organization, self.space, self.owner, "editor")
        self.request = _make_request(self.owner)

    # ── 创建 ──

    def test_create_project_returns_200_and_project_id(self):
        """POST /projects/ 应成功创建并返回带 id 的项目摘要。"""
        body = ProjectCreateRequest(
            organization_id=str(self.organization.id),
            space_id=str(self.space.id),
            name="集成测试演示文稿",
            preset="ppt",
        )

        with patch("apps.tabtinspace.services.resource_bridge.ResourceBridge.on_create"), \
             patch("apps.tabslide.api.ensure_space_in_organization"):
            resp = slide_api.create_project(self.request, body)

        self.assertEqual(_status(resp), 200)
        data = _body(resp)["data"]
        self.assertIn("id", data)
        self.assertEqual(data["name"], "集成测试演示文稿")
        self.assertEqual(data["preset"], "ppt")

    def test_create_project_persists_to_database(self):
        """创建后 SlideProject 应存在于数据库中。"""
        body = ProjectCreateRequest(
            organization_id=str(self.organization.id),
            space_id=str(self.space.id),
            name="持久化测试项目",
            preset="ppt",
        )

        with patch("apps.tabtinspace.services.resource_bridge.ResourceBridge.on_create"), \
             patch("apps.tabslide.api.ensure_space_in_organization"):
            resp = slide_api.create_project(self.request, body)

        self.assertEqual(_status(resp), 200)
        project_id = _body(resp)["data"]["id"]
        self.assertTrue(SlideProject.objects.filter(id=project_id, status="active").exists())

    def test_create_project_unauthenticated_returns_403(self):
        """未认证用户创建项目应返回 403。"""
        request = SimpleNamespace(auth=None)
        body = ProjectCreateRequest(
            organization_id=str(self.organization.id),
            space_id=str(self.space.id),
            name="未授权项目",
        )
        resp = slide_api.create_project(request, body)
        self.assertEqual(_status(resp), 403)

    # ── 列表 ──

    def test_list_projects_returns_created_project(self):
        """GET /projects/ 应包含当前 space 内的项目。"""
        project = SlideProject.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            name="列表测试项目",
            preset="ppt",
            status="active",
        )

        with patch("apps.tabslide.api.ensure_space_in_organization"):
            resp = slide_api.list_projects(
                self.request,
                organization_id=str(self.organization.id),
                space_id=str(self.space.id),
            )

        self.assertEqual(_status(resp), 200)
        items = _body(resp)["data"]["projects"]
        ids = [p["id"] for p in items]
        self.assertIn(str(project.id), ids)

    def test_list_projects_excludes_archived(self):
        """归档项目不应出现在列表中。"""
        SlideProject.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            name="已归档项目",
            preset="ppt",
            status="archived",
        )

        with patch("apps.tabslide.api.ensure_space_in_organization"):
            resp = slide_api.list_projects(
                self.request,
                organization_id=str(self.organization.id),
                space_id=str(self.space.id),
            )

        items = _body(resp)["data"]["projects"]
        names = [p["name"] for p in items]
        self.assertNotIn("已归档项目", names)

    # ── 详情 ──

    def test_get_project_returns_detail_with_pages(self):
        """GET /projects/{id}/ 应返回项目详情（含 pages 字段）。"""
        project = SlideProject.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            name="详情测试项目",
            preset="ppt",
            status="active",
            latest_version=1,
        )

        resp = slide_api.get_project(self.request, str(project.id))

        self.assertEqual(_status(resp), 200)
        data = _body(resp)["data"]
        self.assertEqual(data["id"], str(project.id))
        self.assertEqual(data["name"], "详情测试项目")
        self.assertIn("pages", data)

    def test_get_nonexistent_project_returns_404(self):
        """请求不存在的项目 ID 应返回 404。"""
        resp = slide_api.get_project(self.request, str(uuid.uuid4()))
        self.assertEqual(_status(resp), 404)

    # ── 删除（归档） ──

    def test_delete_project_archives_it(self):
        """DELETE /projects/{id}/ 应将项目状态变更为 archived。"""
        project = SlideProject.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            name="待删除项目",
            preset="ppt",
            status="active",
        )

        with patch("apps.tabtinspace.services.resource_bridge.ResourceBridge.on_archive"):
            resp = slide_api.delete_project(self.request, str(project.id))

        self.assertEqual(_status(resp), 200)
        project.refresh_from_db()
        self.assertEqual(project.status, "archived")

    def test_delete_nonexistent_project_returns_404(self):
        """删除不存在的项目应返回 404。"""
        resp = slide_api.delete_project(self.request, str(uuid.uuid4()))
        self.assertEqual(_status(resp), 404)

    # ── 更新 ──

    def test_update_project_name(self):
        """PUT /projects/{id}/ 应更新项目名称。"""
        project = SlideProject.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            name="原始名称",
            preset="ppt",
            status="active",
        )
        body = ProjectUpdateRequest(name="新名称")

        with patch("apps.tabtinspace.services.resource_bridge.ResourceBridge.on_update"):
            resp = slide_api.update_project(self.request, str(project.id), body)

        self.assertEqual(_status(resp), 200)
        project.refresh_from_db()
        self.assertEqual(project.name, "新名称")


# ─────────────────────────────────────────────────────────────────────────────
# TC-01 — import-pptx 基本冒烟测试
# ─────────────────────────────────────────────────────────────────────────────


class ImportPptxSmokeTests(TestCase):
    """
    TC-01（import-pptx）：端点冒烟测试。

    PPTX 解析（python-pptx + OSS 上传）通过 mock 隔离。
    测试目标：HTTP 路由、权限检查、响应结构。
    """

    databases = {"default", "postgresql"}

    def setUp(self):
        self.owner = _make_user("pptx_owner")
        self.organization = Organization.objects.create(
            name="PPTX 导入测试组织",
            owner=self.owner,
        )
        self.space = Space.objects.create(
            organization=self.organization,
            name="PPTX 导入测试空间",
        )
        _ensure_space_membership(self.organization, self.space, self.owner, "editor")
        self.request = _make_request(self.owner)

    def _make_fake_file(self, name: str = "test.pptx") -> MagicMock:
        """构造最小化 UploadedFile mock。"""
        fake_file = MagicMock()
        fake_file.name = name
        fake_file.size = 21
        fake_file.read.return_value = b"PK\x03\x04"
        fake_file.chunks.return_value = iter([b"PK\x03\x04fake pptx content"])
        return fake_file

    def test_import_pptx_smoke_returns_200_with_task_id(self):
        """CRT-01: import-pptx 端点异步化后应返回 200 + task_id。"""
        mock_result = MagicMock()
        mock_result.id = "celery-task-id-123"
        oss_service = MagicMock()
        oss_service.upload_file.return_value = {"success": True, "data": {}}

        with patch("apps.tabslide.api.ensure_space_in_organization"), \
             patch.object(SlideService, "check_space_permission", return_value=True), \
             patch(
                 "apps.services.oss.services.factory.get_oss_service",
                 return_value=oss_service,
             ), \
             patch(
                 "apps.tabslide.tasks.import_pptx_oss_task.delay",
                 return_value=mock_result,
             ):
            resp = slide_api.import_pptx(
                self.request,
                organization_id=str(self.organization.id),
                space_id=str(self.space.id),
                file=self._make_fake_file(),
            )

        self.assertEqual(_status(resp), 200)
        data = _body(resp)["data"]
        self.assertIn("task_id", data)
        self.assertEqual(data["status"], "processing")

    def test_import_pptx_without_auth_returns_403(self):
        """未认证请求（auth=None）应返回 403。"""
        request = SimpleNamespace(auth=None)
        resp = slide_api.import_pptx(
            request,
            organization_id=str(self.organization.id),
            space_id=str(self.space.id),
            file=self._make_fake_file(),
        )
        self.assertEqual(_status(resp), 403)

    def test_import_pptx_invalid_space_returns_404(self):
        """organization_id 与 space_id 不匹配时应返回 404。"""
        with patch(
            "apps.tabslide.api.ensure_space_in_organization",
            side_effect=ValueError("organization_id 与 space_id 不匹配"),
        ):
            resp = slide_api.import_pptx(
                self.request,
                organization_id=str(uuid.uuid4()),
                space_id=str(self.space.id),
                file=self._make_fake_file(),
            )
        self.assertEqual(_status(resp), 404)


# ─────────────────────────────────────────────────────────────────────────────
# TC-01 — export 基本冒烟测试
# ─────────────────────────────────────────────────────────────────────────────


class ExportSmokeTests(TestCase):
    """
    TC-01（export）：export/ 端点冒烟测试。

    pptx_oss_url 查找通过 mock 隔离，测试路由、响应结构、格式校验。
    export_project 是 async 函数，通过 asyncio.run 驱动。
    """

    databases = {"default", "postgresql"}

    def setUp(self):
        self.owner = _make_user("export_owner")
        self.organization = Organization.objects.create(
            name="导出测试组织",
            owner=self.owner,
        )
        self.space = Space.objects.create(
            organization=self.organization,
            name="导出测试空间",
        )
        _ensure_space_membership(self.organization, self.space, self.owner, "editor")
        self.request = _make_request(self.owner)

        self.project = SlideProject.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            name="导出测试项目",
            preset="ppt",
            pptx_oss_url="https://oss.example.com/test.pptx",
            status="active",
        )

    def _call_export(self, fmt: str = "pptx", request=None):
        """同步调用 async export_project。"""
        import asyncio
        req = request or self.request
        body = ExportRequest(format=fmt)
        return asyncio.run(slide_api.export_project(req, str(self.project.id), body))

    def test_export_pptx_returns_download_url(self):
        """export/ 以 format=pptx 应返回 download_url 字段。"""
        fake_url = "https://oss.example.com/test.pptx"
        with patch.object(
            SlideService,
            "get_export_pptx_path",
            return_value=(self.project, fake_url),
        ):
            resp = self._call_export("pptx")

        self.assertEqual(_status(resp), 200)
        data = _body(resp)["data"]
        self.assertIn("download_url", data)
        self.assertEqual(data["download_url"], fake_url)
        self.assertTrue(data["filename"].endswith(".pptx"))

    def test_export_unsupported_format_returns_400(self):
        """不支持的导出格式应返回 400 而不崩溃。"""
        resp = self._call_export("docx")
        self.assertEqual(_status(resp), 400)

    def test_export_without_auth_returns_403(self):
        """未认证用户应返回 403。"""
        request = SimpleNamespace(auth=None)
        resp = self._call_export("pptx", request=request)
        self.assertEqual(_status(resp), 403)

    def test_export_nonexistent_project_returns_error(self):
        """导出不存在的项目应返回 4xx。"""
        with patch.object(
            SlideService,
            "get_export_pptx_path",
            side_effect=ValueError("项目不存在"),
        ):
            resp = self._call_export("pptx")

        self.assertGreaterEqual(_status(resp), 400)
        self.assertLess(_status(resp), 500)
