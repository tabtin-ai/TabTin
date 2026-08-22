"""设置 IA Phase 1·1C — MCP 后端模型单测。

覆盖范围（任务验收清单）：
- ``MCPConnection.save()`` 归属 → scope 归一（device→local / organization→remote）；
- ``MCPConnection.clean()`` 本地 vs 远程归属互斥四分支校验；
- partial ``UniqueConstraint``：(device,name) / (organization,name) 同归属下 name 唯一；
- ``SecureCredential`` 凭据 Fernet 加密读写（set_value/get_value 往返）；
- ``SecureCredential`` 新增 ``api_key`` 类型 + ``device`` 外键（仅本机用凭证下沉设备级）；
- ``MCPConnectionService`` 端到端：create（带加密凭据）/ list / update / record_probe / delete。

跑法（借用主目录 venv，单文件自动路由到 in-memory SQLite 隔离 settings）::

    cd apps/tabtin_django
    <venv>/bin/python -m pytest apps/tabtinspace/tests/test_mcp_connection.py -q

本文件经 root conftest 的 ``_ISOLATED_SETTINGS_HINTS`` 自动切到
``tabtin.settings_share_test``（双 in-memory SQLite + syncdb，绕开本地 PG/MySQL），
并在 ``_ISOLATED_TEST_FILES`` 硬排除于主 settings 默认 suite。
"""
from __future__ import annotations

from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.test import RequestFactory, SimpleTestCase, TestCase

from apps.tabtinspace.models import Device, MCPConnection, RemoteServer, SecureCredential
from apps.tabtinspace.services.base import ServiceError
from apps.tabtinspace.services.mcp_connection_service import MCPConnectionService
from apps.tabtinspace.tests.fixtures import create_test_user, create_test_organization

PG = "postgresql"


class MCPConnectionShareContractTests(SimpleTestCase):
    """组织精选快照的分享者归属不依赖数据库测试现场。"""

    @patch("apps.tabtinspace.services.mcp_connection_service.postgres_app_db_alias", return_value="default")
    @patch("apps.tabtinspace.services.mcp_connection_service.transaction.atomic", return_value=nullcontext())
    @patch("apps.tabtinspace.services.mcp_connection_service.MCPConnection")
    @patch("apps.tabtinspace.services.mcp_connection_service.Organization")
    def test_create_org_connection_records_exact_sharer(
        self,
        organization_model,
        connection_model,
        _atomic,
        _db_alias,
    ):
        user = SimpleNamespace(id=uuid4())
        organization_id = uuid4()
        organization_model.objects.get.return_value = SimpleNamespace(id=organization_id)
        connection_model.objects.filter.return_value.exists.return_value = False
        saved_connection = MagicMock()
        connection_model.return_value = saved_connection

        service = MCPConnectionService(user=user)
        service.check_organization_permission = MagicMock(return_value=True)

        result = service.create_org_connection(
            organization_id=organization_id,
            name="snapshot",
            endpoint="https://mcp.example.com/snapshot",
        )

        self.assertIs(result, saved_connection)
        self.assertEqual(connection_model.call_args.kwargs["created_by_id"], user.id)


class _MCPBaseTestCase(TestCase):
    """共享 User → Organization → Device 链路构造。"""

    databases = {"default", "postgresql"}

    def setUp(self):
        self.user = create_test_user(prefix="mcp")
        self.organization = create_test_organization(owner=self.user, prefix="mcp")
        self.device = self._make_device("Mac-A")

    def _make_device(self, name: str) -> Device:
        return Device.objects.using(PG).create(
            organization=self.organization,
            user_id=self.user.id,
            name=name,
            device_type="electron",
            role="control",
            fingerprint=f"electron-{uuid4().hex}",
        )


class MCPConnectionScopeNormalizationTests(_MCPBaseTestCase):
    """save() 按归属归一 scope（照抄 LLMProvider 范式）。"""

    def test_device_owner_normalizes_scope_to_local(self):
        conn = MCPConnection.objects.create(
            device=self.device,
            name="local-fs",
            transport="stdio",
            command="npx",
            args=["-y", "@modelcontextprotocol/server-filesystem"],
        )
        conn.refresh_from_db()
        self.assertEqual(conn.scope, "local")
        self.assertEqual(conn.device_id, self.device.id)
        self.assertIsNone(conn.organization_id)

    def test_organization_owner_normalizes_scope_to_remote(self):
        # remote 档字段已预留：save() 归一 scope='remote'（API 本期不开放，模型层可用）。
        conn = MCPConnection.objects.create(
            organization=self.organization,
            name="remote-saas",
            transport="http",
            endpoint="https://mcp.example.com/sse",
        )
        conn.refresh_from_db()
        self.assertEqual(conn.scope, "remote")
        self.assertEqual(conn.organization_id, self.organization.id)
        self.assertIsNone(conn.device_id)


class MCPConnectionCleanValidationTests(_MCPBaseTestCase):
    """clean() 本地 vs 远程归属互斥强校验（PRD §2.3）。"""

    def test_local_only_device_passes(self):
        conn = MCPConnection(device=self.device, name="ok-local")
        conn.clean()  # 不抛即通过

    def test_remote_only_organization_passes(self):
        conn = MCPConnection(organization=self.organization, name="ok-remote")
        conn.clean()

    def test_both_owners_raises(self):
        conn = MCPConnection(device=self.device, organization=self.organization, name="both")
        with self.assertRaises(ValidationError):
            conn.clean()

    def test_neither_owner_raises(self):
        conn = MCPConnection(name="orphan")
        with self.assertRaises(ValidationError):
            conn.clean()

    def test_full_clean_also_enforced(self):
        # full_clean（ModelForm / 真实校验入口）同样走 clean()，互斥仍生效。
        conn = MCPConnection(name="orphan2")
        with self.assertRaises(ValidationError):
            conn.full_clean()


class MCPConnectionPartialUniqueTests(_MCPBaseTestCase):
    """partial UniqueConstraint：同归属下 name 唯一，跨归属互不干扰。"""

    def test_same_device_same_name_conflicts(self):
        MCPConnection.objects.create(device=self.device, name="dup")
        with self.assertRaises(IntegrityError):
            with transaction.atomic(using=PG):
                MCPConnection.objects.create(device=self.device, name="dup")

    def test_different_device_same_name_ok(self):
        other_device = self._make_device("Mac-B")
        MCPConnection.objects.create(device=self.device, name="shared-name")
        # 不同设备同名 → 不冲突（partial index 仅约束 (device,name)）。
        conn2 = MCPConnection.objects.create(device=other_device, name="shared-name")
        self.assertIsNotNone(conn2.id)

    def test_same_organization_same_name_conflicts(self):
        MCPConnection.objects.create(organization=self.organization, name="rdup")
        with self.assertRaises(IntegrityError):
            with transaction.atomic(using=PG):
                MCPConnection.objects.create(organization=self.organization, name="rdup")

    def test_local_and_remote_same_name_ok(self):
        # device 档与 organization 档同名互不干扰（两个独立 partial 唯一索引）。
        MCPConnection.objects.create(device=self.device, name="x")
        conn2 = MCPConnection.objects.create(organization=self.organization, name="x")
        self.assertEqual(conn2.scope, "remote")


class SecureCredentialApiKeyDeviceTests(_MCPBaseTestCase):
    """SecureCredential 新增 api_key 类型 + device 外键 + Fernet 加解密。"""

    def test_api_key_type_and_device_fk_persist(self):
        cred = SecureCredential.objects.using(PG).create(
            organization=self.organization,
            user_id=self.user.id,
            device=self.device,
            name="mcp-token",
            credential_type="api_key",
            encrypted_value="",
        )
        cred.refresh_from_db()
        self.assertEqual(cred.credential_type, "api_key")
        self.assertEqual(cred.device_id, self.device.id)
        # 反向 related_name 可达。
        self.assertEqual(
            list(self.device.secure_credentials_device.values_list("id", flat=True)),
            [cred.id],
        )

    def test_set_get_value_roundtrip_and_ciphertext_differs(self):
        plain = "test-api-key柰"
        cred = SecureCredential.objects.using(PG).create(
            organization=self.organization,
            user_id=self.user.id,
            device=self.device,
            name="mcp-secret",
            credential_type="api_key",
            encrypted_value="",
        )
        cred.set_value(plain)
        cred.save(update_fields=["encrypted_value"])

        # 落库密文不是明文。
        self.assertNotEqual(cred.encrypted_value, plain)
        self.assertTrue(cred.encrypted_value)

        # 从 DB 重新取出仍能解密回明文。
        reloaded = SecureCredential.objects.using(PG).get(id=cred.id)
        self.assertEqual(reloaded.get_value(), plain)

    def test_device_nullable_keeps_backward_compat(self):
        # device 可空：现有 organization+user 归属的 ssh 凭据不受影响。
        cred = SecureCredential.objects.using(PG).create(
            organization=self.organization,
            user_id=self.user.id,
            name="legacy-ssh",
            credential_type="ssh_password",
            encrypted_value="",
        )
        cred.refresh_from_db()
        self.assertIsNone(cred.device_id)
        self.assertEqual(cred.credential_type, "ssh_password")


class MCPConnectionServiceTests(_MCPBaseTestCase):
    """MCPConnectionService 端到端（create 带加密凭据 / list / update / probe / delete）。"""

    def setUp(self):
        super().setUp()
        self.service = MCPConnectionService(user=self.user)

    def test_create_with_credential_encrypts_and_links(self):
        conn = self.service.create_connection(
            device_id=self.device.id,
            name="fs-mcp",
            transport="stdio",
            command="npx",
            args=["-y", "server-filesystem", "/tmp"],
            config={"env_keys": ["FS_ROOT"]},
            credential_value="env-secret-value",
            credential_name="fs-mcp-secret",
        )
        self.assertIsNotNone(conn)
        self.assertEqual(conn.scope, "local")
        self.assertEqual(conn.args, ["-y", "server-filesystem", "/tmp"])
        self.assertEqual(conn.config, {"env_keys": ["FS_ROOT"]})

        # 凭据：api_key 类型 + device 维度 + 明文不落 MCPConnection，可解密回原值。
        self.assertIsNotNone(conn.credential)
        self.assertEqual(conn.credential.credential_type, "api_key")
        self.assertEqual(conn.credential.device_id, self.device.id)
        self.assertEqual(conn.credential.get_value(), "env-secret-value")

    def test_create_without_credential_has_no_credential(self):
        conn = self.service.create_connection(
            device_id=self.device.id, name="no-cred",
        )
        self.assertIsNotNone(conn)
        self.assertIsNone(conn.credential_id)

    def test_create_rejects_unknown_device(self):
        # 设备不属于该用户 / 不存在 → None（router 映射 404）。
        self.assertIsNone(
            self.service.create_connection(device_id=uuid4(), name="ghost")
        )

    def test_list_scoped_to_owner_device(self):
        self.service.create_connection(device_id=self.device.id, name="c1")
        self.service.create_connection(device_id=self.device.id, name="c2")
        rows = self.service.list_connections(device_id=self.device.id)
        self.assertEqual({r.name for r in rows}, {"c1", "c2"})

    def test_update_rotates_credential(self):
        conn = self.service.create_connection(
            device_id=self.device.id, name="rot",
            credential_value="old-secret",
        )
        old_cred_id = conn.credential_id

        updated = self.service.update_connection(
            connection_id=conn.id,
            enabled=False,
            credential_value="new-secret",
        )
        self.assertFalse(updated.enabled)
        # 复用同一 SecureCredential 行，仅轮换密文。
        self.assertEqual(updated.credential_id, old_cred_id)
        self.assertEqual(updated.credential.get_value(), "new-secret")

    def test_record_probe_stores_result_only(self):
        conn = self.service.create_connection(device_id=self.device.id, name="probe-me")
        probe = {"ok": True, "tools": ["read_file", "write_file"], "latency_ms": 12}
        updated = self.service.record_probe(connection_id=conn.id, last_probe=probe)
        self.assertEqual(updated.last_probe, probe)
        updated.refresh_from_db()
        self.assertEqual(updated.last_probe["tools"], ["read_file", "write_file"])

    def test_delete_removes_connection_and_orphan_credential(self):
        conn = self.service.create_connection(
            device_id=self.device.id, name="del",
            credential_value="to-be-removed",
        )
        cred_id = conn.credential_id
        self.assertTrue(self.service.delete_connection(connection_id=conn.id))
        self.assertFalse(MCPConnection.objects.filter(id=conn.id).exists())
        # 凭据无其他引用 → 一并清理。
        self.assertFalse(SecureCredential.objects.filter(id=cred_id).exists())

    def test_create_duplicate_name_raises_service_error_400(self):
        # 撞名 (device,name)：service 把 IntegrityError 映射成 400 ServiceError，不冒 500。
        self.service.create_connection(device_id=self.device.id, name="dup")
        with self.assertRaises(ServiceError) as ctx:
            self.service.create_connection(device_id=self.device.id, name="dup")
        self.assertEqual(ctx.exception.status, 400)
        self.assertEqual(ctx.exception.code, "MCP_CONNECTION_NAME_CONFLICT")

    def test_create_duplicate_does_not_leak_orphan_credential(self):
        # 撞名回滚整笔事务：第二次带凭据的创建失败，不应漏出孤儿 SecureCredential。
        self.service.create_connection(device_id=self.device.id, name="dup2")
        cred_before = SecureCredential.objects.count()
        with self.assertRaises(ServiceError):
            self.service.create_connection(
                device_id=self.device.id, name="dup2",
                credential_value="should-roll-back",
            )
        self.assertEqual(SecureCredential.objects.count(), cred_before)


class MCPConnectionOwnerXorCheckConstraintTests(_MCPBaseTestCase):
    """DB 级 XOR CheckConstraint：绕过 clean() 的 objects.create 路径也拦得住。"""

    def test_both_owners_rejected_by_db(self):
        # 同时传 device + organization（save() 只归一 scope、不清空另一归属）→ CheckConstraint 拒。
        with self.assertRaises(IntegrityError):
            with transaction.atomic(using=PG):
                MCPConnection.objects.create(
                    device=self.device, organization=self.organization, name="both-db",
                )

    def test_neither_owner_rejected_by_db(self):
        # 两者皆空（objects.create 不调 clean）→ DB CheckConstraint 兜底拒绝。
        with self.assertRaises(IntegrityError):
            with transaction.atomic(using=PG):
                MCPConnection.objects.create(name="orphan-db")


class MCPConnectionCascadeDeleteTests(_MCPBaseTestCase):
    """device on_delete=CASCADE：设备删除 → 其 MCP 连接级联删除（不留 NULL 孤儿）。"""

    def test_device_delete_cascades_connections(self):
        conn1 = MCPConnection.objects.create(device=self.device, name="c1")
        conn2 = MCPConnection.objects.create(device=self.device, name="c2")
        # 另一台设备上的连接不应被牵连。
        other_device = self._make_device("Mac-Other")
        survivor = MCPConnection.objects.create(device=other_device, name="keep")

        self.device.delete()

        self.assertFalse(MCPConnection.objects.filter(id=conn1.id).exists())
        self.assertFalse(MCPConnection.objects.filter(id=conn2.id).exists())
        self.assertTrue(MCPConnection.objects.filter(id=survivor.id).exists())


class MCPConnectionCredentialRetentionTests(_MCPBaseTestCase):
    """删除连接时孤儿凭据清理的「负分支」：凭据仍被引用则必须保留。"""

    def setUp(self):
        super().setUp()
        self.service = MCPConnectionService(user=self.user)

    def _make_credential(self, name: str) -> SecureCredential:
        cred = SecureCredential.objects.using(PG).create(
            organization=self.organization,
            user_id=self.user.id,
            device=self.device,
            name=name,
            credential_type="api_key",
            encrypted_value="",
        )
        cred.set_value("shared-secret")
        cred.save(update_fields=["encrypted_value"])
        return cred

    def test_delete_keeps_credential_referenced_by_another_connection(self):
        cred = self._make_credential("shared-by-conns")
        conn1 = MCPConnection.objects.create(device=self.device, name="a", credential=cred)
        MCPConnection.objects.create(device=self.device, name="b", credential=cred)

        self.assertTrue(self.service.delete_connection(connection_id=conn1.id))
        # 另一个连接仍引用 → 凭据保留。
        self.assertTrue(SecureCredential.objects.filter(id=cred.id).exists())

    def test_delete_keeps_credential_referenced_by_remote_server(self):
        cred = self._make_credential("shared-with-ssh")
        conn = MCPConnection.objects.create(device=self.device, name="mcp", credential=cred)
        RemoteServer.objects.create(
            device=self.device,
            name="prod-ssh",
            host="10.0.0.1",
            port=22,
            username="root",
            auth_method="password",
            credential=cred,
        )

        self.assertTrue(self.service.delete_connection(connection_id=conn.id))
        # RemoteServer 仍引用 → 凭据保留（跨资源共享凭据不被误删）。
        self.assertTrue(SecureCredential.objects.filter(id=cred.id).exists())


class MCPConnectionCrossUserTests(_MCPBaseTestCase):
    """跨用户越权：操作他人 device 下的连接 → service 返回 None/False → router 404。"""

    def setUp(self):
        super().setUp()
        # user1（self.user）的 service
        self.service = MCPConnectionService(user=self.user)
        # user2 + 其设备 + 其连接（不属于 self.user）。
        self.other_user = create_test_user(prefix="mcp-other")
        self.other_organization = create_test_organization(owner=self.other_user, prefix="mcp-other")
        self.other_device = Device.objects.using(PG).create(
            organization=self.other_organization,
            user_id=self.other_user.id,
            name="OtherMac",
            device_type="electron",
            role="control",
            fingerprint=f"electron-{uuid4().hex}",
        )
        self.other_conn = MCPConnection.objects.create(
            device=self.other_device, name="not-yours",
        )

    def test_service_denies_cross_user_mutations(self):
        self.assertIsNone(
            self.service.update_connection(connection_id=self.other_conn.id, name="hijack")
        )
        self.assertIsNone(
            self.service.record_probe(connection_id=self.other_conn.id, last_probe={"ok": True})
        )
        self.assertFalse(self.service.delete_connection(connection_id=self.other_conn.id))
        # 他人连接仍在、未被改动。
        self.assertTrue(MCPConnection.objects.filter(id=self.other_conn.id, name="not-yours").exists())

    def test_router_returns_404_for_cross_user(self):
        from apps.tabtinspace.routers.mcp_connection import (
            delete_mcp_connection,
            probe_mcp_connection,
            update_mcp_connection,
        )
        from apps.tabtinspace.schemas.mcp_connection import (
            MCPConnectionProbe,
            MCPConnectionUpdate,
        )

        rf = RequestFactory()

        def _auth_request(path: str):
            req = rf.post(path)
            req.auth = self.user  # user1 尝试操作 user2 的连接
            return req

        resp_update = update_mcp_connection(
            _auth_request("/x"), self.other_conn.id, MCPConnectionUpdate(name="hijack"),
        )
        self.assertEqual(resp_update.status_code, 404)

        resp_delete = delete_mcp_connection(_auth_request("/x"), self.other_conn.id)
        self.assertEqual(resp_delete.status_code, 404)

        resp_probe = probe_mcp_connection(
            _auth_request("/x"), self.other_conn.id, MCPConnectionProbe(last_probe={"ok": True}),
        )
        self.assertEqual(resp_probe.status_code, 404)


class MCPConnectionRouterConflictTests(_MCPBaseTestCase):
    """router 层撞名 → 400（IntegrityError 不冒成 500）。"""

    def test_router_create_duplicate_returns_400(self):
        from apps.tabtinspace.routers.mcp_connection import create_mcp_connection
        from apps.tabtinspace.schemas.mcp_connection import MCPConnectionCreate

        rf = RequestFactory()
        req = rf.post("/x")
        req.auth = self.user

        first = create_mcp_connection(req, self.device.id, MCPConnectionCreate(name="dup-router"))
        # 首次成功返回 dict envelope（success_response）。
        self.assertIsInstance(first, dict)
        self.assertTrue(first.get("success"))

        second = create_mcp_connection(req, self.device.id, MCPConnectionCreate(name="dup-router"))
        # 撞名 → JsonResponse 400（而非 500）。
        self.assertEqual(second.status_code, 400)


class MCPConnectionOrgRemoteTests(_MCPBaseTestCase):
    """组织级 remote MCP：创建 / 列表 / runtime-config / 拒绝非 http。"""

    def setUp(self):
        super().setUp()
        self.service = MCPConnectionService(user=self.user)

    def test_create_org_http_connection(self):
        conn = self.service.create_org_connection(
            organization_id=self.organization.id,
            name="saas-mcp",
            description="团队统一远程工具",
            endpoint="https://mcp.example.com/sse",
            credential_value="org-token",
        )
        self.assertEqual(conn.scope, "remote")
        self.assertEqual(conn.transport, "http")
        self.assertEqual(conn.description, "团队统一远程工具")
        self.assertIsNone(conn.device_id)
        self.assertEqual(conn.created_by_id, self.user.id)
        self.assertEqual(conn.credential.get_value(), "org-token")
        self.assertIsNone(conn.credential.device_id)

    def test_create_org_requires_endpoint(self):
        with self.assertRaises(ServiceError) as ctx:
            self.service.create_org_connection(
                organization_id=self.organization.id,
                name="no-url",
                endpoint="",
            )
        self.assertEqual(ctx.exception.code, "MCP_CONNECTION_INVALID")

    def test_create_org_rejects_duplicate_endpoint(self):
        self.service.create_org_connection(
            organization_id=self.organization.id,
            name="first",
            endpoint="https://mcp.example.com/dup",
        )
        with self.assertRaises(ServiceError) as ctx:
            self.service.create_org_connection(
                organization_id=self.organization.id,
                name="second",
                endpoint="https://mcp.example.com/dup",
            )
        self.assertEqual(ctx.exception.code, "MCP_CONNECTION_ENDPOINT_CONFLICT")

    def test_list_org_and_runtime_config(self):
        conn = self.service.create_org_connection(
            organization_id=self.organization.id,
            name="runtime-me",
            endpoint="https://mcp.example.com/v1",
            credential_value="Bearer secret-xyz",
        )
        rows = self.service.list_org_connections(organization_id=self.organization.id)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].id, conn.id)

        runtime = self.service.get_runtime_config(connection_id=conn.id)
        self.assertEqual(runtime["endpoint"], "https://mcp.example.com/v1")
        self.assertEqual(runtime["headers"].get("Authorization"), "Bearer secret-xyz")

    def test_runtime_config_rejects_disabled_connection(self):
        conn = self.service.create_org_connection(
            organization_id=self.organization.id,
            name="disabled-runtime",
            endpoint="https://mcp.example.com/disabled",
            credential_value="secret",
            enabled=False,
        )
        with self.assertRaises(ServiceError) as ctx:
            self.service.get_runtime_config(connection_id=conn.id)
        self.assertEqual(ctx.exception.code, "MCP_CONNECTION_DISABLED")

    def test_runtime_config_http_injects_header_even_with_credential_env(self):
        conn = self.service.create_org_connection(
            organization_id=self.organization.id,
            name="env-and-header",
            endpoint="https://mcp.example.com/env",
            credential_value="token-abc",
            config={"credential_env": "MCP_TOKEN"},
        )
        runtime = self.service.get_runtime_config(connection_id=conn.id)
        self.assertEqual(runtime["env"].get("MCP_TOKEN"), "token-abc")
        self.assertEqual(runtime["headers"].get("Authorization"), "Bearer token-abc")

    def test_runtime_config_rejects_non_member(self):
        conn = self.service.create_org_connection(
            organization_id=self.organization.id,
            name="member-only",
            endpoint="https://mcp.example.com/member",
            credential_value="secret",
        )
        outsider = create_test_user(prefix="mcp-out")
        outsider_service = MCPConnectionService(user=outsider)
        with self.assertRaises(ServiceError) as ctx:
            outsider_service.get_runtime_config(connection_id=conn.id)
        self.assertEqual(ctx.exception.code, "MCP_CONNECTION_NOT_FOUND")

    def test_update_org_rejects_stdio_transport(self):
        conn = self.service.create_org_connection(
            organization_id=self.organization.id,
            name="keep-http",
            endpoint="https://mcp.example.com/v1",
        )
        with self.assertRaises(ServiceError) as ctx:
            self.service.update_connection(connection_id=conn.id, transport="stdio")
        self.assertEqual(ctx.exception.code, "MCP_CONNECTION_INVALID")
