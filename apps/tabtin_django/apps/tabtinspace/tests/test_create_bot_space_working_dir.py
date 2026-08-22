"""create_space ROUTER 透传 working_dir / working_dir_type 的回归测试。

背景（work_type 主线数据源断点）：
- service 层 ``SpaceService.create_space`` 接受 ``working_dir`` /
  ``working_dir_type`` 并落库；
- router 必须把这两个字段传给 service，否则新建 Space 会丢失执行边界。

本测试直接调 ninja view 函数（django-ninja 装饰器返回原函数），构造带 ``.auth``
的 request，断言 router → service → DB 的透传闭环。
"""
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import RequestFactory, SimpleTestCase, TestCase
from pydantic import ValidationError

from apps.tabchat.models import Conversation, ConversationMember
from apps.tabtinspace.models import Agent, Device, Space, SpaceMembership, Organization, OrganizationMember, ProjectMembership
from apps.tabtinspace.routers.space import create_space
from apps.tabtinspace.schemas.agent import AgentCreate, AgentUpdate
from apps.tabtinspace.schemas.space import SpaceCreate
from apps.tabtinspace.services.base import ServiceError
from apps.tabtinspace.services.space_service import SpaceService
from apps.tabtinspace.signals import create_default_organization

User = get_user_model()


class WorkingDirSchemaValidationTests(SimpleTestCase):
    """working_dir 是 control_device 原生路径，后端校验不应依赖自身 OS。"""

    def test_create_space_accepts_windows_drive_path(self):
        data = SpaceCreate(
            organization_id=uuid4(),
            name="Windows Space",
            working_dir=r"C:\Users\me\proj",
            working_dir_type="code",
        )

        self.assertEqual(data.working_dir, r"C:\Users\me\proj")

    def test_create_space_accepts_windows_forward_slash_path(self):
        data = SpaceCreate(
            organization_id=uuid4(),
            name="Windows Forward Slash Space",
            working_dir="C:/Users/me/proj",
            working_dir_type="mixed",
        )

        self.assertEqual(data.working_dir, "C:/Users/me/proj")

    def test_agent_update_accepts_windows_unc_path(self):
        data = AgentUpdate(
            working_dir=r"\\server\share\proj",
            working_dir_type="doc",
        )

        self.assertEqual(data.working_dir, r"\\server\share\proj")

    def test_agent_create_accepts_windows_drive_path(self):
        data = AgentCreate(
            organization_id=uuid4(),
            name="Windows Agent",
            working_dir=r"C:\Users\me\proj",
            working_dir_type="code",
        )

        self.assertEqual(data.working_dir, r"C:\Users\me\proj")

    def test_agent_update_rejects_relative_path(self):
        with self.assertRaises(ValidationError):
            AgentUpdate(working_dir=r"projects\proj")

    def test_agent_update_rejects_windows_root_relative_path(self):
        with self.assertRaises(ValidationError):
            AgentUpdate(working_dir=r"\Users\me\proj")

    def test_agent_create_rejects_windows_drive_relative_path(self):
        with self.assertRaises(ValidationError):
            AgentCreate(
                organization_id=uuid4(),
                name="Drive Relative Agent",
                working_dir=r"C:proj",
            )

    def test_agent_create_rejects_windows_root_relative_path(self):
        with self.assertRaises(ValidationError):
            AgentCreate(
                organization_id=uuid4(),
                name="Root Relative Agent",
                working_dir=r"\foo",
            )


class _DisconnectDefaultOrganizationSignal:
    """临时 disconnect User.post_save → create_default_organization，避免测试副作用。"""

    def __enter__(self):
        post_save.disconnect(receiver=create_default_organization, sender=User)
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        post_save.connect(receiver=create_default_organization, sender=User)
        return False


class CreateBotSpaceWorkingDirRouterTests(TestCase):
    """router 层 working_dir / working_dir_type 落库回归。"""

    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._signal_guard = _DisconnectDefaultOrganizationSignal()
        cls._signal_guard.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls._signal_guard.__exit__(None, None, None)
        super().tearDownClass()

    def setUp(self):
        user_manager = User.objects.db_manager("default")
        self.owner = user_manager.create_user(
            username="wd_owner",
            email="wd-owner@test.com",
            password="testpass123",
        )
        User.objects.db_manager("postgresql").create_user(
            id=self.owner.id,
            username="wd_owner",
            email="wd-owner@test.com",
            password="testpass123",
        )
        self.organization = Organization.objects.create(
            name="WorkingDir Router Team",
            owner_id=self.owner.id,
            is_default=False,
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.owner,
            role="owner",
        )
        self.device = Device.objects.create(
            organization=self.organization,
            user=self.owner,
            name="Owner Mac",
            device_type="electron",
            role="control",
            fingerprint="owner-mac-fp",
        )
        self.rf = RequestFactory()

    def _call_router(self, **extra):
        request = self.rf.post("/api/context/spaces")
        request.auth = self.owner
        data = SpaceCreate(
            organization_id=self.organization.id,
            name=extra.pop("name", "Code Space"),
            **extra,
        )
        return create_space(request, data)

    def test_router_persists_working_dir_and_type(self):
        """选了目录 + 类型 → Space.working_dir / working_dir_type 落库。"""
        status, _body = self._call_router(
            device_id=self.device.id,
            working_dir="/Users/me/proj",
            working_dir_type="code",
        )
        self.assertEqual(status, 201)

        space = Space.objects.get(name="Code Space")
        self.assertIsNotNone(space.agent_id)
        self.assertEqual(space.control_device_id, self.device.id)
        self.assertEqual(space.bound_device_id, self.device.id)
        self.assertEqual(space.working_dir, "/Users/me/proj")
        self.assertEqual(space.normalized_working_dir, "/Users/me/proj")
        self.assertEqual(space.working_dir_type, "code")
        agent = Agent.objects.get(id=space.agent_id)
        self.assertEqual(agent.type, "bot")
        self.assertEqual(agent.custom_rules, "")

    def test_router_persists_windows_working_dir_and_type(self):
        """Windows 桌面端选择的本机目录不应被 Linux/macOS 后端误判为相对路径。"""
        status, _body = self._call_router(
            name="Windows Space",
            device_id=self.device.id,
            working_dir=r"C:\Users\me\proj",
            working_dir_type="code",
        )
        self.assertEqual(status, 201)

        space = Space.objects.get(name="Windows Space")
        self.assertEqual(space.working_dir, r"C:\Users\me\proj")
        self.assertEqual(space.working_dir_type, "code")

    def test_router_rejects_missing_working_dir(self):
        """Space 是执行现场；缺工作目录不能创建。"""
        response = self._call_router(
            name="Bare Space",
            device_id=self.device.id,
        )

        self.assertEqual(response.status_code, 400)
        self.assertFalse(Space.objects.filter(name="Bare Space").exists())

    def test_router_rejects_missing_device(self):
        """Space 是执行现场；缺执行设备不能创建。"""
        response = self._call_router(
            name="No Device Space",
            working_dir="/Users/me/proj",
            working_dir_type="mixed",
        )

        self.assertEqual(response.status_code, 400)
        self.assertFalse(Space.objects.filter(name="No Device Space").exists())

    def test_router_creates_team_space_without_owner_execution(self):
        """分层模型：Project（team_space 房间）不再绑定 Owner 执行空间。

        执行落到成员各自的 Workspace（见 principle/workspace-project.md）；
        创建时无需选择、也不建立 owner 执行绑定。
        """
        status, _body = self._call_router(
            name="Launch Team Space",
            type=Space.SpaceType.TEAM_SPACE,
        )

        self.assertEqual(status, 201)
        team_space = Space.objects.get(name="Launch Team Space")
        self.assertEqual(team_space.type, Space.SpaceType.TEAM_SPACE)
        self.assertIsNone(team_space.execution_space_id)
        self.assertIsNone(team_space.control_device_id)
        self.assertEqual(team_space.working_dir, "")
        self.assertTrue(
            ProjectMembership.objects.filter(
                project=team_space,
                user_id=self.owner.id,
                role="owner",
            ).exists()
        )
        self.assertTrue(
            Conversation.objects.filter(space_id=team_space.id, name="#general").exists()
        )

    def test_router_team_space_ignores_legacy_execution_space_param(self):
        """历史 execution_space_id 入参保留兼容但被忽略，不再建立 owner 绑定。"""
        status, _body = self._call_router(
            name="Owner Personal Space",
            device_id=self.device.id,
            working_dir="/Users/me/team-proj",
            working_dir_type="code",
        )
        self.assertEqual(status, 201)
        personal = Space.objects.get(name="Owner Personal Space")

        status, _body = self._call_router(
            name="Team Space With Legacy Param",
            type=Space.SpaceType.TEAM_SPACE,
            execution_space_id=personal.id,
        )

        self.assertEqual(status, 201)
        team_space = Space.objects.get(name="Team Space With Legacy Param")
        self.assertIsNone(team_space.execution_space_id)

    def test_router_persists_doc_type(self):
        """doc 类型同样透传（不被吞）。"""
        status, _body = self._call_router(
            name="Doc Space",
            device_id=self.device.id,
            working_dir="/Users/me/cases",
            working_dir_type="doc",
        )
        self.assertEqual(status, 201)

        space = Space.objects.get(name="Doc Space")
        self.assertEqual(space.working_dir, "/Users/me/cases")
        self.assertEqual(space.working_dir_type, "doc")

    def test_duplicate_space_names_are_allowed_when_working_dir_differs(self):
        """Space 展示名允许重复，唯一性落在当前用户的设备工作目录上。"""
        first = self._call_router(
            name="Same Name",
            device_id=self.device.id,
            working_dir="/Users/me/proj-a",
            working_dir_type="mixed",
        )
        second = self._call_router(
            name="Same Name",
            device_id=self.device.id,
            working_dir="/Users/me/proj-b",
            working_dir_type="mixed",
        )

        self.assertEqual(first[0], 201)
        self.assertEqual(second[0], 201)
        self.assertEqual(Space.objects.filter(organization=self.organization, name="Same Name").count(), 2)

    def test_same_device_working_dir_must_be_unique(self):
        """同组织 + 同用户 + 同设备下，一个标准化目录只能绑定一个 Space。"""
        status, _body = self._call_router(
            name="First Dir",
            device_id=self.device.id,
            working_dir="/Users/me/proj",
            working_dir_type="mixed",
        )
        self.assertEqual(status, 201)

        response = self._call_router(
            name="Second Dir",
            device_id=self.device.id,
            working_dir="/Users/me/proj/",
            working_dir_type="mixed",
        )

        self.assertEqual(response.status_code, 409)
        self.assertIn("WORKING_DIR_CONFLICT", str(response.content))

    def test_list_spaces_can_scope_to_current_device(self):
        """Space 列表支持 Team + Device 作用域。"""
        other_device = Device.objects.create(
            organization=self.organization,
            user=self.owner,
            name="Owner Mac 2",
            device_type="electron",
            role="control",
            fingerprint="owner-mac-fp-2",
        )
        self._call_router(
            name="This Device",
            device_id=self.device.id,
            working_dir="/Users/me/this-device",
            working_dir_type="mixed",
        )
        self._call_router(
            name="Other Device",
            device_id=other_device.id,
            working_dir="/Users/me/other-device",
            working_dir_type="mixed",
        )

        service = SpaceService(user=self.owner)
        spaces, total = service.list_spaces(
            organization_id=self.organization.id,
            device_id=self.device.id,
            is_archived=False,
        )

        self.assertEqual(total, 1)
        self.assertEqual(spaces[0].name, "This Device")

    def test_create_space_provisions_default_execution_agent(self):
        """Space 以 Device + working_dir 成立，同时默认带上 bot 执行身份（规则可空）。"""
        space = SpaceService(user=self.owner).create_space(
            organization_id=self.organization.id,
            name="Local Workspace",
            device_id=self.device.id,
            working_dir="/Users/me/local-workspace",
            working_dir_type="code",
        )

        self.assertIsNotNone(space)
        self.assertIsNotNone(space.agent_id)
        self.assertEqual(space.control_device_id, self.device.id)
        self.assertEqual(space.normalized_working_dir, "/Users/me/local-workspace")

        agent = Agent.objects.get(id=space.agent_id)
        self.assertEqual(agent.type, "bot")
        self.assertEqual(agent.custom_rules, "")

        self.assertTrue(
            SpaceMembership.objects.filter(
                workspace=space,
                user_id=self.owner.id,
                role="owner",
                is_active=True,
            ).exists()
        )
        self.assertTrue(SpaceService(user=self.owner).check_space_permission(str(space.id), "editor"))

        spaces, total = SpaceService(user=self.owner).list_spaces(
            organization_id=self.organization.id,
            device_id=self.device.id,
            is_archived=False,
        )
        self.assertEqual(total, 1)
        self.assertEqual(spaces[0].id, space.id)

    def test_delete_non_last_space_does_not_delete_team_resources(self):
        """删除 Space 只清理工作现场关系，不调用团队资源删除链路。"""
        self._call_router(
            name="Keep",
            device_id=self.device.id,
            working_dir="/Users/me/keep",
            working_dir_type="mixed",
        )
        self._call_router(
            name="Delete",
            device_id=self.device.id,
            working_dir="/Users/me/delete",
            working_dir_type="mixed",
        )
        target = Space.objects.get(name="Delete")

        from unittest.mock import patch
        with patch("apps.tabtinspace.services.organization_service.OrganizationService.delete_space_resources") as delete_resources, \
             patch("apps.tabtinspace.services.trash_cleaner.TrashCleaner.release_file_usages_for_spaces") as release_files:
            self.assertTrue(
                SpaceService(user=self.owner).delete_space(target.id, acting_device_id=self.device.id)
            )
            self.assertTrue(
                SpaceService(user=self.owner).delete_space(target.id, acting_device_id=self.device.id)
            )
            delete_resources.assert_not_called()
            release_files.assert_not_called()

        self.assertFalse(Space.objects.filter(id=target.id).exists())
        self.assertEqual(Space.objects.filter(organization=self.organization).count(), 1)

    def test_delete_last_space_is_blocked_per_team_device(self):
        """每个 Team + 执行设备至少保留一个 Space。"""
        self._call_router(
            name="Only",
            device_id=self.device.id,
            working_dir="/Users/me/only",
            working_dir_type="mixed",
        )
        only = Space.objects.get(name="Only")

        with self.assertRaises(ServiceError) as ctx:
            SpaceService(user=self.owner).delete_space(only.id, acting_device_id=self.device.id)

        self.assertEqual(ctx.exception.code, "LAST_SPACE_REQUIRED")
        self.assertTrue(Space.objects.filter(id=only.id).exists())

    def test_delete_from_remote_device_is_forbidden(self):
        """Space 删除只能在执行设备本机发起；远程端或未声明设备一律拒绝。"""
        self._call_router(
            name="Keep Local",
            device_id=self.device.id,
            working_dir="/Users/me/keep-local",
            working_dir_type="mixed",
        )
        self._call_router(
            name="Delete Target",
            device_id=self.device.id,
            working_dir="/Users/me/delete-target",
            working_dir_type="mixed",
        )
        target = Space.objects.get(name="Delete Target")
        remote_device = Device.objects.create(
            organization=self.organization,
            user=self.owner,
            name="Remote Mac",
            device_type="electron",
            role="control",
            fingerprint="remote-mac-fp",
        )

        # 另一台设备（远程控制端）发起删除
        with self.assertRaises(ServiceError) as ctx:
            SpaceService(user=self.owner).delete_space(target.id, acting_device_id=remote_device.id)
        self.assertEqual(ctx.exception.code, "REMOTE_DELETE_FORBIDDEN")

        # 未声明设备（旧客户端 / 绕过 UI）同样拒绝
        with self.assertRaises(ServiceError) as ctx:
            SpaceService(user=self.owner).delete_space(target.id)
        self.assertEqual(ctx.exception.code, "REMOTE_DELETE_FORBIDDEN")

        self.assertTrue(Space.objects.filter(id=target.id).exists())

    def test_delete_execution_bound_personal_space_is_blocked_with_clear_error(self):
        """个人 Space 被团队 Space 绑为 execution_space 时，删除应返回可读错误而非 500。"""
        self._call_router(
            name="Keep Personal",
            device_id=self.device.id,
            working_dir="/Users/me/keep-personal",
            working_dir_type="mixed",
        )
        self._call_router(
            name="Exec Personal",
            device_id=self.device.id,
            working_dir="/Users/me/exec-personal",
            working_dir_type="mixed",
        )
        personal = Space.objects.get(name="Exec Personal")
        team_space = Space.objects.create(
            organization=self.organization,
            name="Team Bound",
            status="active",
            type=Space.SpaceType.TEAM_SPACE,
            execution_space=personal,
        )

        with self.assertRaises(ServiceError) as ctx:
            SpaceService(user=self.owner).delete_space(
                personal.id,
                acting_device_id=self.device.id,
            )

        self.assertEqual(ctx.exception.code, "EXECUTION_SPACE_IN_USE")
        self.assertIn("Team Bound", ctx.exception.message)
        self.assertTrue(Space.objects.filter(id=personal.id).exists())
        self.assertTrue(Space.objects.filter(id=team_space.id).exists())

    def test_delete_space_cleans_checkpoints_and_writes_audit(self):
        """删除 Space 清理 Space 级检查点（运行态），并留下 space_delete 审计。"""
        from apps.collab.models import SpaceCheckpoint
        from apps.tabtinspace.models import SpaceAdminActionLog

        self._call_router(
            name="Keep CP",
            device_id=self.device.id,
            working_dir="/Users/me/keep-cp",
            working_dir_type="mixed",
        )
        self._call_router(
            name="Delete CP",
            device_id=self.device.id,
            working_dir="/Users/me/delete-cp",
            working_dir_type="mixed",
        )
        target = Space.objects.get(name="Delete CP")
        SpaceCheckpoint.objects.create(
            organization_id=self.organization.id,
            space_id=target.id,
            name="before delete",
        )

        self.assertTrue(
            SpaceService(user=self.owner).delete_space(target.id, acting_device_id=self.device.id)
        )

        self.assertFalse(SpaceCheckpoint.objects.filter(space_id=target.id).exists())
        audit = SpaceAdminActionLog.objects.filter(
            action_type="space_delete",
            target_id=target.id,
        ).first()
        self.assertIsNotNone(audit)
        self.assertEqual(audit.operator_id, str(self.owner.id))

    def test_delete_last_space_without_device_falls_back_to_team_scope(self):
        """无执行设备的遗留 Space 退化为整个 Team 兜底，最后一个同样不可删。"""
        legacy = Space.objects.create(
            organization=self.organization,
            type=Space.SpaceType.WORKSPACE,
            name="Legacy No Device",
        )
        # 建立 owner 成员关系，使权限校验通过
        SpaceMembership.objects.create(
            workspace=legacy,
            user=self.owner,
            role="owner",
            is_active=True,
        )

        with self.assertRaises(ServiceError) as ctx:
            SpaceService(user=self.owner).delete_space(legacy.id)
        self.assertEqual(ctx.exception.code, "LAST_SPACE_REQUIRED")

        # Team 里有另一个可用 Space 后即可删除（无 device 也没有远程限制）
        self._call_router(
            name="Second Active",
            device_id=self.device.id,
            working_dir="/Users/me/second-active",
            working_dir_type="mixed",
        )
        self.assertTrue(SpaceService(user=self.owner).delete_space(legacy.id))
        self.assertFalse(Space.objects.filter(id=legacy.id).exists())


class CreateSpaceServiceErrorTests(TestCase):
    """create_space 结构化错误：不再 return None 伪装成 403。"""

    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._signal_guard = _DisconnectDefaultOrganizationSignal()
        cls._signal_guard.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls._signal_guard.__exit__(None, None, None)
        super().tearDownClass()

    def setUp(self):
        user_manager = User.objects.db_manager("default")
        self.owner = user_manager.create_user(
            username="err_owner",
            email="err-owner@test.com",
            password="testpass123",
        )
        User.objects.db_manager("postgresql").create_user(
            id=self.owner.id,
            username="err_owner",
            email="err-owner@test.com",
            password="testpass123",
        )
        self.organization = Organization.objects.create(
            name="Error Test Team",
            owner_id=self.owner.id,
            is_default=False,
        )
        OrganizationMember.objects.create(organization=self.organization, user=self.owner, role="owner")
        self.device = Device.objects.create(
            organization=self.organization,
            user=self.owner,
            name="Owner Device",
            device_type="electron",
            role="control",
            fingerprint="err-owner-fp",
        )
        self.rf = RequestFactory()

    def test_missing_device_returns_device_not_found(self):
        request = self.rf.post("/api/context/spaces")
        request.auth = self.owner
        data = SpaceCreate(
            organization_id=self.organization.id,
            name="No Device",
            device_id=uuid4(),
            working_dir="/Users/me/nodevice",
            working_dir_type="mixed",
        )
        response = create_space(request, data)
        self.assertEqual(response.status_code, 404)
        self.assertIn("DEVICE_NOT_FOUND", str(response.content))

    def test_service_raises_on_invalid_agent(self):
        service = SpaceService(user=self.owner)
        with self.assertRaises(ServiceError) as ctx:
            service.create_space(
                organization_id=self.organization.id,
                name="Bad Agent",
                agent_id=uuid4(),
                device_id=self.device.id,
                working_dir="/Users/me/bad-agent",
                working_dir_type="mixed",
            )
        self.assertEqual(ctx.exception.code, "AGENT_NOT_FOUND")
        self.assertEqual(ctx.exception.status, 404)
