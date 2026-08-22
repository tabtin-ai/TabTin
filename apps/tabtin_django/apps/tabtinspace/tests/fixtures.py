"""tabtinspace 测试 fixture helper（L24.2 修复）。

为 W1.5 E2E 与 R11 真表性能 baseline 提供统一的 Organization → Agent → Space
完整链路构造与清理工具。Agent 关联仅用于兼容旧执行身份链路，不再是 Space
成立的前提。

设计目标
--------

1. **可复用**：测试与 bench 脚本统一通过本模块创建 prod-mode fixture。
2. **轻量**：直接走 ``Model.objects.using(...).create(...)``，绕过
   ``OrganizationService.provision_organization_defaults`` 的 billing / extensions
   副作用，避免污染计费表与扩展安装表。
3. **可清理**：``cleanup_test_organization`` 自动级联清理 Organization + Space +
   Agent + OrganizationMember + SpaceMembership，bench / 测试结束后无残留。
4. **跨库友好**：Organization / Space / Agent 在 PostgreSQL（``postgresql``
   alias），User 在 MySQL（``default``），通过显式 ``.using()`` 绑定。

使用示例
--------

pytest 风格（推荐 — 自动 cleanup）::

    from apps.tabtinspace.tests.fixtures import organization_with_agent  # 引入 fixture

    def test_my_thing(organization_with_agent):
        # yield 顺序: organization, agent, space, user
        organization, agent, space, user = organization_with_agent
        # ：现场与身份解耦；Agent 经 SpaceMembership 关联
        assert SpaceMembership.objects.filter(
            workspace_id=space.id, agent_id=agent.id,
        ).exists()
    # 自动 cleanup,删除 user

unittest 风格（手动 setUp / tearDown）::

    from django.test import TransactionTestCase
    from apps.tabtinspace.tests.fixtures import (
        create_test_organization_with_agent,
        cleanup_test_organization,
    )

    class MyTest(TransactionTestCase):
        databases = {"default", "postgresql"}

        def setUp(self):
            self.ctx = create_test_organization_with_agent()

        def tearDown(self):
            cleanup_test_organization(self.ctx["organization"])

bench 脚本风格（standalone django.setup,直接 import 使用）::

    from apps.tabtinspace.tests.fixtures import (
        create_test_organization_with_agent,
        cleanup_test_organization,
    )

    ctx = create_test_organization_with_agent(prefix="bench_a1")
    try:
        # ... 在 ctx['organization'] / ctx['space'] / ctx['agent'] / ctx['user'] 上做 bench ...
    finally:
        cleanup_test_organization(ctx["organization"], delete_user=True)

模式选择
--------

- **pytest fixture (`organization_with_agent`)**:依赖 ``pytest-django`` 的 ``db`` fixture,
  适合标准 pytest 测试用例,自动 cleanup。
- **unittest TransactionTestCase**:适合 ``django.test`` 测试,需手动管理 setUp/tearDown,
  必须设 ``databases = {"default", "postgresql"}`` 让两库都进入测试 transaction。
- **bench / standalone script**:不依赖 pytest-django,直接调 ``django.setup()`` 后用
  ``create_test_organization_with_agent`` + ``cleanup_test_organization``;落在 dev DB 上,
  cleanup 用 ``_raw_delete`` 避免跨库 cascade collector 问题。
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Optional
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db import connections, transaction

from apps.services.common.db_router import postgres_app_db_alias
from apps.tabtinspace.models import (
    Agent,
    Device,
    Organization,
    OrganizationMember,
    SpaceMembership,
    Workspace,
)

logger = logging.getLogger(__name__)

User = get_user_model()

USERS_DB_ALIAS = "default"
# 单库治理：dual 下 tabtinspace 在 postgresql alias、User 在 default(MySQL)，跨库无 FK；
# single_pg 下二者同库（default=PG），且 Organization.owner 等已是物理 FK。此处用
# postgres_app_db_alias()（single_pg→'default' / dual→'postgresql'）让 User 与
# Organization/Agent/Space 落在**同一 alias/同一测试事务**，否则 single_pg 下 postgresql
# 作为 default 的 TEST MIRROR 会与 default 处于不同事务，User 对 Organization 的 owner FK
# 检查不可见 → IntegrityError。
TABTINSPACE_DB_ALIAS = postgres_app_db_alias()


def _short_uid(prefix: str = "test") -> str:
    return f"{prefix}_{uuid4().hex[:8]}"


def create_test_user(
    *,
    email: Optional[str] = None,
    nickname: Optional[str] = None,
    prefix: str = "test",
    is_active: bool = True,
    **kwargs: Any,
) -> Any:
    """创建用于测试的 User（落在 ``default`` 数据库）。

    返回创建的 User 实例。如果 ``email`` 已存在则直接复用（idempotent）。
    """
    suffix = _short_uid(prefix)
    email = email or f"{suffix}@tabtin.test"
    existing = User.objects.using(USERS_DB_ALIAS).filter(email=email).first()
    if existing:
        if is_active and not existing.is_active:
            existing.is_active = True
            existing.save(using=USERS_DB_ALIAS, update_fields=["is_active"])
        return existing
    nickname = nickname or f"Test {suffix}"
    return User.objects.db_manager(USERS_DB_ALIAS).create_user(
        email=email,
        password="TabtinTest#2026",
        nickname=nickname,
        is_active=is_active,
        **kwargs,
    )


def create_test_organization(
    *,
    owner: Optional[Any] = None,
    name: Optional[str] = None,
    organization_type: str = Organization.OrganizationType.TEAM,
    prefix: str = "test",
    skip_member: bool = False,
    **kwargs: Any,
) -> Organization:
    """创建测试 Organization（落在 ``postgresql`` 数据库）。

    若 ``owner`` 未提供，会自动创建一个 test User。
    若 ``skip_member`` 为 False，会同时创建 owner 角色的 OrganizationMember。
    """
    owner = owner or create_test_user(prefix=prefix)
    name = name or f"WS-{_short_uid(prefix)}"
    organization = Organization.objects.using(TABTINSPACE_DB_ALIAS).create(
        name=name,
        owner_id=owner.id,
        type=organization_type,
        is_default=False,
        **kwargs,
    )
    if not skip_member:
        OrganizationMember.objects.using(TABTINSPACE_DB_ALIAS).get_or_create(
            organization_id=organization.id,
            user_id=owner.id,
            defaults={"role": "owner"},
        )
    return organization


def create_test_agent(
    *,
    organization: Organization,
    name: Optional[str] = None,
    agent_type: str = "bot",
    user: Optional[Any] = None,
    prefix: str = "test",
    **kwargs: Any,
) -> Agent:
    """创建（或复用）测试 Agent（落在 ``postgresql`` 数据库）。

    ``agent_type`` 默认 ``bot``（用于 workspace 关联）。
    传入 ``user`` 时写入 ``owner_user_id``；Agent 不再作为用户影子身份。
    """
    name = name or f"Agent-{_short_uid(prefix)}"
    user_id = getattr(user, "id", None) if user is not None else None

    if user_id is not None:
        agent, _ = Agent.objects.using(TABTINSPACE_DB_ALIAS).get_or_create(
            organization_id=organization.id,
            owner_user_id=user_id,
            name=name,
            defaults={
                "type": agent_type,
                "is_active": True,
                **kwargs,
            },
        )
        if not agent.is_active:
            agent.is_active = True
            agent.save(
                using=TABTINSPACE_DB_ALIAS,
                update_fields=["is_active", "updated_at"],
            )
        return agent

    return Agent.objects.using(TABTINSPACE_DB_ALIAS).create(
        organization_id=organization.id,
        name=name,
        type=agent_type,
        is_active=True,
        **kwargs,
    )


def create_test_bot_space(
    *,
    organization: Organization,
    agent: Agent,
    name: Optional[str] = None,
    prefix: str = "test",
    **kwargs: Any,
) -> Workspace:
    """#3266：创建带 Agent 关联的个人 Workspace（历史名 bot space）。"""
    if agent is None:
        raise ValueError("create_test_bot_space 的兼容链路需要显式传入 agent")
    if agent.organization_id != organization.id:
        raise ValueError(
            f"agent.organization_id={agent.organization_id} 与 organization.id={organization.id} 不一致"
        )
    name = name or f"BotSpace-{_short_uid(prefix)}"
    # 允许调用方传入 device；否则造一个最小 device。
    device = kwargs.pop("device", None)
    if device is None:
        device = Device.objects.using(TABTINSPACE_DB_ALIAS).create(
            organization=organization,
            user_id=kwargs.pop("created_by_id", None) or organization.owner_id,
            name=f"FixtureDevice-{prefix}",
            device_type="electron",
            role="control",
            fingerprint=f"fixture-bot-{_short_uid(prefix)}",
        )
    working_dir = kwargs.pop("working_dir", f"/tmp/fixture-bot-{_short_uid(prefix)}")
    created_by_id = kwargs.pop("created_by_id", organization.owner_id)
    # ：Workspace 不再挂 agent；身份写 SpaceMembership.agent
    workspace = Workspace.objects.using(TABTINSPACE_DB_ALIAS).create(
        organization_id=organization.id,
        device=device,
        name=name,
        working_dir=working_dir,
        normalized_working_dir=working_dir,
        created_by_id=created_by_id,
        kind=Workspace.Kind.STANDARD,
        **kwargs,
    )
    SpaceMembership.objects.using(TABTINSPACE_DB_ALIAS).get_or_create(
        workspace_id=workspace.id,
        agent_id=agent.id,
        defaults={"role": "owner", "is_active": True, "permissions": {}},
    )
    return workspace


def create_test_personal_workspace(
    *,
    organization: Organization,
    owner: Any,
    device: "Device",
    name: str,
    working_dir: str,
    working_dir_type: str = "mixed",
    visibility: str = "private",
    agent: Optional[Agent] = None,
    prefix: str = "test",
) -> Dict[str, Any]:
    """#3266 终态：为测试构造个人 Workspace + owner 成员。

    Space 表已 DROP；``visibility`` 参数保留兼容签名——共享语义由是否存在
    非 owner membership 表达（见 space_visibility）。返回
    ``{'space', 'workspace', 'membership'}``（space 与 workspace 同引用）。
    """
    from django.utils import timezone
    from apps.tabtinspace.services.membership_utils import ensure_user_membership

    workspace = Workspace.objects.using(TABTINSPACE_DB_ALIAS).create(
        organization=organization,
        device=device,
        name=name,
        working_dir=working_dir,
        normalized_working_dir=working_dir,
        working_dir_type=working_dir_type,
        created_by=owner,
        kind=Workspace.Kind.STANDARD,
        trust_status=Workspace.TrustStatus.TRUSTED,
        trust_source=Workspace.TrustSource.USER_CONFIRMED,
        trusted_at=timezone.now(),
    )
    membership = ensure_user_membership(workspace, owner.id, 'owner')
    if agent is not None:
        SpaceMembership.objects.using(TABTINSPACE_DB_ALIAS).get_or_create(
            workspace_id=workspace.id,
            agent_id=agent.id,
            defaults={"role": "owner", "is_active": True, "permissions": {}},
        )
    return {"space": workspace, "workspace": workspace, "membership": membership}


LEGACY_SPACE_TYPE_DM = "dm"
LEGACY_SPACE_TYPE_GROUP = "group"
LEGACY_SPACE_TYPE_TEAM = "team"


def create_legacy_team_space(
    *,
    organization: Organization,
    name: Optional[str] = None,
    prefix: str = "test",
    **kwargs: Any,
):
    """#3266：Space 表已 DROP；历史 team Space fixture 退役。"""
    raise RuntimeError(
        'create_legacy_team_space 已退役；请改用 Project.objects.create'
    )


def create_test_organization_with_agent(
    *,
    owner: Optional[Any] = None,
    organization_name: Optional[str] = None,
    agent_name: Optional[str] = None,
    space_name: Optional[str] = None,
    prefix: str = "test",
    create_space: bool = True,
    space_type: str = "bot",
    **organization_kwargs: Any,
) -> Dict[str, Any]:
    """一站式 fixture：创建 User → Organization → Agent → Space 完整链路。

    返回 dict::

        {
            "user": <User>,
            "organization": <Organization>,
            "agent": <Agent>,
            "space": <Space>,
        }

    创建 ``bot`` Space（默认）；若 ``create_space=False``，则只返回
    user/organization/agent，space=None。历史非 workspace 请显式调用
    ``create_legacy_team_space`` 并在测试中说明原因。
    """
    if space_type != "bot":
        raise ValueError(
            "create_test_organization_with_agent 只支持 workspace；"
            "legacy 非 bot 场景请显式使用 create_legacy_team_space"
        )

    user = owner or create_test_user(prefix=prefix)
    organization = create_test_organization(
        owner=user,
        name=organization_name,
        prefix=prefix,
        **organization_kwargs,
    )
    agent = create_test_agent(
        organization=organization,
        name=agent_name,
        agent_type="bot",
        prefix=prefix,
        owner_user=user,
    )

    space: Optional[Workspace] = None
    workspace: Optional[Workspace] = None
    if create_space:
        workspace = create_test_bot_space(
            organization=organization,
            agent=agent,
            name=space_name,
            prefix=prefix,
            created_by_id=user.id,
        )
        space = workspace
        SpaceMembership.objects.using(TABTINSPACE_DB_ALIAS).get_or_create(
            workspace_id=workspace.id,
            agent_id=agent.id,
            defaults={"role": "owner", "is_active": True, "permissions": {}},
        )
        SpaceMembership.objects.using(TABTINSPACE_DB_ALIAS).get_or_create(
            workspace_id=workspace.id,
            user_id=user.id,
            defaults={"role": "owner", "is_active": True, "permissions": {}},
        )

    return {
        "user": user,
        "organization": organization,
        "agent": agent,
        "space": space,
        "workspace": workspace,
    }


def _raw_delete_pg(model, **filters: Any) -> int:
    """绕过 Django ORM cascade collector,在 ``postgresql`` 上 raw DELETE。

    Django ORM 的 ``QuerySet.delete()`` 会触发 Collector,自动尝试维护
    跨库 FK 的 SET_NULL / CASCADE,但跨库时容易报 "relation does not exist"。
    本 helper 用 ``QuerySet._raw_delete()`` 跳过 Collector,只做单表 DELETE。
    """
    try:
        return model.objects.using(TABTINSPACE_DB_ALIAS).filter(
            **filters
        )._raw_delete(TABTINSPACE_DB_ALIAS)
    except Exception as exc:
        logger.warning(
            "[fixtures._raw_delete_pg] %s.delete(%s) 失败: %s",
            model.__name__, filters, exc,
        )
        return 0


def cleanup_test_organization(
    organization: Optional[Organization],
    *,
    delete_user: bool = False,
) -> None:
    """级联清理 Organization 及其所有派生资源（raw delete，绕过跨库 FK collector）。

    清理顺序（与外键依赖反向）::

        PG 库:
          TrackerRun → Tracker（model 自 Tracker 模块改名波次 3a 起统一为 Tracker；
          GoalAgendaMeta / GoalAttendee / GoalReminderDelivery 已于波次 1 下线；
          ScheduledJob / ScheduledJobRun 已于 2026-05-28 收编下线）
          SpaceMembership → Space → Agent → OrganizationMember → Organization

        MySQL 库（delete_user=True 时）:
          ChatSession（FK user_id → users_auth_user）→ User

    使用 ``QuerySet._raw_delete`` 跳过 Django Collector，避免它去 default DB
    上的 ``users_auth`` 表执行 SET_NULL 而触发 ``relation does not exist``
    错误（跨库 FK 用 ``db_constraint=False``，业务上由 signal/任务异步清理；
    测试 cleanup 不必负责跨库一致性）。

    scheduler 与 conversation 的清理本来由 charter §7 的 signal/async job 兜底；
    Layer B TransactionTestCase 真路径下 signal 不一定 fire，必须在 fixture 里
    显式删除 Goal/ChatSession 等子表行，否则 _raw_delete_pg(Space) 会被
    ``goal.space_id`` FK 拒绝（PG 默认 NO ACTION，Django 的 SET_NULL 仅是
    应用层语义），_raw_delete(User) 会被 ``chat_session.user_id`` FK 拒绝。

    ``delete_user=True`` 时会同时删除 owner User（仅当该 user 没被其他
    Organization 引用时安全）。默认 False，避免影响共享 user。
    """
    if organization is None:
        return
    organization_id = organization.id
    owner_id = organization.owner_id

    # tabtinspace_space / tabtinspace_organization 在 PG 上各被 9+ 张子表真 FK
    # 引用（scheduler.goal / scheduler_job / tabtinspace_collection /
    # tabtinspace_context_item / ...）。逐表删既容易漏（每次 app 演进新 FK
    # 都要回头改 fixture），又重复——直接 session_replication_role='replica'
    # 关 FK trigger 后 wipe；测试 cleanup 不关心 referential integrity。
    # PG 9.5+ 普通用户可设此参数（CI 用 superuser 也无碍）；session 级，仅
    # 影响当前 cleanup transaction。
    try:
        conn = connections[TABTINSPACE_DB_ALIAS]
        with transaction.atomic(using=TABTINSPACE_DB_ALIAS), conn.cursor() as cursor:
            cursor.execute("SET session_replication_role = 'replica'")
            try:
                _raw_delete_pg(
                    SpaceMembership, workspace__organization_id=organization_id,
                )
                _raw_delete_pg(Workspace, organization_id=organization_id)
                _raw_delete_pg(Agent, organization_id=organization_id)
                _raw_delete_pg(OrganizationMember, organization_id=organization_id)
                _raw_delete_pg(Organization, id=organization_id)
            finally:
                cursor.execute("SET session_replication_role = 'origin'")
    except Exception as exc:
        logger.warning(
            "[fixtures.cleanup_test_organization] 清理失败 organization=%s: %s",
            organization_id, exc, exc_info=True,
        )

    if delete_user and owner_id:
        try:
            other_organizations = (
                Organization.objects.using(TABTINSPACE_DB_ALIAS)
                .filter(owner_id=owner_id)
                .exists()
            )
            if not other_organizations:
                # users_auth_user 被 15+ 张子表的真 FK 引用（UserProfile / ApiKey
                # / Session / chat_session / credential_vault_* / ...），逐表
                # _raw_delete 又脆又冗。SET FOREIGN_KEY_CHECKS=0 把整个 user 子图
                # 一次 wipe——MySQL session 级，仅在本 cleanup transaction 期间禁用，
                # 不影响业务连接。
                conn = connections[USERS_DB_ALIAS]
                if conn.vendor == "mysql":
                    with conn.cursor() as cursor:
                        cursor.execute("SET FOREIGN_KEY_CHECKS=0")
                        try:
                            User.objects.using(USERS_DB_ALIAS).filter(
                                id=owner_id
                            )._raw_delete(USERS_DB_ALIAS)
                        finally:
                            cursor.execute("SET FOREIGN_KEY_CHECKS=1")
                else:
                    User.objects.using(USERS_DB_ALIAS).filter(
                        id=owner_id
                    )._raw_delete(USERS_DB_ALIAS)
        except Exception as exc:
            logger.warning(
                "[fixtures.cleanup_test_organization] 删除 owner User 失败 owner=%s: %s",
                owner_id, exc, exc_info=True,
            )


# ── pytest fixture（可选，用于 pytest 测试模块） ─────────────────────


try:
    import pytest  # noqa: F401

    @pytest.fixture()
    def test_user(db):
        """pytest fixture：创建并 yield 一个 test User。"""
        user = create_test_user()
        yield user
        try:
            User.objects.using(USERS_DB_ALIAS).filter(id=user.id).delete()
        except Exception:
            pass

    @pytest.fixture()
    def organization_with_agent(db):
        """pytest fixture：返回 (organization, agent, space, user)，自动清理。"""
        ctx = create_test_organization_with_agent()
        yield ctx["organization"], ctx["agent"], ctx["space"], ctx["user"]
        cleanup_test_organization(ctx["organization"], delete_user=True)

except ImportError:  # pragma: no cover
    pass


__all__ = [
    "USERS_DB_ALIAS",
    "TABTINSPACE_DB_ALIAS",
    "cleanup_test_organization",
    "create_legacy_team_space",
    "create_test_agent",
    "create_test_bot_space",
    "create_test_personal_workspace",
    "create_test_user",
    "create_test_organization",
    "create_test_organization_with_agent",
    "LEGACY_SPACE_TYPE_DM",
    "LEGACY_SPACE_TYPE_GROUP",
    "LEGACY_SPACE_TYPE_TEAM",
]
