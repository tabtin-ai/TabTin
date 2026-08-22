"""W1-B 验收测试：App 凭据消费链路打通。

覆盖新增的 ``POST /api/credential-vault/app/{credential_id}/autofill-reveal``：
  - JWT 认证（复用 ``JWTAuth``），不需要登录密码二次校验（PD-4）；
  - Category 校验：只能对 ``APP_LOGIN`` 凭据生效；
  - 速率限制：命中 ``_check_autofill_rate_limit`` 后返回 429；
  - 过期 / 停用凭据返回 410；
  - 跨用户访问其他用户凭据返回 404。

**测试边界说明**：使用 ``django.test.TestCase`` + ``django.test.Client`` +
``override_settings(ROOT_URLCONF=...)`` 在测试模块内组装独立的 NinjaAPI，
完全绕开生产 urlconf；JWTAuth.authenticate 被 patch 返回真实 User 实例，
这样 ``request.auth`` 的属性访问与生产一致（而 MagicMock 会丢失 ``id`` /
``pk`` 的真实字段语义，踩过多个坑）。
"""
from __future__ import annotations

import json
import uuid
from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import Client, TestCase, override_settings
from django.urls import path
from django.utils import timezone
from ninja import NinjaAPI

from apps.credential_vault.api import router as credential_vault_router
from apps.credential_vault.models import CredentialCategory, UserCredential


User = get_user_model()

_test_api = NinjaAPI(title="CredentialVaultTestAPI", urls_namespace="credential_vault_test")
_test_api.add_router("/credential-vault", credential_vault_router)

urlpatterns = [path("api/", _test_api.urls)]


def _auth_as(user):
    """Patch JWTAuth.authenticate → 指定 User（避免真实 JWT 链路）。"""
    return patch(
        "apps.users.auth.permissions.JWTAuth.authenticate",
        return_value=user,
    )


@override_settings(ROOT_URLCONF="apps.credential_vault.tests")
class AppAutofillRevealApiTests(TestCase):
    """W1-B 验收：新端点 ``/api/credential-vault/app/{id}/autofill-reveal``。"""

    # 避免 create_user post_save signal 踩 Organization / 其他 DB 的坑
    # 用 settings_credential_vault_test 时 tabtinspace 不在 INSTALLED_APPS，
    # signals 也不会被装载，所以 disconnect 是 best-effort。
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._tabtinspace_signal = None
        try:
            from django.db.models.signals import post_save
            from apps.tabtinspace.signals import create_default_organization
            post_save.disconnect(create_default_organization, sender=User)
            cls._tabtinspace_signal = create_default_organization
        except Exception:
            pass

    @classmethod
    def tearDownClass(cls):
        if cls._tabtinspace_signal is not None:
            from django.db.models.signals import post_save
            post_save.connect(cls._tabtinspace_signal, sender=User)
        super().tearDownClass()

    def setUp(self):
        self.client = Client()
        # 每个测试清 cache：避免跨测试的限流计数污染
        cache.clear()
        self.user = User.objects.create_user(
            username=f"w1b_user_{uuid.uuid4().hex[:8]}",
            email=f"w1b_{uuid.uuid4().hex[:8]}@example.com",
            password="test_pass_123456",
        )
        self.other_user = User.objects.create_user(
            username=f"w1b_other_{uuid.uuid4().hex[:8]}",
            email=f"other_{uuid.uuid4().hex[:8]}@example.com",
            password="other_pass_123456",
        )
        self.app_cred = UserCredential.objects.create(
            user=self.user,
            category=CredentialCategory.APP_LOGIN,
            service_name="com.tencent.mm",
            display_name="微信",
            encrypted_data={
                "username": "wx_user",
                "password": "wx_secret_xyz",
            },
            metadata={
                "app_package": "com.tencent.mm",
                "app_name": "微信",
            },
        )
        self.website_cred = UserCredential.objects.create(
            user=self.user,
            category=CredentialCategory.WEBSITE_LOGIN,
            service_name="github.com",
            display_name="GitHub",
            encrypted_data={
                "url": "https://github.com",
                "username": "me",
                "password": "gh_secret",
            },
        )

    def _post_reveal(self, cred_id) -> "Client":
        return self.client.post(
            f"/api/credential-vault/app/{cred_id}/autofill-reveal",
            content_type="application/json",
            HTTP_AUTHORIZATION="Bearer test-token",
        )

    # ── 正向路径 ─────────────────────────────────────────────────

    def test_app_autofill_reveal_returns_plaintext(self):
        """JWT-only，正常返回 ``{username, password}`` 明文。"""
        with _auth_as(self.user):
            resp = self._post_reveal(self.app_cred.id)
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertTrue(body["success"])
        # 明文字段必须完整——Agent 自动填充依赖
        self.assertEqual(body["data"]["username"], "wx_user")
        self.assertEqual(body["data"]["password"], "wx_secret_xyz")

    def test_app_autofill_reveal_does_not_require_password_body(self):
        """PD-4：autofill-reveal 不接受 / 不要求 ``password`` 字段（对齐 website）。"""
        with _auth_as(self.user):
            # 即使 body 里塞了 password 也不被当作二次校验使用
            resp = self.client.post(
                f"/api/credential-vault/app/{self.app_cred.id}/autofill-reveal",
                data=json.dumps({"password": "wrong_master_pw"}),
                content_type="application/json",
                HTTP_AUTHORIZATION="Bearer test-token",
            )
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.json()["success"])

    # ── Category / 所属权校验 ───────────────────────────────────

    def test_website_credential_id_returns_404(self):
        """website 凭据 ID 走 app 端点必须 404（category 隔离）。"""
        with _auth_as(self.user):
            resp = self._post_reveal(self.website_cred.id)
        self.assertEqual(resp.status_code, 404)
        self.assertEqual(resp.json()["code"], "NOT_FOUND")

    def test_other_users_credential_returns_404(self):
        """跨用户访问必须 404（不是 403，避免 ID 枚举攻击）。"""
        other_cred = UserCredential.objects.create(
            user=self.other_user,
            category=CredentialCategory.APP_LOGIN,
            service_name="com.other.app",
            encrypted_data={"username": "u", "password": "p"},
        )
        with _auth_as(self.user):
            resp = self._post_reveal(other_cred.id)
        self.assertEqual(resp.status_code, 404)

    def test_nonexistent_id_returns_404(self):
        with _auth_as(self.user):
            resp = self._post_reveal(uuid.uuid4())
        self.assertEqual(resp.status_code, 404)

    # ── 过期 / 停用 ─────────────────────────────────────────────

    def test_expired_credential_returns_410(self):
        """过期凭据返回 410 Gone，避免 Agent 拿到失效密码产生无效登录尝试。"""
        self.app_cred.expires_at = timezone.now() - timedelta(hours=1)
        self.app_cred.save(update_fields=["expires_at"])
        with _auth_as(self.user):
            resp = self._post_reveal(self.app_cred.id)
        self.assertEqual(resp.status_code, 410)
        self.assertEqual(resp.json()["code"], "CREDENTIAL_EXPIRED")

    def test_inactive_credential_returns_410(self):
        self.app_cred.is_active = False
        self.app_cred.save(update_fields=["is_active"])
        with _auth_as(self.user):
            resp = self._post_reveal(self.app_cred.id)
        self.assertEqual(resp.status_code, 410)
        self.assertEqual(resp.json()["code"], "CREDENTIAL_INACTIVE")

    # ── 速率限制 ───────────────────────────────────────────────

    def test_rate_limit_kicks_in_after_configured_quota(self):
        """per-user 20 次/5 分钟配额：第 21 次命中 429（与 website autofill 共用配额）。"""
        from apps.credential_vault.api import AUTOFILL_RATE_LIMIT_MAX

        with _auth_as(self.user):
            # 用完配额：前 MAX 次成功
            for _ in range(AUTOFILL_RATE_LIMIT_MAX):
                resp = self._post_reveal(self.app_cred.id)
                self.assertEqual(resp.status_code, 200)
            # 第 MAX+1 次应 429
            resp = self._post_reveal(self.app_cred.id)
        self.assertEqual(resp.status_code, 429)
        self.assertEqual(resp.json()["code"], "RATE_LIMITED")

    def test_autofill_429_has_retry_after_header_and_body(self):
        """Wave 2a 补丁 P1-1：autofill-reveal 超限 → 429 带 Retry-After + body 字段。

        与 list 端点对称，保证前端（Electron 主进程 / Android 填充）可以统一按
        ``Retry-After`` 秒数退避，不再自己估计 ``AUTOFILL_RATE_LIMIT_WINDOW``。
        """
        from apps.credential_vault.api import AUTOFILL_RATE_LIMIT_MAX
        with _auth_as(self.user):
            for _ in range(AUTOFILL_RATE_LIMIT_MAX):
                self._post_reveal(self.app_cred.id)
            resp = self._post_reveal(self.app_cred.id)
        self.assertEqual(resp.status_code, 429)
        self.assertIn("Retry-After", resp.headers)
        retry_after_header = int(resp.headers["Retry-After"])
        self.assertGreaterEqual(retry_after_header, 1)
        body = resp.json()
        self.assertEqual(body["retry_after_seconds"], retry_after_header)

    def test_rate_limit_shared_with_website_autofill(self):
        """website 与 app 共用 _check_autofill_rate_limit → 任一端点刷满都影响对方。"""
        from apps.credential_vault.api import AUTOFILL_RATE_LIMIT_MAX

        with _auth_as(self.user):
            # 把配额打在 website 端点
            for _ in range(AUTOFILL_RATE_LIMIT_MAX):
                r = self.client.post(
                    f"/api/credential-vault/website/{self.website_cred.id}/autofill-reveal",
                    content_type="application/json",
                    HTTP_AUTHORIZATION="Bearer test-token",
                )
                self.assertEqual(r.status_code, 200)
            # App 端点也应立即被限
            resp = self._post_reveal(self.app_cred.id)
        self.assertEqual(resp.status_code, 429)

    # ── 无认证 ─────────────────────────────────────────────────

    def test_missing_auth_header_returns_401(self):
        """无 JWT header 必须拒绝——JWTAuth 是 router 级默认认证。"""
        # 不 patch _auth_as：走真实 JWTAuth.authenticate，无 header 时拒绝
        resp = self.client.post(
            f"/api/credential-vault/app/{self.app_cred.id}/autofill-reveal",
            content_type="application/json",
        )
        self.assertIn(resp.status_code, (401, 403))


@override_settings(ROOT_URLCONF="apps.credential_vault.tests")
class AppAutofillRevealAuditTests(TestCase):
    """验证审计日志关键字段（不落明文密码）。"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._tabtinspace_signal = None
        try:
            from django.db.models.signals import post_save
            from apps.tabtinspace.signals import create_default_organization
            post_save.disconnect(create_default_organization, sender=User)
            cls._tabtinspace_signal = create_default_organization
        except Exception:
            pass

    @classmethod
    def tearDownClass(cls):
        if cls._tabtinspace_signal is not None:
            from django.db.models.signals import post_save
            post_save.connect(cls._tabtinspace_signal, sender=User)
        super().tearDownClass()

    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(
            username=f"audit_user_{uuid.uuid4().hex[:8]}",
            email=f"audit_{uuid.uuid4().hex[:8]}@example.com",
            password="test_pass_123",
        )
        self.cred = UserCredential.objects.create(
            user=self.user,
            category=CredentialCategory.APP_LOGIN,
            service_name="com.audit.app",
            encrypted_data={"username": "audit_u", "password": "super_secret_audit"},
        )
        self.client = Client()

    def test_success_log_does_not_contain_plaintext_password(self):
        """关键安全断言：审计日志里不能出现明文密码。"""
        with self.assertLogs("apps.credential_vault.api", level="INFO") as cm, \
             _auth_as(self.user):
            resp = self.client.post(
                f"/api/credential-vault/app/{self.cred.id}/autofill-reveal",
                content_type="application/json",
                HTTP_AUTHORIZATION="Bearer test-token",
            )
        self.assertEqual(resp.status_code, 200)
        joined = "\n".join(cm.output)
        # credential_id / app_package 应该记录，但密码明文绝不能出现
        self.assertIn(str(self.cred.id), joined)
        self.assertIn("com.audit.app", joined)
        self.assertNotIn("super_secret_audit", joined)


# ══════════════════════════════════════════════════════════════════════
# P0-1 修复验收：website autofill-reveal 对齐 app 端点
# ══════════════════════════════════════════════════════════════════════


@override_settings(ROOT_URLCONF="apps.credential_vault.tests")
class WebsiteAutofillRevealApiTests(TestCase):
    """P0-1 修复验收：``/api/credential-vault/website/{id}/autofill-reveal`` 与
    ``/app/`` 端点**语义对称**——过期 / 停用 / 不存在 / 限流返回同样的状态码
    和错误码。

    为什么这些测试是 P0：PD-4（自动允许）下 Agent 自动拿凭据，用户禁用凭据
    是"撤回许可"的唯一方式，如果 website 端点无视 is_active 就等于变相越权。
    前端 data-tools.ts 的 ``gone`` 分支也需要 410 信号来停止盲目重试。
    """

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._tabtinspace_signal = None
        try:
            from django.db.models.signals import post_save
            from apps.tabtinspace.signals import create_default_organization
            post_save.disconnect(create_default_organization, sender=User)
            cls._tabtinspace_signal = create_default_organization
        except Exception:
            pass

    @classmethod
    def tearDownClass(cls):
        if cls._tabtinspace_signal is not None:
            from django.db.models.signals import post_save
            post_save.connect(cls._tabtinspace_signal, sender=User)
        super().tearDownClass()

    def setUp(self):
        self.client = Client()
        cache.clear()
        self.user = User.objects.create_user(
            username=f"web_user_{uuid.uuid4().hex[:8]}",
            email=f"web_{uuid.uuid4().hex[:8]}@example.com",
            password="test_pass_123456",
        )
        self.other_user = User.objects.create_user(
            username=f"web_other_{uuid.uuid4().hex[:8]}",
            email=f"web_other_{uuid.uuid4().hex[:8]}@example.com",
            password="other_pass_123456",
        )
        self.website_cred = UserCredential.objects.create(
            user=self.user,
            category=CredentialCategory.WEBSITE_LOGIN,
            service_name="github.com",
            display_name="GitHub",
            encrypted_data={
                "url": "https://github.com",
                "username": "me",
                "password": "gh_secret_plaintext",
            },
        )
        self.app_cred = UserCredential.objects.create(
            user=self.user,
            category=CredentialCategory.APP_LOGIN,
            service_name="com.example.app",
            encrypted_data={"username": "u", "password": "p"},
        )

    def _post_website(self, cred_id) -> "Client":
        return self.client.post(
            f"/api/credential-vault/website/{cred_id}/autofill-reveal",
            content_type="application/json",
            HTTP_AUTHORIZATION="Bearer test-token",
        )

    def test_website_autofill_reveal_returns_plaintext(self):
        with _auth_as(self.user):
            resp = self._post_website(self.website_cred.id)
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertTrue(body["success"])
        self.assertEqual(body["data"]["password"], "gh_secret_plaintext")
        self.assertEqual(body["data"]["username"], "me")

    def test_website_expired_credential_returns_410(self):
        """P0-1：过期的 website 凭据必须返回 410 + ``CREDENTIAL_EXPIRED``。

        不修前：过期凭据仍返回 200，Agent 拿旧密码登录失败后会被 data-tools
        按"密码错"策略重试。
        """
        self.website_cred.expires_at = timezone.now() - timedelta(hours=1)
        self.website_cred.save(update_fields=["expires_at"])
        with _auth_as(self.user):
            resp = self._post_website(self.website_cred.id)
        self.assertEqual(resp.status_code, 410)
        self.assertEqual(resp.json()["code"], "CREDENTIAL_EXPIRED")

    def test_website_inactive_credential_returns_410(self):
        """P0-1：用户禁用的 website 凭据必须返回 410 + ``CREDENTIAL_INACTIVE``。

        这是 PD-4（自动允许）下用户撤回许可的唯一方式——若后端无视 is_active，
        用户禁用动作被 Agent 悄悄忽略，等于变相越权。
        """
        self.website_cred.is_active = False
        self.website_cred.save(update_fields=["is_active"])
        with _auth_as(self.user):
            resp = self._post_website(self.website_cred.id)
        self.assertEqual(resp.status_code, 410)
        self.assertEqual(resp.json()["code"], "CREDENTIAL_INACTIVE")

    def test_website_category_mismatch_returns_404(self):
        """APP 凭据 ID 走 website 端点返回 404（category 隔离）。"""
        with _auth_as(self.user):
            resp = self._post_website(self.app_cred.id)
        self.assertEqual(resp.status_code, 404)
        self.assertEqual(resp.json()["code"], "NOT_FOUND")

    def test_website_other_users_credential_returns_404(self):
        other_cred = UserCredential.objects.create(
            user=self.other_user,
            category=CredentialCategory.WEBSITE_LOGIN,
            service_name="other.example.com",
            encrypted_data={"url": "https://other.example.com", "username": "u", "password": "p"},
        )
        with _auth_as(self.user):
            resp = self._post_website(other_cred.id)
        self.assertEqual(resp.status_code, 404)

    def test_website_audit_log_does_not_leak_plaintext(self):
        """P0-1：website 端点也必须写审计日志，且不泄漏明文密码。"""
        with self.assertLogs("apps.credential_vault.api", level="INFO") as cm, \
             _auth_as(self.user):
            resp = self._post_website(self.website_cred.id)
        self.assertEqual(resp.status_code, 200)
        joined = "\n".join(cm.output)
        self.assertIn(str(self.website_cred.id), joined)
        self.assertIn("github.com", joined)
        self.assertNotIn("gh_secret_plaintext", joined)

    def test_website_expired_audit_log_includes_reason(self):
        """过期/停用分支也要写日志（不修前 website 完全没有审计）。"""
        self.website_cred.expires_at = timezone.now() - timedelta(hours=1)
        self.website_cred.save(update_fields=["expires_at"])
        with self.assertLogs("apps.credential_vault.api", level="INFO") as cm, \
             _auth_as(self.user):
            resp = self._post_website(self.website_cred.id)
        self.assertEqual(resp.status_code, 410)
        joined = "\n".join(cm.output)
        self.assertIn("expired", joined.lower())
        self.assertIn(str(self.website_cred.id), joined)


# ══════════════════════════════════════════════════════════════════════
# Wave 1.5：Skill 运行时密钥注入端点 /skill-reveal
# ══════════════════════════════════════════════════════════════════════


class DeriveEnvFromCredentialTests(TestCase):
    """``derive_env_from_credential`` 单元测试——纯函数，不依赖 DB / auth。

    为什么单独开一个测试类：映射表是 Wave 5 UI 层会读的**唯一来源**，单独校
    验让"新服务加入映射表 → 测试保证 env 正确派生"成为固定动作。
    """

    def test_openai_returns_openai_api_key(self):
        from apps.credential_vault.skill_reveal import derive_env_from_credential
        env = derive_env_from_credential(
            service_name="openai",
            encrypted_data={"api_key": "sk-test-123"},
            primary_env_hint=None,
        )
        self.assertEqual(env, {"OPENAI_API_KEY": "sk-test-123"})

    def test_openai_is_case_insensitive(self):
        from apps.credential_vault.skill_reveal import derive_env_from_credential
        env = derive_env_from_credential(
            service_name="OpenAI",
            encrypted_data={"api_key": "sk-xx-abcd"},  # P0-2: 必须 >= 8 字符
            primary_env_hint=None,
        )
        self.assertEqual(env, {"OPENAI_API_KEY": "sk-xx-abcd"})

    def test_generic_fallback_uses_primary_env_hint(self):
        """未注册服务 + 有 primary_env → 用 primary_env 作为 env 变量名。"""
        from apps.credential_vault.skill_reveal import derive_env_from_credential
        env = derive_env_from_credential(
            service_name="custom-llm",
            encrypted_data={"api_key": "pk-9-abcdef"},  # P0-2: >= 8 字符
            primary_env_hint="CUSTOM_LLM_KEY",
        )
        self.assertEqual(env, {"CUSTOM_LLM_KEY": "pk-9-abcdef"})

    def test_generic_fallback_empty_without_hint(self):
        """未注册 + 无 primary_env → 返回空字典（调用方 422 降级）。"""
        from apps.credential_vault.skill_reveal import derive_env_from_credential
        env = derive_env_from_credential(
            service_name="unknown-svc",
            encrypted_data={"api_key": "x"},
            primary_env_hint=None,
        )
        self.assertEqual(env, {})

    def test_empty_data_returns_empty(self):
        from apps.credential_vault.skill_reveal import derive_env_from_credential
        env = derive_env_from_credential(
            service_name="openai",
            encrypted_data={},
            primary_env_hint=None,
        )
        self.assertEqual(env, {})

    # ── P0-2 补丁（Wave 1.5 质疑 2）：后端最小密钥长度守门 ────────────

    def test_short_value_is_filtered_out(self):
        """短于 8 字符的 value 被丢弃（防止前端脱敏误伤）。

        短 key 场景：openai 凭据填了 `"api_key": "short"`（5 字符）→ 派生
        结果应为 **空 dict**，让 skill-reveal 端点回 422，而不是返回
        {OPENAI_API_KEY: 'short'} 让短 key 流到前端导致字面脱敏误伤。
        """
        from apps.credential_vault.skill_reveal import derive_env_from_credential
        env = derive_env_from_credential(
            service_name="openai",
            encrypted_data={"api_key": "short"},  # 5 字符，低于阈值
            primary_env_hint=None,
        )
        self.assertEqual(env, {})

    def test_exactly_eight_chars_is_accepted(self):
        """阈值边界：正好 8 字符的 value 必须通过（不能误伤合法短 key）。

        长度 == MIN_SECRET_VALUE_LENGTH 是合法的；前端 redact 阈值也是严格
        `< 8`，所以正好 8 字符会进入脱敏替换。
        """
        from apps.credential_vault.skill_reveal import derive_env_from_credential
        env = derive_env_from_credential(
            service_name="openai",
            encrypted_data={"api_key": "abc12345"},  # 正好 8 字符
            primary_env_hint=None,
        )
        self.assertEqual(env, {"OPENAI_API_KEY": "abc12345"})

    def test_generic_short_api_key_returns_empty(self):
        """非映射表服务 + 短 api_key → 整体派生失败（返回空 dict）。"""
        from apps.credential_vault.skill_reveal import derive_env_from_credential
        env = derive_env_from_credential(
            service_name="custom-llm",
            encrypted_data={"api_key": "sk1"},  # 3 字符
            primary_env_hint="CUSTOM_LLM_KEY",
        )
        self.assertEqual(env, {})


@override_settings(ROOT_URLCONF="apps.credential_vault.tests")
class SkillRevealApiTests(TestCase):
    """Wave 1.5 验收：``POST /api/credential-vault/skill-reveal``。

    **测试边界**：``_lookup_credential_id_from_space`` 在生产路径需要加载
    ``tabtinspace.services.app_settings_service.AppSettingsService``；但测试
    settings（``settings_credential_vault_test``）**不包含 tabtinspace app**，
    所以这里一律 patch 这个 helper 返回测试数据——endpoint 的职责边界就是
    "给我 credential_id，我做校验 + 派生"，绑定关系解析是另一个模块的事。
    """

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._tabtinspace_signal = None
        try:
            from django.db.models.signals import post_save
            from apps.tabtinspace.signals import create_default_organization
            post_save.disconnect(create_default_organization, sender=User)
            cls._tabtinspace_signal = create_default_organization
        except Exception:
            pass

    @classmethod
    def tearDownClass(cls):
        if cls._tabtinspace_signal is not None:
            from django.db.models.signals import post_save
            post_save.connect(cls._tabtinspace_signal, sender=User)
        super().tearDownClass()

    def setUp(self):
        self.client = Client()
        cache.clear()
        self.user = User.objects.create_user(
            username=f"sr_user_{uuid.uuid4().hex[:8]}",
            email=f"sr_{uuid.uuid4().hex[:8]}@example.com",
            password="test_pass_123456",
        )
        self.other_user = User.objects.create_user(
            username=f"sr_other_{uuid.uuid4().hex[:8]}",
            email=f"sr_o_{uuid.uuid4().hex[:8]}@example.com",
            password="other_pass",
        )
        self.api_key_cred = UserCredential.objects.create(
            user=self.user,
            category=CredentialCategory.API_KEY,
            service_name="openai",
            display_name="OpenAI (work)",
            encrypted_data={"api_key": "sk-my-secret-value-xyz"},
        )
        self.app_login_cred = UserCredential.objects.create(
            user=self.user,
            category=CredentialCategory.APP_LOGIN,
            service_name="com.tencent.mm",
            encrypted_data={"username": "u", "password": "p"},
        )
        self.space_id = uuid.uuid4().hex
        self.agent_id = uuid.uuid4().hex
        self.skill_key = "user:gpt-translate"

    def _post_reveal(
        self, *, space_id=None, agent_id=None, skill_key=None, primary_env=None
    ):
        body = {
            "space_id": space_id if space_id is not None else self.space_id,
            "agent_id": agent_id if agent_id is not None else self.agent_id,
            "skill_key": skill_key if skill_key is not None else self.skill_key,
        }
        if primary_env is not None:
            body["primary_env"] = primary_env
        return self.client.post(
            "/api/credential-vault/api-key/skill-reveal",
            data=json.dumps(body),
            content_type="application/json",
            HTTP_AUTHORIZATION="Bearer test-token",
        )

    def _patch_lookup(self, cred_id):
        """Patch 绑定解析，返回指定 credential_id（或 None 表示"未绑定"）。"""
        return patch(
            "apps.credential_vault.skill_reveal._lookup_credential_id_from_space",
            return_value=cred_id,
        )

    # ── 正向路径 ───────────────────────────────────────────────

    def test_skill_reveal_returns_env_dict(self):
        """绑定 openai 凭据的 Skill 调用 skill-reveal 返回 OPENAI_API_KEY。"""
        with _auth_as(self.user), self._patch_lookup(str(self.api_key_cred.id)):
            resp = self._post_reveal()
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertTrue(body["success"])
        self.assertEqual(body["credential_id"], str(self.api_key_cred.id))
        self.assertEqual(body["service_name"], "openai")
        self.assertEqual(body["env"], {"OPENAI_API_KEY": "sk-my-secret-value-xyz"})

    def test_primary_env_hint_used_for_unknown_service(self):
        """未在 SKILL_CREDENTIAL_ENV_MAP 的 service_name + primary_env → 按 hint 派生。"""
        cred = UserCredential.objects.create(
            user=self.user,
            category=CredentialCategory.API_KEY,
            service_name="mystery-llm",
            encrypted_data={"api_key": "mys-key-abcdefgh"},  # P0-2: >= 8 字符
        )
        with _auth_as(self.user), self._patch_lookup(str(cred.id)):
            resp = self._post_reveal(primary_env="MYSTERY_LLM_API_KEY")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["env"], {"MYSTERY_LLM_API_KEY": "mys-key-abcdefgh"})

    # ── P0-3 补丁：真实非映射表服务（deepseek）端到端 ─────────────

    def test_deepseek_non_mapped_service_e2e(self):
        """**P0-3 端到端 smoke**：非映射表服务（deepseek）+ primary_env → 200 + 正确 env。

        这是反思 3 说的"真实 Skill 验收"——P0-1 修复后，deepseek/gemini/moonshot
        等不在 SKILL_CREDENTIAL_ENV_MAP 的服务**必须**能从 primary_env hint 派
        生出正确的 env 变量。不修前：后端收到 primary_env=None → _derive_generic
        返回 {} → 422。修后：primary_env='DEEPSEEK_API_KEY' → {DEEPSEEK_API_KEY: '...'}.
        """
        cred = UserCredential.objects.create(
            user=self.user,
            category=CredentialCategory.API_KEY,
            service_name="deepseek",  # 不在 SKILL_CREDENTIAL_ENV_MAP
            display_name="DeepSeek (work)",
            encrypted_data={"api_key": "test-api-key"},
        )
        with _auth_as(self.user), self._patch_lookup(str(cred.id)):
            resp = self._post_reveal(primary_env="DEEPSEEK_API_KEY")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertTrue(body["success"])
        self.assertEqual(body["service_name"], "deepseek")
        self.assertEqual(body["env"], {"DEEPSEEK_API_KEY": "test-api-key"})

    def test_deepseek_without_primary_env_returns_422(self):
        """反例：deepseek 不传 primary_env → 422 MISSING_PRIMARY_ENV（Review G 分子码）。

        保证 P0-1 没修好时这条测试会失败——这是"线索": Skill frontmatter 未写
        primary_env 又不在映射表内，必须显式 422 而不是静默降级。
        """
        cred = UserCredential.objects.create(
            user=self.user,
            category=CredentialCategory.API_KEY,
            service_name="deepseek",
            encrypted_data={"api_key": "sk-fake-smoke-12345678"},
        )
        with _auth_as(self.user), self._patch_lookup(str(cred.id)):
            resp = self._post_reveal()  # 不传 primary_env
        self.assertEqual(resp.status_code, 422)
        self.assertEqual(resp.json()["code"], "MISSING_PRIMARY_ENV")

    # ── 错误路径 ───────────────────────────────────────────────

    def test_no_binding_returns_404(self):
        """Skill 未绑定任何 credential_id → 404 SKILL_NOT_BOUND。"""
        with _auth_as(self.user), self._patch_lookup(None):
            resp = self._post_reveal()
        self.assertEqual(resp.status_code, 404)
        self.assertEqual(resp.json()["code"], "SKILL_NOT_BOUND")

    def test_website_credential_category_returns_404(self):
        """绑定的 credential 不是 api_key 类别 → 404 NOT_FOUND（category 隔离）。"""
        with _auth_as(self.user), self._patch_lookup(str(self.app_login_cred.id)):
            resp = self._post_reveal()
        self.assertEqual(resp.status_code, 404)
        self.assertEqual(resp.json()["code"], "NOT_FOUND")

    def test_other_users_credential_returns_404(self):
        """跨用户绑定（异常数据）→ 统一 404，不泄漏凭据归属。"""
        other_cred = UserCredential.objects.create(
            user=self.other_user,
            category=CredentialCategory.API_KEY,
            service_name="openai",
            encrypted_data={"api_key": "other-sk-xxx"},
        )
        with _auth_as(self.user), self._patch_lookup(str(other_cred.id)):
            resp = self._post_reveal()
        self.assertEqual(resp.status_code, 404)

    def test_expired_credential_returns_410(self):
        self.api_key_cred.expires_at = timezone.now() - timedelta(hours=1)
        self.api_key_cred.save(update_fields=["expires_at"])
        with _auth_as(self.user), self._patch_lookup(str(self.api_key_cred.id)):
            resp = self._post_reveal()
        self.assertEqual(resp.status_code, 410)
        self.assertEqual(resp.json()["code"], "CREDENTIAL_EXPIRED")

    def test_inactive_credential_returns_410(self):
        self.api_key_cred.is_active = False
        self.api_key_cred.save(update_fields=["is_active"])
        with _auth_as(self.user), self._patch_lookup(str(self.api_key_cred.id)):
            resp = self._post_reveal()
        self.assertEqual(resp.status_code, 410)
        self.assertEqual(resp.json()["code"], "CREDENTIAL_INACTIVE")

    def test_env_derivation_failed_returns_422_missing_primary_env(self):
        """未知 service + 无 primary_env → 422 `MISSING_PRIMARY_ENV`（Review G 分子码）。"""
        cred = UserCredential.objects.create(
            user=self.user,
            category=CredentialCategory.API_KEY,
            service_name="unknown-svc",
            encrypted_data={"api_key": "k-abcdefg12"},  # 正常长度
        )
        with _auth_as(self.user), self._patch_lookup(str(cred.id)):
            resp = self._post_reveal()
        self.assertEqual(resp.status_code, 422)
        body = resp.json()
        self.assertEqual(body["code"], "MISSING_PRIMARY_ENV")
        # hint 字段可读且指向修复位置
        self.assertIn("primary_env", body["hint"])

    def test_short_secret_returns_422_short_secret_code(self):
        """短 key → 422 `SHORT_SECRET`（Review G）。"""
        cred = UserCredential.objects.create(
            user=self.user,
            category=CredentialCategory.API_KEY,
            service_name="openai",
            encrypted_data={"api_key": "sk-1"},  # 4 字符，低于 8 阈值
        )
        with _auth_as(self.user), self._patch_lookup(str(cred.id)):
            resp = self._post_reveal()
        self.assertEqual(resp.status_code, 422)
        body = resp.json()
        self.assertEqual(body["code"], "SHORT_SECRET")
        self.assertIn("8 字符", body["hint"])

    def test_invalid_primary_env_returns_422(self):
        """primary_env 非法字符（如含空格）→ 422 `INVALID_PRIMARY_ENV`（Review I）。"""
        cred = UserCredential.objects.create(
            user=self.user,
            category=CredentialCategory.API_KEY,
            service_name="mystery-svc",
            encrypted_data={"api_key": "sk-abcdefg123"},
        )
        with _auth_as(self.user), self._patch_lookup(str(cred.id)):
            resp = self._post_reveal(primary_env="MY KEY")  # 含空格
        self.assertEqual(resp.status_code, 422)
        body = resp.json()
        self.assertEqual(body["code"], "INVALID_PRIMARY_ENV")

    def test_invalid_primary_env_digit_start_returns_422(self):
        """primary_env 数字起头（不符合 POSIX env 变量名规范）→ 422。"""
        cred = UserCredential.objects.create(
            user=self.user,
            category=CredentialCategory.API_KEY,
            service_name="mystery-svc",
            encrypted_data={"api_key": "sk-abcdefg123"},
        )
        with _auth_as(self.user), self._patch_lookup(str(cred.id)):
            resp = self._post_reveal(primary_env="1INVALID_KEY")
        self.assertEqual(resp.status_code, 422)
        self.assertEqual(resp.json()["code"], "INVALID_PRIMARY_ENV")

    def test_empty_credential_returns_422(self):
        """凭据内容为空 → 422 `EMPTY_CREDENTIAL`。"""
        cred = UserCredential.objects.create(
            user=self.user,
            category=CredentialCategory.API_KEY,
            service_name="openai",
            encrypted_data={},
        )
        with _auth_as(self.user), self._patch_lookup(str(cred.id)):
            resp = self._post_reveal()
        self.assertEqual(resp.status_code, 422)
        self.assertEqual(resp.json()["code"], "EMPTY_CREDENTIAL")

    def test_primary_env_ignored_warning_for_mapped_service(self):
        """映射表服务 + 用户传了 primary_env → 200 + `warnings` 含忽略提示（Review F）。

        用户 Skill 写 `primary_env: DEEPSEEK_API_KEY` 但凭据 service_name=`openai`
        → 映射表派生 OPENAI_API_KEY，用户的 DEEPSEEK_API_KEY 被忽略 → 命令
        跑到 curl 时 `$DEEPSEEK_API_KEY` 为空，排查困难。现在端点成功返回
        同时附 warnings，resolver 可在 SYSTEM_NOTICE 里附加提示。
        """
        with _auth_as(self.user), self._patch_lookup(str(self.api_key_cred.id)):
            resp = self._post_reveal(primary_env="DEEPSEEK_API_KEY")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["env"], {"OPENAI_API_KEY": "sk-my-secret-value-xyz"})
        self.assertIn("warnings", body)
        self.assertIn("primary_env_ignored_for_mapped_service", body["warnings"])

    def test_primary_env_matches_mapped_key_no_warning(self):
        """映射表 + primary_env 恰好与派生 key 相同 → 无 warning。"""
        with _auth_as(self.user), self._patch_lookup(str(self.api_key_cred.id)):
            resp = self._post_reveal(primary_env="OPENAI_API_KEY")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        # warnings 字段要么不存在，要么空
        self.assertFalse(body.get("warnings"))

    def test_missing_space_id_returns_400(self):
        with _auth_as(self.user), self._patch_lookup(str(self.api_key_cred.id)):
            resp = self._post_reveal(space_id="")
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(resp.json()["code"], "INVALID_SPACE_SKILL")

    def test_missing_agent_id_returns_400(self):
        with _auth_as(self.user), self._patch_lookup(str(self.api_key_cred.id)):
            resp = self._post_reveal(agent_id="")
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(resp.json()["code"], "INVALID_SPACE_SKILL")

    def test_missing_skill_key_returns_400(self):
        with _auth_as(self.user), self._patch_lookup(str(self.api_key_cred.id)):
            resp = self._post_reveal(skill_key="")
        self.assertEqual(resp.status_code, 400)

    # ── 限流 ─────────────────────────────────────────────────

    def test_rate_limit_kicks_in(self):
        """第 61 次 (SKILL_REVEAL_RATE_LIMIT_MAX+1) 命中 429。"""
        from apps.credential_vault.skill_reveal import SKILL_REVEAL_RATE_LIMIT_MAX
        with _auth_as(self.user), self._patch_lookup(str(self.api_key_cred.id)):
            for _ in range(SKILL_REVEAL_RATE_LIMIT_MAX):
                r = self._post_reveal()
                self.assertEqual(r.status_code, 200)
            r = self._post_reveal()
        self.assertEqual(r.status_code, 429)
        self.assertEqual(r.json()["code"], "RATE_LIMITED")

    def test_rate_limit_independent_from_autofill(self):
        """skill-reveal 与 autofill-reveal 限流 key 独立：刷满 autofill 不影响 skill-reveal。"""
        from apps.credential_vault.api import AUTOFILL_RATE_LIMIT_MAX
        website_cred = UserCredential.objects.create(
            user=self.user,
            category=CredentialCategory.WEBSITE_LOGIN,
            service_name="github.com",
            encrypted_data={"url": "x", "username": "u", "password": "p"},
        )
        with _auth_as(self.user):
            for _ in range(AUTOFILL_RATE_LIMIT_MAX):
                r = self.client.post(
                    f"/api/credential-vault/website/{website_cred.id}/autofill-reveal",
                    content_type="application/json",
                    HTTP_AUTHORIZATION="Bearer test-token",
                )
                self.assertEqual(r.status_code, 200)
            # autofill 被打满，但 skill-reveal 不受影响
            with self._patch_lookup(str(self.api_key_cred.id)):
                r = self._post_reveal()
            self.assertEqual(r.status_code, 200)

    # ── 审计日志安全 ────────────────────────────────────────────

    def test_success_log_does_not_contain_plaintext_api_key(self):
        """关键安全断言：成功路径日志绝不能出现 api_key 明文。"""
        with self.assertLogs("apps.credential_vault.skill_reveal", level="INFO") as cm, \
             _auth_as(self.user), \
             self._patch_lookup(str(self.api_key_cred.id)):
            resp = self._post_reveal()
        self.assertEqual(resp.status_code, 200)
        joined = "\n".join(cm.output)
        # credential_id / service_name / env 变量**名**应写入
        self.assertIn(str(self.api_key_cred.id), joined)
        self.assertIn("openai", joined)
        self.assertIn("OPENAI_API_KEY", joined)
        # 明文密钥**绝不能**出现
        self.assertNotIn("sk-my-secret-value-xyz", joined)

    def test_expired_log_does_not_contain_plaintext(self):
        self.api_key_cred.expires_at = timezone.now() - timedelta(hours=1)
        self.api_key_cred.save(update_fields=["expires_at"])
        with self.assertLogs("apps.credential_vault.skill_reveal", level="INFO") as cm, \
             _auth_as(self.user), \
             self._patch_lookup(str(self.api_key_cred.id)):
            resp = self._post_reveal()
        self.assertEqual(resp.status_code, 410)
        joined = "\n".join(cm.output)
        self.assertNotIn("sk-my-secret-value-xyz", joined)

    # ── 无认证 ──────────────────────────────────────────────────

    def test_missing_auth_header_returns_401(self):
        resp = self.client.post(
            "/api/credential-vault/api-key/skill-reveal",
            data=json.dumps({
                "space_id": self.space_id,
                "agent_id": self.agent_id,
                "skill_key": self.skill_key,
            }),
            content_type="application/json",
        )
        self.assertIn(resp.status_code, (401, 403))


# ══════════════════════════════════════════════════════════════════════
# W2-PRE-3：元数据 list 端点限流
# ══════════════════════════════════════════════════════════════════════


@override_settings(ROOT_URLCONF="apps.credential_vault.tests")
class ListRateLimitTests(TestCase):
    """验证 ``GET /api/credential-vault/list`` 的 100 次/分钟 per-user 限流。

    威胁模型：JWT 泄漏后脚本化枚举凭据元数据（service_name / username
    拼用户画像）。正常 UI 远低于 100/min，不会误伤。
    """

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._tabtinspace_signal = None
        try:
            from django.db.models.signals import post_save
            from apps.tabtinspace.signals import create_default_organization
            post_save.disconnect(create_default_organization, sender=User)
            cls._tabtinspace_signal = create_default_organization
        except Exception:
            pass

    @classmethod
    def tearDownClass(cls):
        if cls._tabtinspace_signal is not None:
            from django.db.models.signals import post_save
            post_save.connect(cls._tabtinspace_signal, sender=User)
        super().tearDownClass()

    def setUp(self):
        self.client = Client()
        cache.clear()
        self.user = User.objects.create_user(
            username=f"list_rl_{uuid.uuid4().hex[:8]}",
            email=f"list_rl_{uuid.uuid4().hex[:8]}@example.com",
            password="test_pass_123456",
        )
        self.other_user = User.objects.create_user(
            username=f"list_rl_o_{uuid.uuid4().hex[:8]}",
            email=f"list_rl_o_{uuid.uuid4().hex[:8]}@example.com",
            password="other_pass_123456",
        )

    def _list(self, as_user=None):
        target = as_user or self.user
        with _auth_as(target):
            return self.client.get(
                "/api/credential-vault/list",
                HTTP_AUTHORIZATION="Bearer test-token",
            )

    def test_list_within_quota_succeeds(self):
        """正常路径：100 次以内每次都 200。"""
        for i in range(100):
            resp = self._list()
            self.assertEqual(
                resp.status_code, 200,
                f"第 {i+1} 次应成功，实际 {resp.status_code}",
            )

    def test_list_101st_call_returns_429(self):
        """第 101 次超限返回 429 + ``RATE_LIMITED``。"""
        for _ in range(100):
            self._list()
        resp = self._list()
        self.assertEqual(resp.status_code, 429)
        body = resp.json()
        self.assertEqual(body["code"], "RATE_LIMITED")
        self.assertFalse(body["success"])

    def test_list_rate_limit_is_per_user(self):
        """跨用户独立：A 用完配额不影响 B。"""
        for _ in range(100):
            self._list(as_user=self.user)
        # A 第 101 次 → 429
        self.assertEqual(self._list(as_user=self.user).status_code, 429)
        # B 第 1 次 → 200
        self.assertEqual(self._list(as_user=self.other_user).status_code, 200)

    # ══════════════════════════════════════════════════════════════
    # Wave 2a 补丁 P1-1（独立质疑 8）：429 必须带 Retry-After header + body
    # ══════════════════════════════════════════════════════════════

    def test_list_429_has_retry_after_header_and_body(self):
        """list 超限 → 429 响应的 ``Retry-After`` header 与 body
        ``retry_after_seconds`` 字段同源且非空。"""
        for _ in range(100):
            self._list()
        resp = self._list()
        self.assertEqual(resp.status_code, 429)
        # HTTP header
        self.assertIn("Retry-After", resp.headers)
        header_val = int(resp.headers["Retry-After"])
        self.assertGreaterEqual(header_val, 1)
        # body 字段（供前端 JSON schema 客户端直接展示倒计时）
        body = resp.json()
        self.assertIn("retry_after_seconds", body)
        self.assertEqual(body["retry_after_seconds"], header_val)
        self.assertEqual(body["code"], "RATE_LIMITED")

    def test_list_rate_limit_independent_from_reveal_quota(self):
        """list 与 reveal/autofill 各走独立 cache key——list 打满不会把 reveal
        配额顶掉（反之亦然）。这条保证真实用户在浏览凭据列表的高频场景下
        仍能触发 reveal 动作。
        """
        # 用 100 次 list 把 list 配额打满
        for _ in range(100):
            self._list()
        # list 下一次 429
        self.assertEqual(self._list().status_code, 429)
        # 但 reveal 的 cache key 不应被吃掉——这里不走真实 reveal（需要
        # 密码校验），只验证 ``_check_reveal_rate_limit`` 独立 key：
        from apps.credential_vault.api import (
            _check_reveal_rate_limit,
            _check_autofill_rate_limit,
        )
        ok_reveal, _ = _check_reveal_rate_limit(str(self.user.id))
        ok_autofill, _ = _check_autofill_rate_limit(str(self.user.id))
        self.assertTrue(ok_reveal, "reveal 配额应独立，未被 list 打满影响")
        self.assertTrue(ok_autofill, "autofill 配额应独立，未被 list 打满影响")


# ══════════════════════════════════════════════════════════════════════
# Wave 3 G5：SaveBlacklistEntry model + 黑名单 API（PD-8 后端持久化）
# ══════════════════════════════════════════════════════════════════════


@override_settings(ROOT_URLCONF="apps.credential_vault.tests")
class SaveBlacklistApiTests(TestCase):
    """覆盖 ``GET / POST / DELETE /api/credential-vault/save-blacklist``。

    业务场景（PRD Story 2 + Story 11）：
      - 用户在 SavePasswordBar 点"不为此网站保存" → POST → 后端持久化
      - 主进程 ``checkDomainBlacklist`` 缓存 5min ↔ GET 拉全量
      - 设置页"撤回"→ DELETE 移除特定 domain
    """

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._tabtinspace_signal = None
        try:
            from django.db.models.signals import post_save
            from apps.tabtinspace.signals import create_default_organization
            post_save.disconnect(create_default_organization, sender=User)
            cls._tabtinspace_signal = create_default_organization
        except Exception:
            pass

    @classmethod
    def tearDownClass(cls):
        if cls._tabtinspace_signal is not None:
            from django.db.models.signals import post_save
            post_save.connect(cls._tabtinspace_signal, sender=User)
        super().tearDownClass()

    def setUp(self):
        cache.clear()
        self.client = Client()
        self.user = User.objects.create_user(
            username=f"bl_user_{uuid.uuid4().hex[:8]}",
            email=f"bl_{uuid.uuid4().hex[:8]}@example.com",
            password="test_pass_123456",
        )
        self.other_user = User.objects.create_user(
            username=f"bl_other_{uuid.uuid4().hex[:8]}",
            email=f"bl_o_{uuid.uuid4().hex[:8]}@example.com",
            password="other_pass_123456",
        )

    def _post_blacklist(self, domain, as_user=None):
        target = as_user or self.user
        with _auth_as(target):
            return self.client.post(
                "/api/credential-vault/save-blacklist",
                data=json.dumps({"domain": domain}),
                content_type="application/json",
                HTTP_AUTHORIZATION="Bearer test-token",
            )

    def _get_blacklist(self, as_user=None):
        target = as_user or self.user
        with _auth_as(target):
            return self.client.get(
                "/api/credential-vault/save-blacklist",
                HTTP_AUTHORIZATION="Bearer test-token",
            )

    def _delete_blacklist(self, domain, as_user=None):
        target = as_user or self.user
        with _auth_as(target):
            return self.client.delete(
                f"/api/credential-vault/save-blacklist/{domain}",
                HTTP_AUTHORIZATION="Bearer test-token",
            )

    def test_post_creates_entry(self):
        """正常路径：POST → 200 + 返回新建条目。"""
        resp = self._post_blacklist("github.com")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["domain"], "github.com")
        self.assertIn("id", body)
        # DB 应有该条目
        from apps.credential_vault.models import SaveBlacklistEntry
        self.assertEqual(
            SaveBlacklistEntry.objects.filter(user=self.user, domain="github.com").count(), 1,
        )

    def test_post_duplicate_is_idempotent(self):
        """同一 (user, domain) POST 两次 → 第二次返回旧记录而非 422（幂等）。"""
        resp1 = self._post_blacklist("github.com")
        self.assertEqual(resp1.status_code, 200)
        first_id = resp1.json()["id"]
        resp2 = self._post_blacklist("github.com")
        self.assertEqual(resp2.status_code, 200)
        self.assertEqual(resp2.json()["id"], first_id)

    def test_post_normalizes_domain(self):
        """前导点 / 大写 / 协议头被规整：".GitHub.COM" → "github.com"。"""
        resp = self._post_blacklist(".GitHub.COM")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["domain"], "github.com")

    def test_post_rejects_invalid_domain(self):
        """缺 . 或含协议头 → 422（Pydantic 校验失败）。"""
        for bad in ["nodot", "https://github.com", "github.com/path", " ", ""]:
            resp = self._post_blacklist(bad)
            self.assertIn(resp.status_code, (400, 422), f"bad={bad!r} got {resp.status_code}")

    def test_get_lists_user_entries_only(self):
        """GET 只返回当前用户的条目，跨用户隔离。"""
        self._post_blacklist("github.com", as_user=self.user)
        self._post_blacklist("twitter.com", as_user=self.user)
        self._post_blacklist("other-user-only.com", as_user=self.other_user)

        resp = self._get_blacklist(as_user=self.user)
        self.assertEqual(resp.status_code, 200)
        domains = sorted(item["domain"] for item in resp.json())
        self.assertEqual(domains, ["github.com", "twitter.com"])

    def test_delete_removes_entry(self):
        """DELETE 移除指定 domain 的黑名单条目。"""
        self._post_blacklist("github.com")
        resp = self._delete_blacklist("github.com")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["deleted"], 1)
        # GET 应返回空
        get_resp = self._get_blacklist()
        self.assertEqual(get_resp.json(), [])

    def test_delete_normalizes_domain(self):
        """DELETE 也对 domain 做规整（与 POST 对齐）。"""
        self._post_blacklist("github.com")
        resp = self._delete_blacklist(".GitHub.COM")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["deleted"], 1)

    def test_delete_nonexistent_returns_zero_deleted(self):
        """删除不存在的条目 → 200 + deleted=0（幂等）。"""
        resp = self._delete_blacklist("never-added.com")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["deleted"], 0)

    def test_delete_other_users_entry_returns_zero(self):
        """跨用户：A 的黑名单被 B 删除 → 0（按 user 过滤，不会误删）。"""
        self._post_blacklist("github.com", as_user=self.other_user)
        resp = self._delete_blacklist("github.com", as_user=self.user)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["deleted"], 0)
        # other_user 的条目仍在
        from apps.credential_vault.models import SaveBlacklistEntry
        self.assertEqual(
            SaveBlacklistEntry.objects.filter(user=self.other_user, domain="github.com").count(), 1,
        )

    def test_unique_constraint_per_user_domain(self):
        """直接走 ORM 验证 (user, domain) 唯一约束。"""
        from django.db import IntegrityError
        from apps.credential_vault.models import SaveBlacklistEntry
        SaveBlacklistEntry.objects.create(user=self.user, domain="github.com")
        with self.assertRaises(IntegrityError):
            SaveBlacklistEntry.objects.create(user=self.user, domain="github.com")

    def test_unique_constraint_does_not_collide_across_users(self):
        """跨用户：同 domain 不同用户应都能插入。"""
        from apps.credential_vault.models import SaveBlacklistEntry
        SaveBlacklistEntry.objects.create(user=self.user, domain="github.com")
        SaveBlacklistEntry.objects.create(user=self.other_user, domain="github.com")
        self.assertEqual(SaveBlacklistEntry.objects.count(), 2)

    def test_missing_auth_header_returns_401(self):
        """无 JWT → 拒绝（router 级 JWTAuth）。"""
        resp = self.client.post(
            "/api/credential-vault/save-blacklist",
            data=json.dumps({"domain": "github.com"}),
            content_type="application/json",
        )
        self.assertIn(resp.status_code, (401, 403))


# ══════════════════════════════════════════════════════════════════════
# Wave 4 PD-10：last_used_at 字段 + match 端点排序
# ══════════════════════════════════════════════════════════════════════


@override_settings(ROOT_URLCONF="apps.credential_vault.tests")
class WebsiteMatchOrderingByLastUsedAtTests(TestCase):
    """Wave 4 PD-10 验收：

    - autofill-reveal 成功 → ``last_used_at`` 被回写为当前时间；
    - ``/website/match`` 按 ``last_used_at DESC NULLS LAST, created_at DESC`` 排
      序——多匹配场景下 Agent 后台 view 取**第一条**自动填充；
    - 失败分支（限流 / 不存在 / 过期 / 停用）**不回写** last_used_at，避免污
      染 Wave 5 设置页"最近使用"展示。

    业务理由：见 PD-10 决策记录（取 last_used 倒序第一条不阻塞 Agent；用户
    事后可在 Wave 5 设置页改默认）。
    """

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._tabtinspace_signal = None
        try:
            from django.db.models.signals import post_save
            from apps.tabtinspace.signals import create_default_organization
            post_save.disconnect(create_default_organization, sender=User)
            cls._tabtinspace_signal = create_default_organization
        except Exception:
            pass

    @classmethod
    def tearDownClass(cls):
        if cls._tabtinspace_signal is not None:
            from django.db.models.signals import post_save
            post_save.connect(cls._tabtinspace_signal, sender=User)
        super().tearDownClass()

    def setUp(self):
        cache.clear()
        self.client = Client()
        self.user = User.objects.create_user(
            username=f"lu_user_{uuid.uuid4().hex[:8]}",
            email=f"lu_{uuid.uuid4().hex[:8]}@example.com",
            password="test_pass_123456",
        )

    def _create_website_cred(self, username: str, password: str = "pw-12345678") -> "UserCredential":
        return UserCredential.objects.create(
            user=self.user,
            category=CredentialCategory.WEBSITE_LOGIN,
            service_name="example.com",
            display_name=username,
            encrypted_data={
                "url": "https://example.com",
                "username": username,
                "password": password,
            },
        )

    def _post_autofill(self, cred_id):
        return self.client.post(
            f"/api/credential-vault/website/{cred_id}/autofill-reveal",
            content_type="application/json",
            HTTP_AUTHORIZATION="Bearer test-token",
        )

    def _get_match(self, domain: str = "example.com"):
        return self.client.get(
            f"/api/credential-vault/website/match?domain={domain}",
            HTTP_AUTHORIZATION="Bearer test-token",
        )

    def test_last_used_at_is_null_initially(self):
        """新建凭据 last_used_at 为 NULL（语义：从未被使用过）。"""
        c = self._create_website_cred("alice")
        c.refresh_from_db()
        self.assertIsNone(c.last_used_at)

    def test_autofill_reveal_does_not_update_last_used_at_anymore(self):
        """Wave 5a (L-W4-4)：autofill-reveal **不再**自动写 last_used_at。

        旧 Wave 4 行为：reveal 成功就写。但 reveal 成功 ≠ fill+submit 都成功——
        DOM 异常 / 网站拒绝 / submit 失败时 last_used_at 被错误污染。
        新行为：reveal 仅返回明文，主进程在 fill+submit 全成功后调
        ``/website/{id}/mark-used`` 显式回写。
        """
        c = self._create_website_cred("alice")
        with _auth_as(self.user):
            resp = self._post_autofill(c.id)
        self.assertEqual(resp.status_code, 200)
        c.refresh_from_db()
        # Wave 5a：reveal 不再写 last_used_at（核心修复点验证）
        self.assertIsNone(
            c.last_used_at,
            "Wave 5a (L-W4-4)：reveal 成功不应再写 last_used_at；mark-used 才写",
        )

    def test_match_orders_recently_used_first(self):
        """多匹配 → /website/match 按 last_used_at DESC 排序。

        注意 SQLite 默认 NULLS FIRST 与 PG 对齐方向相反；测试通过 ``F.desc(nulls_last=True)``
        在两库都得到 NULLS LAST。
        """
        c_old = self._create_website_cred("oldest")
        c_new = self._create_website_cred("newest")

        # 用 ORM 直接设置 last_used_at（避免 reveal 限流计数干扰）
        c_old.last_used_at = timezone.now() - timedelta(hours=1)
        c_old.save(update_fields=["last_used_at"])
        c_new.last_used_at = timezone.now()
        c_new.save(update_fields=["last_used_at"])

        with _auth_as(self.user):
            resp = self._get_match()
        self.assertEqual(resp.status_code, 200)
        items = resp.json()
        self.assertEqual(len(items), 2)
        # 最新使用排第一（PD-10 自动填充选第一条）
        self.assertEqual(items[0]["username"], "newest")
        self.assertEqual(items[1]["username"], "oldest")

    def test_match_null_last_used_at_sorts_after_used(self):
        """从未使用过的凭据（NULL）排在所有"用过的"之后。"""
        c_used = self._create_website_cred("used")
        c_never = self._create_website_cred("never")
        c_used.last_used_at = timezone.now() - timedelta(days=30)  # 很久之前用过
        c_used.save(update_fields=["last_used_at"])
        # c_never.last_used_at IS NULL

        with _auth_as(self.user):
            resp = self._get_match()
        items = resp.json()
        self.assertEqual(len(items), 2)
        # used 排前面（即便 30 天前）；never 排后面
        self.assertEqual(items[0]["username"], "used")
        self.assertEqual(items[1]["username"], "never")

    def test_match_null_last_used_at_falls_back_to_created_at_desc(self):
        """两条都 last_used_at IS NULL → 按 created_at DESC 兜底。"""
        c_old = self._create_website_cred("old-create")
        c_new = self._create_website_cred("new-create")
        # 两个 last_used_at 都默认 NULL；created_at 自然 c_new > c_old
        # （因为 c_new 后创建）

        with _auth_as(self.user):
            resp = self._get_match()
        items = resp.json()
        self.assertEqual(len(items), 2)
        # 最新创建排第一
        self.assertEqual(items[0]["username"], "new-create")
        self.assertEqual(items[1]["username"], "old-create")

    def test_website_credential_out_includes_last_used_at(self):
        """WebsiteCredentialOut 序列化包含 last_used_at（Wave 5 UI 要展示）。"""
        c = self._create_website_cred("alice")
        c.last_used_at = timezone.now()
        c.save(update_fields=["last_used_at"])

        with _auth_as(self.user):
            resp = self._get_match()
        items = resp.json()
        self.assertEqual(len(items), 1)
        self.assertIn("last_used_at", items[0])
        self.assertIsNotNone(items[0]["last_used_at"])

    def test_expired_credential_does_not_update_last_used_at(self):
        """过期凭据走失败分支 → last_used_at 不变（保持 NULL）。"""
        c = self._create_website_cred("alice")
        c.expires_at = timezone.now() - timedelta(hours=1)
        c.save(update_fields=["expires_at"])

        with _auth_as(self.user):
            resp = self._post_autofill(c.id)
        self.assertEqual(resp.status_code, 410)
        c.refresh_from_db()
        # 失败路径不回写——避免 Wave 5 设置页把"被尝试过但失败"误展示为"最近使用"
        self.assertIsNone(c.last_used_at)

    def test_inactive_credential_does_not_update_last_used_at(self):
        """禁用凭据同样不回写 last_used_at（与过期对称）。"""
        c = self._create_website_cred("alice")
        c.is_active = False
        c.save(update_fields=["is_active"])

        with _auth_as(self.user):
            resp = self._post_autofill(c.id)
        self.assertEqual(resp.status_code, 410)
        c.refresh_from_db()
        self.assertIsNone(c.last_used_at)

    def test_app_autofill_reveal_does_not_update_last_used_at_anymore(self):
        """Wave 5a：App 端点同步对称——reveal 也不再写 last_used_at。"""
        app_cred = UserCredential.objects.create(
            user=self.user,
            category=CredentialCategory.APP_LOGIN,
            service_name="com.example.app",
            encrypted_data={"username": "u", "password": "pw_value_12345"},
        )
        with _auth_as(self.user):
            resp = self.client.post(
                f"/api/credential-vault/app/{app_cred.id}/autofill-reveal",
                content_type="application/json",
                HTTP_AUTHORIZATION="Bearer test-token",
            )
        self.assertEqual(resp.status_code, 200)
        app_cred.refresh_from_db()
        self.assertIsNone(
            app_cred.last_used_at,
            "Wave 5a：App reveal 同样不再写 last_used_at",
        )

    def test_inactive_credential_filtered_from_match(self):
        """is_active=False 的凭据不出现在 match 结果中（Wave 4 边界场景）。"""
        c_active = self._create_website_cred("active-user")
        c_inactive = self._create_website_cred("inactive-user")
        c_inactive.is_active = False
        c_inactive.save(update_fields=["is_active"])

        with _auth_as(self.user):
            resp = self._get_match()
        items = resp.json()
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["username"], "active-user")

# ══════════════════════════════════════════════════════════════════════
# Wave 5a (L-W4-4)：mark-used 端点单测
# ══════════════════════════════════════════════════════════════════════


@override_settings(ROOT_URLCONF="apps.credential_vault.tests")
class MarkUsedEndpointTests(TestCase):
    """Wave 5a (L-W4-4) 验收：mark-used 端点。

    背景：autofill-reveal 不再在成功 issue 时写 last_used_at。改由主进程在
    ``runAgentAutofill`` 走完 fill + submit + verify 全成功后显式调
    ``POST /website/{id}/mark-used`` 触发回写。这样：
      - reveal 成功但 fill / submit 失败时 last_used_at 不被错误污染；
      - Wave 5 设置页"最近使用"列展示真正成功的登录时刻。

    覆盖断言：
      - 正常路径：标记后 last_used_at 被设置 + 不污染 updated_at；
      - 限流：与 autofill-reveal **共享配额**（20/5min/per-user）；
      - 跨用户禁止访问 → 404；
      - 端点不返回 sensitive 数据（不含 password / encrypted_data）；
      - category 错误（用 app id 调 website 端点）→ 404；
      - 不存在的 credential_id → 404；
      - 已禁用 / 已过期凭据**仍允许** mark-used（语义：事后标记历史使用时刻，
        不做活性校验，与 Wave 5 设置页"禁用前最后一次使用"展示对齐）。
    """

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._tabtinspace_signal = None
        try:
            from django.db.models.signals import post_save
            from apps.tabtinspace.signals import create_default_organization
            post_save.disconnect(create_default_organization, sender=User)
            cls._tabtinspace_signal = create_default_organization
        except Exception:
            pass

    @classmethod
    def tearDownClass(cls):
        if cls._tabtinspace_signal is not None:
            from django.db.models.signals import post_save
            post_save.connect(cls._tabtinspace_signal, sender=User)
        super().tearDownClass()

    def setUp(self):
        cache.clear()
        self.client = Client()
        self.user = User.objects.create_user(
            username=f"mu_user_{uuid.uuid4().hex[:8]}",
            email=f"mu_{uuid.uuid4().hex[:8]}@example.com",
            password="test_pass_123456",
        )

    def _create_website_cred(self, username: str = "alice") -> UserCredential:
        return UserCredential.objects.create(
            user=self.user,
            category=CredentialCategory.WEBSITE_LOGIN,
            service_name="example.com",
            encrypted_data={
                "url": "https://example.com",
                "username": username,
                "password": "secret-pw-NEVER-LEAK",
            },
        )

    def _create_app_cred(self) -> UserCredential:
        return UserCredential.objects.create(
            user=self.user,
            category=CredentialCategory.APP_LOGIN,
            service_name="com.example.app",
            encrypted_data={"username": "u", "password": "secret-pw-NEVER-LEAK"},
        )

    def _post_mark_used(self, cred_id, kind: str = "website"):
        return self.client.post(
            f"/api/credential-vault/{kind}/{cred_id}/mark-used",
            content_type="application/json",
            HTTP_AUTHORIZATION="Bearer test-token",
        )

    # ── 正常路径 ────────────────────────────────────────────────────

    def test_mark_used_website_sets_last_used_at(self):
        c = self._create_website_cred()
        self.assertIsNone(c.last_used_at)
        before = timezone.now()
        with _auth_as(self.user):
            resp = self._post_mark_used(c.id, "website")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertTrue(body["success"])
        self.assertIn("last_used_at", body)
        c.refresh_from_db()
        self.assertIsNotNone(c.last_used_at)
        self.assertGreaterEqual(c.last_used_at, before - timedelta(seconds=1))

    def test_mark_used_app_sets_last_used_at(self):
        c = self._create_app_cred()
        with _auth_as(self.user):
            resp = self._post_mark_used(c.id, "app")
        self.assertEqual(resp.status_code, 200)
        c.refresh_from_db()
        self.assertIsNotNone(c.last_used_at)

    def test_mark_used_does_not_touch_updated_at(self):
        """关键：mark-used 走 update_fields=['last_used_at']，不漂移 updated_at。"""
        c = self._create_website_cred()
        before_updated = c.updated_at
        with _auth_as(self.user):
            resp = self._post_mark_used(c.id, "website")
        self.assertEqual(resp.status_code, 200)
        c.refresh_from_db()
        self.assertEqual(
            c.updated_at, before_updated,
            "updated_at 不应该被 mark-used 改写",
        )

    def test_mark_used_response_does_not_leak_sensitive_fields(self):
        """安全：mark-used 响应**不**包含 password / encrypted_data 等敏感字段。"""
        c = self._create_website_cred()
        with _auth_as(self.user):
            resp = self._post_mark_used(c.id, "website")
        body_text = resp.content.decode("utf-8")
        # 核心安全断言
        self.assertNotIn("secret-pw-NEVER-LEAK", body_text)
        self.assertNotIn("encrypted_data", body_text)
        self.assertNotIn("password", body_text)

    # ── 错误路径 ────────────────────────────────────────────────────

    def test_mark_used_unknown_credential_returns_404(self):
        with _auth_as(self.user):
            resp = self._post_mark_used(uuid.uuid4(), "website")
        self.assertEqual(resp.status_code, 404)
        self.assertEqual(resp.json()["code"], "NOT_FOUND")

    def test_mark_used_category_mismatch_returns_404(self):
        """website 端点用 app credential id → 404（category 字段守门）。"""
        app_cred = self._create_app_cred()
        with _auth_as(self.user):
            resp = self._post_mark_used(app_cred.id, "website")
        self.assertEqual(resp.status_code, 404)

    def test_mark_used_cross_user_returns_404(self):
        """跨用户访问 → 404（不能用别人的 cred id 污染他的 last_used_at）。"""
        c = self._create_website_cred()
        other = User.objects.create_user(
            username=f"other_{uuid.uuid4().hex[:8]}",
            email=f"other_{uuid.uuid4().hex[:8]}@example.com",
            password="test_pass_123456",
        )
        with _auth_as(other):
            resp = self._post_mark_used(c.id, "website")
        self.assertEqual(resp.status_code, 404)

    def test_mark_used_inactive_credential_still_records_history(self):
        """禁用凭据仍允许 mark-used —— 反映"凭据被实际使用过的时刻"事实。

        语义动机：用户 disable 凭据后，Wave 5 设置页"最后一次使用"应当能展示
        禁用前最后那次成功使用的时刻；这不是"凭据现在仍然可用"的判定。
        """
        c = self._create_website_cred()
        c.is_active = False
        c.save(update_fields=["is_active"])
        with _auth_as(self.user):
            resp = self._post_mark_used(c.id, "website")
        self.assertEqual(resp.status_code, 200)
        c.refresh_from_db()
        self.assertIsNotNone(c.last_used_at)

    def test_mark_used_expired_credential_still_records_history(self):
        """过期凭据同样允许 mark-used（与禁用对称）。"""
        c = self._create_website_cred()
        c.expires_at = timezone.now() - timedelta(hours=1)
        c.save(update_fields=["expires_at"])
        with _auth_as(self.user):
            resp = self._post_mark_used(c.id, "website")
        self.assertEqual(resp.status_code, 200)

    # ── 限流 ────────────────────────────────────────────────────

    def test_mark_used_shares_rate_limit_with_autofill_reveal(self):
        """与 autofill-reveal **共享** per-user 20/5min 配额。

        攻击模型：JWT 被盗后攻击者用 mark-used 做 last_used_at 污染攻击 →
        共享计数器让"reveal + mark-used 混用"无法翻倍。
        """
        c = self._create_website_cred()
        # 先用 reveal 把配额刷掉 19 次
        with _auth_as(self.user):
            for _ in range(19):
                resp = self.client.post(
                    f"/api/credential-vault/website/{c.id}/autofill-reveal",
                    content_type="application/json",
                    HTTP_AUTHORIZATION="Bearer test-token",
                )
                self.assertEqual(resp.status_code, 200)
            # 第 20 次走 mark-used 仍然成功（共用计数器，刚好到上限）
            resp = self._post_mark_used(c.id, "website")
            self.assertEqual(resp.status_code, 200)
            # 第 21 次（任何一种）触发限流
            resp = self._post_mark_used(c.id, "website")
            self.assertEqual(resp.status_code, 429)
            self.assertEqual(resp.json()["code"], "RATE_LIMITED")


# ===========================================================================
# Wave 5c T1：UserOnboardingState（首次引导跨设备状态）
# ===========================================================================


@override_settings(ROOT_URLCONF="apps.credential_vault.tests")
class OnboardingStateApiTests(TestCase):
    """Wave 5c T1：`/api/credential-vault/onboarding/state` GET / PUT 端点。

    覆盖：
      - GET 未交互返回全 null（不在读端点产生写副作用）
      - PUT dismiss / complete / reset 三个 action 的语义
      - 幂等：同一动作重发不覆盖更早的时间戳
      - 跨用户隔离
    """

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._tabtinspace_signal = None
        try:
            from django.db.models.signals import post_save
            from apps.tabtinspace.signals import create_default_organization
            post_save.disconnect(create_default_organization, sender=User)
            cls._tabtinspace_signal = create_default_organization
        except Exception:
            pass

    @classmethod
    def tearDownClass(cls):
        if cls._tabtinspace_signal is not None:
            from django.db.models.signals import post_save
            post_save.connect(cls._tabtinspace_signal, sender=User)
        super().tearDownClass()

    def setUp(self):
        self.client = Client()
        cache.clear()
        self.user = User.objects.create_user(
            username=f"onb_{uuid.uuid4().hex[:8]}",
            email=f"onb_{uuid.uuid4().hex[:8]}@example.com",
            password="test_pass_123456",
        )

    def _get(self):
        return self.client.get(
            "/api/credential-vault/onboarding/state",
            HTTP_AUTHORIZATION="Bearer test-token",
        )

    def _put(self, action: str, source: str = ""):
        return self.client.put(
            "/api/credential-vault/onboarding/state",
            data=json.dumps({"action": action, "browser_import_source": source}),
            content_type="application/json",
            HTTP_AUTHORIZATION="Bearer test-token",
        )

    def test_get_returns_null_for_new_user(self):
        with _auth_as(self.user):
            resp = self._get()
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertIsNone(body.get("onboarding_dismissed_at"))
        self.assertIsNone(body.get("browser_import_completed_at"))
        self.assertEqual(body.get("browser_import_source"), "")

    def test_get_does_not_create_row(self):
        """GET 不能产生写副作用——避免大量未引导用户在 GET 时把表打满。"""
        from apps.credential_vault.models import UserOnboardingState

        with _auth_as(self.user):
            self._get()
        self.assertFalse(
            UserOnboardingState.objects.filter(user=self.user).exists(),
            "GET /onboarding/state 不应产生 OnboardingState 行",
        )

    def test_put_dismiss_sets_timestamp(self):
        with _auth_as(self.user):
            resp = self._put("dismiss")
        self.assertEqual(resp.status_code, 200)
        self.assertIsNotNone(resp.json()["onboarding_dismissed_at"])

    def test_put_complete_sets_timestamp_and_source(self):
        with _auth_as(self.user):
            resp = self._put("complete", source="chrome")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertIsNotNone(body["browser_import_completed_at"])
        self.assertEqual(body["browser_import_source"], "chrome")

    def test_put_dismiss_idempotent_keeps_first_timestamp(self):
        """重发 dismiss 不应覆盖最早时间戳——保留追溯准确。"""
        with _auth_as(self.user):
            r1 = self._put("dismiss")
            first_ts = r1.json()["onboarding_dismissed_at"]
            # 间隔一会再发
            import time
            time.sleep(0.05)
            r2 = self._put("dismiss")
            second_ts = r2.json()["onboarding_dismissed_at"]
        self.assertEqual(first_ts, second_ts, "重发 dismiss 不应刷新时间戳")

    def test_put_complete_idempotent_keeps_first_timestamp(self):
        with _auth_as(self.user):
            r1 = self._put("complete", source="chrome")
            first_ts = r1.json()["browser_import_completed_at"]
            import time
            time.sleep(0.05)
            r2 = self._put("complete", source="edge")  # 后续 source 也允许更新
            second_ts = r2.json()["browser_import_completed_at"]
        self.assertEqual(first_ts, second_ts, "重发 complete 不应刷新时间戳")
        # source 允许覆盖（多浏览器导入场景）
        self.assertIn(r2.json()["browser_import_source"], {"edge", "chrome"})

    def test_put_reset_clears_both(self):
        with _auth_as(self.user):
            self._put("dismiss")
            self._put("complete", source="chrome")
            r = self._put("reset")
        body = r.json()
        self.assertIsNone(body["onboarding_dismissed_at"])
        self.assertIsNone(body["browser_import_completed_at"])
        self.assertEqual(body["browser_import_source"], "")

    def test_put_invalid_action_rejected(self):
        with _auth_as(self.user):
            resp = self.client.put(
                "/api/credential-vault/onboarding/state",
                data=json.dumps({"action": "make-up"}),
                content_type="application/json",
                HTTP_AUTHORIZATION="Bearer test-token",
            )
        self.assertEqual(resp.status_code, 422)

    def test_state_isolated_per_user(self):
        other = User.objects.create_user(
            username=f"onb_other_{uuid.uuid4().hex[:8]}",
            email=f"onb_other_{uuid.uuid4().hex[:8]}@example.com",
            password="test_pass_123456",
        )
        with _auth_as(self.user):
            self._put("dismiss")
        with _auth_as(other):
            resp = self._get()
        self.assertIsNone(
            resp.json()["onboarding_dismissed_at"],
            "用户 A 的 dismiss 不应影响用户 B",
        )


@override_settings(ROOT_URLCONF="apps.credential_vault.tests")
class WebsiteCredentialUpdateApiTests(TestCase):
    """#3522 修复验收：``PUT /api/credential-vault/website/{id}`` 部分更新。

    此前前端点「编辑 → 更新」打的是 ``PUT /website/{id}``，但后端只有
    ``POST /website/create`` 没有对应 update 端点，故报 HTTP 404。
    """

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._tabtinspace_signal = None
        try:
            from django.db.models.signals import post_save
            from apps.tabtinspace.signals import create_default_organization
            post_save.disconnect(create_default_organization, sender=User)
            cls._tabtinspace_signal = create_default_organization
        except Exception:
            pass

    @classmethod
    def tearDownClass(cls):
        if cls._tabtinspace_signal is not None:
            from django.db.models.signals import post_save
            post_save.connect(cls._tabtinspace_signal, sender=User)
        super().tearDownClass()

    def setUp(self):
        self.client = Client()
        cache.clear()
        self.user = User.objects.create_user(
            username=f"upd_user_{uuid.uuid4().hex[:8]}",
            email=f"upd_{uuid.uuid4().hex[:8]}@example.com",
            password="test_pass_123456",
        )
        self.other_user = User.objects.create_user(
            username=f"upd_other_{uuid.uuid4().hex[:8]}",
            email=f"upd_other_{uuid.uuid4().hex[:8]}@example.com",
            password="other_pass_123456",
        )
        self.cred = UserCredential.objects.create(
            user=self.user,
            category=CredentialCategory.WEBSITE_LOGIN,
            service_name="github.com",
            display_name="GitHub",
            encrypted_data={
                "url": "https://github.com",
                "username": "me",
                "password": "old_secret",
            },
        )

    def _put(self, cred_id, payload):
        return self.client.put(
            f"/api/credential-vault/website/{cred_id}",
            data=json.dumps(payload),
            content_type="application/json",
            HTTP_AUTHORIZATION="Bearer test-token",
        )

    def test_update_partial_fields(self):
        with _auth_as(self.user):
            resp = self._put(self.cred.id, {"username": "new_me", "display_name": "GH 工作号"})
        self.assertEqual(resp.status_code, 200)
        self.cred.refresh_from_db()
        self.assertEqual(self.cred.encrypted_data["username"], "new_me")
        self.assertEqual(self.cred.display_name, "GH 工作号")
        # 未传的字段保持不变
        self.assertEqual(self.cred.encrypted_data["password"], "old_secret")
        self.assertEqual(self.cred.encrypted_data["url"], "https://github.com")

    def test_update_password_only_when_present(self):
        # 省略 password → 保留原值
        with _auth_as(self.user):
            self._put(self.cred.id, {"username": "x"})
        self.cred.refresh_from_db()
        self.assertEqual(self.cred.encrypted_data["password"], "old_secret")
        # 传 password → 覆盖
        with _auth_as(self.user):
            self._put(self.cred.id, {"password": "new_secret"})
        self.cred.refresh_from_db()
        self.assertEqual(self.cred.encrypted_data["password"], "new_secret")

    def test_update_url_recomputes_service_name(self):
        with _auth_as(self.user):
            resp = self._put(self.cred.id, {"url": "https://passport.jd.com/login"})
        self.assertEqual(resp.status_code, 200)
        self.cred.refresh_from_db()
        self.assertEqual(self.cred.encrypted_data["url"], "https://passport.jd.com/login")
        self.assertEqual(self.cred.service_name, "passport.jd.com")

    def test_update_blank_display_name_falls_back_to_domain(self):
        with _auth_as(self.user):
            self._put(self.cred.id, {"display_name": ""})
        self.cred.refresh_from_db()
        self.assertEqual(self.cred.display_name, "github.com")

    def test_update_other_users_credential_returns_404(self):
        other_cred = UserCredential.objects.create(
            user=self.other_user,
            category=CredentialCategory.WEBSITE_LOGIN,
            service_name="example.com",
            encrypted_data={"url": "https://example.com", "username": "u", "password": "p"},
        )
        with _auth_as(self.user):
            resp = self._put(other_cred.id, {"username": "hacked"})
        self.assertEqual(resp.status_code, 404)

    def test_update_app_credential_returns_404(self):
        app_cred = UserCredential.objects.create(
            user=self.user,
            category=CredentialCategory.APP_LOGIN,
            service_name="com.tencent.mm",
            encrypted_data={"username": "u", "password": "p"},
        )
        with _auth_as(self.user):
            resp = self._put(app_cred.id, {"username": "x"})
        self.assertEqual(resp.status_code, 404)

    # ── 路由顺序回归──────────────────────────────────────
    # ``PUT /website/{credential_id}`` 的路径参数用宽松 str 转换器，若注册在
    # 字面量 ``/website/match`` / ``/website/list`` 之前会把它们顶成 405。
    # 下面两条锁死：新增 PUT 路由后这些字面量 GET 端点仍可用（不被抢占）。

    def test_website_match_not_shadowed_by_update_route(self):
        with _auth_as(self.user):
            resp = self.client.get(
                "/api/credential-vault/website/match?domain=github.com",
                HTTP_AUTHORIZATION="Bearer test-token",
            )
        self.assertEqual(resp.status_code, 200, "match 被 PUT /website/{id} 抢占成 405")
        usernames = [c["username"] for c in resp.json()]
        self.assertIn("me", usernames)

    def test_website_list_not_shadowed_by_update_route(self):
        with _auth_as(self.user):
            resp = self.client.get(
                "/api/credential-vault/website/list",
                HTTP_AUTHORIZATION="Bearer test-token",
            )
        self.assertEqual(resp.status_code, 200, "list 被 PUT /website/{id} 抢占成 405")
        self.assertTrue(any(c["id"] == str(self.cred.id) for c in resp.json()))
