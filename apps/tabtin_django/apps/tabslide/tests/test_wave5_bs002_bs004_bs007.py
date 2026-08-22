"""
Wave 5 回归测试：BS-002 / BS-004 / BS-007

BS-002: list_changes 参数 since_version 类型注解 Optional[int]
BS-004: restore_history 404 检测匹配 i18n key（"not_found"）
BS-007: schemas.py 移除 5 个未被 API 使用的响应 Schema（死代码）
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.tabslide import api as slide_api
from apps.tabslide.models import SlideProject
from apps.tabslide.schemas import RestoreHistoryRequest
from apps.tabtinspace.models import Agent, Space, SpaceMembership, Organization

User = get_user_model()


def _status(resp) -> int:
    if isinstance(resp, tuple):
        return resp[0]
    return 200


def _body(resp) -> dict:
    if isinstance(resp, tuple):
        return resp[1]
    return resp


def _make_user(suffix: str):
    return User.objects.create_user(
        username=f"w5_{suffix}", email=f"w5_{suffix}@test.com", password="pass123",
    )


def _ensure_membership(organization, space, user, role="editor"):
    agent, _ = Agent.objects.get_or_create(
        organization=organization, user=user,
        defaults={"name": user.username, "type": "human", "is_active": True},
    )
    SpaceMembership.objects.update_or_create(
        workspace=space, agent=agent,
        defaults={"role": role, "is_active": True},
    )


def _req(user):
    return SimpleNamespace(auth=user)


# ─────────────────────────────────────────────────────────────────────────────
# BS-002: since_version Optional[int] 类型注解
# ─────────────────────────────────────────────────────────────────────────────


class BS002SinceVersionOptionalTests(TestCase):
    """since_version: Optional[int] = None 应能正常接受 None 和 int。"""

    databases = {"default", "postgresql"}

    def setUp(self):
        self.user = _make_user("bs002")
        self.organization = Organization.objects.create(name="ws-bs002", owner=self.user)
        self.space = Space.objects.create(organization=self.organization, name="sp-bs002")
        _ensure_membership(self.organization, self.space, self.user)
        self.project = SlideProject.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            name="BS002 测试",
            preset="ppt",
            latest_version=1,
            status="active",
        )

    def test_list_changes_since_version_none(self):
        """since_version=None 不应触发 Pydantic 验证错误。"""
        resp = slide_api.list_changes(
            _req(self.user), str(self.project.id), since_version=None, limit=10,
        )
        self.assertEqual(_status(resp), 200)
        self.assertIn("changes", _body(resp).get("data", _body(resp)))

    def test_list_changes_since_version_int(self):
        """since_version=0 应正常返回。"""
        resp = slide_api.list_changes(
            _req(self.user), str(self.project.id), since_version=0, limit=10,
        )
        self.assertEqual(_status(resp), 200)

    def test_type_annotation_is_optional(self):
        """函数签名中 since_version 的默认值应兼容 None。"""
        import inspect
        sig = inspect.signature(slide_api.list_changes)
        param = sig.parameters["since_version"]
        self.assertIs(param.default, None)


# ─────────────────────────────────────────────────────────────────────────────
# BS-004: restore_history 404 检测 —— i18n key 匹配
# ─────────────────────────────────────────────────────────────────────────────


class BS004RestoreHistory404DetectionTests(TestCase):
    """restore_history 在历史不存在时应返回 404（而非 400）。

    修复前：`"不存在" in err_msg` 永远不匹配 i18n key
    ``tabslide.history_not_found``，导致所有 "历史不存在" 错误
    都以 HISTORY_RESTORE_FAILED（非 404）返回。
    """

    databases = {"default", "postgresql"}

    def setUp(self):
        self.user = _make_user("bs004")
        self.organization = Organization.objects.create(name="ws-bs004", owner=self.user)
        self.space = Space.objects.create(organization=self.organization, name="sp-bs004")
        _ensure_membership(self.organization, self.space, self.user)
        self.project = SlideProject.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            name="BS004 测试",
            preset="ppt",
            latest_version=1,
            status="active",
        )

    def test_nonexistent_history_returns_404(self):
        """传入不存在的 history_id，应返回 404 而非 400/HISTORY_RESTORE_FAILED。"""
        body = RestoreHistoryRequest(history_id=str(uuid.uuid4()))
        resp = slide_api.restore_history(
            _req(self.user), str(self.project.id), body,
        )
        self.assertEqual(_status(resp), 404)

    def test_nonexistent_project_returns_404(self):
        """项目不存在时也应返回 404。"""
        body = RestoreHistoryRequest(history_id=str(uuid.uuid4()))
        resp = slide_api.restore_history(
            _req(self.user), str(uuid.uuid4()), body,
        )
        self.assertEqual(_status(resp), 404)

    def test_not_found_pattern_matches_i18n_key(self):
        """验证 "not_found" 子串能匹配 i18n key 格式。"""
        key = "tabslide.history_not_found"
        self.assertIn("not_found", key)

        key2 = "tabslide.project_not_found"
        self.assertIn("not_found", key2)


# ─────────────────────────────────────────────────────────────────────────────
# BS-007: 移除未使用的响应 Schema（死代码清理）
# ─────────────────────────────────────────────────────────────────────────────


class BS007DeadResponseSchemasRemovedTests(TestCase):
    """确认 5 个从未被 API 使用的响应 Schema 已被移除。"""

    def test_project_summary_not_importable(self):
        with self.assertRaises(ImportError):
            from apps.tabslide.schemas import ProjectSummary  # noqa: F401

    def test_project_detail_not_importable(self):
        with self.assertRaises(ImportError):
            from apps.tabslide.schemas import ProjectDetail  # noqa: F401

    def test_slide_history_out_not_importable(self):
        with self.assertRaises(ImportError):
            from apps.tabslide.schemas import SlideHistoryOut  # noqa: F401

    def test_slide_change_out_not_importable(self):
        with self.assertRaises(ImportError):
            from apps.tabslide.schemas import SlideChangeOut  # noqa: F401

    def test_sync_status_out_not_importable(self):
        with self.assertRaises(ImportError):
            from apps.tabslide.schemas import SyncStatusOut  # noqa: F401

    def test_request_schemas_still_importable(self):
        """请求 Schema 不受影响。"""
        from apps.tabslide.schemas import (  # noqa: F401
            ProjectCreateRequest,
            SavePagesRequest,
            ExportRequest,
            RestoreHistoryRequest,
            BatchUpdateElementsRequest,
        )
