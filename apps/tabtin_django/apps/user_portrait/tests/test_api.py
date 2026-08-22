"""
USER 画像 · API 端点集成测试（/#4118 画像 per-Agent 化）

参考 ``apps/tins/tests/test_api.py`` 的模式：
  - 独立 NinjaAPI 实例 + Django 测试 Client；
  - mock JWTAuth.authenticate 绕过真实 JWT，直接返回 fake user；
  - 用扩展 settings（settings_user_portrait_integration_test）让
    fake_tabtinspace 注册的 Organization / OrganizationMember 模型可用，
    成员校验是真路径（不是 mock）。

#4090/#4118 补充：
  - 所有端点新增 ``agent_id`` 查询参数——画像按 Agent 完全隔离；
  - ``_memory_enabled`` 依赖 tabmemo（integration settings 未装），统一 patch
    掉——记忆门闸的真实读取由 record_style 单测覆盖，这里只验画像端点的
    per-Agent 契约与门控分支；
  - ``_resolve_agent_scope`` 的 Agent 归属校验在 integration settings（无
    agent.Agent 模型）下 graceful-skip，故任意合法 agent_id UUID 均可。

覆盖：
  - JWT 认证缺失 → 401
  - JWT 合法但非 organization 成员 → 403
  - JWT 合法且是 owner / member → 200，4 个端点正常路径（带 agent_id）
  - 缺失 agent_id → 400（fail-closed，不返回跨 Agent 聚合）
  - 记忆总闸关闭 → GET 返回空 content_md + memory_enabled=False + 不落库
  - 跨 Agent 隔离：Agent A 的 hint 不出现在 Agent B 的画像
  - POST /distill 在已 pending 状态 → 409
  - POST /hint 空 / 超长 → 400
  - organization_id 非法 UUID → 400
"""

from __future__ import annotations

import json
import uuid
from unittest.mock import patch

import pytest
from django.apps import apps as django_apps
from django.test import Client, TestCase, override_settings
from django.urls import path
from ninja import NinjaAPI

# API 集成测试同样依赖 fake_tabtinspace；其他 settings 下整模块跳过。
if not django_apps.is_installed("apps.user_portrait.tests._fake_tabtinspace"):
    pytest.skip(
        "test_api 需要 settings_user_portrait_integration_test "
        "（装载 fake tabtinspace 模型）",
        allow_module_level=True,
    )

from apps.user_portrait.api import router as user_portrait_router  # noqa: E402
from apps.user_portrait.constants import USER_PORTRAIT_DB  # noqa: E402
from apps.user_portrait.models import UserPortrait  # noqa: E402
from apps.user_portrait.services.portrait_service import UserPortraitService  # noqa: E402
from apps.user_portrait.tests._fake_tabtinspace.models import (  # noqa: E402
    Organization,
    OrganizationMember,
)
from apps.users.auth.models import User  # noqa: E402


_test_api = NinjaAPI(
    title="UserPortraitTestAPI",
    urls_namespace="user_portrait_test",
)
_test_api.add_router("/user-portrait", user_portrait_router)

urlpatterns = [path("api/", _test_api.urls)]


def _auth_patcher(user):
    """让 JWTAuth.authenticate 直接返回指定用户，绕过 JWT/session 校验。"""
    return patch(
        "apps.users.auth.permissions.JWTAuth.authenticate",
        return_value=user,
    )


@override_settings(ROOT_URLCONF="apps.user_portrait.tests.test_api")
class UserPortraitAPIBaseTests(TestCase):
    """共享 setUp：owner / member / outsider + 一个 Organization + 一个 agent_id。"""

    databases = {"default", "postgresql"}

    def setUp(self):
        self.owner = User.objects.create_user(
            email="api_owner@portrait.test",
            password="StrongPass123!",
        )
        self.member = User.objects.create_user(
            email="api_member@portrait.test",
            password="StrongPass123!",
        )
        self.outsider = User.objects.create_user(
            email="api_outsider@portrait.test",
            password="StrongPass123!",
        )
        self.organization = Organization.objects.create(
            name="API Test Organization",
            owner_id=self.owner.id,
        )
        OrganizationMember.objects.create(
            organization_id=self.organization.id,
            user_id=self.member.id,
            role="editor",
        )
        self.client = Client()
        self.wid = str(self.organization.id)
        # /#4118：画像按 Agent 隔离——端点需 agent_id。integration settings
        # 无 agent.Agent 模型，_resolve_agent_scope graceful-skip 归属校验。
        self.aid = str(uuid.uuid4())
        # _memory_enabled 依赖 tabmemo（本 settings 未装），默认 patch 为 True；
        # 关闭态测试各自局部 patch 为 False。
        self._mem_patcher = patch(
            "apps.user_portrait.api._memory_enabled", return_value=True,
        )
        self._mem_patcher.start()
        self.addCleanup(self._mem_patcher.stop)

    @staticmethod
    def _bearer() -> dict:
        """JWT Bearer header（具体 token 不重要，被 _auth_patcher 替换掉）。"""
        return {"HTTP_AUTHORIZATION": "Bearer test-token"}

    def _q(self, extra: str = "") -> str:
        """带 agent_id 的查询串。"""
        base = f"?agent_id={self.aid}"
        return f"{base}&{extra}" if extra else base


class AuthenticationTests(UserPortraitAPIBaseTests):
    """认证缺失 / 失败 → 401。"""

    def test_get_portrait_without_auth_returns_401(self):
        resp = self.client.get(f"/api/user-portrait/me/{self.wid}{self._q()}")
        self.assertEqual(resp.status_code, 401)

    def test_post_hint_without_auth_returns_401(self):
        resp = self.client.post(
            f"/api/user-portrait/me/{self.wid}/hint{self._q()}",
            data=json.dumps({"text": "x"}),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 401)

    def test_post_distill_without_auth_returns_401(self):
        resp = self.client.post(
            f"/api/user-portrait/me/{self.wid}/distill{self._q()}",
            data=json.dumps({}),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 401)

    def test_get_snapshots_without_auth_returns_401(self):
        resp = self.client.get(f"/api/user-portrait/me/{self.wid}/snapshots{self._q()}")
        self.assertEqual(resp.status_code, 401)


class PermissionDeniedTests(UserPortraitAPIBaseTests):
    """JWT 合法但非成员 → 403。"""

    def test_outsider_get_portrait_returns_403(self):
        with _auth_patcher(self.outsider):
            resp = self.client.get(
                f"/api/user-portrait/me/{self.wid}{self._q()}",
                **self._bearer(),
            )
        self.assertEqual(resp.status_code, 403)
        body = resp.json()
        self.assertFalse(body["success"])
        self.assertEqual(body["code"], "PERMISSION_DENIED")

    def test_outsider_post_hint_returns_403(self):
        with _auth_patcher(self.outsider):
            resp = self.client.post(
                f"/api/user-portrait/me/{self.wid}/hint{self._q()}",
                data=json.dumps({"text": "evil"}),
                content_type="application/json",
                **self._bearer(),
            )
        self.assertEqual(resp.status_code, 403)

    def test_outsider_post_distill_returns_403(self):
        with _auth_patcher(self.outsider):
            resp = self.client.post(
                f"/api/user-portrait/me/{self.wid}/distill{self._q()}",
                data=json.dumps({}),
                content_type="application/json",
                **self._bearer(),
            )
        self.assertEqual(resp.status_code, 403)

    def test_outsider_get_snapshots_returns_403(self):
        with _auth_patcher(self.outsider):
            resp = self.client.get(
                f"/api/user-portrait/me/{self.wid}/snapshots{self._q()}",
                **self._bearer(),
            )
        self.assertEqual(resp.status_code, 403)


class HappyPathTests(UserPortraitAPIBaseTests):
    """成员/owner 调用 4 个端点的正常 200 路径。"""

    def test_owner_get_portrait_creates_empty(self):
        with _auth_patcher(self.owner):
            resp = self.client.get(
                f"/api/user-portrait/me/{self.wid}{self._q()}",
                **self._bearer(),
            )
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertTrue(body["success"])
        data = body["data"]
        self.assertEqual(data["organization_id"], self.wid)
        self.assertEqual(data["agent_id"], self.aid)
        self.assertEqual(data["user_id"], str(self.owner.id))
        self.assertEqual(data["content_md"], "")
        self.assertEqual(data["version"], 0)
        self.assertTrue(data["memory_enabled"])
        self.assertEqual(data["last_distill_status"], UserPortrait.DistillStatus.IDLE)
        self.assertEqual(data["pending_hints_count"], 0)

    def test_member_get_portrait_creates_empty(self):
        with _auth_patcher(self.member):
            resp = self.client.get(
                f"/api/user-portrait/me/{self.wid}{self._q()}",
                **self._bearer(),
            )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()["data"]
        self.assertEqual(data["user_id"], str(self.member.id))

    def test_member_post_hint_dispatches_distill(self):
        with _auth_patcher(self.member), patch(
            "apps.user_portrait.tasks.distill_portrait_task.delay",
            return_value=None,
        ) as mock_delay:
            resp = self.client.post(
                f"/api/user-portrait/me/{self.wid}/hint{self._q()}",
                data=json.dumps({"text": "我换团队了"}),
                content_type="application/json",
                **self._bearer(),
            )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()["data"]
        self.assertEqual(data["pending_hints_count"], 1)
        self.assertTrue(data["distill_dispatched"])
        mock_delay.assert_called_once()
        kwargs = mock_delay.call_args.kwargs
        self.assertEqual(kwargs["user_id"], str(self.member.id))
        self.assertEqual(kwargs["organization_id"], self.wid)
        self.assertEqual(kwargs["agent_id"], self.aid)
        self.assertEqual(kwargs["reason"], "hint")

    def test_owner_post_distill_no_materials_skips_without_dispatch(self):
        """#7117：无 hint / 记忆 / 旧画像时不入队，accepted=false。"""
        with _auth_patcher(self.owner), patch(
            "apps.user_portrait.tasks.distill_portrait_task.delay",
            return_value=None,
        ) as mock_delay:
            resp = self.client.post(
                f"/api/user-portrait/me/{self.wid}/distill{self._q()}",
                data=json.dumps({}),
                content_type="application/json",
                **self._bearer(),
            )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()["data"]
        self.assertFalse(data["accepted"])
        self.assertIn("跳过", data["message"])
        mock_delay.assert_not_called()

    def test_owner_post_distill_with_materials_accepts(self):
        """#7117：有旧画像正文时允许入队，accepted=true。"""
        UserPortraitService(user=self.owner).commit_distill_result(
            organization_id=self.wid,
            agent_id=self.aid,
            new_content_md="## 工作背景\n内容",
            trigger_reason="manual",
            input_summary={"memo_count": 0},
        )
        with _auth_patcher(self.owner), patch(
            "apps.user_portrait.tasks.distill_portrait_task.delay",
            return_value=None,
        ) as mock_delay:
            resp = self.client.post(
                f"/api/user-portrait/me/{self.wid}/distill{self._q()}",
                data=json.dumps({}),
                content_type="application/json",
                **self._bearer(),
            )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()["data"]
        self.assertTrue(data["accepted"])
        self.assertIn("整理", data["message"])
        self.assertNotIn("蒸馏", data["message"])
        self.assertEqual(mock_delay.call_args.kwargs["agent_id"], self.aid)

    def test_owner_get_snapshots_returns_empty_list(self):
        with _auth_patcher(self.owner):
            resp = self.client.get(
                f"/api/user-portrait/me/{self.wid}/snapshots{self._q()}",
                **self._bearer(),
            )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()["data"]
        self.assertEqual(data["count"], 0)
        self.assertEqual(data["items"], [])

    def test_owner_get_snapshots_after_distill(self):
        """commit_distill_result 后应该出现 snapshot（同 agent 维度）。"""
        UserPortraitService(user=self.owner).commit_distill_result(
            organization_id=self.wid,
            agent_id=self.aid,
            new_content_md="## 工作背景\n内容",
            trigger_reason="manual",
            input_summary={"memo_count": 1},
        )
        with _auth_patcher(self.owner):
            resp = self.client.get(
                f"/api/user-portrait/me/{self.wid}/snapshots{self._q()}",
                **self._bearer(),
            )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()["data"]
        self.assertEqual(data["count"], 1)
        self.assertEqual(data["items"][0]["trigger_reason"], "manual")


class AgentScopeTests(UserPortraitAPIBaseTests):
    """#4090/#4118：agent_id 必传 + per-Agent 隔离 + 记忆关闭门控。"""

    def test_get_portrait_missing_agent_id_returns_blank_200(self):
        """过渡兼容：GET 只读，缺 agent_id 返回 fail-closed 空画像（200），
        不 400 打断尚未透传 agent_id 的旧 host；且不落 portrait 行、不泄漏跨 Agent。"""
        with _auth_patcher(self.owner):
            resp = self.client.get(
                f"/api/user-portrait/me/{self.wid}",  # 无 agent_id
                **self._bearer(),
            )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()["data"]
        self.assertEqual(data["content_md"], "")
        self.assertEqual(data["agent_id"], "")
        # 未落任何 portrait 行
        self.assertFalse(
            UserPortrait.objects.using(USER_PORTRAIT_DB)
            .filter(user_id=self.owner.id, organization_id=self.wid)
            .exists()
        )

    def test_post_hint_missing_agent_id_returns_400(self):
        with _auth_patcher(self.member):
            resp = self.client.post(
                f"/api/user-portrait/me/{self.wid}/hint",  # 无 agent_id
                data=json.dumps({"text": "no agent"}),
                content_type="application/json",
                **self._bearer(),
            )
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(resp.json()["code"], "INVALID_AGENT_ID")

    def test_cross_agent_hint_isolated(self):
        """Agent A 的 hint 不出现在 Agent B 的画像里。"""
        agent_a = str(uuid.uuid4())
        agent_b = str(uuid.uuid4())
        with _auth_patcher(self.owner), patch(
            "apps.user_portrait.tasks.distill_portrait_task.delay", return_value=None,
        ):
            self.client.post(
                f"/api/user-portrait/me/{self.wid}/hint?agent_id={agent_a}",
                data=json.dumps({"text": "只属于 Agent A"}),
                content_type="application/json",
                **self._bearer(),
            )
            resp_b = self.client.get(
                f"/api/user-portrait/me/{self.wid}?agent_id={agent_b}",
                **self._bearer(),
            )
        data_b = resp_b.json()["data"]
        self.assertEqual(data_b["agent_id"], agent_b)
        self.assertEqual(data_b["pending_hints_count"], 0)

    def test_get_portrait_memory_disabled_returns_blank_and_not_generated(self):
        """记忆总闸关闭 → 返回空 content_md + memory_enabled=False + 不落 portrait 行。"""
        with _auth_patcher(self.owner), patch(
            "apps.user_portrait.api._memory_enabled", return_value=False,
        ):
            resp = self.client.get(
                f"/api/user-portrait/me/{self.wid}{self._q()}",
                **self._bearer(),
            )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()["data"]
        self.assertEqual(data["content_md"], "")
        self.assertFalse(data["memory_enabled"])
        # 关闭态不生成画像行（fail-closed）——查服务真正使用的 alias
        self.assertFalse(
            UserPortrait.objects.using(USER_PORTRAIT_DB)
            .filter(user_id=self.owner.id, organization_id=self.wid, agent_id=self.aid)
            .exists()
        )

    def test_post_hint_memory_disabled_returns_409(self):
        """记忆总闸关闭 → hint 写入被拒（MEMORY_DISABLED / 409），与 agent_memory 域一致。"""
        with _auth_patcher(self.member), patch(
            "apps.user_portrait.api._memory_enabled", return_value=False,
        ):
            resp = self.client.post(
                f"/api/user-portrait/me/{self.wid}/hint{self._q()}",
                data=json.dumps({"text": "关闭后不应写入"}),
                content_type="application/json",
                **self._bearer(),
            )
        self.assertEqual(resp.status_code, 409)
        self.assertEqual(resp.json()["code"], "MEMORY_DISABLED")

    def test_post_distill_memory_disabled_returns_409(self):
        with _auth_patcher(self.owner), patch(
            "apps.user_portrait.api._memory_enabled", return_value=False,
        ):
            resp = self.client.post(
                f"/api/user-portrait/me/{self.wid}/distill{self._q()}",
                data=json.dumps({}),
                content_type="application/json",
                **self._bearer(),
            )
        self.assertEqual(resp.status_code, 409)
        self.assertEqual(resp.json()["code"], "MEMORY_DISABLED")


class HintValidationTests(UserPortraitAPIBaseTests):
    """POST /hint 校验：空 / 超长 → 400。"""

    def test_post_hint_empty_text_returns_400(self):
        with _auth_patcher(self.member):
            resp = self.client.post(
                f"/api/user-portrait/me/{self.wid}/hint{self._q()}",
                data=json.dumps({"text": "   "}),
                content_type="application/json",
                **self._bearer(),
            )
        self.assertEqual(resp.status_code, 400)
        body = resp.json()
        self.assertFalse(body["success"])

    def test_post_hint_too_long_returns_400(self):
        with _auth_patcher(self.member):
            resp = self.client.post(
                f"/api/user-portrait/me/{self.wid}/hint{self._q()}",
                data=json.dumps({"text": "a" * 3000}),
                content_type="application/json",
                **self._bearer(),
            )
        self.assertEqual(resp.status_code, 400)
        body = resp.json()
        self.assertEqual(body["code"], "INVALID_HINT")


class DistillInProgressTests(UserPortraitAPIBaseTests):
    """POST /distill 在已 pending 状态 → 409。"""

    def test_distill_returns_409_when_already_pending(self):
        UserPortraitService(user=self.owner).mark_distill_pending(self.wid, self.aid)

        with _auth_patcher(self.owner):
            resp = self.client.post(
                f"/api/user-portrait/me/{self.wid}/distill{self._q()}",
                data=json.dumps({}),
                content_type="application/json",
                **self._bearer(),
            )
        self.assertEqual(resp.status_code, 409)
        body = resp.json()
        self.assertFalse(body["success"])
        self.assertEqual(body["code"], "DISTILL_IN_PROGRESS")


class OrganizationIdValidationTests(UserPortraitAPIBaseTests):
    """organization_id 非法 UUID → 400（先于 agent 校验）。"""

    def test_get_portrait_invalid_organization_id_returns_400(self):
        with _auth_patcher(self.owner):
            resp = self.client.get(
                f"/api/user-portrait/me/not-a-uuid{self._q()}",
                **self._bearer(),
            )
        self.assertEqual(resp.status_code, 400)
        body = resp.json()
        self.assertEqual(body["code"], "INVALID_ORGANIZATION_ID")

    def test_post_hint_invalid_organization_id_returns_400(self):
        with _auth_patcher(self.member):
            resp = self.client.post(
                f"/api/user-portrait/me/not-a-uuid/hint{self._q()}",
                data=json.dumps({"text": "ok"}),
                content_type="application/json",
                **self._bearer(),
            )
        self.assertEqual(resp.status_code, 400)
        body = resp.json()
        self.assertEqual(body["code"], "INVALID_ORGANIZATION_ID")


class PendingHintsCountReflectsServerStateTests(UserPortraitAPIBaseTests):
    """连续提交 hint 后，GET 端点的 pending_hints_count 必须跟服务器一致。"""

    def test_pending_hints_count_increments(self):
        with _auth_patcher(self.member), patch(
            "apps.user_portrait.tasks.distill_portrait_task.delay",
            return_value=None,
        ):
            for i in range(3):
                self.client.post(
                    f"/api/user-portrait/me/{self.wid}/hint{self._q()}",
                    data=json.dumps({"text": f"hint {i}"}),
                    content_type="application/json",
                    **self._bearer(),
                )
            resp = self.client.get(
                f"/api/user-portrait/me/{self.wid}{self._q()}",
                **self._bearer(),
            )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()["data"]
        self.assertEqual(data["pending_hints_count"], 3)


class CrossOrganizationIsolationViaApiTests(UserPortraitAPIBaseTests):
    """API 层 + 成员校验合在一起的隔离不变量。"""

    def test_owner_cannot_access_other_organization_via_api(self):
        """owner 是 organization_a 的所有者，但访问 organization_b → 403（不漏数据）。"""
        other_owner = User.objects.create_user(
            email="other_owner@portrait.test",
            password="StrongPass123!",
        )
        other_wt = Organization.objects.create(
            name="Other Organization",
            owner_id=other_owner.id,
        )

        with _auth_patcher(self.owner):
            resp = self.client.get(
                f"/api/user-portrait/me/{other_wt.id}{self._q()}",
                **self._bearer(),
            )
        self.assertEqual(resp.status_code, 403)

    def test_member_in_a_cannot_post_hint_to_b(self):
        random_organization = uuid.uuid4()
        with _auth_patcher(self.member):
            resp = self.client.post(
                f"/api/user-portrait/me/{random_organization}/hint{self._q()}",
                data=json.dumps({"text": "leak"}),
                content_type="application/json",
                **self._bearer(),
            )
        self.assertEqual(resp.status_code, 403)
